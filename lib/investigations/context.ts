import { createHash } from 'node:crypto';

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { aiInvestigation, aiInvestigationAttempt, investigation, investigationContextEntry, investigationContextEvent, repositoryBaseline } from '../../db/schema.ts';
import { AI_LIMITS } from '../ai-investigations/types.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { CONTEXT_BUDGET, ContextPolicyError, normalizeContextPath, normalizeSearchQuery, pathDenied, searchablePath, strictUtf8 } from './policy.ts';
import { withScopedRepositoryToken } from './source.ts';
import type { InvestigationSourceGateway } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class InvestigationContextError extends Error {
  constructor(public readonly code:
    | 'invalid_context_request'
    | 'investigation_not_found'
    | 'investigation_not_ready'
    | 'context_operation_replayed'
    | 'context_budget_exhausted'
    | 'path_not_found'
    | 'path_not_readable'
    | 'binary_file_rejected'
    | 'content_identity_mismatch'
    | 'context_source_unavailable'
    | ContextPolicyError['code']) {
    super(code);
    this.name = 'InvestigationContextError';
  }
}

type Operation = 'list_paths' | 'read_text_file' | 'search_text' | 'read_baseline_summary';
type WorkspaceAuthority = { workspace: { id: string } };
type AiAudit = {
  aiInvestigationId?: string;
  aiInvestigationAttemptId?: string;
  ownershipToken?: string;
};

type OperationInput = {
  id: string;
  operation: Operation;
  requestPath?: string;
  queryHash?: string;
  queryBytes?: number;
  budgetBytes: number;
  allowTruncation?: boolean;
} & AiAudit;

function hasValidAiAudit(input: AiAudit): input is Required<AiAudit> {
  const fields = [input.aiInvestigationId, input.aiInvestigationAttemptId, input.ownershipToken];
  if (fields.every((field) => field === undefined)) return false;
  if (!fields.every((field) => typeof field === 'string' && UUID.test(field))) throw new InvestigationContextError('invalid_context_request');
  return true;
}

async function assertActiveAiAttempt(database: VigiloDatabase, value: typeof investigation.$inferSelect, input: AiAudit) {
  if (!hasValidAiAudit(input)) return;
  const [modelRun] = await database.select({ id: aiInvestigation.id }).from(aiInvestigation).where(and(
    eq(aiInvestigation.id, input.aiInvestigationId), eq(aiInvestigation.investigationId, value.id),
    eq(aiInvestigation.workspaceId, value.workspaceId), eq(aiInvestigation.state, 'investigating'),
  )).limit(1);
  if (!modelRun) throw new InvestigationContextError('invalid_context_request');
  const [attempt] = await database.select({ id: aiInvestigationAttempt.id }).from(aiInvestigationAttempt).where(and(
    eq(aiInvestigationAttempt.id, input.aiInvestigationAttemptId),
    eq(aiInvestigationAttempt.aiInvestigationId, input.aiInvestigationId),
    eq(aiInvestigationAttempt.ownershipToken, input.ownershipToken),
    eq(aiInvestigationAttempt.state, 'active'),
    gt(aiInvestigationAttempt.leaseExpiresAt, new Date()),
  )).for('update').limit(1);
  if (!attempt) throw new InvestigationContextError('invalid_context_request');
}

function safeContextError(error: unknown): InvestigationContextError {
  if (error instanceof InvestigationContextError) return error;
  if (error instanceof ContextPolicyError) return new InvestigationContextError(error.code);
  return new InvestigationContextError('context_source_unavailable');
}

async function readyInvestigation(database: VigiloDatabase, context: WorkspaceAuthority, investigationId: string) {
  if (!UUID.test(investigationId)) throw new InvestigationContextError('invalid_context_request');
  const [value] = await database.select().from(investigation).where(and(eq(investigation.id, investigationId), eq(investigation.workspaceId, context.workspace.id))).limit(1);
  if (!value) throw new InvestigationContextError('investigation_not_found');
  if (value.state !== 'ready') throw new InvestigationContextError('investigation_not_ready');
  return value;
}

