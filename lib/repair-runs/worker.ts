import { randomUUID } from 'node:crypto';

import { and, desc, eq, lte } from 'drizzle-orm';
import type { JobResult } from 'pg-boss';

import {
  account,
  repairRun,
  repairRunAttempt,
  repairRunEvent,
  repositoryBaseline,
  user,
  workspace,
} from '../../db/schema.ts';
import { recoverSandbox, type SandboxLifecycleObserver } from '../../src/sandbox-boundary.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { resolveBaselineAuthority } from '../repository-baselines/authority.ts';
import { executeSelectedRepositoryBaseline } from '../repository-baselines/flow.ts';
import type { BaselineEvidence, BaselineOutcome, GitHubBaselineGateway } from '../repository-baselines/types.ts';
import { matchesRepairRunEvidence, transitionRepairRun } from './flow.ts';
import {
  parseRepairJobPayload,
  REPAIR_JOB_MAX_ATTEMPTS,
  type RepairQueueJob,
} from './queue.ts';
import { classifyBaselineOutcome } from './state-machine.ts';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const BASELINE_OUTCOMES = new Set<BaselineOutcome>([
  'baseline_passed', 'baseline_failed', 'installation_failed', 'typecheck_failed', 'build_failed',
  'test_failed', 'timed_out', 'cancelled', 'infrastructure_failed', 'cleanup_failed',
]);
const CUSTOMER_FAILURE_OUTCOMES = new Set<BaselineOutcome>(['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed']);

type StoredRun = typeof repairRun.$inferSelect;
type StoredAttempt = typeof repairRunAttempt.$inferSelect;
type BaselineExecutor = typeof executeSelectedRepositoryBaseline;
type Recovery = typeof recoverSandbox;

export interface WorkerLogger {
  write(event: {
    event: 'job_accepted' | 'job_rejected' | 'run_claimed' | 'attempt_started' | 'baseline_classified' | 'retry_classified' | 'run_finalized' | 'cleanup_observed' | 'investigation_claimed' | 'investigation_ready' | 'investigation_retry';
    runId?: string;
    investigationId?: string;
    attemptId?: string;
    outcome?: string;
    code?: string;
  }): void;
}

export interface RepairWorkerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: GitHubBaselineGateway;
  logger: WorkerLogger;
  shutdownSignal?: AbortSignal;
  baselineExecutor?: BaselineExecutor;
  clock?: () => Date;
  randomId?: () => string;
  recover?: Recovery;
}

type Claim =
  | { kind: 'attempt'; attempt: StoredAttempt; recovered: boolean; run: StoredRun }
  | { kind: 'busy'; run: StoredRun }
  | { kind: 'reconcile'; attempt: StoredAttempt; run: StoredRun }
  | { kind: 'exhausted'; attempt: StoredAttempt | null; run: StoredRun }
  | { kind: 'terminal'; run: StoredRun };

const leaseEnd = (now: Date) => new Date(now.getTime() + LEASE_MS);

function safeFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code)) return error.code;
  return 'baseline_execution_failed';
}

function baselineOutcome(value: string): BaselineOutcome {
  if (!BASELINE_OUTCOMES.has(value as BaselineOutcome)) throw Object.assign(new Error('baseline_evidence_malformed'), { code: 'baseline_evidence_malformed' });
  return value as BaselineOutcome;
}

async function loadRun(database: VigiloDatabase, runId: string): Promise<StoredRun | null> {
  const [run] = await database.select().from(repairRun).where(eq(repairRun.id, runId)).limit(1);
  return run ?? null;
}

async function workerContext(database: VigiloDatabase, workspaceId: string): Promise<AuthenticatedWorkspace | null> {
  const [value] = await database
    .select({ owner: user, workspace, githubUserId: account.accountId })
    .from(workspace)
    .innerJoin(user, eq(user.id, workspace.ownerUserId))
    .innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, 'github')))
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  if (!value) return null;
  return {
    sessionId: 'background-worker',
    user: { id: value.owner.id, name: value.owner.name, email: value.owner.email },
    githubUserId: value.githubUserId,
    workspace: { id: value.workspace.id, ownerUserId: value.workspace.ownerUserId },
  };
}

