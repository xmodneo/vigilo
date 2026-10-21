import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readDatabaseEnvironment } from '../lib/auth/environment.ts';
import { GitHubApiClient } from '../lib/github-app/client.ts';
import { readGitHubAppPrivateKey, readGitHubWorkerEnvironment } from '../lib/github-app/environment.ts';
import {
  createRepairBoss,
  RepairBossInitializationError,
  AI_CANDIDATE_GENERATION_QUEUE,
  AI_INVESTIGATION_QUEUE,
  CANDIDATE_VERIFICATION_QUEUE,
  INVESTIGATION_CONTEXT_QUEUE,
  REPAIR_PUBLICATION_QUEUE,
  REPAIR_LOOP_QUEUE,
  REPAIR_BASELINE_QUEUE,
  REPAIR_WORK_OPTIONS,
  PgBossAiCandidateGenerationQueue,
  PgBossCandidateVerificationQueue,
  PgBossRepairLoopQueue,
} from '../lib/repair-runs/queue.ts';
import { createConsoleWorkerLogger, processRepairJob } from '../lib/repair-runs/worker.ts';
import { repairRun, repairRunSourceCheckpoint } from '../db/schema.ts';
import { investigation } from '../db/schema.ts';
import { candidateVerification } from '../db/schema.ts';
import { inArray } from 'drizzle-orm';
import { processInvestigationJob } from '../lib/investigations/worker.ts';
import { processCandidateVerificationJob } from '../lib/candidate-verifications/worker.ts';
import { aiInvestigation } from '../db/schema.ts';
import { GeminiInvestigationProvider, readGeminiProviderConfiguration } from '../lib/ai-investigations/gemini-provider.ts';
import { processAiInvestigationJob } from '../lib/ai-investigations/worker.ts';
import { aiCandidateGeneration } from '../db/schema.ts';
import { processAiCandidateGenerationJob } from '../lib/ai-candidate-generations/worker.ts';
import { repairLoop } from '../db/schema.ts';
import { processRepairLoopJob } from '../lib/repair-loops/worker.ts';
import { repairPublication } from '../db/schema.ts';
import { processRepairPublicationJob } from '../lib/repair-publications/worker.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { randomUUID } from 'node:crypto';
import { readRuntimeRelease } from '../lib/operations/release.ts';
import { PostgresWorkerHeartbeatStore, WorkerHeartbeatLifecycle } from '../lib/operations/worker-heartbeat.ts';
import { createCanonicalRepairSupervisor, QueueSupervisionShutdownError } from '../lib/operations/queue-supervision.ts';
import { GeneralWorkerShutdownError, stopGeneralWorker } from '../lib/operations/general-worker-shutdown.ts';
import { installWorkerShutdownSignals } from '../lib/operations/worker-startup.ts';
import { isReviewedStagingPlanIdentity } from '../lib/external-execution/reviewed-plan.ts';

