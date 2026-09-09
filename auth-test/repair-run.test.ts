import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import {
  executionProfile,
  githubInstallation,
  repairRun,
  repairRunAttempt,
  repairRunEvent,
  repository,
  repositoryBaseline,
} from '../db/schema.ts';
import { AccessDeniedError, resolveAuthenticatedWorkspace, type AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { computeExecutionProfileIdentity, gitBlobSha } from '../lib/execution-profiles/detector.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import { BaselineAuthorityError } from '../lib/repository-baselines/authority.ts';
import { executeSelectedRepositoryBaseline } from '../lib/repository-baselines/flow.ts';
import type { BaselineEvidence, GitHubBaselineGateway } from '../lib/repository-baselines/types.ts';
import {
  cancelCreatedRepairRun,
  getRepairRun,
  startRepairRun,
} from '../lib/repair-runs/flow.ts';
import { createRepairRunHandlers } from '../lib/repair-runs/handlers.ts';
import {
  parseRepairJobPayload,
  type RepairJobPayload,
  type RepairQueueJob,
  type TransactionalRepairQueue,
} from '../lib/repair-runs/queue.ts';
import {
  classifyBaselineOutcome,
  RepairRunTransitionError,
  validateTransition,
} from '../lib/repair-runs/state-machine.ts';
import { processRepairJob, type RepairWorkerDependencies, type WorkerLogger } from '../lib/repair-runs/worker.ts';
import { commandEvidence } from '../src/fixture-execution.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const REPOSITORY_ID = 8101;
const INSTALLATION_ID = 9001;
const CONFIGURATION: GitHubAppConfiguration = { appId: 991, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' };
const PACKAGE = '{"name":"app"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}';
const OBJECTIVE = 'Investigate the deterministic customer-visible failure.';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function authenticated(context: Awaited<ReturnType<typeof createTestContext>>, githubId = 'repair-user'): Promise<AuthenticatedWorkspace> {
  const user = await saveGithubUser(context, githubId);
  const login = await context.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace((headers) => context.auth.api.getSession({ headers }), context.database, login.headers);
}

function profileValues(workspaceId: string, baseCommitSha = COMMIT) {
  const identityInput = {
    baseCommitSha,
    build: { script: 'build' as const, tool: 'npm' as const },
    githubRepositoryId: REPOSITORY_ID,
    install: { operation: 'ci' as const, tool: 'npm' as const },
    installationId: INSTALLATION_ID,
    lockfileType: 'package-lock' as const,
    nodeMajor: 24 as const,
    packageJsonBlobSha: gitBlobSha(PACKAGE),
    packageJsonContentSha256: sha256(PACKAGE),
    packageLockBlobSha: gitBlobSha(LOCK),
    packageLockContentSha256: sha256(LOCK),
    packageManager: 'npm' as const,
    profileVersion: 2 as const,
    runtimeFamily: 'node' as const,
    test: { script: 'test' as const, tool: 'npm' as const },
    testRunner: 'node-test' as const,
    typecheck: { script: 'typecheck' as const, tool: 'npm' as const },
    workspaceId,
  };
  return {
    baseCommitSha, buildScript: 'build', githubRepositoryId: REPOSITORY_ID, installOperation: 'ci', installationId: INSTALLATION_ID,
    lockfileType: 'package-lock', nodeMajor: 24, packageJsonBlobSha: identityInput.packageJsonBlobSha,
    packageJsonContentSha256: identityInput.packageJsonContentSha256, packageLockBlobSha: identityInput.packageLockBlobSha,
    packageLockContentSha256: identityInput.packageLockContentSha256, packageManager: 'npm',
    profileIdentity: computeExecutionProfileIdentity(identityInput), profileVersion: 2, runtimeFamily: 'node', status: 'ready',
    testRunner: 'node-test', testScript: 'test', typecheckScript: 'typecheck', workspaceId,
  } as const;
}

async function seed(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace, withProfile = true) {
  await context.database.insert(githubInstallation).values({ accountLogin: 'octo', accountType: 'Organization', githubAccountId: 3001, installationId: INSTALLATION_ID, status: 'active', workspaceId: owner.workspace.id });
  await context.database.insert(repository).values({ defaultBranch: 'main', fullName: 'octo/app', githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, isPrivate: true, name: 'app', ownerId: 3001, ownerLogin: 'octo', workspaceId: owner.workspace.id });
  if (withProfile) await context.database.insert(executionProfile).values(profileValues(owner.workspace.id));
}

class MemoryQueue implements TransactionalRepairQueue {
  readonly payloads: RepairJobPayload[] = [];
  fail = false;

  async enqueue(_transaction: Parameters<TransactionalRepairQueue['enqueue']>[0], payload: RepairJobPayload): Promise<string> {
    if (this.fail) throw new Error('queue_unavailable');
    this.payloads.push(structuredClone(payload));
    return payload.repairRunId;
  }
}

const unusedGateway = {} as GitHubBaselineGateway;

function job(repairRunId: string, data: unknown = { version: 1, repairRunId }): RepairQueueJob {
  return {
    id: repairRunId,
    name: 'repair-baseline-v1',
    data,
    signal: new AbortController().signal,
    expireInSeconds: 720,
    heartbeatSeconds: 60,
  } as RepairQueueJob;
}

function evidence(input: {
  workspaceId: string;
  profileIdentity: string;
  baselineId: string;
  outcome?: BaselineEvidence['overallOutcome'];
  repositoryId?: number;
  baseCommitSha?: string;
}): BaselineEvidence {
  const outcome = input.outcome ?? 'baseline_passed';
  const completed = commandEvidence(['npm', 'ci'], 1); completed.status = 'completed'; completed.exitCode = 0;
  const tests = commandEvidence(['npm', 'test'], 1);
  tests.status = outcome === 'baseline_passed' ? 'completed' : 'failed';
  tests.exitCode = outcome === 'baseline_passed' ? 0 : 1;
  return {
    evidenceVersion: 1,
    runId: input.baselineId,
    workspaceId: input.workspaceId,
    githubRepositoryId: input.repositoryId ?? REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    profileIdentity: input.profileIdentity,
    baseCommitSha: input.baseCommitSha ?? COMMIT,
    archiveSha256: 'c'.repeat(64),
    sandbox: { name: 'vigilo-test-sandbox', sessionId: 'test-session', runtime: 'vercel/sandbox/node:24', persistent: false },
    source: { materialized: true, identityBeforeExecution: 'd'.repeat(64), identityAfterExecution: 'd'.repeat(64), unchangedAfterExecution: true },
    credentialsExposure: 'absent',
    networkPolicyBeforeRepositoryExecution: 'deny-all',
    install: completed,
    typecheck: null,
    build: null,
    test: tests,
    executionOutcome: outcome,
    overallOutcome: outcome,
    cleanup: { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' },
    error: outcome === 'baseline_passed' ? null : { phase: 'test', code: outcome },
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 0,
  };
}

async function persistEvidence(database: VigiloDatabase, report: BaselineEvidence) {
  await database.insert(repositoryBaseline).values({
    id: report.runId, workspaceId: report.workspaceId, githubRepositoryId: report.githubRepositoryId, installationId: report.installationId,
    evidenceVersion: 1, profileIdentity: report.profileIdentity, baseCommitSha: report.baseCommitSha, archiveSha256: report.archiveSha256,
    sandboxName: report.sandbox.name, sandboxSessionId: report.sandbox.sessionId, sourceIdentityBefore: report.source.identityBeforeExecution,
    sourceIdentityAfter: report.source.identityAfterExecution, sourceUnchanged: report.source.unchangedAfterExecution, credentialsExposure: report.credentialsExposure,
    networkPolicy: report.networkPolicyBeforeRepositoryExecution, installStatus: report.install.status, installExitCode: report.install.exitCode,
    installTimedOut: report.install.timedOut, testStatus: report.test.status, testExitCode: report.test.exitCode, testTimedOut: report.test.timedOut,
    executionOutcome: report.executionOutcome, overallOutcome: report.overallOutcome, cleanupStop: report.cleanup.stop, cleanupDelete: report.cleanup.delete,
    cleanupLookup: report.cleanup.lookup, errorPhase: report.error?.phase ?? null, errorCode: report.error?.code ?? null,
    startedAt: report.startedAt, completedAt: report.completedAt, durationMs: report.durationMs,
  });
}

type BaselineExecutor = typeof executeSelectedRepositoryBaseline;

function executorFor(outcome: BaselineEvidence['overallOutcome'] = 'baseline_passed', mutate: Partial<BaselineEvidence> = {}, calls?: { count: number }): BaselineExecutor {
  return async (database, _context, _gateway, _configuration, options = {}) => {
    calls && (calls.count += 1);
    assert.ok(options.expectedAuthority);
    assert.ok(options.evidenceId);
    if (options.sandboxObserver?.requested) await options.sandboxObserver.requested({ name: 'vigilo-test-sandbox' });
    if (options.sandboxObserver?.created) await options.sandboxObserver.created({ name: 'vigilo-test-sandbox', sessionId: 'test-session' });
    if (options.sandboxObserver?.cleaned) await options.sandboxObserver.cleaned({ name: 'vigilo-test-sandbox', sessionId: 'test-session', stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
    const report = {
      ...evidence({
        workspaceId: options.expectedAuthority.workspaceId,
        profileIdentity: options.expectedAuthority.profileIdentity,
        baselineId: options.evidenceId,
        outcome,
        repositoryId: options.expectedAuthority.githubRepositoryId,
        baseCommitSha: options.expectedAuthority.baseCommitSha,
      }),
      ...mutate,
    } as BaselineEvidence;
    await options.authorizePersistence?.(report);
    await persistEvidence(database, report);
    return report;
  };
}

const noLogs: WorkerLogger = { write() {} };

function workerDependencies(database: VigiloDatabase, baselineExecutor: BaselineExecutor, overrides: Partial<RepairWorkerDependencies> = {}): RepairWorkerDependencies {
  return {
    configuration: CONFIGURATION,
    database,
    gateway: unusedGateway,
    logger: noLogs,
    baselineExecutor,
    clock: () => NOW,
    ...overrides,
  };
}

async function queuedRun(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace, key = randomUUID(), objective = OBJECTIVE) {
  const queue = new MemoryQueue();
  const run = await startRepairRun(context.database, owner, key, objective, queue, { clock: () => NOW });
  return { queue, run };
}

test('Repair Run state and baseline classification remain fail-closed', () => {
  assert.doesNotThrow(() => validateTransition('created', 'baseline_running'));
  assert.doesNotThrow(() => validateTransition('created', 'cancelled'));
  for (const target of ['ready_for_investigation', 'baseline_failed', 'infrastructure_failed', 'cancelled'] as const) {
    assert.doesNotThrow(() => validateTransition('baseline_running', target));
  }
  for (const [from, to] of [
    ['created', 'ready_for_investigation'], ['baseline_running', 'created'], ['ready_for_investigation', 'baseline_running'],
    ['baseline_failed', 'baseline_running'], ['infrastructure_failed', 'baseline_running'], ['cancelled', 'baseline_running'],
  ] as const) assert.throws(() => validateTransition(from, to), RepairRunTransitionError);
  assert.equal(classifyBaselineOutcome('baseline_passed'), 'ready_for_investigation');
  for (const value of ['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed'] as const) assert.equal(classifyBaselineOutcome(value), 'ready_for_investigation');
  for (const value of ['installation_failed', 'timed_out', 'infrastructure_failed', 'cleanup_failed'] as const) assert.equal(classifyBaselineOutcome(value), 'infrastructure_failed');
});

test('web start atomically creates immutable run, event, and minimal durable responsibility without inline execution', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const queue = new MemoryQueue();
  const run = await startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queue, { clock: () => NOW });
  assert.equal(run.state, 'created');
  assert.deepEqual(run.identity, { workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: profileValues(owner.workspace.id).profileIdentity });
  assert.deepEqual(queue.payloads, [{ version: 1, repairRunId: run.id }]);
  assert.deepEqual((await context.database.select().from(repairRunEvent)).map((event) => event.toState), ['created']);
  assert.equal((await context.database.select().from(repositoryBaseline)).length, 0);
  assert.doesNotMatch(JSON.stringify(queue.payloads), /workspace|repository|installation|commit|profile|token|secret|command/i);
});

test('failed handoff rolls back the Repair Run and its event', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const queue = new MemoryQueue(); queue.fail = true;
  await assert.rejects(startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queue), /handoff_failed/);
  assert.equal((await context.database.select().from(repairRun)).length, 0);
  assert.equal((await context.database.select().from(repairRunEvent)).length, 0);
});

test('repeated and concurrent starts reuse one queued run', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const queue = new MemoryQueue();
  const key = randomUUID();
  const [first, duplicate] = await Promise.all([
    startRepairRun(context.database, owner, key, OBJECTIVE, queue),
    startRepairRun(context.database, owner, key, OBJECTIVE, queue),
  ]);
  const reloaded = await startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queue);
  assert.equal(first.id, duplicate.id); assert.equal(first.id, reloaded.id);
  assert.equal(queue.payloads.length, 1);
  assert.equal((await context.database.select().from(repairRun)).length, 1);
});

