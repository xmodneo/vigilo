import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';

import { aiCandidateGeneration, aiCandidateGenerationAttempt, aiCandidateGenerationEvent, repairCandidate } from '../../db/schema.ts';
import { ModelProviderError, type InvestigationModelProvider } from '../ai-investigations/types.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { InvestigationSourceGateway } from '../investigations/types.ts';
import { proposeRepairCandidate, RepairCandidateError, selfCheckRepairCandidateForWorkspace } from '../repair-candidates/flow.ts';
import { CandidatePolicyError } from '../repair-candidates/policy.ts';
import { parseAiCandidateGenerationJobPayload, REPAIR_JOB_MAX_ATTEMPTS, type RepairQueueJob } from '../repair-runs/queue.ts';
import { AiCandidateGenerationError, runAiCandidateGeneration, type AiCandidateGenerationErrorCode, type AiCandidateGenerationExecution } from './runner.ts';
import { ExternalExecutionAuthorityError } from '../external-execution/types.ts';
import { assertRunBusinessAllowed, lockExternalExecution } from '../external-execution/business-fence.ts';
import { freshDatabaseTime } from '../external-execution/database-clock.ts';
import { assertPublicRepositoryAuthority, RepositoryPolicyError } from '../github-repositories/policy.ts';
import { priorModelTransportUnresolved } from '../ai-investigations/model-request-key.ts';

const HEARTBEAT_MS = 30_000;
type Row = typeof aiCandidateGeneration.$inferSelect; type Attempt = typeof aiCandidateGenerationAttempt.$inferSelect;
type JobResult = { id: string; status: 'completed' | 'failed' | 'deadletter'; output?: { code: string } };
class MissingAiCandidateGeneration extends Error {}
const NON_RETRYABLE = new Set<AiCandidateGenerationErrorCode>(['private_repository_not_supported', 'candidate_generation_authority_mismatch', 'candidate_generation_ownership_lost', 'invalid_model_proposal', 'schema_mismatch', 'invalid_operation_shape', 'invalid_path', 'proposal_limit_exceeded', 'fresh_observation_missing', 'model_limit_exceeded', 'model_protocol_error', 'model_provider_mismatch', 'provider_configuration_failed', 'provider_quota_exhausted', 'unread_existing_file', 'context_source_unavailable', 'execution_authority_missing', 'execution_authority_expired', 'execution_budget_exhausted', 'execution_authority_mismatch', 'provider_attempt_ambiguous', 'sandbox_cleanup_unresolved']);
const RESULT_PERSISTENCE_FAILURE = 'provider_result_unpersisted';

NON_RETRYABLE.add('sandbox_creation_failed');

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

function candidateMatchesGeneration(candidate: typeof repairCandidate.$inferSelect, row: Row): boolean {
  return candidate.proposalKey === row.id && candidate.investigationId === row.investigationId &&
    candidate.repairRunId === row.repairRunId && candidate.workspaceId === row.workspaceId &&
    candidate.githubRepositoryId === row.githubRepositoryId && candidate.installationId === row.installationId &&
    candidate.baseCommitSha === row.baseCommitSha && candidate.profileIdentity === row.profileIdentity;
}

