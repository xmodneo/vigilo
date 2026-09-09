import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import {
  executionProfile,
  githubInstallation,
  repairRun,
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
import type { BaselineEvidence, FrozenBaselineInput, GitHubBaselineGateway } from '../lib/repository-baselines/types.ts';
import {
  getRepairRun,
  startRepairRun,
} from '../lib/repair-runs/flow.ts';
import { createRepairRunHandlers } from '../lib/repair-runs/handlers.ts';
import {
  classifyBaselineOutcome,
  RepairRunTransitionError,
  validateTransition,
} from '../lib/repair-runs/state-machine.ts';
import { commandEvidence } from '../src/fixture-execution.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const REPOSITORY_ID = 8101;
const INSTALLATION_ID = 9001;
const CONFIGURATION: GitHubAppConfiguration = { appId: 991, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' };
const PACKAGE = '{"name":"app"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function authenticated(testContext: Awaited<ReturnType<typeof createTestContext>>, githubId = 'repair-user'): Promise<AuthenticatedWorkspace> {
  const user = await saveGithubUser(testContext, githubId);
  const login = await testContext.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace((headers) => testContext.auth.api.getSession({ headers }), testContext.database, login.headers);
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

async function seed(testContext: Awaited<ReturnType<typeof createTestContext>>, context: AuthenticatedWorkspace, withProfile = true) {
  await testContext.database.insert(githubInstallation).values({ accountLogin: 'octo', accountType: 'Organization', githubAccountId: 3001, installationId: INSTALLATION_ID, status: 'active', workspaceId: context.workspace.id });
  await testContext.database.insert(repository).values({ defaultBranch: 'main', fullName: 'octo/app', githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, isPrivate: true, name: 'app', ownerId: 3001, ownerLogin: 'octo', workspaceId: context.workspace.id });
  if (withProfile) await testContext.database.insert(executionProfile).values(profileValues(context.workspace.id));
}

const unusedGateway = {} as GitHubBaselineGateway;

function evidence(input: { workspaceId: string; profileIdentity: string; baselineId: string; outcome?: BaselineEvidence['overallOutcome']; repositoryId?: number; baseCommitSha?: string }): BaselineEvidence {
  const outcome = input.outcome ?? 'baseline_passed';
  const completed = commandEvidence(['npm', 'ci'], 1); completed.status = 'completed'; completed.exitCode = 0;
  const tests = commandEvidence(['npm', 'test'], 1); tests.status = outcome === 'baseline_passed' ? 'completed' : 'failed'; tests.exitCode = outcome === 'baseline_passed' ? 0 : 1;
  return {
    evidenceVersion: 1, runId: input.baselineId, workspaceId: input.workspaceId, githubRepositoryId: input.repositoryId ?? REPOSITORY_ID,
    installationId: INSTALLATION_ID, profileIdentity: input.profileIdentity, baseCommitSha: input.baseCommitSha ?? COMMIT,
    archiveSha256: 'c'.repeat(64), sandbox: { name: 'sandbox', sessionId: 'session', runtime: 'vercel/sandbox/node:24', persistent: false },
    source: { materialized: true, identityBeforeExecution: 'd'.repeat(64), identityAfterExecution: 'd'.repeat(64), unchangedAfterExecution: true },
    credentialsExposure: 'absent', networkPolicyBeforeRepositoryExecution: 'deny-all', install: completed, typecheck: null, build: null, test: tests,
    executionOutcome: outcome, overallOutcome: outcome, cleanup: { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' },
    error: outcome === 'baseline_passed' ? null : { phase: 'test', code: outcome }, startedAt: NOW, completedAt: NOW, durationMs: 0,
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

function executorFor(outcome: BaselineEvidence['overallOutcome'] = 'baseline_passed', mutate: Partial<BaselineEvidence> = {}): BaselineExecutor {
  return async (database, _context, _gateway, _configuration, options = {}) => {
    assert.ok(options.expectedAuthority);
    const report = { ...evidence({ workspaceId: options.expectedAuthority.workspaceId, profileIdentity: options.expectedAuthority.profileIdentity, baselineId: randomUUID(), outcome, repositoryId: options.expectedAuthority.githubRepositoryId, baseCommitSha: options.expectedAuthority.baseCommitSha }), ...mutate } as BaselineEvidence;
    await persistEvidence(database, report);
    return report;
  };
}

test('Repair Run transition policy allows only the Task 3.1 graph', () => {
  assert.doesNotThrow(() => validateTransition('created', 'baseline_running'));
  assert.doesNotThrow(() => validateTransition('created', 'cancelled'));
  for (const target of ['ready_for_investigation', 'baseline_failed', 'infrastructure_failed', 'cancelled'] as const) {
    assert.doesNotThrow(() => validateTransition('baseline_running', target));
  }
});

test('Repair Run transition policy fails closed for invalid and terminal transitions', () => {
  for (const [from, to] of [
    ['created', 'ready_for_investigation'],
    ['baseline_running', 'created'],
    ['ready_for_investigation', 'baseline_running'],
    ['baseline_failed', 'baseline_running'],
    ['infrastructure_failed', 'baseline_running'],
    ['cancelled', 'baseline_running'],
  ] as const) {
    assert.throws(() => validateTransition(from, to), RepairRunTransitionError);
  }
});

test('baseline outcomes preserve customer failures and infrastructure failures', () => {
  assert.equal(classifyBaselineOutcome('baseline_passed'), 'ready_for_investigation');
  for (const outcome of ['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed'] as const) {
    assert.equal(classifyBaselineOutcome(outcome), 'baseline_failed');
  }
  for (const outcome of ['installation_failed', 'timed_out', 'infrastructure_failed', 'cleanup_failed'] as const) {
    assert.equal(classifyBaselineOutcome(outcome), 'infrastructure_failed');
  }
  assert.equal(classifyBaselineOutcome('cancelled'), 'cancelled');
});

test('authenticated start persists immutable authority, linked evidence, and transition history', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(), clock: () => NOW });
  assert.equal(run.state, 'ready_for_investigation');
  assert.deepEqual(run.identity, { workspaceId: user.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: profileValues(user.workspace.id).profileIdentity });
  assert.ok(run.baselineId);
  assert.equal((await ctx.database.select().from(repairRunEvent)).length, 3);
  assert.deepEqual((await ctx.database.select().from(repairRunEvent)).map((event) => event.toState), ['created', 'baseline_running', 'ready_for_investigation']);
  assert.deepEqual(await getRepairRun(ctx.database, user, run.id), run);
  assert.doesNotMatch(JSON.stringify(await ctx.database.select().from(repairRun)), /token|private.key|source.code|DATABASE_URL/i);
});

test('later branch and profile movement do not mutate an existing run identity', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(), clock: () => NOW });
  await ctx.database.update(repository).set({ defaultBranch: 'next' }).where(eq(repository.githubRepositoryId, REPOSITORY_ID));
  await ctx.database.update(executionProfile).set({ baseCommitSha: 'b'.repeat(40), profileIdentity: 'e'.repeat(64) }).where(eq(executionProfile.githubRepositoryId, REPOSITORY_ID));
  const persisted = await getRepairRun(ctx.database, user, run.id);
  assert.equal(persisted?.identity.baseCommitSha, COMMIT);
  assert.equal(persisted?.identity.profileIdentity, profileValues(user.workspace.id).profileIdentity);
});