test('minimal queue payload parser rejects malformed and authoritative fields', () => {
  const id = randomUUID();
  assert.deepEqual(parseRepairJobPayload({ version: 1, repairRunId: id }), { version: 1, repairRunId: id });
  for (const value of [null, {}, { version: 2, repairRunId: id }, { version: 1, repairRunId: 'bad' }, { version: 1, repairRunId: id, workspaceId: randomUUID() }]) {
    assert.throws(() => parseRepairJobPayload(value), /invalid_job_payload/);
  }
});

test('worker resolves authority, owns execution, persists evidence, and logs only safe facts', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  const logs: unknown[] = [];
  const result = await processRepairJob(job(run.id), workerDependencies(context.database, executorFor(), { logger: { write: (entry) => logs.push(entry) } }));
  assert.equal(result.status, 'completed');
  const stored = await getRepairRun(context.database, owner, run.id);
  assert.equal(stored?.state, 'ready_for_investigation'); assert.ok(stored?.baselineId);
  assert.deepEqual((await context.database.select().from(repairRunEvent)).map((event) => event.toState), ['created', 'baseline_running', 'ready_for_investigation']);
  const [attempt] = await context.database.select().from(repairRunAttempt);
  assert.equal(attempt?.state, 'succeeded'); assert.equal(attempt?.cleanupLookup, 'absent');
  assert.doesNotMatch(JSON.stringify(logs), /token|secret|private.key|database|source.code|stdout|stderr/i);
});