async function claim(database: VigiloDatabase, id: string, queueJobId: string, randomId: () => string): Promise<Claim> {
  return database.transaction(async (transaction) => {
    await lockExternalExecution(transaction);
    const [row] = await transaction.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, id)).for('update').limit(1);
    if (!row) throw new MissingAiCandidateGeneration();
    const now = await freshDatabaseTime(transaction);
    if (['frozen', 'abstained', 'failed', 'cancelled'].includes(row.state)) return { kind: 'terminal' };
    const [active] = await transaction.select().from(aiCandidateGenerationAttempt).where(and(eq(aiCandidateGenerationAttempt.generationId, id), eq(aiCandidateGenerationAttempt.state, 'active'))).limit(1);
    if (active && active.leaseExpiresAt && active.leaseExpiresAt > now) return { kind: 'busy' };
    if (active) {
      const [abandoned] = await transaction.update(aiCandidateGenerationAttempt).set({ state: 'abandoned', leaseExpiresAt: null, finishedAt: now, failureCode: 'process_loss' }).where(and(eq(aiCandidateGenerationAttempt.id, active.id), eq(aiCandidateGenerationAttempt.ownershipToken, active.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), lte(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).returning({ id: aiCandidateGenerationAttempt.id });
      if (!abandoned) return { kind: 'busy' };
    }
    const [latest] = await transaction.select({ attemptNumber: aiCandidateGenerationAttempt.attemptNumber, failureCode: aiCandidateGenerationAttempt.failureCode }).from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, id)).orderBy(desc(aiCandidateGenerationAttempt.attemptNumber)).limit(1);
    if (row.state === 'generating' && latest?.failureCode && (latest.failureCode === RESULT_PERSISTENCE_FAILURE || NON_RETRYABLE.has(latest.failureCode as AiCandidateGenerationErrorCode))) {
      const [failed] = await transaction.update(aiCandidateGeneration).set({ state: 'failed', failureCode: latest.failureCode, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.state, 'generating'))).returning();
      if (failed) await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: failed.workspaceId, fromState: 'generating', toState: 'failed', failureCode: latest.failureCode, createdAt: now });
      return { kind: 'terminal' };
    }
    const [persistedCandidate] = await transaction.select().from(repairCandidate)
      .where(and(eq(repairCandidate.investigationId, row.investigationId), eq(repairCandidate.proposalKey, id))).limit(1);
    const priorAttempts = await transaction.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt)
      .where(eq(aiCandidateGenerationAttempt.generationId, id));
    const priorTransportUnresolved = await priorModelTransportUnresolved(transaction, priorAttempts.map((attempt) => attempt.id));
    const candidateBindingValid = persistedCandidate ? candidateMatchesGeneration(persistedCandidate, row) : false;
    // Freezing retains a proposal hash, not the exact proposed bytes. Only a
    // completed frozen/rejected artifact can be reconciled without transport.
    const locallyReconcilable = candidateBindingValid && (persistedCandidate?.state === 'frozen' || persistedCandidate?.state === 'rejected');
    if ((persistedCandidate && !locallyReconcilable) || (priorTransportUnresolved && !locallyReconcilable)) {
      const code = persistedCandidate && !candidateBindingValid ? 'candidate_generation_authority_mismatch' : RESULT_PERSISTENCE_FAILURE;
      const [failed] = await transaction.update(aiCandidateGeneration).set({ state: 'failed', failureCode: code,
        completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.state, 'generating'))).returning();
      if (failed) await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id,
        workspaceId: row.workspaceId, fromState: 'generating', toState: 'failed', failureCode: code, createdAt: now });
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
    try { await assertRunBusinessAllowed(transaction, { workspaceId: row.workspaceId, repairRunId: row.repairRunId }, now); }
    catch (error) {
      if (!(error instanceof ExternalExecutionAuthorityError)) throw error;
      await transaction.update(aiCandidateGeneration).set({ state: 'failed', failureCode: error.code, completedAt: now, updatedAt: now }).where(eq(aiCandidateGeneration.id, id));
      await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: row.workspaceId, fromState: 'generating', toState: 'failed', failureCode: error.code, createdAt: now });
      return { kind: 'terminal' };
    }
    const [attempt] = await transaction.insert(aiCandidateGenerationAttempt).values({ id: randomId(), generationId: id, queueJobId, attemptNumber, ownershipToken: randomId(), state: 'active', claimedAt: sql`clock_timestamp()`, heartbeatAt: sql`clock_timestamp()`, leaseExpiresAt: sql`clock_timestamp() + interval '4 minutes'` }).returning();
    if (!attempt) throw new Error('ai_candidate_generation_claim_failed');
    return { kind: 'attempt', row: current, attempt };
  });
}

async function heartbeat(database: VigiloDatabase, attempt: Attempt): Promise<boolean> {
  const [updated] = await database.update(aiCandidateGenerationAttempt).set({ heartbeatAt: sql`clock_timestamp()`, leaseExpiresAt: sql`clock_timestamp() + interval '4 minutes'` }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).returning({ id: aiCandidateGenerationAttempt.id });
  return !!updated;
}

async function complete(database: VigiloDatabase, row: Row, attempt: Attempt, candidateId: string, usage: AiCandidateGenerationExecution['usage'], now: Date, randomId: () => string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [parent] = await transaction.select({ state: aiCandidateGeneration.state }).from(aiCandidateGeneration)
      .where(eq(aiCandidateGeneration.id, row.id)).for('update').limit(1);
    if (parent?.state !== 'generating') return false;
    const [owned] = await transaction.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).for('update').limit(1);
    if (!owned) return false;
    const [updated] = await transaction.update(aiCandidateGeneration).set({ state: 'frozen', completionReason: 'proposal_ready', repairCandidateId: candidateId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCallCount: usage.toolCallCount, modelTurnCount: usage.modelTurnCount, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, row.id), eq(aiCandidateGeneration.state, 'generating'))).returning();
    if (!updated) return false;
    const [finished] = await transaction.update(aiCandidateGenerationAttempt).set({ state: 'succeeded', leaseExpiresAt: null, finishedAt: now }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).returning({ id: aiCandidateGenerationAttempt.id });
    if (!finished) throw new Error('candidate_generation_ownership_lost');
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: row.id, workspaceId: row.workspaceId, fromState: 'generating', toState: 'frozen', createdAt: now });
    return true;
  });
}