function sameAuthority(run: StoredRun, authority: Awaited<ReturnType<typeof resolveBaselineAuthority>>): boolean {
  return authority.profile.workspaceId === run.workspaceId &&
    authority.profile.githubRepositoryId === run.githubRepositoryId &&
    authority.profile.installationId === run.installationId &&
    authority.profile.profileIdentity === run.profileIdentity &&
    authority.profile.baseCommitSha === run.baseCommitSha;
}

async function claimAttempt(
  database: VigiloDatabase,
  runId: string,
  queueJobId: string,
  now: Date,
  randomId: () => string,
): Promise<Claim> {
  return database.transaction(async (transaction) => {
    const [run] = await transaction.select().from(repairRun).where(eq(repairRun.id, runId)).limit(1);
    if (!run) throw new Error('run_not_found');
    if (!['created', 'baseline_running'].includes(run.state)) return { kind: 'terminal', run };

    const [active] = await transaction.select().from(repairRunAttempt).where(and(
      eq(repairRunAttempt.repairRunId, run.id),
      eq(repairRunAttempt.state, 'active'),
    )).limit(1);
    if (active) {
      if (!active.leaseExpiresAt || active.leaseExpiresAt.getTime() > now.getTime()) return { kind: 'busy', run };
      const ownershipToken = randomId();
      const [recovered] = await transaction.update(repairRunAttempt).set({
        ownershipToken,
        heartbeatAt: now,
        leaseExpiresAt: leaseEnd(now),
        failureClassification: 'process_loss',
        failureCode: 'stale_worker_recovery',
      }).where(and(
        eq(repairRunAttempt.id, active.id),
        eq(repairRunAttempt.ownershipToken, active.ownershipToken),
        eq(repairRunAttempt.state, 'active'),
        lte(repairRunAttempt.leaseExpiresAt, now),
      )).returning();
      return recovered ? { kind: 'attempt', attempt: recovered, recovered: true, run } : { kind: 'busy', run };
    }

    const [latest] = await transaction.select().from(repairRunAttempt)
      .where(eq(repairRunAttempt.repairRunId, run.id))
      .orderBy(desc(repairRunAttempt.attemptNumber))
      .limit(1);
    if (latest && ['succeeded', 'customer_failed', 'exhausted'].includes(latest.state)) return { kind: 'reconcile', attempt: latest, run };
    if (latest && latest.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS) return { kind: 'exhausted', attempt: latest, run };

    if (run.state === 'created') {
      const [claimedRun] = await transaction.update(repairRun).set({
        state: 'baseline_running',
        baselineStartedAt: now,
        stateChangedAt: now,
        updatedAt: now,
      }).where(and(eq(repairRun.id, run.id), eq(repairRun.state, 'created'))).returning();
      if (!claimedRun) return { kind: 'busy', run };
      await transaction.insert(repairRunEvent).values({
        id: randomId(), repairRunId: run.id, fromState: 'created', toState: 'baseline_running', createdAt: now,
      });
      Object.assign(run, claimedRun);
    }

    const ownershipToken = randomId();
    const [attempt] = await transaction.insert(repairRunAttempt).values({
      id: randomId(),
      repairRunId: run.id,
      queueJobId,
      attemptNumber: (latest?.attemptNumber ?? 0) + 1,
      expectedBaselineId: randomId(),
      ownershipToken,
      state: 'active',
      claimedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: leaseEnd(now),
    }).onConflictDoNothing().returning();
    return attempt ? { kind: 'attempt', attempt, recovered: false, run } : { kind: 'busy', run };
  });
}

