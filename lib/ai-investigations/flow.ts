import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { aiInvestigation, aiInvestigationEvent, executionProfile, investigation, repairRun, repositoryBaseline } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { trustworthyComparableBaseline } from '../candidate-verifications/classification.ts';
import { AI_INVESTIGATION_JOB_VERSION, type TransactionalAiInvestigationQueue } from '../repair-runs/queue.ts';
import { AI_INVESTIGATION_PROTOCOL_VERSION, AI_MODEL_ID, AI_PROVIDER_ID, type AiInvestigationResult, type InvestigationConclusion } from './types.ts';

export class AiInvestigationFlowError extends Error {
  constructor(public readonly code: 'investigation_not_ready' | 'ai_investigation_not_found' | 'ai_investigation_handoff_failed') { super(code); this.name = 'AiInvestigationFlowError'; }
}

function result(row: typeof aiInvestigation.$inferSelect): AiInvestigationResult {
  const conclusion: InvestigationConclusion | null = row.conclusionStatus && row.summary && row.suspectedFiles && row.evidenceReferences && row.proposedApproach && row.confidence
    ? { status: row.conclusionStatus as InvestigationConclusion['status'], summary: row.summary, suspectedFiles: row.suspectedFiles, evidence: row.evidenceReferences, proposedApproach: row.proposedApproach, confidence: row.confidence as InvestigationConclusion['confidence'] }
    : null;
  return { id: row.id, investigationId: row.investigationId, executionOrdinal: row.executionOrdinal, repairRunId: row.repairRunId, state: row.state as AiInvestigationResult['state'], revision: row.baseCommitSha, providerId: row.providerId, modelId: row.modelId, protocolVersion: row.protocolVersion, completionReason: row.completionReason as AiInvestigationResult['completionReason'], conclusion, usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens, toolCallCount: row.toolCallCount, modelTurnCount: row.modelTurnCount }, failureCode: row.failureCode, createdAt: row.createdAt, completedAt: row.completedAt };
}

export async function startAiInvestigation(database: VigiloDatabase, context: AuthenticatedWorkspace, investigationId: string, queue: TransactionalAiInvestigationQueue, options: { randomId?: () => string; clock?: () => Date; idempotencyKey?: string } = {}): Promise<AiInvestigationResult> {
  const randomId = options.randomId ?? randomUUID; const now = (options.clock ?? (() => new Date()))();
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) throw new AiInvestigationFlowError('investigation_not_ready');
  const created = await database.transaction(async (transaction) => {
    const [parent] = await transaction.select().from(investigation).where(and(eq(investigation.id, investigationId), eq(investigation.workspaceId, context.workspace.id))).for('update').limit(1);
    if (!parent || parent.state !== 'ready') throw new AiInvestigationFlowError('investigation_not_ready');
    const [sameIntent] = await transaction.select().from(aiInvestigation).where(and(eq(aiInvestigation.investigationId, investigationId), eq(aiInvestigation.idempotencyKey, idempotencyKey))).limit(1);
    if (sameIntent) return sameIntent;
    const [latest] = await transaction.select().from(aiInvestigation).where(and(eq(aiInvestigation.investigationId, investigationId), eq(aiInvestigation.workspaceId, context.workspace.id))).orderBy(desc(aiInvestigation.executionOrdinal)).limit(1);
    if (latest && (latest.state === 'completed' || ['created', 'queued', 'investigating'].includes(latest.state))) return latest;
    const [authority] = await transaction.select({ current: investigation, run: repairRun, baseline: repositoryBaseline, profile: executionProfile })
      .from(investigation).innerJoin(repairRun, eq(repairRun.id, investigation.repairRunId)).innerJoin(repositoryBaseline, eq(repositoryBaseline.id, investigation.baselineId)).innerJoin(executionProfile, and(eq(executionProfile.githubRepositoryId, investigation.githubRepositoryId), eq(executionProfile.workspaceId, investigation.workspaceId)))
      .where(and(eq(investigation.id, investigationId), eq(investigation.workspaceId, context.workspace.id))).limit(1);
    if (!authority || authority.current.state !== 'ready' || authority.run.state !== 'ready_for_investigation' || authority.run.baselineId !== authority.baseline.id || authority.profile.status !== 'ready' || !trustworthyComparableBaseline(authority.baseline)) throw new AiInvestigationFlowError('investigation_not_ready');
    const values = [authority.run, authority.baseline, authority.profile];
    if (values.some((value) => value.workspaceId !== authority.current.workspaceId || value.githubRepositoryId !== authority.current.githubRepositoryId || value.installationId !== authority.current.installationId || value.baseCommitSha !== authority.current.baseCommitSha || value.profileIdentity !== authority.current.profileIdentity)) throw new AiInvestigationFlowError('investigation_not_ready');
    const id = randomId();
    const [row] = await transaction.insert(aiInvestigation).values({ id, investigationId: authority.current.id, executionOrdinal: (latest?.executionOrdinal ?? 0) + 1, idempotencyKey, repairRunId: authority.current.repairRunId, baselineId: authority.current.baselineId, workspaceId: authority.current.workspaceId, githubRepositoryId: authority.current.githubRepositoryId, installationId: authority.current.installationId, baseCommitSha: authority.current.baseCommitSha, profileIdentity: authority.current.profileIdentity, providerId: AI_PROVIDER_ID, modelId: AI_MODEL_ID, protocolVersion: AI_INVESTIGATION_PROTOCOL_VERSION, state: 'created', createdAt: now, queuedAt: null, updatedAt: now }).returning();
    if (!row) throw new AiInvestigationFlowError('ai_investigation_handoff_failed');
    await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: id, workspaceId: row.workspaceId, fromState: null, toState: 'created', createdAt: now });
    const queuedId = await queue.enqueueAiInvestigation(transaction, { version: AI_INVESTIGATION_JOB_VERSION, aiInvestigationId: id });
    if (queuedId !== id) throw new AiInvestigationFlowError('ai_investigation_handoff_failed');
    const [queued] = await transaction.update(aiInvestigation).set({ state: 'queued', queuedAt: now, updatedAt: now }).where(and(eq(aiInvestigation.id, id), eq(aiInvestigation.state, 'created'))).returning();
    if (!queued) throw new AiInvestigationFlowError('ai_investigation_handoff_failed');
    await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: id, workspaceId: row.workspaceId, fromState: 'created', toState: 'queued', createdAt: now });
    return queued;
  });
  return result(created);
}

export async function getAiInvestigation(database: VigiloDatabase, context: AuthenticatedWorkspace, id: string): Promise<AiInvestigationResult | null> {
  const [row] = await database.select().from(aiInvestigation).where(and(eq(aiInvestigation.id, id), eq(aiInvestigation.workspaceId, context.workspace.id))).limit(1);
  return row ? result(row) : null;
}

export async function getAiInvestigationForInvestigation(database: VigiloDatabase, context: AuthenticatedWorkspace, investigationId: string): Promise<AiInvestigationResult | null> {
  const [row] = await database.select().from(aiInvestigation).where(and(eq(aiInvestigation.investigationId, investigationId), eq(aiInvestigation.workspaceId, context.workspace.id))).orderBy(desc(aiInvestigation.executionOrdinal)).limit(1);
  return row ? result(row) : null;
}