async function abstain(database: VigiloDatabase, row: Row, attempt: Attempt, usage: AiCandidateGenerationExecution['usage'], now: Date, randomId: () => string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [parent] = await transaction.select({ state: aiCandidateGeneration.state }).from(aiCandidateGeneration)
      .where(eq(aiCandidateGeneration.id, row.id)).for('update').limit(1);
    if (parent?.state !== 'generating') return false;
    const [owned] = await transaction.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).for('update').limit(1);
    if (!owned) return false;
    const [updated] = await transaction.update(aiCandidateGeneration).set({ state: 'abstained', completionReason: 'insufficient_evidence', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCallCount: usage.toolCallCount, modelTurnCount: usage.modelTurnCount, completedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, row.id), eq(aiCandidateGeneration.state, 'generating'))).returning();
    if (!updated) return false;
    const [finished] = await transaction.update(aiCandidateGenerationAttempt).set({ state: 'succeeded', leaseExpiresAt: null, finishedAt: now }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).returning({ id: aiCandidateGenerationAttempt.id });
    if (!finished) throw new Error('candidate_generation_ownership_lost');
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: row.id, workspaceId: row.workspaceId, fromState: 'generating', toState: 'abstained', createdAt: now });
    return true;
  });
}

async function fail(database: VigiloDatabase, row: Row, attempt: Attempt, code: string, retryable: boolean, now: Date, randomId: () => string): Promise<'retry' | 'failed' | 'lost'> {
  return database.transaction(async (transaction) => {
    const [parent] = await transaction.select({ state: aiCandidateGeneration.state }).from(aiCandidateGeneration)
      .where(eq(aiCandidateGeneration.id, row.id)).for('update').limit(1);
    if (parent?.state !== 'generating') return 'lost';
    const exhausted = !retryable || attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS;
    const [finished] = await transaction.update(aiCandidateGenerationAttempt).set({ state: exhausted ? 'exhausted' : 'retryable_failed', leaseExpiresAt: null, finishedAt: now, failureCode: code }).where(and(eq(aiCandidateGenerationAttempt.id, attempt.id), eq(aiCandidateGenerationAttempt.ownershipToken, attempt.ownershipToken), eq(aiCandidateGenerationAttempt.state, 'active'), gt(aiCandidateGenerationAttempt.leaseExpiresAt, sql`clock_timestamp()`))).returning();
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
  try { claimed = await claim(dependencies.database, payload.proposalGenerationId, job.id, randomId); }
  catch (error) { return error instanceof MissingAiCandidateGeneration
    ? { id: job.id, status: 'deadletter', output: { code: 'ai_candidate_generation_not_found' } }
    : { id: job.id, status: 'failed', output: { code: 'ai_candidate_generation_claim_failed' } }; }
  if (claimed.kind === 'terminal') return { id: job.id, status: 'completed' }; if (claimed.kind === 'busy') return { id: job.id, status: 'failed', output: { code: 'active_ai_candidate_generation_attempt' } }; if (claimed.kind !== 'attempt') return { id: job.id, status: 'failed', output: { code: 'ai_candidate_generation_claim_failed' } };
  const { row, attempt } = claimed; const controller = new AbortController(); const abort = () => controller.abort(); job.signal?.addEventListener('abort', abort, { once: true }); dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  const interval = setInterval(() => { void heartbeat(dependencies.database, attempt).then((owned) => { if (!owned) controller.abort(); }).catch(() => controller.abort()); }, HEARTBEAT_MS);
  let modelResultReceived = false;
  let candidateFrozen = false;
  try {
    await assertPublicRepositoryAuthority(dependencies.database, row.workspaceId, row.githubRepositoryId);
    const [persisted] = await dependencies.database.select().from(repairCandidate).where(and(eq(repairCandidate.investigationId, row.investigationId), eq(repairCandidate.proposalKey, row.id))).limit(1);
    if (persisted?.state === 'frozen') {
      await selfCheckRepairCandidateForWorkspace(dependencies.database, row.workspaceId, persisted.id);
      return await complete(dependencies.database, row, attempt, persisted.id, { inputTokens: row.inputTokens, outputTokens: row.outputTokens, toolCallCount: row.toolCallCount, modelTurnCount: row.modelTurnCount }, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'candidate_generation_ownership_lost' } };
    }
    if (persisted?.state === 'rejected') {
      const code = candidatePolicyFailureCode(persisted.rejectionCode);
      const outcome = await fail(dependencies.database, row, attempt, code, false, clock(), randomId);
      return outcome === 'failed' ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: outcome === 'lost' ? 'candidate_generation_ownership_lost' : code } };
    }
    const provider = dependencies.createProvider(); if (provider.providerId !== row.providerId || provider.modelId !== row.modelId) throw new AiCandidateGenerationError('model_provider_mismatch');
    const execution = await (dependencies.executor ?? runAiCandidateGeneration)(dependencies.database, dependencies.gateway, dependencies.configuration, provider, { generationId: row.id, generationAttemptId: attempt.id, ownershipToken: attempt.ownershipToken, aiInvestigationId: row.aiInvestigationId, investigationId: row.investigationId, workspaceId: row.workspaceId, baseCommitSha: row.baseCommitSha, profileIdentity: row.profileIdentity, baselineId: row.baselineId }, { signal: controller.signal, randomId });
    modelResultReceived = true;
    if (execution.result.status === 'insufficient_evidence') return await abstain(dependencies.database, row, attempt, execution.usage, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'candidate_generation_ownership_lost' } };
    await dependencies.database.transaction(async (transaction) => {
      await lockExternalExecution(transaction);
      await assertRunBusinessAllowed(transaction, { workspaceId: row.workspaceId, repairRunId: row.repairRunId }, clock());
    });
    const candidate = await proposeRepairCandidate(dependencies.database, { workspace: { id: row.workspaceId } } as never, dependencies.gateway, dependencies.configuration, { proposalKey: row.id, investigationId: row.investigationId, files: execution.result.proposal.files.map((file) => ({ ...file, resultingContent: file.resultingContent === null ? null : Buffer.from(file.resultingContent, 'utf8') })) });
    if (candidate.state !== 'frozen') throw new AiCandidateGenerationError(candidatePolicyFailureCode(candidate.rejectionCode));
    candidateFrozen = true;
    await dependencies.afterCandidateFrozen?.();
    return await complete(dependencies.database, row, attempt, candidate.id, execution.usage, clock(), randomId) ? { id: job.id, status: 'completed' } : { id: job.id, status: 'failed', output: { code: 'candidate_generation_ownership_lost' } };
  } catch (error) {
    const classified = error instanceof RepositoryPolicyError ? 'private_repository_not_supported' : error instanceof AiCandidateGenerationError ? error.code : error instanceof ModelProviderError ? error.code : error instanceof ExternalExecutionAuthorityError ? error.code : error instanceof CandidatePolicyError ? candidatePolicyFailureCode(error.code) : error instanceof RepairCandidateError ? repairCandidateFailureCode(error) : controller.signal.aborted ? 'model_timeout' : 'model_provider_failed';
    const code = modelResultReceived && classified === 'model_provider_failed'
      ? candidateFrozen ? 'candidate_completion_unpersisted' : RESULT_PERSISTENCE_FAILURE : classified;
    // A frozen candidate is durable and may be reconciled without another model
    // request. Before freezing, no post-response failure may retry the model.
    const retryable = (candidateFrozen && code === 'candidate_completion_unpersisted') ||
      (!modelResultReceived && !NON_RETRYABLE.has(code as AiCandidateGenerationErrorCode) &&
        (code !== 'provider_rate_limited' || (error instanceof AiCandidateGenerationError && error.retryAfterMs !== null && error.retryAfterMs >= 1_000 && error.retryAfterMs <= 60_000)));
    let outcome: 'retry' | 'failed' | 'lost';
    try { outcome = await fail(dependencies.database, row, attempt, code, retryable, clock(), randomId); }
    catch { return { id: job.id, status: 'failed', output: { code } }; }
    if (outcome === 'failed') return { id: job.id, status: 'completed' };
    return { id: job.id, status: 'failed', output: { code: outcome === 'lost' ? 'candidate_generation_ownership_lost' : code } };
  } finally { clearInterval(interval); job.signal?.removeEventListener('abort', abort); dependencies.shutdownSignal?.removeEventListener('abort', abort); }
}