test('duplicate workers cannot own or execute the same active run', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  let release!: () => void; let entered!: () => void; const calls = { count: 0 };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const delegate = executorFor('baseline_passed', {}, calls);
  const blocking: BaselineExecutor = async (...args) => { entered(); await gate; return delegate(...args); };
  const first = processRepairJob(job(run.id), workerDependencies(context.database, blocking));
  await started;
  const duplicate = await processRepairJob(job(run.id), workerDependencies(context.database, delegate));
  assert.equal(duplicate.status, 'failed'); assert.deepEqual(duplicate.output, { code: 'active_attempt' });
  release(); await first;
  assert.equal(calls.count, 1);
  assert.equal((await context.database.select().from(repositoryBaseline)).length, 1);
});

test('a worker whose fencing token is revoked cannot finalize the Repair Run', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  let evidenceStored!: () => void; let release!: () => void;
  const stored = new Promise<void>((resolve) => { evidenceStored = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor: BaselineExecutor = async (database, _owner, _gateway, _configuration, options) => {
    assert.ok(options?.expectedAuthority); assert.ok(options.evidenceId);
    const report = evidence({
      workspaceId: options.expectedAuthority.workspaceId,
      profileIdentity: 'f'.repeat(64),
      baselineId: options.evidenceId,
    });
    await options.authorizePersistence?.(report);
    await persistEvidence(database, report);
    evidenceStored();
    await gate;
    return report;
  };
  const processing = processRepairJob(job(run.id), workerDependencies(context.database, executor));
  await stored;
  const [attempt] = await context.database.select().from(repairRunAttempt); assert.ok(attempt);
  await context.database.update(repairRunAttempt).set({ ownershipToken: randomUUID() }).where(eq(repairRunAttempt.id, attempt.id));
  release();
  const result = await processing;
  assert.equal(result.status, 'failed'); assert.deepEqual(result.output, { code: 'attempt_ownership_lost' });
  assert.equal((await getRepairRun(context.database, owner, run.id))?.state, 'baseline_running');
  assert.equal((await context.database.select().from(repairRunAttempt))[0]?.state, 'active');
});

test('terminal and cancelled runs make later delivery harmless', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const first = await queuedRun(context, owner);
  await processRepairJob(job(first.run.id), workerDependencies(context.database, executorFor()));
  const calls = { count: 0 };
  assert.equal((await processRepairJob(job(first.run.id), workerDependencies(context.database, executorFor('baseline_passed', {}, calls)))).status, 'completed');
  const secondProfile = profileValues(owner.workspace.id, 'b'.repeat(40));
  await context.database.update(executionProfile).set(secondProfile).where(eq(executionProfile.githubRepositoryId, REPOSITORY_ID));
  const second = await queuedRun(context, owner);
  await cancelCreatedRepairRun(context.database, owner, second.run.id, NOW);
  assert.equal((await processRepairJob(job(second.run.id), workerDependencies(context.database, executorFor('baseline_passed', {}, calls)))).status, 'completed');
  assert.equal(calls.count, 0);
});

