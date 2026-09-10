import { randomUUID } from 'node:crypto';

import { and, desc, eq, lte } from 'drizzle-orm';
import type { JobResult } from 'pg-boss';

import {
  candidateVerification,
  candidateVerificationAttempt,
  candidateVerificationEvidence,
  candidateVerificationEvent,
} from '../../db/schema.ts';
import { recoverSandbox, type SandboxLifecycleObserver } from '../../src/sandbox-boundary.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { WorkerLogger } from '../repair-runs/worker.ts';
import {
  parseCandidateVerificationJobPayload,
  REPAIR_JOB_MAX_ATTEMPTS,
  type RepairQueueJob,
} from '../repair-runs/queue.ts';
import { CandidateVerificationPreparationError, executeCandidateVerification } from './execution.ts';
import type { CandidateVerificationEvidence as VerificationEvidence, CandidateVerificationGateway } from './types.ts';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
type VerificationRow = typeof candidateVerification.$inferSelect;
type AttemptRow = typeof candidateVerificationAttempt.$inferSelect;
type VerificationExecutor = typeof executeCandidateVerification;

export interface CandidateVerificationWorkerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: CandidateVerificationGateway;
  logger: WorkerLogger;
  shutdownSignal?: AbortSignal;
  executor?: VerificationExecutor;
  clock?: () => Date;
  randomId?: () => string;
  recover?: typeof recoverSandbox;
  afterEvidencePersisted?: () => Promise<void>;
}

type Claim =
  | { kind: 'attempt'; verification: VerificationRow; attempt: AttemptRow; recovered: boolean }
  | { kind: 'reconcile'; verification: VerificationRow; attempt: AttemptRow }
  | { kind: 'busy'; verification: VerificationRow }
  | { kind: 'terminal'; verification: VerificationRow }
  | { kind: 'exhausted'; verification: VerificationRow; attempt: AttemptRow | null };

const leaseEnd = (now: Date) => new Date(now.getTime() + LEASE_MS);

function safeCode(error: unknown, aborted = false): string {
  if (aborted) return 'worker_interrupted';
  if (error instanceof CandidateVerificationPreparationError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code)) return error.code;
  return 'verification_execution_failed';
}

async function claimAttempt(database: VigiloDatabase, verificationId: string, queueJobId: string, now: Date, randomId: () => string): Promise<Claim> {
  return database.transaction(async (transaction) => {
    const [verification] = await transaction.select().from(candidateVerification).where(eq(candidateVerification.id, verificationId)).limit(1);
    if (!verification) throw new Error('verification_not_found');
    if (['completed', 'infrastructure_failed', 'cancelled'].includes(verification.state)) return { kind: 'terminal', verification };
    const [active] = await transaction.select().from(candidateVerificationAttempt).where(and(
      eq(candidateVerificationAttempt.verificationId, verification.id), eq(candidateVerificationAttempt.state, 'active'),
    )).limit(1);
    if (active) {
      if (!active.leaseExpiresAt || active.leaseExpiresAt.getTime() > now.getTime()) return { kind: 'busy', verification };
      const [existingEvidence] = await transaction.select().from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, active.expectedEvidenceId)).limit(1);
      const ownershipToken = randomId();
      const [recovered] = await transaction.update(candidateVerificationAttempt).set({ ownershipToken, heartbeatAt: now, leaseExpiresAt: leaseEnd(now), failureCode: 'stale_worker_recovery' }).where(and(
        eq(candidateVerificationAttempt.id, active.id), eq(candidateVerificationAttempt.ownershipToken, active.ownershipToken),
        eq(candidateVerificationAttempt.state, 'active'), lte(candidateVerificationAttempt.leaseExpiresAt, now),
      )).returning();
      if (!recovered) return { kind: 'busy', verification };
      return existingEvidence ? { kind: 'reconcile', verification, attempt: recovered } : { kind: 'attempt', verification, attempt: recovered, recovered: true };
    }
    const [latest] = await transaction.select().from(candidateVerificationAttempt).where(eq(candidateVerificationAttempt.verificationId, verification.id)).orderBy(desc(candidateVerificationAttempt.attemptNumber)).limit(1);
    if (latest && ['succeeded', 'checks_failed', 'exhausted'].includes(latest.state) && latest.evidenceId) return { kind: 'reconcile', verification, attempt: latest };
    if (latest && latest.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS) return { kind: 'exhausted', verification, attempt: latest };
    if (verification.state === 'queued') {
      const [owned] = await transaction.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: now, updatedAt: now }).where(and(eq(candidateVerification.id, verification.id), eq(candidateVerification.state, 'queued'))).returning();
      if (!owned) return { kind: 'busy', verification };
      await transaction.insert(candidateVerificationEvent).values({ id: randomId(), verificationId: verification.id, workspaceId: verification.workspaceId, fromState: 'queued', toState: 'verifying', createdAt: now });
      Object.assign(verification, owned);
    }
    const [attempt] = await transaction.insert(candidateVerificationAttempt).values({
      id: randomId(), verificationId: verification.id, queueJobId, attemptNumber: (latest?.attemptNumber ?? 0) + 1,
      expectedEvidenceId: randomId(), ownershipToken: randomId(), state: 'active', claimedAt: now,
      heartbeatAt: now, leaseExpiresAt: leaseEnd(now),
    }).onConflictDoNothing().returning();
    return attempt ? { kind: 'attempt', verification, attempt, recovered: false } : { kind: 'busy', verification };
  });
}