async function main(): Promise<void> {
  const environment = readDatabaseEnvironment();
  const configuration = readGitHubWorkerEnvironment();
  const releaseSha = readRuntimeRelease();
  const client = postgres(environment.databaseUrl, { max: 2, prepare: false });
  const heartbeatClient = postgres(environment.databaseUrl, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5, connection: { statement_timeout: 5_000, lock_timeout: 2_000 } });
  const database = drizzle(client, { schema });
  const executionAuthority = new DurableExternalExecutionAuthorizer(database, { runtimeReleaseSha: releaseSha });
  const logger = createConsoleWorkerLogger();
  const shutdown = new AbortController();
  const heartbeat = new WorkerHeartbeatLifecycle(new PostgresWorkerHeartbeatStore(heartbeatClient), {
    id: randomUUID(),
    releaseSha,
  });
  let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;
  let supervision: Awaited<ReturnType<typeof createCanonicalRepairSupervisor>> | undefined;
  const workerIds: Array<{ id: string; queue: string }> = [];
  let heartbeatStarted = false;
  const shutdownSignals = installWorkerShutdownSignals(shutdown);

  try {
    await heartbeat.start();
    heartbeatStarted = true;
    if (shutdown.signal.aborted) return;
    boss = await createRepairBoss(environment.databaseUrl, 'worker');
    if (shutdown.signal.aborted) return;
    const gateway = new GitHubApiClient(configuration, await readGitHubAppPrivateKey(configuration.privateKeyPath));
    if (shutdown.signal.aborted) return;
    boss.on('error', () => logger.write({ event: 'retry_classified', code: 'queue_operation_failed' }));

    const active = await database.select({ id: repairRun.id }).from(repairRun).where(inArray(repairRun.state, ['created', 'baseline_running']));
    const reviewed = active.length === 0 ? [] : await database.select({ repairRunId: repairRunSourceCheckpoint.repairRunId,
      planIdentity: repairRunSourceCheckpoint.planIdentity }).from(repairRunSourceCheckpoint)
      .where(inArray(repairRunSourceCheckpoint.repairRunId, active.map((run) => run.id)));
    const reviewedIds = new Set(reviewed.filter((checkpoint) => isReviewedStagingPlanIdentity(checkpoint.planIdentity))
      .map((checkpoint) => checkpoint.repairRunId));
    for (const run of active) {
      if (shutdown.signal.aborted) return;
      if (reviewedIds.has(run.id)) continue;
      try { await boss.retry(REPAIR_BASELINE_QUEUE, run.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }
    const activeInvestigations = await database.select({ id: investigation.id }).from(investigation).where(inArray(investigation.state, ['created', 'context_preparing']));
    for (const value of activeInvestigations) {
      if (shutdown.signal.aborted) return;
      try { await boss.retry(INVESTIGATION_CONTEXT_QUEUE, value.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }
    const activeVerifications = await database.select({ id: candidateVerification.id }).from(candidateVerification).where(inArray(candidateVerification.state, ['created', 'queued', 'verifying']));
    for (const value of activeVerifications) {
      if (shutdown.signal.aborted) return;
      try { await boss.retry(CANDIDATE_VERIFICATION_QUEUE, value.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }
    const activeAiInvestigations = await database.select({ id: aiInvestigation.id }).from(aiInvestigation).where(inArray(aiInvestigation.state, ['created', 'queued', 'investigating']));
    for (const value of activeAiInvestigations) {
      if (shutdown.signal.aborted) return;
      try { await boss.retry(AI_INVESTIGATION_QUEUE, value.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }
    const activeAiCandidateGenerations = await database.select({ id: aiCandidateGeneration.id }).from(aiCandidateGeneration).where(inArray(aiCandidateGeneration.state, ['created', 'queued', 'generating']));
    for (const value of activeAiCandidateGenerations) {
      if (shutdown.signal.aborted) return;
      try { await boss.retry(AI_CANDIDATE_GENERATION_QUEUE, value.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }
    const activeRepairLoops = await database.select({ wakeJobId: repairLoop.wakeJobId }).from(repairLoop).where(inArray(repairLoop.state, ['queued', 'running']));
    for (const value of activeRepairLoops) {
      if (shutdown.signal.aborted) return;
      if (!value.wakeJobId) continue;
      try { await boss.retry(REPAIR_LOOP_QUEUE, value.wakeJobId); }
      catch { /* A non-failed fenced wake remains owned by pg-boss. */ }
    }
    const activePublications = await database.select({ id: repairPublication.id }).from(repairPublication).where(inArray(repairPublication.state, ['queued', 'preparing', 'publishing']));
    for (const value of activePublications) {
      if (shutdown.signal.aborted) return;
      try { await boss.retry(REPAIR_PUBLICATION_QUEUE, value.id); }
      catch { /* A non-failed canonical publication job remains owned by pg-boss. */ }
    }

    if (shutdown.signal.aborted) return;
    const workOptions = { ...REPAIR_WORK_OPTIONS, perJobResults: true as const };
    const repairWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(REPAIR_BASELINE_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0];
      if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try {
        return [await processRepairJob(job, { configuration, database, gateway, logger, shutdownSignal: shutdown.signal, executionAuthority, runtimeReleaseSha: releaseSha })];
      } catch {
        return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_operation_failed' } }];
      }
    });
    workerIds.push({ id: repairWorkerId, queue: REPAIR_BASELINE_QUEUE });
    if (shutdown.signal.aborted) return;
    const investigationWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(INVESTIGATION_CONTEXT_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0];
      if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try {
        return [await processInvestigationJob(job, { configuration, database, gateway, logger, shutdownSignal: shutdown.signal })];
      } catch {
        return [{ id: job.id, status: 'failed' as const, output: { code: 'investigation_worker_failed' } }];
      }
    });
    workerIds.push({ id: investigationWorkerId, queue: INVESTIGATION_CONTEXT_QUEUE });
    if (shutdown.signal.aborted) return;
    const verificationWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(CANDIDATE_VERIFICATION_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0];
      if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try {
        return [await processCandidateVerificationJob(job, { configuration, database, gateway, logger, shutdownSignal: shutdown.signal, executionAuthority })];
      } catch {
        return [{ id: job.id, status: 'failed' as const, output: { code: 'candidate_verification_worker_failed' } }];
      }
    });
    workerIds.push({ id: verificationWorkerId, queue: CANDIDATE_VERIFICATION_QUEUE });
    if (shutdown.signal.aborted) return;
    const aiWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(AI_INVESTIGATION_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0]; if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try { return [await processAiInvestigationJob(job, { configuration, database, gateway, shutdownSignal: shutdown.signal, createProvider: () => { const provider = readGeminiProviderConfiguration(); return new GeminiInvestigationProvider(provider.apiKey, undefined, undefined, executionAuthority, provider.accountIdentity); } })]; }
      catch { return [{ id: job.id, status: 'failed' as const, output: { code: 'ai_investigation_worker_failed' } }]; }
    });
    workerIds.push({ id: aiWorkerId, queue: AI_INVESTIGATION_QUEUE });
    if (shutdown.signal.aborted) return;
    const aiCandidateGenerationWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(AI_CANDIDATE_GENERATION_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0]; if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try { return [await processAiCandidateGenerationJob(job, { configuration, database, gateway, shutdownSignal: shutdown.signal, createProvider: () => { const provider = readGeminiProviderConfiguration(); return new GeminiInvestigationProvider(provider.apiKey, undefined, undefined, executionAuthority, provider.accountIdentity); } })]; }
      catch { return [{ id: job.id, status: 'failed' as const, output: { code: 'ai_candidate_generation_worker_failed' } }]; }
    });
    workerIds.push({ id: aiCandidateGenerationWorkerId, queue: AI_CANDIDATE_GENERATION_QUEUE });
    if (shutdown.signal.aborted) return;
    const loopQueue = new PgBossRepairLoopQueue(boss);
    const generationQueue = new PgBossAiCandidateGenerationQueue(boss);
    const verificationQueue = new PgBossCandidateVerificationQueue(boss);
    const repairLoopWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(REPAIR_LOOP_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0]; if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try {
        return [await processRepairLoopJob(job, { database, executionAuthority, runtimeReleaseSha: releaseSha, queues: {
          enqueueRepairLoop: loopQueue.enqueueRepairLoop.bind(loopQueue),
          enqueueAiCandidateGeneration: generationQueue.enqueueAiCandidateGeneration.bind(generationQueue),
          enqueueVerification: verificationQueue.enqueueVerification.bind(verificationQueue),
        } })];
      } catch { return [{ id: job.id, status: 'failed' as const, output: { code: 'repair_loop_worker_failed' } }]; }
    });
    workerIds.push({ id: repairLoopWorkerId, queue: REPAIR_LOOP_QUEUE });
    if (shutdown.signal.aborted) return;
    const repairPublicationWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(REPAIR_PUBLICATION_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0]; if (!job) return [];
      if (shutdown.signal.aborted) return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_stopping' } }];
      try { return [await processRepairPublicationJob(job, { configuration, database, gateway, logger, shutdownSignal: shutdown.signal, executionAuthority })]; }
      catch { return [{ id: job.id, status: 'failed' as const, output: { code: 'repair_publication_worker_failed' } }]; }
    });
    workerIds.push({ id: repairPublicationWorkerId, queue: REPAIR_PUBLICATION_QUEUE });
    if (shutdown.signal.aborted) return;

    supervision = await createCanonicalRepairSupervisor(environment.databaseUrl,
      () => logger.write({ event: 'retry_classified', code: 'queue_supervision_failed' }));
    if (shutdown.signal.aborted) return;
    await heartbeat.ready();
    if (shutdown.signal.aborted) return;
    heartbeat.begin();
    await shutdownSignals.requested;
  } finally {
    shutdown.abort();
    shutdownSignals.dispose();
    await stopGeneralWorker({
      heartbeat: heartbeatStarted ? heartbeat : undefined,
      supervisor: supervision,
      boss,
      workers: workerIds,
      failureCode: shutdownSignals.isGraceful() ? undefined : 'worker_runtime_failed',
      closeClients: async () => { await client.end({ timeout: 2 }); },
      closeHeartbeatClient: async () => { await heartbeatClient.end({ timeout: 2 }); },
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof QueueSupervisionShutdownError || error instanceof GeneralWorkerShutdownError
    ? 'Vigilo worker shutdown unresolved; exiting fail-closed.\n'
    : 'Vigilo worker stopped after a safe startup or runtime failure.\n');
  process.exitCode = 1;
  // The helper already attempted its one bounded stop; an unsuccessful stop
  // may leave dependency-owned handles alive in this local worker process.
  if ((error instanceof RepairBossInitializationError && error.cleanupFailed)
    || error instanceof QueueSupervisionShutdownError || error instanceof GeneralWorkerShutdownError) process.exit(1);
});