test('customer test, build, and typecheck failures remain investigable without retry', async (t) => {
  for (const outcome of ['test_failed', 'build_failed', 'typecheck_failed'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close());
    const owner = await authenticated(context, `customer-${outcome}`); await seed(context, owner);
    const { run } = await queuedRun(context, owner);
    const result = await processRepairJob(job(run.id), workerDependencies(context.database, executorFor(outcome)));
    assert.equal(result.status, 'completed');
    const stored = await getRepairRun(context.database, owner, run.id);
    assert.equal(stored?.state, 'ready_for_investigation'); assert.equal(stored?.failureClassification, 'customer_baseline_failure');
    assert.equal((await context.database.select().from(repairRunAttempt)).length, 1);
  }
});

test('infrastructure failures retry within bounds and exhaust accurately', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await processRepairJob(job(run.id), workerDependencies(context.database, executorFor('installation_failed')));
    assert.equal(result.status, attempt < 3 ? 'failed' : 'completed');
  }
  const stored = await getRepairRun(context.database, owner, run.id);
  assert.equal(stored?.state, 'infrastructure_failed'); assert.equal(stored?.failureCode, 'installation_failed');
  assert.deepEqual((await context.database.select().from(repairRunAttempt)).map((attempt) => attempt.state), ['retryable_failed', 'retryable_failed', 'exhausted']);
});