async function reserveOperation(
  database: VigiloDatabase,
  value: typeof investigation.$inferSelect,
  input: OperationInput,
) {
  if (!UUID.test(input.id) || input.budgetBytes < 0 || input.budgetBytes > value.maxCumulativeBytes) throw new InvestigationContextError('invalid_context_request');
  hasValidAiAudit(input);
  const now = new Date();
  return database.transaction(async (transaction) => {
    const [locked] = await transaction.select({ id: investigation.id }).from(investigation).where(and(eq(investigation.id, value.id), eq(investigation.workspaceId, value.workspaceId))).for('update').limit(1);
    if (!locked) throw new InvestigationContextError('investigation_not_found');
    await assertActiveAiAttempt(transaction as VigiloDatabase, value, input);
    const [existing] = await transaction.select().from(investigationContextEvent).where(eq(investigationContextEvent.id, input.id)).limit(1);
    if (existing) throw new InvestigationContextError('context_operation_replayed');
    const [usage] = await transaction.select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${investigationContextEvent.budgetBytes}), 0)::int`,
    }).from(investigationContextEvent).where(eq(investigationContextEvent.investigationId, value.id));
    if (!usage || usage.count >= value.maxOperations) throw new InvestigationContextError('context_budget_exhausted');
    let reservedBytes = input.budgetBytes;
    const parentRemaining = value.maxCumulativeBytes - usage.bytes;
    if (input.allowTruncation) reservedBytes = Math.min(reservedBytes, parentRemaining);
    else if (reservedBytes > parentRemaining) throw new InvestigationContextError('context_budget_exhausted');
    if (input.aiInvestigationId) {
      const [aiUsage] = await transaction.select({ bytes: sql<number>`coalesce(sum(${investigationContextEvent.budgetBytes}), 0)::int` })
        .from(investigationContextEvent).where(eq(investigationContextEvent.aiInvestigationId, input.aiInvestigationId));
      if (!aiUsage) throw new InvestigationContextError('context_budget_exhausted');
      const aiRemaining = AI_LIMITS.maxContextResultBytes - aiUsage.bytes;
      if (input.allowTruncation) reservedBytes = Math.min(reservedBytes, aiRemaining);
      else if (reservedBytes > aiRemaining) throw new InvestigationContextError('context_budget_exhausted');
    }
    if (input.budgetBytes > 0 && reservedBytes <= 0) throw new InvestigationContextError('context_budget_exhausted');
    await transaction.insert(investigationContextEvent).values({
      id: input.id, investigationId: value.id, aiInvestigationId: input.aiInvestigationId ?? null, workspaceId: value.workspaceId, operation: input.operation,
      status: 'started', requestPath: input.requestPath ?? null, queryHash: input.queryHash ?? null,
      queryBytes: input.queryBytes ?? null, budgetBytes: reservedBytes, createdAt: now,
    });
    return reservedBytes;
  });
}

async function completeOperation(
  database: VigiloDatabase,
  value: typeof investigation.$inferSelect,
  operationId: string,
  audit: AiAudit,
  facts: { resultCount: number; resultBytes: number; truncated: boolean; budgetExhausted: boolean },
) {
  await database.transaction(async (transaction) => {
    await assertActiveAiAttempt(transaction as VigiloDatabase, value, audit);
    const [event] = await transaction.select({ budgetBytes: investigationContextEvent.budgetBytes }).from(investigationContextEvent).where(and(eq(investigationContextEvent.id, operationId), eq(investigationContextEvent.investigationId, value.id), eq(investigationContextEvent.workspaceId, value.workspaceId), eq(investigationContextEvent.status, 'started'))).for('update').limit(1);
    if (!event) throw new InvestigationContextError('context_operation_replayed');
    if (facts.resultBytes < 0 || facts.resultBytes > event.budgetBytes) throw new InvestigationContextError('context_budget_exhausted');
    const [updated] = await transaction.update(investigationContextEvent).set({
      status: 'completed', resultCount: facts.resultCount, resultBytes: facts.resultBytes,
      budgetBytes: facts.resultBytes, truncated: facts.truncated, budgetExhausted: facts.budgetExhausted,
      completedAt: new Date(),
    }).where(and(eq(investigationContextEvent.id, operationId), eq(investigationContextEvent.status, 'started'))).returning({ id: investigationContextEvent.id });
    if (!updated) throw new InvestigationContextError('context_operation_replayed');
  });
}

async function failOperation(database: VigiloDatabase, value: typeof investigation.$inferSelect, operationId: string, audit: AiAudit, code: string) {
  await database.transaction(async (transaction) => {
    await assertActiveAiAttempt(transaction as VigiloDatabase, value, audit);
    const [updated] = await transaction.update(investigationContextEvent).set({
      status: 'failed', resultCount: 0, resultBytes: 0, budgetBytes: 0, failureCode: /^[a-z_]{1,64}$/.test(code) ? code : 'context_source_unavailable', completedAt: new Date(),
    }).where(and(eq(investigationContextEvent.id, operationId), eq(investigationContextEvent.investigationId, value.id), eq(investigationContextEvent.workspaceId, value.workspaceId), eq(investigationContextEvent.status, 'started'))).returning({ id: investigationContextEvent.id });
    if (!updated) throw new InvestigationContextError('context_operation_replayed');
  });
}

async function rejectOperation(
  database: VigiloDatabase,
  value: typeof investigation.$inferSelect,
  input: Omit<OperationInput, 'budgetBytes'>,
  code: string,
) {
  if (!UUID.test(input.id)) return;
  hasValidAiAudit(input);
  const safeCode = /^[a-z_]{1,64}$/.test(code) ? code : 'invalid_context_request';
  const now = new Date();
  await database.transaction(async (transaction) => {
    const [locked] = await transaction.select({ id: investigation.id }).from(investigation).where(and(eq(investigation.id, value.id), eq(investigation.workspaceId, value.workspaceId))).for('update').limit(1);
    if (!locked) throw new InvestigationContextError('investigation_not_found');
    await assertActiveAiAttempt(transaction as VigiloDatabase, value, input);
    const [usage] = await transaction.select({ count: sql<number>`count(*)::int` }).from(investigationContextEvent).where(eq(investigationContextEvent.investigationId, value.id));
    if (!usage || usage.count >= value.maxOperations) throw new InvestigationContextError('context_budget_exhausted');
    const [inserted] = await transaction.insert(investigationContextEvent).values({
      id: input.id, investigationId: value.id, aiInvestigationId: input.aiInvestigationId ?? null, workspaceId: value.workspaceId, operation: input.operation,
      status: 'rejected', requestPath: input.requestPath ?? null, queryHash: input.queryHash ?? null,
      queryBytes: input.queryBytes ?? null, budgetBytes: 0, failureCode: safeCode, createdAt: now, completedAt: now,
    }).onConflictDoNothing().returning({ id: investigationContextEvent.id });
    if (!inserted) throw new InvestigationContextError('context_operation_replayed');
  });
}

async function audited<T>(
  database: VigiloDatabase,
  value: typeof investigation.$inferSelect,
  input: Parameters<typeof reserveOperation>[2],
  operation: (reservedBytes: number) => Promise<{ value: T; resultCount: number; resultBytes: number; truncated: boolean; budgetExhausted: boolean }>,
): Promise<T> {
  const reservedBytes = await reserveOperation(database, value, input);
  try {
    const output = await operation(reservedBytes);
    await completeOperation(database, value, input.id, input, output);
    return output.value;
  } catch (error) {
    const safe = safeContextError(error);
    await failOperation(database, value, input.id, input, safe.code);
    throw safe;
  }
}

function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export async function listPaths(database: VigiloDatabase, context: WorkspaceAuthority, investigationId: string, operationId: string, limit = CONTEXT_BUDGET.maxListPaths, audit: AiAudit = {}) {
  const value = await readyInvestigation(database, context, investigationId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTEXT_BUDGET.maxListPaths) {
    await rejectOperation(database, value, { id: operationId, operation: 'list_paths', ...audit }, 'invalid_context_request');
    throw new InvestigationContextError('invalid_context_request');
  }
  return audited(database, value, { id: operationId, operation: 'list_paths', budgetBytes: 0, ...audit }, async () => {
    const rows = await database.select({
      path: investigationContextEntry.path, kind: investigationContextEntry.kind, sizeBytes: investigationContextEntry.sizeBytes, readable: investigationContextEntry.readable,
    }).from(investigationContextEntry).where(eq(investigationContextEntry.investigationId, value.id)).orderBy(asc(investigationContextEntry.path)).limit(limit + 1);
    const paths = rows.slice(0, limit);
    const truncated = value.treeTruncated || rows.length > limit;
    return { value: { paths, truncated, budgetExhausted: value.treeTruncated }, resultCount: paths.length, resultBytes: 0, truncated, budgetExhausted: value.treeTruncated };
  });
}

async function scopedBlob(
  gateway: InvestigationSourceGateway,
  configuration: GitHubAppConfiguration,
  value: typeof investigation.$inferSelect,
  entry: typeof investigationContextEntry.$inferSelect,
): Promise<Buffer> {
  return withScopedRepositoryToken(gateway, configuration, value, async ({ accessToken, owner, repository }) => {
    const blob = await gateway.getBlob({ accessToken, owner, repository, blobSha: entry.objectSha });
    if (blob.sha !== entry.objectSha || gitBlobSha(blob.bytes) !== entry.objectSha || blob.bytes.byteLength !== entry.sizeBytes) throw new InvestigationContextError('content_identity_mismatch');
    return blob.bytes;
  });
}

export async function readTextFile(
  database: VigiloDatabase,
  context: WorkspaceAuthority,
  gateway: InvestigationSourceGateway,
  configuration: GitHubAppConfiguration,
  investigationId: string,
  operationId: string,
  pathInput: unknown,
  audit: AiAudit = {},
) {
  const value = await readyInvestigation(database, context, investigationId);
  let path: string;
  try {
    path = normalizeContextPath(pathInput);
    if (pathDenied(path)) throw new ContextPolicyError('path_denied');
  } catch (error) {
    const safe = safeContextError(error);
    await rejectOperation(database, value, { id: operationId, operation: 'read_text_file', ...audit }, safe.code);
    throw safe;
  }
  const [entry] = await database.select().from(investigationContextEntry).where(and(eq(investigationContextEntry.investigationId, value.id), eq(investigationContextEntry.path, path))).limit(1);
  if (!entry) {
    await rejectOperation(database, value, { id: operationId, operation: 'read_text_file', requestPath: path, ...audit }, 'path_not_found');
    throw new InvestigationContextError('path_not_found');
  }
  if (!entry.readable || entry.kind !== 'blob' || entry.sizeBytes === null || entry.sizeBytes > value.maxFileBytes) {
    await rejectOperation(database, value, { id: operationId, operation: 'read_text_file', requestPath: path, ...audit }, 'path_not_readable');
    throw new InvestigationContextError('path_not_readable');
  }
  return audited(database, value, { id: operationId, operation: 'read_text_file', requestPath: path, budgetBytes: entry.sizeBytes, ...audit }, async () => {
    const bytes = await scopedBlob(gateway, configuration, value, entry);
    const content = strictUtf8(bytes);
    if (content === null) throw new InvestigationContextError('binary_file_rejected');
    return { value: { path, content, bytes: bytes.byteLength, blobSha: entry.objectSha, truncated: false }, resultCount: 1, resultBytes: bytes.byteLength, truncated: false, budgetExhausted: false };
  });
}

export async function searchText(
  database: VigiloDatabase,
  context: WorkspaceAuthority,
  gateway: InvestigationSourceGateway,
  configuration: GitHubAppConfiguration,
  investigationId: string,
  operationId: string,
  queryInput: unknown,
  audit: AiAudit = {},
) {
  const value = await readyInvestigation(database, context, investigationId);
  let query: string;
  try {
    query = normalizeSearchQuery(queryInput);
  } catch (error) {
    const safe = safeContextError(error);
    await rejectOperation(database, value, { id: operationId, operation: 'search_text', ...audit }, safe.code);
    throw safe;
  }
  const queryHash = createHash('sha256').update(query).digest('hex');
  const all = await database.select().from(investigationContextEntry).where(and(eq(investigationContextEntry.investigationId, value.id), eq(investigationContextEntry.readable, true))).orderBy(asc(investigationContextEntry.path));
  const eligible = all.filter((entry) => searchablePath(entry.path));
  const candidates = eligible.slice(0, CONTEXT_BUDGET.maxSearchCandidateFiles);
  return audited(database, value, {
    id: operationId, operation: 'search_text', queryHash, queryBytes: Buffer.byteLength(query, 'utf8'), budgetBytes: CONTEXT_BUDGET.maxSearchBytes, allowTruncation: true, ...audit,
  }, async (reservedBytes) => {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedBytes = 0;
    let truncated = value.treeTruncated || eligible.length > candidates.length;
    await withScopedRepositoryToken(gateway, configuration, value, async ({ accessToken, owner, repository }) => {
      for (const entry of candidates) {
        if (entry.sizeBytes === null || scannedBytes + entry.sizeBytes > reservedBytes) { truncated = true; break; }
        const blob = await gateway.getBlob({ accessToken, owner, repository, blobSha: entry.objectSha });
        if (blob.sha !== entry.objectSha || gitBlobSha(blob.bytes) !== entry.objectSha || blob.bytes.byteLength !== entry.sizeBytes) throw new InvestigationContextError('content_identity_mismatch');
        scannedBytes += blob.bytes.byteLength;
        const content = strictUtf8(blob.bytes);
        if (content === null) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          if (!line.includes(query)) continue;
          matches.push({ path: entry.path, line: index + 1, text: line.slice(0, CONTEXT_BUDGET.maxSearchLineCharacters) });
          if (matches.length >= CONTEXT_BUDGET.maxSearchMatches) { truncated = true; return; }
        }
      }
    });
    return { value: { matches, scannedBytes, truncated, budgetExhausted: truncated }, resultCount: matches.length, resultBytes: scannedBytes, truncated, budgetExhausted: truncated };
  });
}

export async function readBaselineSummary(database: VigiloDatabase, context: WorkspaceAuthority, investigationId: string, operationId: string, audit: AiAudit = {}) {
  const value = await readyInvestigation(database, context, investigationId);
  return audited(database, value, { id: operationId, operation: 'read_baseline_summary', budgetBytes: 0, ...audit }, async () => {
    const [baseline] = await database.select().from(repositoryBaseline).where(and(eq(repositoryBaseline.id, value.baselineId), eq(repositoryBaseline.workspaceId, value.workspaceId))).limit(1);
    if (!baseline || baseline.githubRepositoryId !== value.githubRepositoryId || baseline.installationId !== value.installationId || baseline.baseCommitSha !== value.baseCommitSha || baseline.profileIdentity !== value.profileIdentity) throw new InvestigationContextError('context_source_unavailable');
    const summary = {
      baselineId: baseline.id, baseCommitSha: baseline.baseCommitSha, profileIdentity: baseline.profileIdentity,
      executionOutcome: baseline.executionOutcome, overallOutcome: baseline.overallOutcome,
      phases: { install: baseline.installStatus, typecheck: baseline.typecheckStatus, build: baseline.buildStatus, test: baseline.testStatus },
      safety: { credentialsExposure: baseline.credentialsExposure, networkPolicy: baseline.networkPolicy, cleanup: { stop: baseline.cleanupStop, delete: baseline.cleanupDelete, lookup: baseline.cleanupLookup }, sourceUnchanged: baseline.sourceUnchanged },
      failure: baseline.errorCode ? { phase: baseline.errorPhase, code: baseline.errorCode } : null,
    };
    return { value: summary, resultCount: 1, resultBytes: 0, truncated: false, budgetExhausted: false };
  });
}
