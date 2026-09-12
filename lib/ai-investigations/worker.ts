import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt } from 'drizzle-orm';

import { aiInvestigation, aiInvestigationAttempt, aiInvestigationEvent } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { InvestigationSourceGateway } from '../investigations/types.ts';
import { parseAiInvestigationJobPayload, REPAIR_JOB_MAX_ATTEMPTS, type RepairQueueJob } from '../repair-runs/queue.ts';
import { AiAgentError, runAiInvestigation, type AiAgentErrorCode, type AiAgentExecution } from './runner.ts';
import { ModelProviderError, type InvestigationModelProvider } from './types.ts';

const LEASE_MS = 4 * 60_000;
const HEARTBEAT_MS = 30_000;
type Attempt = typeof aiInvestigationAttempt.$inferSelect;
type Row = typeof aiInvestigation.$inferSelect;
type JobResult = { id: string; status: 'completed' | 'failed' | 'deadletter'; output?: { code: string } };
const NON_RETRYABLE_FAILURES = new Set<AiAgentErrorCode>([
  'ai_authority_mismatch',
  'ai_investigation_ownership_lost',
  'fabricated_evidence_reference',
  'model_limit_exceeded',
  'model_protocol_error',
  'model_provider_mismatch',
  'provider_configuration_failed',
  'provider_quota_exhausted',
  'unobserved_suspected_file',
]);

function nonRetryableFailureCode(code: string | null): code is AiAgentErrorCode {
  return code !== null && NON_RETRYABLE_FAILURES.has(code as AiAgentErrorCode);
}

function retryableFailure(error: unknown, code: AiAgentErrorCode): boolean {
  if (NON_RETRYABLE_FAILURES.has(code)) return false;
  if (code !== 'provider_rate_limited') return true;
  return error instanceof AiAgentError
    && error.retryAfterMs !== null
    && error.retryAfterMs >= 1_000
    && error.retryAfterMs <= 60_000;
}

export interface AiInvestigationWorkerDependencies {
  database: VigiloDatabase;
  gateway: InvestigationSourceGateway;
  configuration: GitHubAppConfiguration;
  createProvider(): InvestigationModelProvider;
  shutdownSignal?: AbortSignal;
  randomId?: () => string;
  clock?: () => Date;
  executor?: typeof runAiInvestigation;
  afterExecution?: () => Promise<void>;
}

type Claim = { kind: 'attempt'; row: Row; attempt: Attempt } | { kind: 'busy' | 'terminal' };