test('malformed payload and unknown run IDs dead-letter safely', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const dependencies = workerDependencies(context.database, executorFor());
  assert.equal((await processRepairJob(job(randomUUID(), { version: 1, repairRunId: 'forged' }), dependencies)).status, 'deadletter');
  const unknown = randomUUID();
  assert.equal((await processRepairJob(job(unknown), dependencies)).status, 'deadletter');
});

test('authority changes after queueing fail closed without repository execution', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  await context.database.update(executionProfile).set({ baseCommitSha: 'b'.repeat(40), profileIdentity: 'e'.repeat(64) }).where(eq(executionProfile.githubRepositoryId, REPOSITORY_ID));
  const calls = { count: 0 };
  await processRepairJob(job(run.id), workerDependencies(context.database, executorFor('baseline_passed', {}, calls)));
  assert.equal(calls.count, 0);
  assert.equal((await getRepairRun(context.database, owner, run.id))?.state, 'infrastructure_failed');
});

test('graceful shutdown aborts worker-owned execution and records a retryable interruption', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  const shutdown = new AbortController(); shutdown.abort();
  const executor: BaselineExecutor = async (_database, _owner, _gateway, _configuration, options) => {
    assert.ok(options);
    assert.equal(options.cancellation?.aborted, true);
    throw new Error('must_not_be_exposed');
  };
  const result = await processRepairJob(job(run.id), workerDependencies(context.database, executor, { shutdownSignal: shutdown.signal }));
  assert.equal(result.status, 'failed'); assert.deepEqual(result.output, { code: 'worker_interrupted' });
  assert.equal((await getRepairRun(context.database, owner, run.id))?.state, 'baseline_running');
  assert.equal((await context.database.select().from(repairRunAttempt))[0]?.state, 'retryable_failed');
});

test('stale ownership cleans the abandoned sandbox before a replacement attempt', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const never: BaselineExecutor = async () => { entered(); return new Promise<never>(() => {}); };
  void processRepairJob(job(run.id), workerDependencies(context.database, never));
  await started;
  const [active] = await context.database.select().from(repairRunAttempt);
  assert.ok(active);
  await context.database.update(repairRunAttempt).set({ sandboxName: 'abandoned-sandbox', sandboxSessionId: 'old-session', leaseExpiresAt: new Date(NOW.getTime() - 1) }).where(eq(repairRunAttempt.id, active.id));
  const recovered: string[] = [];
  const retry = await processRepairJob(job(run.id), workerDependencies(context.database, executorFor(), {
    clock: () => new Date(NOW.getTime() + 1),
    recover: async (identity) => { recovered.push(`${identity.name}:${identity.sessionId}`); return { stop: 'confirmed', delete: 'confirmed', lookup: 'absent', errors: [] }; },
  }));
  assert.equal(retry.status, 'failed'); assert.deepEqual(recovered, ['abandoned-sandbox:old-session']);
  const replacement = await processRepairJob(job(run.id), workerDependencies(context.database, executorFor(), { clock: () => new Date(NOW.getTime() + 2) }));
  assert.equal(replacement.status, 'completed');
  assert.equal((await context.database.select().from(repairRunAttempt)).length, 2);
});

