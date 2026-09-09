import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { executionProfile, githubInstallation, repository, repositoryBaseline } from '../db/schema.ts';
import { AccessDeniedError, resolveAuthenticatedWorkspace, type AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { computeExecutionProfileIdentity, gitBlobSha } from '../lib/execution-profiles/detector.ts';
import type { VerifiedGitHubInstallation } from '../lib/github-app/types.ts';
import { BaselineAuthorityError } from '../lib/repository-baselines/authority.ts';
import { executeSelectedRepositoryBaseline, getCurrentRepositoryBaseline, RepositoryBaselineError } from '../lib/repository-baselines/flow.ts';
import { createRepositoryBaselineHandlers } from '../lib/repository-baselines/handlers.ts';
import type { BaselineEvidence, FrozenBaselineInput, GitHubBaselineGateway } from '../lib/repository-baselines/types.ts';
import { commandEvidence } from '../src/fixture-execution.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-09-09T10:00:00.000Z');
const CONFIG = { appId: 991, appSlug: 'vigilo-dev-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' } as const;
const REPO = { defaultBranch: 'main', fullName: 'octo/private', id: 8101, isPrivate: true, name: 'private', ownerId: 3001, ownerLogin: 'octo' };
const PACKAGE = '{"name":"private"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"private"}}}';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function context(testContext: Awaited<ReturnType<typeof createTestContext>>, githubId = '2001') {
  const user = await saveGithubUser(testContext, githubId);
  const login = await testContext.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace((headers) => testContext.auth.api.getSession({ headers }), testContext.database, login.headers);
}

function readyValues(workspaceId: string) {
  const base = {
    baseCommitSha: COMMIT,
    build: { script: 'build' as const, tool: 'npm' as const },
    githubRepositoryId: REPO.id,
    install: { operation: 'ci' as const, tool: 'npm' as const },
    installationId: 9001,
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
    baseCommitSha: COMMIT, buildScript: 'build', githubRepositoryId: REPO.id,
    installOperation: 'ci', installationId: 9001, lockfileType: 'package-lock', nodeMajor: 24,
    packageJsonBlobSha: base.packageJsonBlobSha, packageJsonContentSha256: base.packageJsonContentSha256,
    packageLockBlobSha: base.packageLockBlobSha, packageLockContentSha256: base.packageLockContentSha256,
    packageManager: 'npm', profileIdentity: computeExecutionProfileIdentity(base), profileVersion: 2,
    runtimeFamily: 'node', status: 'ready', testRunner: 'node-test', testScript: 'test',
    typecheckScript: 'typecheck', workspaceId,
  } as const;
}

async function seed(testContext: Awaited<ReturnType<typeof createTestContext>>, auth: AuthenticatedWorkspace, profile = true) {
  await testContext.database.insert(githubInstallation).values({ accountLogin: 'octo', accountType: 'Organization', githubAccountId: 3001, installationId: 9001, status: 'active', workspaceId: auth.workspace.id });
  await testContext.database.insert(repository).values({ ...REPO, githubRepositoryId: REPO.id, installationId: 9001, workspaceId: auth.workspace.id });
  if (profile) await testContext.database.insert(executionProfile).values(readyValues(auth.workspace.id));
}

class Gateway implements GitHubBaselineGateway {
  calls: string[] = [];
  installation: VerifiedGitHubInstallation = { account: { id: 3001, login: 'octo', type: 'Organization' as const }, appId: 991, appSlug: 'vigilo-dev-test', id: 9001, permissions: { contents: 'read', metadata: 'read' }, suspendedAt: null };
  repository = { ...REPO };
  async getInstallation() { this.calls.push('installation'); return this.installation; }
  async createInstallationAccessToken(input: { installationId: number; repositoryId: number }) {
    assert.deepEqual(input, { installationId: 9001, repositoryId: 8101 });
    this.calls.push('mint:one-repository:contents-read:metadata-read');
    return { accessToken: 'installation-token-sentinel', repository: this.repository };
  }
  async getRepositoryMetadata(token: string) { assert.equal(token, 'installation-token-sentinel'); this.calls.push('metadata'); return this.repository; }
  async downloadRepositoryArchive(input: { accessToken: string; ref: string }) {
    assert.equal(input.accessToken, 'installation-token-sentinel');
    assert.equal(input.ref, COMMIT);
    this.calls.push(`archive:${input.ref}`);
    return Buffer.from('archive-bytes');
  }
  async revokeInstallationAccessToken(token: string) { assert.equal(token, 'installation-token-sentinel'); this.calls.push('revoke'); }
}

