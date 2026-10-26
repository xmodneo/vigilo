import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { aiCandidateGeneration, aiInvestigation, candidateVerification, investigation, repairLoop, repairRun } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { GeminiInvestigationProvider, readGeminiProviderConfiguration } from '../ai-investigations/gemini-provider.ts';
import { processAiInvestigationJob } from '../ai-investigations/worker.ts';
import { processAiCandidateGenerationJob } from '../ai-candidate-generations/worker.ts';
import { processCandidateVerificationJob } from '../candidate-verifications/worker.ts';
import type { DurableExternalExecutionAuthorizer } from '../external-execution/authority.ts';
import { assertRunBusinessAllowed, lockExternalExecution } from '../external-execution/business-fence.ts';
import { assertReviewedPlanIntegrity } from '../external-execution/reviewed-plan-integrity.ts';
import { assertMatchedSourceCheckpoint } from '../external-execution/source-checkpoint.ts';
import type { GitHubApiClient } from '../github-app/client.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { processInvestigationJob } from '../investigations/worker.ts';
import { processRepairLoopJob } from '../repair-loops/worker.ts';
import { PgBossAiCandidateGenerationQueue, PgBossCandidateVerificationQueue, PgBossRepairLoopQueue, type RepairQueueJob } from './queue.ts';
import { createConsoleWorkerLogger } from './worker.ts';
import { claimExactPhaseJob, exactPhaseQueues, ExactPhaseJobError, type ExactPhaseRequest } from './exact-phase-job.ts';

type Result = { id: string; status: 'completed' | 'failed' | 'deadletter'; output?: { code: string } };

export interface ExactPhaseReceipt {
  kind: 'exact_phase_one_shot';
  phase: ExactPhaseRequest['phase'];
  repairRunId: string;
  jobId: string;
  planIdentity: string;
  releaseSha: string;
  result: 'completed' | 'failed';
  subjectState: string;
}

export interface ExactPhaseDependencies {
  database: VigiloDatabase;
  boss: PgBoss;
  configuration: GitHubAppConfiguration;
  gateway: GitHubApiClient;
  executionAuthority: DurableExternalExecutionAuthorizer;
  runtimeReleaseSha: string;
  workerHeartbeatId: string;
}

/** Recheck durable authority immediately before a one-shot context job mints a GitHub token. */
export async function assertSourceReadAuthority(database: VigiloDatabase, request: ExactPhaseRequest,
  runtimeReleaseSha: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await database.transaction(async (transaction) => {
    await lockExternalExecution(transaction);
    const [run] = await transaction.select({ workspaceId: repairRun.workspaceId }).from(repairRun)
      .where(eq(repairRun.id, request.repairRunId)).limit(1);
    if (!run) throw new ExactPhaseJobError('exact_job_authority_changed');
    const response = await transaction.execute(sql`select clock_timestamp() as authority_time`);
    const rows = Array.isArray(response) ? response :
      (response as { rows?: Array<{ authority_time: Date | string }> }).rows ?? [];
    const rawTime = rows[0]?.authority_time;
    const now = rawTime instanceof Date ? rawTime : typeof rawTime === 'string' ? new Date(rawTime) : null;
    if (!now || !Number.isFinite(now.getTime())) throw new ExactPhaseJobError('exact_job_unavailable');
    await assertMatchedSourceCheckpoint(transaction, request.repairRunId);
    await assertRunBusinessAllowed(transaction,
      { workspaceId: run.workspaceId, repairRunId: request.repairRunId }, now);
    if (await assertReviewedPlanIntegrity(transaction, request.repairRunId, runtimeReleaseSha, now) !== true)
      throw new ExactPhaseJobError('exact_job_authority_changed');
  });
  signal.throwIfAborted();
}

async function subjectState(database: VigiloDatabase, request: ExactPhaseRequest): Promise<string> {
  if (request.phase === 'context') {
    const [row] = await database.select({ state: investigation.state }).from(investigation).where(eq(investigation.id, request.jobId)).limit(1);
    return row?.state ?? 'missing';
  }
  if (request.phase === 'investigation') {
    const [row] = await database.select({ state: aiInvestigation.state }).from(aiInvestigation).where(eq(aiInvestigation.id, request.jobId)).limit(1);
    return row?.state ?? 'missing';
  }
  if (request.phase === 'generation') {
    const [row] = await database.select({ state: aiCandidateGeneration.state }).from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, request.jobId)).limit(1);
    return row?.state ?? 'missing';
  }
  if (request.phase === 'verification') {
    const [row] = await database.select({ state: candidateVerification.state }).from(candidateVerification).where(eq(candidateVerification.id, request.jobId)).limit(1);
    return row?.state ?? 'missing';
  }
  const [row] = await database.select({ state: repairLoop.state }).from(repairLoop).where(eq(repairLoop.wakeJobId, request.jobId)).limit(1);
  return row?.state ?? 'missing';
}