async function renew(database: VigiloDatabase, attempt: AttemptRow, now: Date): Promise<void> {
  const [updated] = await database.update(candidateVerificationAttempt).set({ heartbeatAt: now, leaseExpiresAt: leaseEnd(now) }).where(and(
    eq(candidateVerificationAttempt.id, attempt.id), eq(candidateVerificationAttempt.ownershipToken, attempt.ownershipToken), eq(candidateVerificationAttempt.state, 'active'),
  )).returning({ id: candidateVerificationAttempt.id });
  if (!updated) throw Object.assign(new Error('verification_ownership_lost'), { code: 'verification_ownership_lost' });
}

async function updateSandbox(database: VigiloDatabase, attempt: AttemptRow, values: Partial<typeof candidateVerificationAttempt.$inferInsert>, now: Date): Promise<void> {
  const [updated] = await database.update(candidateVerificationAttempt).set({ ...values, heartbeatAt: now, leaseExpiresAt: leaseEnd(now) }).where(and(
    eq(candidateVerificationAttempt.id, attempt.id), eq(candidateVerificationAttempt.ownershipToken, attempt.ownershipToken), eq(candidateVerificationAttempt.state, 'active'),
  )).returning({ id: candidateVerificationAttempt.id });
  if (!updated) throw Object.assign(new Error('verification_ownership_lost'), { code: 'verification_ownership_lost' });
}

async function finishAttempt(database: VigiloDatabase, attempt: AttemptRow, now: Date, values: {
  state: 'succeeded' | 'checks_failed' | 'retryable_failed' | 'exhausted' | 'abandoned'; evidenceId?: string | null;
  failureCode?: string | null; cleanup?: { stop: string; delete: string; lookup: string };
}): Promise<boolean> {
  const [updated] = await database.update(candidateVerificationAttempt).set({
    state: values.state, evidenceId: values.evidenceId ?? null, failureCode: values.failureCode ?? null,
    cleanupStop: values.cleanup?.stop ?? null, cleanupDelete: values.cleanup?.delete ?? null, cleanupLookup: values.cleanup?.lookup ?? null,
    heartbeatAt: now, leaseExpiresAt: null, finishedAt: now,
  }).where(and(eq(candidateVerificationAttempt.id, attempt.id), eq(candidateVerificationAttempt.ownershipToken, attempt.ownershipToken), eq(candidateVerificationAttempt.state, 'active'))).returning({ id: candidateVerificationAttempt.id });
  return Boolean(updated);
}