async function renewAttempt(database: VigiloDatabase, attempt: StoredAttempt, now: Date): Promise<void> {
  const [updated] = await database.update(repairRunAttempt).set({ heartbeatAt: now, leaseExpiresAt: leaseEnd(now) }).where(and(
    eq(repairRunAttempt.id, attempt.id),
    eq(repairRunAttempt.ownershipToken, attempt.ownershipToken),
    eq(repairRunAttempt.state, 'active'),
  )).returning({ id: repairRunAttempt.id });
  if (!updated) throw Object.assign(new Error('attempt_ownership_lost'), { code: 'attempt_ownership_lost' });
}

async function updateSandboxFacts(database: VigiloDatabase, attempt: StoredAttempt, values: Partial<typeof repairRunAttempt.$inferInsert>, now: Date): Promise<void> {
  const [updated] = await database.update(repairRunAttempt).set({ ...values, heartbeatAt: now, leaseExpiresAt: leaseEnd(now) }).where(and(
    eq(repairRunAttempt.id, attempt.id),
    eq(repairRunAttempt.ownershipToken, attempt.ownershipToken),
    eq(repairRunAttempt.state, 'active'),
  )).returning({ id: repairRunAttempt.id });
  if (!updated) throw Object.assign(new Error('attempt_ownership_lost'), { code: 'attempt_ownership_lost' });
}

async function finishAttempt(
  database: VigiloDatabase,
  attempt: StoredAttempt,
  now: Date,
  values: {
    state: 'succeeded' | 'customer_failed' | 'retryable_failed' | 'exhausted' | 'abandoned';
    baselineId?: string | null;
    failureClassification?: 'customer_baseline_failure' | 'infrastructure_failure' | 'process_loss' | null;
    failureCode?: string | null;
    cleanup?: { stop: string; delete: string; lookup: string };
  },
): Promise<boolean> {
  const [updated] = await database.update(repairRunAttempt).set({
    state: values.state,
    baselineId: values.baselineId ?? null,
    failureClassification: values.failureClassification ?? null,
    failureCode: values.failureCode ?? null,
    cleanupStop: values.cleanup?.stop ?? null,
    cleanupDelete: values.cleanup?.delete ?? null,
    cleanupLookup: values.cleanup?.lookup ?? null,
    heartbeatAt: now,
    leaseExpiresAt: null,
    finishedAt: now,
  }).where(and(
    eq(repairRunAttempt.id, attempt.id),
    eq(repairRunAttempt.ownershipToken, attempt.ownershipToken),
    eq(repairRunAttempt.state, 'active'),
  )).returning({ id: repairRunAttempt.id });
  return Boolean(updated);
}

async function evidenceForAttempt(database: VigiloDatabase, attempt: StoredAttempt) {
  const [evidence] = await database.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, attempt.expectedBaselineId)).limit(1);
  return evidence ?? null;
}