test('unconfirmed abandoned sandbox cleanup blocks replacement execution', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  void processRepairJob(job(run.id), workerDependencies(context.database, async () => { entered(); return new Promise<never>(() => {}); }));
  await started;
  const [active] = await context.database.select().from(repairRunAttempt); assert.ok(active);
  await context.database.update(repairRunAttempt).set({ sandboxName: 'unresolved-sandbox', leaseExpiresAt: new Date(NOW.getTime() - 1) }).where(eq(repairRunAttempt.id, active.id));
  const calls = { count: 0 };
  const dependencies = workerDependencies(context.database, executorFor('baseline_passed', {}, calls), {
    clock: () => new Date(NOW.getTime() + 1),
    recover: async () => ({ stop: 'failed', delete: 'failed', lookup: 'still_present', errors: [{ operation: 'lookup', code: 'provider_unavailable' }] }),
  });
  assert.equal((await processRepairJob(job(run.id), dependencies)).status, 'failed');
  assert.equal((await processRepairJob(job(run.id), dependencies)).status, 'failed');
  assert.equal(calls.count, 0);
});

test('matching evidence persisted before a crash is reconciled without rerunning customer code', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  void processRepairJob(job(run.id), workerDependencies(context.database, async () => { entered(); return new Promise<never>(() => {}); }));
  await started;
  const [attempt] = await context.database.select().from(repairRunAttempt); assert.ok(attempt);
  await persistEvidence(context.database, evidence({ workspaceId: owner.workspace.id, profileIdentity: run.identity.profileIdentity, baselineId: attempt.expectedBaselineId }));
  await context.database.update(repairRunAttempt).set({ state: 'succeeded', baselineId: attempt.expectedBaselineId, leaseExpiresAt: null, finishedAt: NOW }).where(eq(repairRunAttempt.id, attempt.id));
  const calls = { count: 0 };
  const result = await processRepairJob(job(run.id), workerDependencies(context.database, executorFor('baseline_passed', {}, calls)));
  assert.equal(result.status, 'completed'); assert.equal(calls.count, 0);
  assert.equal((await getRepairRun(context.database, owner, run.id))?.state, 'ready_for_investigation');
});

test('mismatched crash evidence is never reconciled as success', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  void processRepairJob(job(run.id), workerDependencies(context.database, async () => { entered(); return new Promise<never>(() => {}); }));
  await started;
  const [attempt] = await context.database.select().from(repairRunAttempt); assert.ok(attempt);
  await persistEvidence(context.database, evidence({ workspaceId: owner.workspace.id, profileIdentity: 'f'.repeat(64), baselineId: attempt.expectedBaselineId }));
  await context.database.update(repairRunAttempt).set({ state: 'succeeded', baselineId: attempt.expectedBaselineId, leaseExpiresAt: null, finishedAt: NOW }).where(eq(repairRunAttempt.id, attempt.id));
  await processRepairJob(job(run.id), workerDependencies(context.database, executorFor()));
  assert.equal((await getRepairRun(context.database, owner, run.id))?.state, 'infrastructure_failed');
});

test('database constraints reject duplicate ownership and fabricated success', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run } = await queuedRun(context, owner);
  const values = { id: randomUUID(), repairRunId: run.id, queueJobId: run.id, attemptNumber: 1, expectedBaselineId: randomUUID(), ownershipToken: randomUUID(), state: 'active', claimedAt: NOW, heartbeatAt: NOW, leaseExpiresAt: new Date(NOW.getTime() + 1_000) };
  await context.database.insert(repairRunAttempt).values(values);
  await assert.rejects(context.database.insert(repairRunAttempt).values({ ...values, id: randomUUID(), attemptNumber: 2, expectedBaselineId: randomUUID(), ownershipToken: randomUUID() }));
  await assert.rejects(context.database.insert(repairRun).values({ id: randomUUID(), workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: run.identity.profileIdentity, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineStartedAt: NOW, completedAt: NOW, createdAt: NOW, stateChangedAt: NOW, updatedAt: NOW }));
});

