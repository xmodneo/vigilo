import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt } from 'drizzle-orm';

import { aiCandidateGeneration, aiCandidateGenerationAttempt, aiCandidateGenerationEvent, repairCandidate } from '../../db/schema.ts';
import { ModelProviderError, type InvestigationModelProvider } from '../ai-investigations/types.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { InvestigationSourceGateway } from '../investigations/types.ts';
import { proposeRepairCandidate, RepairCandidateError } from '../repair-candidates/flow.ts';
import { CandidatePolicyError } from '../repair-candidates/policy.ts';
import { parseAiCandidateGenerationJobPayload, REPAIR_JOB_MAX_ATTEMPTS, type RepairQueueJob } from '../repair-runs/queue.ts';
import { AiCandidateGenerationError, runAiCandidateGeneration, type AiCandidateGenerationErrorCode, type AiCandidateGenerationExecution } from './runner.ts';

const LEASE_MS = 4 * 60_000; const HEARTBEAT_MS = 30_000;
type Row = typeof aiCandidateGeneration.$inferSelect; type Attempt = typeof aiCandidateGenerationAttempt.$inferSelect;
type JobResult = { id: string; status: 'completed' | 'failed' | 'deadletter'; output?: { code: string } };
const NON_RETRYABLE = new Set<AiCandidateGenerationErrorCode>(['candidate_generation_authority_mismatch', 'candidate_generation_ownership_lost', 'invalid_model_proposal', 'schema_mismatch', 'invalid_operation_shape', 'invalid_path', 'proposal_limit_exceeded', 'fresh_observation_missing', 'model_limit_exceeded', 'model_protocol_error', 'model_provider_mismatch', 'provider_configuration_failed', 'provider_quota_exhausted', 'unread_existing_file', 'context_source_unavailable']);

function candidatePolicyFailureCode(code: string | null): AiCandidateGenerationErrorCode {
  if (['invalid_path', 'denied_path', 'package_manifest_change_not_allowed', 'unsupported_file_type'].includes(String(code))) return 'invalid_path';
  if (code === 'change_budget_exceeded') return 'proposal_limit_exceeded';
  if (['malformed_proposal', 'binary_content', 'no_effective_change', 'add_path_already_exists'].includes(String(code))) return 'invalid_operation_shape';
  if (['base_file_missing', 'base_identity_mismatch'].includes(String(code))) return 'candidate_generation_authority_mismatch';
  if (['installation_unavailable', 'repository_access_lost', 'source_evidence_incomplete', 'infrastructure_failed'].includes(String(code))) return 'context_source_unavailable';
  if (['proposal_conflict', 'candidate_conflict'].includes(String(code))) return 'candidate_generation_ownership_lost';
  return 'invalid_model_proposal';
}

function repairCandidateFailureCode(error: RepairCandidateError): AiCandidateGenerationErrorCode {
  if (error.code === 'investigation_not_eligible' || error.code === 'candidate_artifact_invalid') return 'candidate_generation_authority_mismatch';
  if (error.code === 'candidate_conflict' || error.code === 'proposal_conflict' || error.code === 'candidate_not_found') return 'candidate_generation_ownership_lost';
  return 'invalid_model_proposal';
}

export interface AiCandidateGenerationWorkerDependencies {
  database: VigiloDatabase;
  gateway: InvestigationSourceGateway;
  configuration: GitHubAppConfiguration;
  createProvider(): InvestigationModelProvider;
  shutdownSignal?: AbortSignal;
  randomId?: () => string;
  clock?: () => Date;
  executor?: typeof runAiCandidateGeneration;
  afterCandidateFrozen?: () => Promise<void>;
}

type Claim = { kind: 'attempt'; row: Row; attempt: Attempt } | { kind: 'busy' | 'terminal' };