function evidenceValues(report: VerificationEvidence): typeof candidateVerificationEvidence.$inferInsert {
  const command = (value: VerificationEvidence['install'] | null) => value ? { status: value.status, exitCode: value.exitCode, timedOut: value.timedOut } : null;
  const install = command(report.install)!; const typecheck = command(report.typecheck); const build = command(report.build); const test = command(report.test)!;
  return {
    id: report.evidenceId, verificationId: report.verificationId, attemptId: report.attemptId, evidenceVersion: report.evidenceVersion,
    candidateId: report.candidateId, candidateIdentity: report.candidateIdentity, workspaceId: report.workspaceId,
    githubRepositoryId: report.githubRepositoryId, installationId: report.installationId, baseCommitSha: report.baseCommitSha,
    profileIdentity: report.profileIdentity, baselineId: report.baselineId, candidateArtifactIntegrity: report.candidateArtifactIntegrity,
    sandboxName: report.sandbox.name, sandboxSessionId: report.sandbox.sessionId, distinctSandboxConfirmed: report.distinctSandboxConfirmed,
    pristineSourceIdentity: report.pristineSourceIdentity, pristineBaseIntegrity: report.pristineBaseIntegrity,
    reconstructedSourceIdentity: report.reconstructedSourceIdentity, candidateReconstruction: report.candidateReconstruction,
    credentialsExposure: report.credentialsExposure, networkPolicy: report.networkPolicyBeforeRepositoryExecution,
    installStatus: install.status, installExitCode: install.exitCode, installTimedOut: install.timedOut,
    typecheckStatus: typecheck?.status ?? null, typecheckExitCode: typecheck?.exitCode ?? null, typecheckTimedOut: typecheck?.timedOut ?? null,
    buildStatus: build?.status ?? null, buildExitCode: build?.exitCode ?? null, buildTimedOut: build?.timedOut ?? null,
    testStatus: test.status, testExitCode: test.exitCode, testTimedOut: test.timedOut,
    sourceIdentityAfter: report.sourceIdentityAfterExecution, sourceIntegrityUnchanged: report.sourceIntegrityUnchanged,
    cleanupStop: report.cleanup.stop, cleanupDelete: report.cleanup.delete, cleanupLookup: report.cleanup.lookup,
    executionOutcome: report.executionOutcome, verificationContract: report.verificationContract,
    baselineComparison: report.baselineComparison, repairObjectiveEvidence: report.repairObjectiveEvidence,
    errorPhase: report.error?.phase ?? null, errorCode: report.error?.code ?? null,
    startedAt: report.startedAt, completedAt: report.completedAt, durationMs: report.durationMs,
  };
}

function evidenceMatches(verification: VerificationRow, attempt: AttemptRow, evidence: typeof candidateVerificationEvidence.$inferSelect): boolean {
  return evidence.id === attempt.expectedEvidenceId && evidence.attemptId === attempt.id && evidence.verificationId === verification.id &&
    evidence.candidateId === verification.candidateId && evidence.candidateIdentity === verification.candidateIdentity &&
    evidence.workspaceId === verification.workspaceId && evidence.githubRepositoryId === verification.githubRepositoryId &&
    evidence.installationId === verification.installationId && evidence.baseCommitSha === verification.baseCommitSha &&
    evidence.profileIdentity === verification.profileIdentity && evidence.baselineId === verification.baselineId &&
    evidence.repairObjectiveEvidence === 'not_measured';
}

async function persistEvidence(database: VigiloDatabase, attempt: AttemptRow, report: VerificationEvidence): Promise<void> {
  await database.transaction(async (transaction) => {
    const [owned] = await transaction.select().from(candidateVerificationAttempt).where(and(
      eq(candidateVerificationAttempt.id, attempt.id), eq(candidateVerificationAttempt.ownershipToken, attempt.ownershipToken), eq(candidateVerificationAttempt.state, 'active'),
    )).for('update').limit(1);
    if (!owned || report.evidenceId !== attempt.expectedEvidenceId || report.attemptId !== attempt.id) throw Object.assign(new Error('verification_ownership_lost'), { code: 'verification_ownership_lost' });
    await transaction.insert(candidateVerificationEvidence).values(evidenceValues(report));
  });
}