test('protected async API accepts only idempotent intent and remains workspace scoped', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context, 'api-owner'); await seed(context, owner);
  const outsider = await authenticated(context, 'api-outsider');
  const queue = new MemoryQueue();
  const handlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: context.database, queue, resolveContext: async () => owner });
  const key = randomUUID();
  const response = await handlers.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: key, objective: OBJECTIVE }) }));
  assert.equal(response.status, 303); assert.equal(queue.payloads.length, 1);
  const runId = queue.payloads[0]?.repairRunId; assert.ok(runId);
  const read = await handlers.read(new Request(`http://localhost:3000/api/repair-runs/${runId}`), runId);
  assert.equal(read.status, 200); assert.equal((await read.json()).repairRun.state, 'created');
  const outsiderHandlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: context.database, queue, resolveContext: async () => outsider });
  assert.equal((await outsiderHandlers.read(new Request(`http://localhost:3000/api/repair-runs/${runId}`), runId)).status, 404);
  const forged = await handlers.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: randomUUID(), objective: OBJECTIVE, repositoryId: '999', state: 'ready_for_investigation' }) }));
  assert.match(forged.headers.get('location') ?? '', /invalid_idempotency_key/);
});

test('queued cancellation is authenticated, same-origin, durable, and later delivery is harmless', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run, queue } = await queuedRun(context, owner);
  const handlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: context.database, queue, resolveContext: async () => owner });
  assert.equal((await handlers.cancel(new Request(`http://localhost:3000/api/repair-runs/${run.id}/cancel`, { method: 'POST', headers: { origin: 'https://attacker.example' } }), run.id)).status, 403);
  const response = await handlers.cancel(new Request(`http://localhost:3000/api/repair-runs/${run.id}/cancel`, { method: 'POST', headers: { origin: CONFIGURATION.baseUrl } }), run.id);
  assert.equal(response.status, 303); assert.equal((await getRepairRun(context.database, owner, run.id))?.state, 'cancelled');
  const calls = { count: 0 };
  await processRepairJob(job(run.id), workerDependencies(context.database, executorFor('baseline_passed', {}, calls)));
  assert.equal(calls.count, 0);
});

test('unauthenticated start/read are rejected and historical identity survives repository removal', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner);
  const { run, queue } = await queuedRun(context, owner);
  const denied = createRepairRunHandlers({ configuration: CONFIGURATION, database: context.database, queue, resolveContext: async () => { throw new AccessDeniedError('unauthorized'); } });
  assert.equal((await denied.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: randomUUID(), objective: OBJECTIVE }) }))).status, 303);
  assert.equal((await denied.read(new Request(`http://localhost:3000/api/repair-runs/${run.id}`), run.id)).status, 401);
  await context.database.delete(repository).where(eq(repository.workspaceId, owner.workspace.id));
  assert.equal((await getRepairRun(context.database, owner, run.id))?.identity.githubRepositoryId, REPOSITORY_ID);
});

test('missing and corrupted profiles prevent queue handoff', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); await seed(context, owner, false);
  const queue = new MemoryQueue();
  await assert.rejects(startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queue), BaselineAuthorityError);
  await context.database.insert(executionProfile).values({ ...profileValues(owner.workspace.id), profileIdentity: 'f'.repeat(64) });
  await assert.rejects(startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queue), (error: unknown) => error instanceof BaselineAuthorityError && error.code === 'profile_corrupt');
  assert.equal(queue.payloads.length, 0);
});

test('worker reuses Task 2.6 and repair orchestration contains no parallel sandbox implementation', async () => {
  const workerSource = await readFile('lib/repair-runs/worker.ts', 'utf8');
  const webSource = await readFile('lib/repair-runs/flow.ts', 'utf8');
  assert.match(workerSource, /executeSelectedRepositoryBaseline/);
  assert.doesNotMatch(webSource, /executeSelectedRepositoryBaseline|@vercel\/sandbox|Sandbox\.create|runFrozenRepositoryBaseline|npm ci/);
  assert.doesNotMatch(workerSource, /Sandbox\.create|runFrozenRepositoryBaseline|npm ci/);
});