async function claim(database: VigiloDatabase, id: string, queueJobId: string, now: Date, randomId: () => string): Promise<Claim> {
  return database.transaction(async (transaction) => {
    const [row] = await transaction.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, id)).for('update').limit(1);
    if (!row) throw new Error('ai_candidate_generation_not_found');
    if (['frozen', 'abstained', 'failed', 'cancelled'].includes(row.state)) return { kind: 'terminal' };
    const [active] = await transaction.select().from(aiCandidateGenerationAttempt).where(and(eq(aiCandidateGenerationAttempt.generationId, id), eq(aiCandidateGenerationAttempt.state, 'active'))).limit(1);
    if (active && active.leaseExpiresAt && active.leaseExpiresAt > now) return { kind: 'busy' };
    if (active) await transaction.update(aiCandidateGenerationAttempt).set({ state: 'abandoned', leaseExpiresAt: null, finishedAt: now, failureCode: 'process_loss' }).where(and(eq(aiCandidateGenerationAttempt.id, active.id), eq(aiCandidateGenerationAttempt.ownershipToken, active.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active')));
    const [latest] = await transaction.select({ attemptNumber: aiCandidateGenerationAttempt.attemptNumber, failureCode: aiCandidateGenerationAttempt.failureCode }).from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, id)).orderBy(desc(aiCandidateGenerationAttempt.attemptNumber)).limit(1);
    if (row.state === 'generating' && latest?.failureCode && NON_RETRYABLE.has(latest.failureCode as AiCandidateGenerationErrorCode)) {
      const [failed] = await transaction.update(aiCandidateGeneration).set({ state: 'failed', failureCode: latest.failureCode, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.state, 'generating'))).returning();
      if (failed) await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: failed.workspaceId, fromState: 'generating', toState: 'failed', failureCode: latest.failureCode, createdAt: now });
      return { kind: 'terminal' };
    }
    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    if (attemptNumber > REPAIR_JOB_MAX_ATTEMPTS) {
      const [failed] = await transaction.update(aiCandidateGeneration).set({ state: 'failed', failureCode: 'model_retry_exhausted', completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.state, 'generating'))).returning();
      if (failed) await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: failed.workspaceId, fromState: 'generating', toState: 'failed', failureCode: 'model_retry_exhausted', createdAt: now });
      return { kind: 'terminal' };
    }
    let current = row;
    if (row.state === 'queued') {
      const [updated] = await transaction.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.state, 'queued'))).returning();
      if (!updated) return { kind: 'busy' };
      current = updated;
      await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: updated.workspaceId, fromState: 'queued', toState: 'generating', createdAt: now });
    }
    if (current.state !== 'generating') return { kind: 'terminal' };
    const [attempt] = await transaction.insert(aiCandidateGenerationAttempt).values({ id: randomId(), generationId: id, queueJobId, attemptNumber, ownershipToken: randomId(), state: 'active', claimedAt: now, heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }).returning();
    if (!attempt) throw new Error('ai_candidate_generation_claim_failed');
    return { kind: 'attempt', row: current, attempt };
  });
}

async function heartbeat(database: VigiloDatabase, attempt: Attempt, now: Date): Promise<boolean> {
  const [updated] = await database.update(aiCandidateGenerationAttempt).set({ heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, now))).returning({ id: aiCandidateGenerationAttempt.id });
  return !!updated;
}

async function complete(database: VigiloDatabase, row: Row, attempt: Attempt, candidateId: string, usage: AiCandidateGenerationExecution['usage'], now: Date, randomId: () => string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [owned] = await transaction.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, now))).for('update').limit(1);
    if (!owned) return false;
    const [updated] = await transaction.update(aiCandidateGeneration).set({ state: 'frozen', completionReason: 'proposal_ready', repairCandidateId: candidateId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCallCount: usage.toolCallCount, modelTurnCount: usage.modelTurnCount, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, row.id), eq(aiCandidateGeneration.state, 'generating'))).returning();
    if (!updated) return false;
    await transaction.update(aiCandidateGenerationAttempt).set({ state: 'succeeded', leaseExpiresAt: null, finishedAt: now }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active')));
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: row.id, workspaceId: row.workspaceId, fromState: 'generating', toState: 'frozen', createdAt: now });
    return true;
  });
}

async function abstain(database: VigiloDatabase, row: Row, attempt: Attempt, usage: AiCandidateGenerationExecution['usage'], now: Date, randomId: () => string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [owned] = await transaction.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, now))).for('update').limit(1);
    if (!owned) return false;
    const [updated] = await transaction.update(aiCandidateGeneration).set({ state: 'abstained', completionReason: 'insufficient_evidence', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCallCount: usage.toolCallCount, modelTurnCount: usage.modelTurnCount, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, row.id), eq(aiCandidateGeneration.state, 'generating'))).returning();
    if (!updated) return false;
    await transaction.update(aiCandidateGenerationAttempt).set({ state: 'succeeded', leaseExpiresAt: null, finishedAt: now }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active')));
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: row.id, workspaceId: row.workspaceId, fromState: 'generating', toState: 'abstained', createdAt: now });
    return true;
  });
}

async function fail(database: VigiloDatabase, row: Row, attempt: Attempt, code: string, retryable: boolean, now: Date, randomId: () => string): Promise<'retry' | 'failed' | 'lost'> {
  return database.transaction(async (transaction) => {
    const exhausted = !retryable || attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS;
    const [finished] = await transaction.update(aiCandidateGenerationAttempt).set({ state: exhausted ? 'exhausted' : 'retryable_failed', leaseExpiresAt: null, finishedAt: now, failureCode: code }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, now))).returning();
    if (!finished) return 'lost'; if (!exhausted) return 'retry';
    const [updated] = await transaction.update(aiCandidateGeneration).set({ state: 'failed', failureCode: code, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, row.id), eq(aiCandidateGeneration.state, 'generating'))).returning();
    if (!updated) return 'lost';
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: row.id, workspaceId: row.workspaceId, fromState: 'generating', toState: 'failed', failureCode: code, createdAt: now });
    return 'failed';
  });
}