test('historical run and evidence survive removal of mutable repository selection', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(), clock: () => NOW });
  await ctx.database.delete(repository).where(eq(repository.workspaceId, user.workspace.id));
  assert.equal((await getRepairRun(ctx.database, user, run.id))?.identity.githubRepositoryId, REPOSITORY_ID);
  assert.equal((await ctx.database.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, run.baselineId!))).length, 1);
});

test('missing and corrupted Ready profiles prevent run creation', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user, false);
  await assert.rejects(startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID()), BaselineAuthorityError);
  await ctx.database.insert(executionProfile).values({ ...profileValues(user.workspace.id), profileIdentity: 'f'.repeat(64) });
  await assert.rejects(startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID()), (error: unknown) => error instanceof BaselineAuthorityError && error.code === 'profile_corrupt');
  assert.equal((await ctx.database.select().from(repairRun)).length, 0);
});

test('customer typecheck, build, and test failures remain baseline failures', async (t) => {
  for (const outcome of ['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed'] as const) {
    const ctx = await createTestContext(); t.after(() => ctx.client.close());
    const user = await authenticated(ctx, `user-${outcome}`); await seed(ctx, user);
    const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(outcome), clock: () => NOW });
    assert.equal(run.state, 'baseline_failed');
    assert.equal(run.failureClassification, 'customer_baseline_failure');
    assert.equal(run.baselineOutcome, outcome);
  }
});

test('infrastructure and cleanup failures never produce a ready run', async (t) => {
  for (const outcome of ['installation_failed', 'timed_out', 'infrastructure_failed', 'cleanup_failed'] as const) {
    const ctx = await createTestContext(); t.after(() => ctx.client.close());
    const user = await authenticated(ctx, `user-${outcome}`); await seed(ctx, user);
    const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(outcome), clock: () => NOW });
    assert.equal(run.state, 'infrastructure_failed');
    assert.equal(run.failureClassification, 'infrastructure_failure');
  }
});