function passedEvidence(input: FrozenBaselineInput): BaselineEvidence {
  const completed = commandEvidence(['ci'], 1);
  completed.status = 'completed'; completed.exitCode = 0;
  const tests = commandEvidence(['test'], 1);
  tests.status = 'completed'; tests.exitCode = 0;
  return {
    evidenceVersion: 1, runId: input.runId, workspaceId: input.profile.workspaceId,
    githubRepositoryId: input.profile.githubRepositoryId, installationId: input.profile.installationId,
    profileIdentity: input.profile.profileIdentity, baseCommitSha: input.profile.baseCommitSha,
    archiveSha256: input.archiveSha256,
    sandbox: { name: 'sandbox-safe-name', sessionId: 'sandbox-session', runtime: 'vercel/sandbox/node:24', persistent: false },
    source: { materialized: true, identityBeforeExecution: 'b'.repeat(64), identityAfterExecution: 'b'.repeat(64), unchangedAfterExecution: true },
    credentialsExposure: 'absent', networkPolicyBeforeRepositoryExecution: 'deny-all', install: completed,
    typecheck: null, build: null, test: tests, executionOutcome: 'baseline_passed', overallOutcome: 'baseline_passed',
    cleanup: { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' }, error: null,
    startedAt: input.startedAt, completedAt: NOW, durationMs: 0,
  };
}

test('authoritative flow uses the frozen commit and revokes the read-only repository token before sandbox execution', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const auth = await context(ctx); await seed(ctx, auth);
  const gateway = new Gateway();
  const report = await executeSelectedRepositoryBaseline(ctx.database, auth, gateway, CONFIG, {
    clock: () => NOW, randomId: () => 'baseline-run-1',
    runner: async (input) => {
      assert.equal(gateway.calls.at(-1), 'revoke');
      assert.equal(input.profile.baseCommitSha, COMMIT);
      assert.equal(input.profile.githubRepositoryId, REPO.id);
      assert.equal(input.archive.toString(), 'archive-bytes');
      return passedEvidence(input);
    },
  });
  assert.equal(report.overallOutcome, 'baseline_passed');
  assert.deepEqual(gateway.calls, ['installation', 'mint:one-repository:contents-read:metadata-read', 'metadata', `archive:${COMMIT}`, 'revoke']);
  const [stored] = await ctx.database.select().from(repositoryBaseline);
  assert.equal(stored?.baseCommitSha, COMMIT);
  assert.equal(stored?.profileIdentity, readyValues(auth.workspace.id).profileIdentity);
  assert.doesNotMatch(JSON.stringify(stored), /installation-token-sentinel|private key|DATABASE_URL/);
});

test('missing, unsupported, corrupted, and cross-workspace profile authority fail before source acquisition', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const owner = await context(ctx, '2001'); const other = await context(ctx, '2002');
  await seed(ctx, owner, false);
  for (const auth of [owner, other]) await assert.rejects(
    executeSelectedRepositoryBaseline(ctx.database, auth, new Gateway(), CONFIG, { runner: async (input) => passedEvidence(input) }),
    (error: unknown) => error instanceof BaselineAuthorityError,
  );
  await ctx.database.insert(executionProfile).values({ ...readyValues(owner.workspace.id), profileIdentity: 'f'.repeat(64) });
  await assert.rejects(executeSelectedRepositoryBaseline(ctx.database, owner, new Gateway(), CONFIG),
    (error: unknown) => error instanceof BaselineAuthorityError && error.code === 'profile_corrupt');
});