async function dispatch(job: RepairQueueJob, request: ExactPhaseRequest, dependencies: ExactPhaseDependencies,
  signal: AbortSignal): Promise<Result> {
  const { database, boss, gateway, configuration, executionAuthority, runtimeReleaseSha } = dependencies;
  if (request.phase === 'context') return processInvestigationJob(job, {
    database, gateway, configuration, logger: createConsoleWorkerLogger(), shutdownSignal: signal,
    beforeExternalSourceRead: () => assertSourceReadAuthority(database, request, runtimeReleaseSha, signal),
  });
  if (request.phase === 'investigation') return processAiInvestigationJob(job, {
    database, gateway, configuration, shutdownSignal: signal,
    createProvider: () => {
      const provider = readGeminiProviderConfiguration();
      return new GeminiInvestigationProvider(provider.apiKey, undefined, undefined, executionAuthority, provider.accountIdentity);
    },
  });
  if (request.phase === 'generation') return processAiCandidateGenerationJob(job, {
    database, gateway, configuration, shutdownSignal: signal,
    createProvider: () => {
      const provider = readGeminiProviderConfiguration();
      return new GeminiInvestigationProvider(provider.apiKey, undefined, undefined, executionAuthority, provider.accountIdentity);
    },
  });
  if (request.phase === 'verification') return processCandidateVerificationJob(job, {
    database, gateway, configuration, logger: createConsoleWorkerLogger(), shutdownSignal: signal,
    executionAuthority,
  });
  const loopQueue = new PgBossRepairLoopQueue(boss);
  const generationQueue = new PgBossAiCandidateGenerationQueue(boss);
  const verificationQueue = new PgBossCandidateVerificationQueue(boss);
  return processRepairLoopJob(job, {
    database, executionAuthority, runtimeReleaseSha,
    queues: {
      enqueueRepairLoop: loopQueue.enqueueRepairLoop.bind(loopQueue),
      enqueueAiCandidateGeneration: generationQueue.enqueueAiCandidateGeneration.bind(generationQueue),
      enqueueVerification: verificationQueue.enqueueVerification.bind(verificationQueue),
    },
  });
}

/** No work() registration or queue-wide retry. One atomic exact claim, one handler, one settlement. */
export async function executeExactPhaseOnce(request: ExactPhaseRequest, dependencies: ExactPhaseDependencies,
  shutdownSignal: AbortSignal, options: { runJob?: typeof dispatch } = {}): Promise<ExactPhaseReceipt> {
  if (shutdownSignal.aborted) throw new ExactPhaseJobError('exact_job_unavailable');
  const { database, boss, runtimeReleaseSha, workerHeartbeatId } = dependencies;
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  shutdownSignal.addEventListener('abort', abort, { once: true });
  if (shutdownSignal.aborted) cancellation.abort();
  let claimed;
  try {
    if (cancellation.signal.aborted) throw new ExactPhaseJobError('exact_job_unavailable');
    claimed = await claimExactPhaseJob(database, request, runtimeReleaseSha, workerHeartbeatId);
    if (cancellation.signal.aborted) throw new ExactPhaseJobError('exact_job_unavailable');
  } catch (error) {
    shutdownSignal.removeEventListener('abort', abort);
    throw error;
  }
  const queue = exactPhaseQueues[request.phase];
  let touching = false;
  const timer = setInterval(() => {
    if (touching) return;
    touching = true;
    void boss.touch(queue, claimed.id).then((value) => {
      if ((value as { affected?: number }).affected !== 1) cancellation.abort();
    }).catch(() => cancellation.abort()).finally(() => { touching = false; });
  }, 25_000);
  timer.unref();
  let settled = false;
  try {
    const job = { id: claimed.id, name: queue, data: claimed.data, signal: cancellation.signal,
      retryCount: 0, retryLimit: 0 } as RepairQueueJob;
    let result: Result;
    try {
      if (cancellation.signal.aborted) throw new ExactPhaseJobError('exact_job_unavailable');
      result = await (options.runJob ?? dispatch)(job, request, dependencies, cancellation.signal);
    }
    catch { result = { id: claimed.id, status: 'failed', output: { code: 'worker_operation_failed' } }; }
    if (result.id !== claimed.id) throw new ExactPhaseJobError('exact_job_unavailable');
    const state = await subjectState(database, request);
    const handled = result.status === 'completed' && !['created', 'queued', 'context_preparing', 'investigating', 'generating', 'verifying', 'missing'].includes(state);
    const succeeded = handled && (request.phase === 'context' ? state === 'ready'
      : request.phase === 'investigation' ? state === 'completed'
      : request.phase === 'generation' ? ['frozen', 'abstained'].includes(state)
      : request.phase === 'verification' ? state === 'completed'
      : ['running', 'verified', 'abstained', 'review_required', 'limit_reached'].includes(state));
    const settlement = handled
      ? await boss.complete(queue, claimed.id)
      : await boss.fail(queue, claimed.id, { code: 'exact_phase_one_shot_failed' });
    if ((settlement as { affected?: number }).affected !== 1) throw new ExactPhaseJobError('exact_job_unavailable');
    settled = true;
    return { kind: 'exact_phase_one_shot', phase: request.phase, repairRunId: request.repairRunId,
      jobId: request.jobId, planIdentity: request.planIdentity, releaseSha: runtimeReleaseSha,
      result: succeeded ? 'completed' : 'failed', subjectState: state };
  } catch (error) {
    if (!settled) {
      try { await boss.fail(queue, claimed.id, { code: 'exact_phase_one_shot_failed' }); }
      catch { /* Preserve the primary failure; the job cannot retry with retry_limit zero. */ }
    }
    throw error;
  } finally {
    clearInterval(timer);
    shutdownSignal.removeEventListener('abort', abort);
  }
}