export async function processAiCandidateGenerationJob(job: RepairQueueJob, dependencies: AiCandidateGenerationWorkerDependencies): Promise<JobResult> {
  let payload; try { payload = parseAiCandidateGenerationJobPayload(job.data); } catch { return { id: job.id, status: 'deadletter', output: { code: 'invalid_ai_candidate_generation_job_payload' } }; }
  const randomId = dependencies.randomId ?? randomUUID; const clock = dependencies.clock ?? (() => new Date()); let claimed;
  try { claimed = await claim(dependencies.database, payload.proposalGenerationId, job.id, clock(), randomId); } catch { return { id: job.id, status: 'deadletter', output: { code: 'ai_candidate_generation_not_found' } }; }
  if (claimed.kind === 'terminal') return { id: job.id, status: 'completed' }; if (claimed.kind === 'busy') return { id: job.id, status: 'failed', output: { code: 'active_ai_candidate_generation_attempt' } }; if (claimed.kind !== 'attempt') return { id: job.id, status: 'failed', output: { code: 'ai_candidate_generation_claim_failed' } };
  const { row, attempt } = claimed; const controller = new AbortController(); const abort = () => controller.abort(); job.signal?.addEventListener('abort', abort, { once: true }); dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  const interval = setInterval(() => { void heartbeat(dependencies.database, attempt, clock()).then((owned) => { if (!owned) controller.abort(); }).catch(() => controller.abort()); }, HEARTBEAT_MS);
  try {
    const [persisted] = await dependencies.database.select().from(repairCandidate).where(and(eq(repairCandidate.investigationId, row.investigationId), eq(repairCandidate.proposalKey, row.id))).limit(1);
    if (persisted?.state === 'frozen') return await complete(dependencies.database, row, attempt, persisted.id, { inputTokens: row.inputTokens, outputTokens: row.outputTokens, toolCallCount: row.toolCallCount, modelTurnCount: row.modelTurnCount }, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'candidate_generation_ownership_lost' } };
    if (persisted?.state === 'rejected') {
      const code = candidatePolicyFailureCode(persisted.rejectionCode);
      const outcome = await fail(dependencies.database, row, attempt, code, false, clock(), randomId);
      return outcome === 'failed' ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: outcome === 'lost' ? 'candidate_generation_ownership_lost' : code } };
    }
    const provider = dependencies.createProvider(); if (provider.providerId !== row.providerId || provider.modelId !== row.modelId) throw new AiCandidateGenerationError('model_provider_mismatch');
    const execution = await (dependencies.executor ?? runAiCandidateGeneration)(dependencies.database, dependencies.gateway, dependencies.configuration, provider, { generationId: row.id, generationAttemptId: attempt.id, ownershipToken: attempt.ownershipToken, aiInvestigationId: row.aiInvestigationId, investigationId: row.investigationId, workspaceId: row.workspaceId, baseCommitSha: row.baseCommitSha, profileIdentity: row.profileIdentity, baselineId: row.baselineId }, { signal: controller.signal, randomId });
    if (execution.result.status === 'insufficient_evidence') return await abstain(dependencies.database, row, attempt, execution.usage, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'candidate_generation_ownership_lost' } };
    const candidate = await proposeRepairCandidate(dependencies.database, { workspace: { id: row.workspaceId } } as never, dependencies.gateway, dependencies.configuration, { proposalKey: row.id, investigationId: row.investigationId, files: execution.result.proposal.files.map((file) => ({ ...file, resultingContent: file.resultingContent === null ? null : Buffer.from(file.resultingContent, 'utf8') })) });
    if (candidate.state !== 'frozen') throw new AiCandidateGenerationError(candidatePolicyFailureCode(candidate.rejectionCode));
    await dependencies.afterCandidateFrozen?.();
    return await complete(dependencies.database, row, attempt, candidate.id, execution.usage, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'candidate_generation_ownership_lost' } };
  } catch (error) {
    const code: AiCandidateGenerationErrorCode = error instanceof AiCandidateGenerationError ? error.code : error instanceof ModelProviderError ? error.code : error instanceof CandidatePolicyError ? candidatePolicyFailureCode(error.code) : error instanceof RepairCandidateError ? repairCandidateFailureCode(error) : controller.signal.aborted ? 'model_timeout' : 'model_provider_failed';
    const retryable = !NON_RETRYABLE.has(code) && (code !== 'provider_rate_limited' || (error instanceof AiCandidateGenerationError && error.retryAfterMs !== null && error.retryAfterMs >= 1_000 && error.retryAfterMs <= 60_000));
    const outcome = await fail(dependencies.database, row, attempt, code, retryable, clock(), randomId);
    if (outcome === 'failed') return { id: job.id, status: 'completed' };
    return { id: job.id, status: 'failed', output: { code: outcome === 'lost' ? 'candidate_generation_ownership_lost' : code } };
  } finally { clearInterval(interval); job.signal?.removeEventListener('abort', abort); dependencies.shutdownSignal?.removeEventListener('abort', abort); }
}