async function finalizeFromEvidence(
  dependencies: RepairWorkerDependencies,
  run: StoredRun,
  attempt: StoredAttempt,
  evidence: typeof repositoryBaseline.$inferSelect,
): Promise<JobResult> {
  const now = (dependencies.clock ?? (() => new Date()))();
  if (!matchesRepairRunEvidence(run, evidence)) {
    const owned = await finishAttempt(dependencies.database, attempt, now, { state: 'exhausted', failureClassification: 'infrastructure_failure', failureCode: 'baseline_evidence_mismatch' });
    if (!owned) return { id: attempt.queueJobId, status: 'failed', output: { code: 'attempt_ownership_lost' } };
    await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', 'infrastructure_failed', now, { eventId: (dependencies.randomId ?? randomUUID)(), failureCode: 'baseline_evidence_mismatch' });
    dependencies.logger.write({ event: 'run_finalized', runId: run.id, attemptId: attempt.id, outcome: 'infrastructure_failed' });
    return { id: attempt.queueJobId, status: 'completed' };
  }
  const outcome = baselineOutcome(evidence.overallOutcome);
  const target = classifyBaselineOutcome(outcome);
  const cleanup = { stop: evidence.cleanupStop, delete: evidence.cleanupDelete, lookup: evidence.cleanupLookup };
  if (target === 'ready_for_investigation' || target === 'baseline_failed') {
    const customerFailure = CUSTOMER_FAILURE_OUTCOMES.has(outcome);
    const state = customerFailure ? 'customer_failed' : 'succeeded';
    const owned = await finishAttempt(dependencies.database, attempt, now, {
      state,
      baselineId: evidence.id,
      failureClassification: customerFailure ? 'customer_baseline_failure' : null,
      failureCode: customerFailure ? evidence.overallOutcome : null,
      cleanup,
    });
    if (!owned) return { id: attempt.queueJobId, status: 'failed', output: { code: 'attempt_ownership_lost' } };
    await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', target, now, { baselineId: evidence.id, eventId: (dependencies.randomId ?? randomUUID)() });
    dependencies.logger.write({ event: 'run_finalized', runId: run.id, attemptId: attempt.id, outcome: target });
    return { id: attempt.queueJobId, status: 'completed' };
  }

  const exhausted = attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS;
  const state = exhausted ? 'exhausted' : 'retryable_failed';
  const owned = await finishAttempt(dependencies.database, attempt, now, {
    state,
    baselineId: evidence.id,
    failureClassification: 'infrastructure_failure',
    failureCode: evidence.overallOutcome === 'cancelled' ? 'worker_interrupted' : evidence.overallOutcome,
    cleanup,
  });
  if (!owned) return { id: attempt.queueJobId, status: 'failed', output: { code: 'attempt_ownership_lost' } };
  if (!exhausted) {
    dependencies.logger.write({ event: 'retry_classified', runId: run.id, attemptId: attempt.id, outcome: evidence.overallOutcome });
    return { id: attempt.queueJobId, status: 'failed', output: { code: 'retryable_infrastructure_failure' } };
  }
  await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', 'infrastructure_failed', now, {
    baselineId: evidence.id,
    eventId: (dependencies.randomId ?? randomUUID)(),
    failureCode: evidence.overallOutcome === 'cancelled' ? 'worker_interrupted' : evidence.overallOutcome,
  });
  dependencies.logger.write({ event: 'run_finalized', runId: run.id, attemptId: attempt.id, outcome: 'infrastructure_failed' });
  return { id: attempt.queueJobId, status: 'completed' };
}