async function finalizeFromEvidence(dependencies: CandidateVerificationWorkerDependencies, verification: VerificationRow, attempt: AttemptRow, evidence: typeof candidateVerificationEvidence.$inferSelect): Promise<JobResult> {
  const now = (dependencies.clock ?? (() => new Date()))();
  if (!evidenceMatches(verification, attempt, evidence)) {
    if (attempt.state === 'active') await finishAttempt(dependencies.database, attempt, now, { state: 'exhausted', failureCode: 'verification_evidence_mismatch' });
    await finalizeInfrastructure(dependencies, verification, evidence.id, 'verification_evidence_mismatch', now, evidence.candidateArtifactIntegrity === 'invalid' ? 'invalid' : 'valid');
    return { id: attempt.queueJobId, status: 'completed' };
  }
  if (evidence.verificationContract === 'checks_passed' || evidence.verificationContract === 'checks_failed') {
    if (attempt.state === 'active') {
      const owned = await finishAttempt(dependencies.database, attempt, now, { state: evidence.verificationContract === 'checks_passed' ? 'succeeded' : 'checks_failed', evidenceId: evidence.id, cleanup: { stop: evidence.cleanupStop, delete: evidence.cleanupDelete, lookup: evidence.cleanupLookup } });
      if (!owned) return { id: attempt.queueJobId, status: 'failed', output: { code: 'verification_ownership_lost' } };
    }
    const [updated] = await dependencies.database.update(candidateVerification).set({
      state: 'completed', candidateArtifactIntegrity: 'valid', verificationContract: evidence.verificationContract,
      baselineComparison: evidence.baselineComparison, evidenceId: evidence.id, completedAt: now, updatedAt: now,
    }).where(and(eq(candidateVerification.id, verification.id), eq(candidateVerification.state, 'verifying'))).returning();
    if (updated) await dependencies.database.insert(candidateVerificationEvent).values({ id: (dependencies.randomId ?? randomUUID)(), verificationId: verification.id, workspaceId: verification.workspaceId, fromState: 'verifying', toState: 'completed', verificationContract: evidence.verificationContract, baselineComparison: evidence.baselineComparison, createdAt: now });
    dependencies.logger.write({ event: 'verification_finalized', verificationId: verification.id, outcome: evidence.verificationContract });
    return { id: attempt.queueJobId, status: 'completed' };
  }
  if (attempt.state !== 'active') {
    await finalizeInfrastructure(dependencies, verification, evidence.id, evidence.errorCode ?? evidence.executionOutcome, now, evidence.candidateArtifactIntegrity === 'invalid' ? 'invalid' : 'valid');
    return { id: attempt.queueJobId, status: 'completed' };
  }
  const exhausted = attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS;
  const owned = await finishAttempt(dependencies.database, attempt, now, { state: exhausted ? 'exhausted' : 'retryable_failed', evidenceId: evidence.id, failureCode: evidence.errorCode ?? evidence.executionOutcome, cleanup: { stop: evidence.cleanupStop, delete: evidence.cleanupDelete, lookup: evidence.cleanupLookup } });
  if (!owned) return { id: attempt.queueJobId, status: 'failed', output: { code: 'verification_ownership_lost' } };
  if (exhausted) {
    await finalizeInfrastructure(dependencies, verification, evidence.id, evidence.errorCode ?? evidence.executionOutcome, now, evidence.candidateArtifactIntegrity === 'invalid' ? 'invalid' : 'valid');
    return { id: attempt.queueJobId, status: 'completed' };
  }
  return { id: attempt.queueJobId, status: 'failed', output: { code: evidence.errorCode ?? evidence.executionOutcome } };
}

async function finalizeInfrastructure(dependencies: CandidateVerificationWorkerDependencies, verification: VerificationRow, evidenceId: string | null, code: string, now: Date, artifactIntegrity: 'valid' | 'invalid' | null = null): Promise<void> {
  const [updated] = await dependencies.database.update(candidateVerification).set({
    state: 'infrastructure_failed', candidateArtifactIntegrity: artifactIntegrity, verificationContract: 'infrastructure_failed',
    baselineComparison: 'not_comparable', evidenceId, failureCode: /^[a-z_]{1,64}$/.test(code) ? code : 'verification_execution_failed',
    completedAt: now, updatedAt: now,
  }).where(and(eq(candidateVerification.id, verification.id), eq(candidateVerification.state, 'verifying'))).returning();
  if (updated) await dependencies.database.insert(candidateVerificationEvent).values({ id: (dependencies.randomId ?? randomUUID)(), verificationId: verification.id, workspaceId: verification.workspaceId, fromState: 'verifying', toState: 'infrastructure_failed', verificationContract: 'infrastructure_failed', baselineComparison: 'not_comparable', failureCode: updated.failureCode, createdAt: now });
}