test('cancelled baseline evidence persists cancellation distinctly from failure', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor('cancelled'), clock: () => NOW });
  assert.equal(run.state, 'cancelled'); assert.equal(run.failureClassification, 'cancelled'); assert.equal(run.baselineOutcome, 'cancelled'); assert.ok(run.baselineId);
});

test('baseline acquisition exception is persisted as infrastructure failure without fabricated evidence', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: async () => { throw Object.assign(new Error('provider detail'), { code: 'source_unavailable' }); }, clock: () => NOW });
  assert.equal(run.state, 'infrastructure_failed'); assert.equal(run.failureCode, 'source_unavailable'); assert.equal(run.baselineId, null);
});

test('missing or mismatched baseline evidence fails closed as infrastructure failure', async (t) => {
  for (const mode of ['missing', 'mismatched'] as const) {
    const ctx = await createTestContext(); t.after(() => ctx.client.close());
    const user = await authenticated(ctx, `user-${mode}`); await seed(ctx, user);
    const execute: BaselineExecutor = mode === 'missing'
      ? async (_database, _context, _gateway, _configuration, options = {}) => evidence({ workspaceId: options.expectedAuthority!.workspaceId, profileIdentity: options.expectedAuthority!.profileIdentity, baselineId: randomUUID() })
      : executorFor('baseline_passed', { profileIdentity: 'f'.repeat(64) });
    const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: execute, clock: () => NOW });
    assert.equal(run.state, 'infrastructure_failed');
    assert.equal(run.baselineId, null);
  }
});

test('repeated idempotent initiation reuses one run and executes one baseline', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const key = randomUUID(); let calls = 0;
  const execute = async (...args: Parameters<ReturnType<typeof executorFor>>) => { calls += 1; return executorFor()(...args); };
  const first = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, key, { baselineExecutor: execute, clock: () => NOW });
  const second = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, key, { baselineExecutor: execute, clock: () => NOW });
  assert.equal(first.id, second.id); assert.equal(calls, 1); assert.equal((await ctx.database.select().from(repairRun)).length, 1);
});

test('concurrent duplicate initiation has one execution owner', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const key = randomUUID(); let calls = 0; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const delegate = executorFor();
  const execute: typeof delegate = async (...args) => { calls += 1; entered(); await wait; return delegate(...args); };
  const firstPromise = startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, key, { baselineExecutor: execute, clock: () => NOW });
  await started;
  const duplicate = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, key, { baselineExecutor: execute, clock: () => NOW });
  assert.equal(duplicate.state, 'baseline_running');
  release();
  const first = await firstPromise;
  assert.equal(first.id, duplicate.id); assert.equal(calls, 1);
});

test('an active immutable identity is deduplicated after a browser reload changes the intent key', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  let calls = 0; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const delegate = executorFor();
  const execute: typeof delegate = async (...args) => { calls += 1; entered(); await wait; return delegate(...args); };
  const firstPromise = startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: execute, clock: () => NOW });
  await started;
  const reloadedSubmission = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: execute, clock: () => NOW });
  assert.equal(reloadedSubmission.state, 'baseline_running');
  release();
  const first = await firstPromise;
  assert.equal(first.id, reloadedSubmission.id); assert.equal(calls, 1); assert.equal((await ctx.database.select().from(repairRun)).length, 1);
});

test('an exact old idempotency key wins over a newer active identity conflict', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const oldKey = randomUUID();
  const oldRun = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, oldKey, { baselineExecutor: executorFor(), clock: () => NOW });
  const movedProfile = profileValues(user.workspace.id, 'b'.repeat(40));
  await ctx.database.update(executionProfile).set(movedProfile).where(eq(executionProfile.githubRepositoryId, REPOSITORY_ID));
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const delegate = executorFor();
  const execute: typeof delegate = async (...args) => { entered(); await wait; return delegate(...args); };
  const activePromise = startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: execute, clock: () => NOW });
  await started;
  const replay = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, oldKey, { baselineExecutor: execute, clock: () => NOW });
  assert.equal(replay.id, oldRun.id); assert.equal(replay.state, 'ready_for_investigation');
  release(); await activePromise;
});

test('cross-workspace reads fail closed', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const owner = await authenticated(ctx, 'owner'); await seed(ctx, owner);
  const outsider = await authenticated(ctx, 'outsider');
  const run = await startRepairRun(ctx.database, owner, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(), clock: () => NOW });
  assert.equal(await getRepairRun(ctx.database, outsider, run.id), null);
});

test('cancellation before execution is durable and does not invoke baseline execution', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const cancellation = new AbortController(); cancellation.abort(); let called = false;
  const run = await startRepairRun(ctx.database, user, unusedGateway, CONFIGURATION, randomUUID(), { cancellation: cancellation.signal, baselineExecutor: async (...args) => { called = true; return executorFor()(...args); }, clock: () => NOW });
  assert.equal(run.state, 'cancelled'); assert.equal(called, false); assert.equal(run.baselineStartedAt, null);
});