test('suspended installation and removed repository access fail closed without a baseline row', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const auth = await context(ctx); await seed(ctx, auth);
  const suspended = new Gateway(); suspended.installation = { ...suspended.installation, suspendedAt: NOW.toISOString() };
  await assert.rejects(executeSelectedRepositoryBaseline(ctx.database, auth, suspended, CONFIG),
    (error: unknown) => error instanceof RepositoryBaselineError && error.code === 'installation_unavailable');
  const removed = new Gateway(); removed.createInstallationAccessToken = async () => { throw new Error('not accessible'); };
  await assert.rejects(executeSelectedRepositoryBaseline(ctx.database, auth, removed, CONFIG));
  assert.equal((await ctx.database.select().from(repositoryBaseline)).length, 0);
});

test('protected endpoint ignores forged revision and commands and exposes no credential', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const auth = await context(ctx); await seed(ctx, auth);
  const gateway = new Gateway();
  const handlers = createRepositoryBaselineHandlers({
    configuration: CONFIG, database: ctx.database, gateway, resolveContext: async () => auth,
    execute: (database, context, source, configuration) => executeSelectedRepositoryBaseline(database, context, source, configuration, {
      clock: () => NOW, randomId: () => 'baseline-handler', runner: async (input) => passedEvidence(input),
    }),
  });
  const response = await handlers.run(new Request('http://localhost:3000/api/github/repositories/baseline', {
    method: 'POST', headers: { origin: CONFIG.baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ commit: 'f'.repeat(40), command: 'curl attacker.example' }),
  }));
  assert.equal(response.status, 303);
  assert.equal(gateway.calls.includes(`archive:${COMMIT}`), true);
  assert.doesNotMatch(await response.text(), /installation-token-sentinel|curl|archive-bytes/);
});

test('baseline handlers require same-origin and authenticated workspace', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const handlers = createRepositoryBaselineHandlers({ configuration: CONFIG, database: ctx.database, gateway: new Gateway(), resolveContext: async () => { throw new AccessDeniedError('unauthorized'); } });
  assert.equal((await handlers.run(new Request('http://localhost/api', { method: 'POST', headers: { origin: 'https://attacker.example' } }))).status, 403);
  assert.equal((await handlers.current(new Request('http://localhost/api'))).status, 401);
});

test('current baseline is scoped to the current selected profile and excludes stale evidence', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const auth = await context(ctx); await seed(ctx, auth);
  const gateway = new Gateway();
  await executeSelectedRepositoryBaseline(ctx.database, auth, gateway, CONFIG, { clock: () => NOW, randomId: () => 'baseline-current', runner: async (input) => passedEvidence(input) });
  assert.equal((await getCurrentRepositoryBaseline(ctx.database, auth))?.id, 'baseline-current');
  await ctx.database.update(executionProfile).set({ profileIdentity: 'e'.repeat(64) }).where(eq(executionProfile.githubRepositoryId, REPO.id));
  assert.equal(await getCurrentRepositoryBaseline(ctx.database, auth), null);
});

test('database constraints reject malformed baseline evidence', async (t) => {
  const ctx = await createTestContext(); t.after(() => ctx.client.close());
  const auth = await context(ctx); await seed(ctx, auth);
  await assert.rejects(ctx.database.insert(repositoryBaseline).values({
    archiveSha256: 'not-a-hash', baseCommitSha: COMMIT, cleanupDelete: 'confirmed', cleanupLookup: 'absent', cleanupStop: 'confirmed',
    completedAt: NOW, credentialsExposure: 'absent', durationMs: 0, evidenceVersion: 1, executionOutcome: 'baseline_passed',
    githubRepositoryId: REPO.id, id: 'invalid', installStatus: 'completed', installTimedOut: false, installationId: 9001,
    networkPolicy: 'deny-all', overallOutcome: 'baseline_passed', profileIdentity: 'b'.repeat(64), sandboxName: 'sandbox',
    startedAt: NOW, testStatus: 'completed', testTimedOut: false, workspaceId: auth.workspace.id,
  }));
});