async function reconcileCompletedAttempt(dependencies: RepairWorkerDependencies, claim: Extract<Claim, { kind: 'reconcile' }>): Promise<JobResult> {
  if (claim.attempt.state === 'exhausted') {
    await transitionRepairRun(dependencies.database, claim.run.workspaceId, claim.run.id, 'baseline_running', 'infrastructure_failed', (dependencies.clock ?? (() => new Date()))(), {
      eventId: (dependencies.randomId ?? randomUUID)(), failureCode: claim.attempt.failureCode ?? 'retry_exhausted',
    });
    return { id: claim.attempt.queueJobId, status: 'completed' };
  }
  const evidence = claim.attempt.baselineId ? await evidenceForAttempt(dependencies.database, claim.attempt) : null;
  if (!evidence || evidence.id !== claim.attempt.baselineId) {
    await transitionRepairRun(dependencies.database, claim.run.workspaceId, claim.run.id, 'baseline_running', 'infrastructure_failed', (dependencies.clock ?? (() => new Date()))(), {
      eventId: (dependencies.randomId ?? randomUUID)(), failureCode: 'baseline_evidence_missing',
    });
    return { id: claim.attempt.queueJobId, status: 'completed' };
  }
  if (!matchesRepairRunEvidence(claim.run, evidence)) {
    await transitionRepairRun(dependencies.database, claim.run.workspaceId, claim.run.id, 'baseline_running', 'infrastructure_failed', (dependencies.clock ?? (() => new Date()))(), {
      eventId: (dependencies.randomId ?? randomUUID)(), failureCode: 'baseline_evidence_mismatch',
    });
    return { id: claim.attempt.queueJobId, status: 'completed' };
  }
  const target = classifyBaselineOutcome(baselineOutcome(evidence.overallOutcome));
  const customerFailure = CUSTOMER_FAILURE_OUTCOMES.has(baselineOutcome(evidence.overallOutcome));
  if ((claim.attempt.state === 'succeeded' && (target !== 'ready_for_investigation' || customerFailure)) ||
    (claim.attempt.state === 'customer_failed' && (target !== 'ready_for_investigation' || !customerFailure))) {
    await transitionRepairRun(dependencies.database, claim.run.workspaceId, claim.run.id, 'baseline_running', 'infrastructure_failed', (dependencies.clock ?? (() => new Date()))(), {
      eventId: (dependencies.randomId ?? randomUUID)(), failureCode: 'baseline_evidence_mismatch',
    });
    return { id: claim.attempt.queueJobId, status: 'completed' };
  }
  await transitionRepairRun(dependencies.database, claim.run.workspaceId, claim.run.id, 'baseline_running', target, (dependencies.clock ?? (() => new Date()))(), {
    baselineId: evidence.id,
    eventId: (dependencies.randomId ?? randomUUID)(),
  });
  dependencies.logger.write({ event: 'run_finalized', runId: claim.run.id, attemptId: claim.attempt.id, outcome: target });
  return { id: claim.attempt.queueJobId, status: 'completed' };
}

async function recoverStaleAttempt(dependencies: RepairWorkerDependencies, run: StoredRun, attempt: StoredAttempt): Promise<JobResult> {
  const evidence = await evidenceForAttempt(dependencies.database, attempt);
  if (evidence) return finalizeFromEvidence(dependencies, run, attempt, evidence);

  const cleanup = attempt.sandboxName
    ? await (dependencies.recover ?? recoverSandbox)({ name: attempt.sandboxName, sessionId: attempt.sandboxSessionId })
    : { stop: 'not_needed', delete: 'not_needed', lookup: 'absent', errors: [] };
  dependencies.logger.write({ event: 'cleanup_observed', runId: run.id, attemptId: attempt.id, outcome: cleanup.lookup });
  const confirmed = cleanup.lookup === 'absent' && ['confirmed', 'not_needed'].includes(cleanup.stop) && ['confirmed', 'not_needed'].includes(cleanup.delete);
  const now = (dependencies.clock ?? (() => new Date()))();
  if (!confirmed) {
    await updateSandboxFacts(dependencies.database, attempt, {
      cleanupStop: cleanup.stop,
      cleanupDelete: cleanup.delete,
      cleanupLookup: cleanup.lookup,
      failureClassification: 'process_loss',
      failureCode: 'abandoned_cleanup_unconfirmed',
    }, now);
    return { id: attempt.queueJobId, status: 'failed', output: { code: 'abandoned_cleanup_unconfirmed' } };
  }
  const owned = await finishAttempt(dependencies.database, attempt, now, {
    state: attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS ? 'exhausted' : 'abandoned',
    failureClassification: 'process_loss',
    failureCode: 'worker_process_lost',
    cleanup,
  });
  if (!owned) return { id: attempt.queueJobId, status: 'failed', output: { code: 'attempt_ownership_lost' } };
  if (attempt.attemptNumber < REPAIR_JOB_MAX_ATTEMPTS) return { id: attempt.queueJobId, status: 'failed', output: { code: 'worker_process_lost' } };
  await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', 'infrastructure_failed', now, {
    eventId: (dependencies.randomId ?? randomUUID)(), failureCode: 'worker_process_lost',
  });
  return { id: attempt.queueJobId, status: 'completed' };
}