async function claim(database: VigiloDatabase, id: string, queueJobId: string, now: Date, randomId: () => string): Promise<Claim> {
  return database.transaction(async (transaction) => {
    const [row] = await transaction.select().from(aiInvestigation).where(eq(aiInvestigation.id, id)).for('update').limit(1);
    if (!row) throw new Error('ai_investigation_not_found');
    if (['completed', 'failed', 'cancelled'].includes(row.state)) return { kind: 'terminal' };
    const [active] = await transaction.select().from(aiInvestigationAttempt).where(and(eq(aiInvestigationAttempt.aiInvestigationId, id), eq(aiInvestigationAttempt.state, 'active'))).limit(1);
    if (active && active.leaseExpiresAt && active.leaseExpiresAt > now) return { kind: 'busy' };
    if (active) await transaction.update(aiInvestigationAttempt).set({ state: 'abandoned', leaseExpiresAt: null, finishedAt: now, failureCode: 'process_loss' }).where(and(eq(aiInvestigationAttempt.id, active.id), eq(aiInvestigationAttempt.ownershipToken, active.ownershipToken), eq(aiInvestigationAttempt.state, 'active')));
    const [latest] = await transaction.select({ attemptNumber: aiInvestigationAttempt.attemptNumber, state: aiInvestigationAttempt.state, failureCode: aiInvestigationAttempt.failureCode }).from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, id)).orderBy(desc(aiInvestigationAttempt.attemptNumber)).limit(1);
    if (row.state === 'investigating' && latest?.state === 'retryable_failed' && nonRetryableFailureCode(latest.failureCode)) {
      const [failed] = await transaction.update(aiInvestigation).set({ state: 'failed', failureCode: latest.failureCode, completedAt: now, updatedAt: now }).where(and(eq(aiInvestigation.id, id), eq(aiInvestigation.state, 'investigating'))).returning();
      if (failed) await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: id, workspaceId: failed.workspaceId, fromState: 'investigating', toState: 'failed', failureCode: latest.failureCode, createdAt: now });
      return { kind: 'terminal' };
    }
    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    if (attemptNumber > REPAIR_JOB_MAX_ATTEMPTS) {
      const [failed] = await transaction.update(aiInvestigation).set({ state: 'failed', failureCode: 'model_retry_exhausted', completedAt: now, updatedAt: now }).where(and(eq(aiInvestigation.id, id), eq(aiInvestigation.state, 'investigating'))).returning();
      if (failed) await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: id, workspaceId: failed.workspaceId, fromState: 'investigating', toState: 'failed', failureCode: 'model_retry_exhausted', createdAt: now });
      return { kind: 'terminal' };
    }
    let current = row;
    if (row.state === 'queued') {
      const [updated] = await transaction.update(aiInvestigation).set({ state: 'investigating', investigationStartedAt: now, updatedAt: now }).where(and(eq(aiInvestigation.id, id), eq(aiInvestigation.state, 'queued'))).returning();
      if (!updated) return { kind: 'busy' };
      current = updated;
      await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: id, workspaceId: updated.workspaceId, fromState: 'queued', toState: 'investigating', createdAt: now });
    }
    if (current.state !== 'investigating') return { kind: 'terminal' };
    const [attempt] = await transaction.insert(aiInvestigationAttempt).values({ id: randomId(), aiInvestigationId: id, queueJobId, attemptNumber, ownershipToken: randomId(), state: 'active', claimedAt: now, heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }).returning();
    if (!attempt) throw new Error('ai_investigation_claim_failed');
    return { kind: 'attempt', row: current, attempt };
  });
}

async function heartbeat(database: VigiloDatabase, attempt: Attempt, now: Date): Promise<boolean> {
  const [updated] = await database.update(aiInvestigationAttempt).set({ heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }).where(and(eq(aiInvestigationAttempt.id, attempt.id), eq(aiInvestigationAttempt.ownershipToken, attempt.ownershipToken), eq(aiInvestigationAttempt.state, 'active'), gt(aiInvestigationAttempt.leaseExpiresAt, now))).returning({ id: aiInvestigationAttempt.id });
  return !!updated;
}

async function complete(database: VigiloDatabase, row: Row, attempt: Attempt, execution: AiAgentExecution, now: Date, randomId: () => string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [owned] = await transaction.select().from(aiInvestigationAttempt).where(and(eq(aiInvestigationAttempt.id, attempt.id), eq(aiInvestigationAttempt.ownershipToken, attempt.ownershipToken), eq(aiInvestigationAttempt.state, 'active'), gt(aiInvestigationAttempt.leaseExpiresAt, now))).for('update').limit(1);
    if (!owned) return false;
    const [updated] = await transaction.update(aiInvestigation).set({ state: 'completed', completionReason: execution.completionReason, conclusionStatus: execution.conclusion.status, summary: execution.conclusion.summary, suspectedFiles: execution.conclusion.suspectedFiles, evidenceReferences: execution.conclusion.evidence, proposedApproach: execution.conclusion.proposedApproach, confidence: execution.conclusion.confidence, inputTokens: execution.usage.inputTokens, outputTokens: execution.usage.outputTokens, toolCallCount: execution.usage.toolCallCount, modelTurnCount: execution.usage.modelTurnCount, completedAt: now, updatedAt: now }).where(and(eq(aiInvestigation.id, row.id), eq(aiInvestigation.state, 'investigating'))).returning();
    if (!updated) return false;
    await transaction.update(aiInvestigationAttempt).set({ state: 'succeeded', leaseExpiresAt: null, finishedAt: now }).where(and(eq(aiInvestigationAttempt.id, attempt.id), eq(aiInvestigationAttempt.ownershipToken, attempt.ownershipToken), eq(aiInvestigationAttempt.state, 'active')));
    await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: row.id, workspaceId: row.workspaceId, fromState: 'investigating', toState: 'completed', createdAt: now });
    return true;
  });
}