test('database constraints reject arbitrary states and ready state without evidence', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  const base = { id: randomUUID(), workspaceId: user.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: profileValues(user.workspace.id).profileIdentity, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), createdAt: NOW, stateChangedAt: NOW, updatedAt: NOW };
  await assert.rejects(ctx.database.insert(repairRun).values({ ...base, state: 'browser_chosen' }));
  await assert.rejects(ctx.database.insert(repairRun).values({ ...base, id: randomUUID(), idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineStartedAt: NOW, completedAt: NOW }));
  const createdId = randomUUID();
  await ctx.database.insert(repairRun).values({ ...base, id: createdId, idempotencyKey: randomUUID(), state: 'created' });
  await assert.rejects(ctx.database.insert(repairRunEvent).values({ id: randomUUID(), repairRunId: createdId, fromState: 'created', toState: 'ready_for_investigation', createdAt: NOW }));
});

test('protected start API accepts only an authenticated idempotent intent', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  let receivedKey = '';
  const handlers = createRepairRunHandlers({
    configuration: CONFIGURATION, database: ctx.database, gateway: unusedGateway, resolveContext: async () => user,
    start: async (database, context, gateway, configuration, key) => {
      receivedKey = key;
      return startRepairRun(database, context, gateway, configuration, key, { baselineExecutor: executorFor(), clock: () => NOW });
    },
  });
  const key = randomUUID();
  const response = await handlers.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: key }) }));
  assert.equal(response.status, 303); assert.equal(receivedKey, key);
  assert.match(response.headers.get('location') ?? '', /repairRun=/);
  assert.doesNotMatch(await response.text(), /profileIdentity|commit|installation|token/i);
});

test('start API rejects forged authority fields and arbitrary state', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const user = await authenticated(ctx); await seed(ctx, user);
  let called = false;
  const handlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: ctx.database, gateway: unusedGateway, resolveContext: async () => user, start: async () => { called = true; throw new Error('must not run'); } });
  const response = await handlers.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: randomUUID(), state: 'ready_for_investigation', commit: 'f'.repeat(40), profile: 'e'.repeat(64) }) }));
  assert.equal(response.status, 303); assert.match(response.headers.get('location') ?? '', /invalid_idempotency_key/); assert.equal(called, false);
});

test('start and read APIs reject unauthenticated access and cross-origin mutation', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const handlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: ctx.database, gateway: unusedGateway, resolveContext: async () => { throw new AccessDeniedError('unauthorized'); } });
  const crossOrigin = await handlers.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: 'https://attacker.example' }, body: new URLSearchParams({ idempotencyKey: randomUUID() }) }));
  assert.equal(crossOrigin.status, 403);
  const unauthorized = await handlers.start(new Request('http://localhost:3000/api/repair-runs', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: randomUUID() }) }));
  assert.equal(unauthorized.status, 303); assert.match(unauthorized.headers.get('location') ?? '', /sign-in/);
  assert.equal((await handlers.read(new Request('http://localhost:3000/api/repair-runs/run'), 'run')).status, 401);
});

test('read API returns durable state after initiation and hides another workspace run', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const owner = await authenticated(ctx, 'read-owner'); await seed(ctx, owner);
  const outsider = await authenticated(ctx, 'read-outsider');
  const run = await startRepairRun(ctx.database, owner, unusedGateway, CONFIGURATION, randomUUID(), { baselineExecutor: executorFor(), clock: () => NOW });
  const ownerHandlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: ctx.database, gateway: unusedGateway, resolveContext: async () => owner });
  const response = await ownerHandlers.read(new Request(`http://localhost:3000/api/repair-runs/${run.id}`), run.id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.repairRun.id, run.id); assert.equal(body.repairRun.state, 'ready_for_investigation'); assert.equal(body.repairRun.baseline.evidenceId, run.baselineId);
  assert.doesNotMatch(JSON.stringify(body), /workspaceId|installationId|token|secret/i);
  const outsiderHandlers = createRepairRunHandlers({ configuration: CONFIGURATION, database: ctx.database, gateway: unusedGateway, resolveContext: async () => outsider });
  assert.equal((await outsiderHandlers.read(new Request(`http://localhost:3000/api/repair-runs/${run.id}`), run.id)).status, 404);
});

test('Repair Run orchestration reuses Task 2.6 and contains no sandbox implementation', async () => {
  const source = await readFile('lib/repair-runs/flow.ts', 'utf8');
  assert.match(source, /executeSelectedRepositoryBaseline/);
  assert.doesNotMatch(source, /@vercel\/sandbox|Sandbox\.create|runFrozenRepositoryBaseline|npm ci/);
});