function observerFor(dependencies: RepairWorkerDependencies, attempt: StoredAttempt): SandboxLifecycleObserver {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    requested: ({ name }) => updateSandboxFacts(dependencies.database, attempt, { sandboxName: name }, clock()),
    created: ({ name, sessionId }) => updateSandboxFacts(dependencies.database, attempt, { sandboxName: name, sandboxSessionId: sessionId }, clock()),
    cleaned: async ({ stop, delete: deleted, lookup }) => {
      await updateSandboxFacts(dependencies.database, attempt, { cleanupStop: stop, cleanupDelete: deleted, cleanupLookup: lookup }, clock());
      dependencies.logger.write({ event: 'cleanup_observed', runId: attempt.repairRunId, attemptId: attempt.id, outcome: lookup });
    },
  };
}

async function executeAttempt(dependencies: RepairWorkerDependencies, run: StoredRun, attempt: StoredAttempt, job: RepairQueueJob): Promise<JobResult> {
  const context = await workerContext(dependencies.database, run.workspaceId);
  if (!context) {
    const now = (dependencies.clock ?? (() => new Date()))();
    const owned = await finishAttempt(dependencies.database, attempt, now, { state: 'exhausted', failureClassification: 'infrastructure_failure', failureCode: 'workspace_authority_missing' });
    if (!owned) return { id: job.id, status: 'failed', output: { code: 'attempt_ownership_lost' } };
    await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', 'infrastructure_failed', now, { eventId: (dependencies.randomId ?? randomUUID)(), failureCode: 'workspace_authority_missing' });
    return { id: job.id, status: 'completed' };
  }

  try {
    const authority = await resolveBaselineAuthority(dependencies.database, context);
    if (!sameAuthority(run, authority)) throw Object.assign(new Error('authority_changed'), { code: 'authority_changed' });
  } catch (error) {
    const now = (dependencies.clock ?? (() => new Date()))();
    const code = safeFailureCode(error);
    const owned = await finishAttempt(dependencies.database, attempt, now, { state: 'exhausted', failureClassification: 'infrastructure_failure', failureCode: code });
    if (!owned) return { id: job.id, status: 'failed', output: { code: 'attempt_ownership_lost' } };
    await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', 'infrastructure_failed', now, { eventId: (dependencies.randomId ?? randomUUID)(), failureCode: code });
    return { id: job.id, status: 'completed' };
  }

  dependencies.logger.write({ event: 'attempt_started', runId: run.id, attemptId: attempt.id });
  const controller = new AbortController();
  const abort = () => controller.abort();
  job.signal.addEventListener('abort', abort, { once: true });
  dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  if (job.signal.aborted || dependencies.shutdownSignal?.aborted) controller.abort();
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    renewAttempt(dependencies.database, attempt, (dependencies.clock ?? (() => new Date()))())
      .catch(() => controller.abort())
      .finally(() => { heartbeatRunning = false; });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const evidence: BaselineEvidence = await (dependencies.baselineExecutor ?? executeSelectedRepositoryBaseline)(
      dependencies.database,
      context,
      dependencies.gateway,
      dependencies.configuration,
      {
        cancellation: controller.signal,
        evidenceId: attempt.expectedBaselineId,
        expectedAuthority: {
          workspaceId: run.workspaceId,
          githubRepositoryId: run.githubRepositoryId,
          installationId: run.installationId,
          profileIdentity: run.profileIdentity,
          baseCommitSha: run.baseCommitSha,
        },
        authorizePersistence: () => renewAttempt(dependencies.database, attempt, (dependencies.clock ?? (() => new Date()))()),
        sandboxObserver: observerFor(dependencies, attempt),
      },
    );
    dependencies.logger.write({ event: 'baseline_classified', runId: run.id, attemptId: attempt.id, outcome: evidence.overallOutcome });
    const persisted = await evidenceForAttempt(dependencies.database, attempt);
    if (!persisted) throw Object.assign(new Error('baseline_evidence_missing'), { code: 'baseline_evidence_missing' });
    return finalizeFromEvidence(dependencies, run, attempt, persisted);
  } catch (error) {
    const now = (dependencies.clock ?? (() => new Date()))();
    const code = controller.signal.aborted ? 'worker_interrupted' : safeFailureCode(error);
    const exhausted = attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS || code === 'attempt_ownership_lost';
    const owned = await finishAttempt(dependencies.database, attempt, now, {
      state: exhausted ? 'exhausted' : 'retryable_failed',
      failureClassification: 'infrastructure_failure',
      failureCode: code,
    });
    if (!owned) return { id: job.id, status: 'failed', output: { code: 'attempt_ownership_lost' } };
    if (!exhausted) {
      dependencies.logger.write({ event: 'retry_classified', runId: run.id, attemptId: attempt.id, code });
      return { id: job.id, status: 'failed', output: { code } };
    }
    await transitionRepairRun(dependencies.database, run.workspaceId, run.id, 'baseline_running', 'infrastructure_failed', now, {
      eventId: (dependencies.randomId ?? randomUUID)(), failureCode: code,
    });
    dependencies.logger.write({ event: 'run_finalized', runId: run.id, attemptId: attempt.id, outcome: 'infrastructure_failed' });
    return { id: job.id, status: 'completed' };
  } finally {
    clearInterval(heartbeat);
    job.signal.removeEventListener('abort', abort);
    dependencies.shutdownSignal?.removeEventListener('abort', abort);
  }
}