async function failAttempt(database: VigiloDatabase, row: Row, attempt: Attempt, code: string, retryable: boolean, now: Date, randomId: () => string): Promise<'retry' | 'failed' | 'lost'> {
  return database.transaction(async (transaction) => {
    const exhausted = !retryable || attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS;
    const [finished] = await transaction.update(aiInvestigationAttempt).set({ state: exhausted ? 'exhausted' : 'retryable_failed', leaseExpiresAt: null, finishedAt: now, failureCode: code }).where(and(eq(aiInvestigationAttempt.id, attempt.id), eq(aiInvestigationAttempt.ownershipToken, attempt.ownershipToken), eq(aiInvestigationAttempt.state, 'active'), gt(aiInvestigationAttempt.leaseExpiresAt, now))).returning();
    if (!finished) return 'lost';
    if (!exhausted) return 'retry';
    const [updated] = await transaction.update(aiInvestigation).set({ state: 'failed', failureCode: code, completedAt: now, updatedAt: now }).where(and(eq(aiInvestigation.id, row.id), eq(aiInvestigation.state, 'investigating'))).returning();
    if (!updated) return 'lost';
    await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: row.id, workspaceId: row.workspaceId, fromState: 'investigating', toState: 'failed', failureCode: code, createdAt: now });
    return 'failed';
  });
}

export async function processAiInvestigationJob(job: RepairQueueJob, dependencies: AiInvestigationWorkerDependencies): Promise<JobResult> {
  let payload;
  try { payload = parseAiInvestigationJobPayload(job.data); } catch { return { id: job.id, status: 'deadletter', output: { code: 'invalid_ai_investigation_job_payload' } }; }
  const randomId = dependencies.randomId ?? randomUUID; const clock = dependencies.clock ?? (() => new Date());
  let claimed;
  try { claimed = await claim(dependencies.database, payload.aiInvestigationId, job.id, clock(), randomId); } catch { return { id: job.id, status: 'deadletter', output: { code: 'ai_investigation_not_found' } }; }
  if (claimed.kind === 'terminal') return { id: job.id, status: 'completed' };
  if (claimed.kind === 'busy') return { id: job.id, status: 'failed', output: { code: 'active_ai_investigation_attempt' } };
  if (claimed.kind !== 'attempt') return { id: job.id, status: 'failed', output: { code: 'ai_investigation_claim_failed' } };
  const { row, attempt } = claimed;
  const controller = new AbortController();
  const abort = () => controller.abort();
  job.signal?.addEventListener('abort', abort, { once: true }); dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  const interval = setInterval(() => { void heartbeat(dependencies.database, attempt, clock()).then((owned) => { if (!owned) controller.abort(); }).catch(() => controller.abort()); }, HEARTBEAT_MS);
  try {
    const provider = dependencies.createProvider();
    if (provider.providerId !== row.providerId || provider.modelId !== row.modelId) throw new AiAgentError('model_provider_mismatch');
    const execution = await (dependencies.executor ?? runAiInvestigation)(dependencies.database, dependencies.gateway, dependencies.configuration, provider, { aiInvestigationId: row.id, aiInvestigationAttemptId: attempt.id, ownershipToken: attempt.ownershipToken, investigationId: row.investigationId, workspaceId: row.workspaceId, baseCommitSha: row.baseCommitSha, profileIdentity: row.profileIdentity, baselineId: row.baselineId }, { signal: controller.signal, randomId });
    await dependencies.afterExecution?.();
    return await complete(dependencies.database, row, attempt, execution, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'ai_investigation_ownership_lost' } };
  } catch (error) {
    const code: AiAgentErrorCode = error instanceof AiAgentError ? error.code : error instanceof ModelProviderError ? error.code : controller.signal.aborted ? 'model_timeout' : 'model_provider_failed';
    const normalized = error instanceof ModelProviderError ? new AiAgentError(error.code, error.retryAfterMs) : error;
    const outcome = await failAttempt(dependencies.database, row, attempt, code, retryableFailure(normalized, code), clock(), randomId);
    if (outcome === 'failed') return { id: job.id, status: 'completed' };
    return { id: job.id, status: 'failed', output: { code: outcome === 'lost' ? 'ai_investigation_ownership_lost' : code } };
  } finally {
    clearInterval(interval); job.signal?.removeEventListener('abort', abort); dependencies.shutdownSignal?.removeEventListener('abort', abort);
  }
}