export async function processCandidateVerificationJob(job: RepairQueueJob, dependencies: CandidateVerificationWorkerDependencies): Promise<JobResult> {
  let payload;
  try { payload = parseCandidateVerificationJobPayload(job.data); }
  catch { return { id: job.id, status: 'deadletter', output: { code: 'invalid_candidate_verification_job_payload' } }; }
  const now = (dependencies.clock ?? (() => new Date()))();
  let claim: Claim;
  try { claim = await claimAttempt(dependencies.database, payload.verificationId, job.id, now, dependencies.randomId ?? randomUUID); }
  catch { return { id: job.id, status: 'deadletter', output: { code: 'verification_not_found' } }; }
  if (claim.kind === 'terminal') return { id: job.id, status: 'completed' };
  if (claim.kind === 'busy') return { id: job.id, status: 'failed', output: { code: 'active_verification_attempt' } };
  if (claim.kind === 'exhausted') {
    await finalizeInfrastructure(dependencies, claim.verification, claim.attempt?.evidenceId ?? null, 'verification_retry_exhausted', now);
    return { id: job.id, status: 'completed' };
  }
  if (claim.kind === 'reconcile') {
    const [evidence] = await dependencies.database.select().from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, claim.attempt.expectedEvidenceId)).limit(1);
    if (!evidence) {
      await finalizeInfrastructure(dependencies, claim.verification, null, 'verification_evidence_missing', now);
      return { id: job.id, status: 'completed' };
    }
    return finalizeFromEvidence(dependencies, claim.verification, claim.attempt, evidence);
  }
  if (claim.kind !== 'attempt') return { id: job.id, status: 'failed', output: { code: 'verification_claim_failed' } };
  const { attempt, verification } = claim;
  if (claim.recovered && attempt.sandboxName) {
    const cleanup = await (dependencies.recover ?? recoverSandbox)({ name: attempt.sandboxName, sessionId: attempt.sandboxSessionId });
    const confirmed = cleanup.stop === 'confirmed' && cleanup.delete === 'confirmed' && cleanup.lookup === 'absent' || cleanup.lookup === 'absent';
    if (!confirmed) return { id: job.id, status: 'failed', output: { code: 'orphan_cleanup_unconfirmed' } };
    await finishAttempt(dependencies.database, attempt, now, { state: 'abandoned', failureCode: 'process_loss', cleanup });
    return { id: job.id, status: 'failed', output: { code: 'process_loss_recovered' } };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  job.signal?.addEventListener('abort', abort, { once: true });
  dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  const heartbeat = setInterval(() => { void renew(dependencies.database, attempt, (dependencies.clock ?? (() => new Date()))()).catch(() => controller.abort()); }, HEARTBEAT_MS);
  const observer: SandboxLifecycleObserver = {
    requested: async ({ name }) => updateSandbox(dependencies.database, attempt, { sandboxName: name }, (dependencies.clock ?? (() => new Date()))()),
    created: async ({ name, sessionId }) => updateSandbox(dependencies.database, attempt, { sandboxName: name, sandboxSessionId: sessionId }, (dependencies.clock ?? (() => new Date()))()),
    cleaned: async ({ stop, delete: deleted, lookup }) => updateSandbox(dependencies.database, attempt, { cleanupStop: stop, cleanupDelete: deleted, cleanupLookup: lookup }, (dependencies.clock ?? (() => new Date()))()),
  };
  try {
    const report = await (dependencies.executor ?? executeCandidateVerification)(dependencies.database, dependencies.gateway, dependencies.configuration, {
      verificationId: verification.id, attemptId: attempt.id, evidenceId: attempt.expectedEvidenceId,
    }, { cancellation: controller.signal, ...(dependencies.clock ? { clock: dependencies.clock } : {}), sandboxObserver: observer });
    await persistEvidence(dependencies.database, attempt, report);
    await dependencies.afterEvidencePersisted?.();
    const [evidence] = await dependencies.database.select().from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, report.evidenceId)).limit(1);
    if (!evidence) throw Object.assign(new Error('verification_evidence_missing'), { code: 'verification_evidence_missing' });
    return await finalizeFromEvidence(dependencies, verification, attempt, evidence);
  } catch (error) {
    const [persisted] = await dependencies.database.select({ id: candidateVerificationEvidence.id }).from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, attempt.expectedEvidenceId)).limit(1);
    if (persisted) {
      // Once immutable evidence exists, a retry must reconcile it after this
      // ownership lease expires instead of running customer code again.
      return { id: job.id, status: 'failed', output: { code: 'verification_reconciliation_pending' } };
    }
    const code = safeCode(error, controller.signal.aborted);
    const artifactInvalid = code === 'candidate_artifact_invalid';
    const exhausted = artifactInvalid || attempt.attemptNumber >= REPAIR_JOB_MAX_ATTEMPTS;
    const owned = await finishAttempt(dependencies.database, attempt, (dependencies.clock ?? (() => new Date()))(), { state: exhausted ? 'exhausted' : 'retryable_failed', failureCode: code });
    if (!owned) return { id: job.id, status: 'failed', output: { code: 'verification_ownership_lost' } };
    if (exhausted) {
      await finalizeInfrastructure(dependencies, verification, null, code, (dependencies.clock ?? (() => new Date()))(), artifactInvalid ? 'invalid' : null);
      return { id: job.id, status: 'completed' };
    }
    return { id: job.id, status: 'failed', output: { code } };
  } finally {
    clearInterval(heartbeat);
    job.signal?.removeEventListener('abort', abort);
    dependencies.shutdownSignal?.removeEventListener('abort', abort);
  }
}