export async function processRepairJob(job: RepairQueueJob, dependencies: RepairWorkerDependencies): Promise<JobResult> {
  let payload;
  try {
    payload = parseRepairJobPayload(job.data);
    if (job.id !== payload.repairRunId) throw new Error('invalid_job_identity');
  } catch {
    dependencies.logger.write({ event: 'job_rejected', code: 'invalid_job_payload' });
    return { id: job.id, status: 'deadletter', output: { code: 'invalid_job_payload' } };
  }
  dependencies.logger.write({ event: 'job_accepted', runId: payload.repairRunId });
  const existing = await loadRun(dependencies.database, payload.repairRunId);
  if (!existing) {
    dependencies.logger.write({ event: 'job_rejected', runId: payload.repairRunId, code: 'run_not_found' });
    return { id: job.id, status: 'deadletter', output: { code: 'run_not_found' } };
  }
  const claim = await claimAttempt(dependencies.database, existing.id, job.id, (dependencies.clock ?? (() => new Date()))(), dependencies.randomId ?? randomUUID);
  if (claim.kind === 'terminal') return { id: job.id, status: 'completed' };
  if (claim.kind === 'busy') return { id: job.id, status: 'failed', output: { code: 'active_attempt' } };
  if (claim.kind === 'exhausted') {
    await transitionRepairRun(dependencies.database, claim.run.workspaceId, claim.run.id, 'baseline_running', 'infrastructure_failed', (dependencies.clock ?? (() => new Date()))(), {
      eventId: (dependencies.randomId ?? randomUUID)(), failureCode: claim.attempt?.failureCode ?? 'retry_exhausted',
    });
    return { id: job.id, status: 'completed' };
  }
  if (claim.kind === 'reconcile') return reconcileCompletedAttempt(dependencies, claim);
  dependencies.logger.write({ event: 'run_claimed', runId: claim.run.id, attemptId: claim.attempt.id });
  if (claim.recovered) return recoverStaleAttempt(dependencies, claim.run, claim.attempt);
  return executeAttempt(dependencies, claim.run, claim.attempt, job);
}

export function createConsoleWorkerLogger(stream: Pick<NodeJS.WriteStream, 'write'> = process.stdout): WorkerLogger {
  return { write: (event) => { stream.write(`${JSON.stringify(event)}\n`); } };
}
