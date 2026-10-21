import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { computeExecutionProfileIdentity, gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { detectSelectedRepositoryExecutionProfile } from '../lib/execution-profiles/flow.ts';
import type { GitHubExecutionProfileGateway } from '../lib/execution-profiles/types.ts';
import { buildReviewedStagingPlan, type ReviewedStagingInput } from '../lib/external-execution/reviewed-plan.ts';
import { stageReviewedRepairRun, type ReviewedStagingReceipt } from '../lib/external-execution/reviewed-staging.ts';
import { lockExternalExecution } from '../lib/external-execution/business-fence.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { vercelTeamProjectIdentity } from '../lib/external-execution/provider-account.ts';
import { hasRepositorySwitchConflict } from '../lib/github-repositories/switch-guard.ts';
import { createRepairBoss, PgBossReviewedBaselineQueue, REVIEWED_BASELINE_QUEUE, type TransactionalReviewedBaselineQueue } from '../lib/repair-runs/queue.ts';

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error('missing_required_environment:DATABASE_URL');
const configured = new URL(configuredUrl);
if (configured.hostname !== '127.0.0.1' || configured.pathname !== '/vigilo' ||
    !(configured.port === '55432' ||
      (configured.port === '55433' && process.env.VIGILO_DISPOSABLE_NATIVE_POSTGRES === 'true')))
  throw new Error('disposable_test_requires_local_vigilo_postgres');
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });

const RELEASE = 'b'.repeat(40);
const COMMIT = 'a'.repeat(40);
const HASH = 'c'.repeat(64);
const PACKAGE = '{"name":"app"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function scenario(kind: 'identical' | 'conflicting' | 'visibility' | 'expiry_staging' | 'expiry_staging_commit' | 'expiry_reservation_wait' | 'expiry_reservation_transition') {
  const name = `vigilo_reviewed_stage_${randomUUID().replaceAll('-', '')}`;
  const testUrl = new URL(configured); testUrl.pathname = `/${name}`;
  let clientA: ReturnType<typeof postgres> | undefined;
  let clientB: ReturnType<typeof postgres> | undefined;
  let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    clientA = postgres(testUrl.toString(), { max: 1, prepare: false, onnotice: () => {},
      connection: { application_name: 'vigilo-review-stage-a' } });
    clientB = postgres(testUrl.toString(), { max: 1, prepare: false, onnotice: () => {},
      connection: { application_name: 'vigilo-review-stage-b' } });
    const rawDatabaseA = drizzle(clientA, { schema });
    const databaseA = rawDatabaseA as unknown as VigiloDatabase;
    const databaseB = drizzle(clientB, { schema }) as unknown as VigiloDatabase;
    await migrate(rawDatabaseA, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    boss = await createRepairBoss(testUrl.toString(), 'publisher');
    const queue = new PgBossReviewedBaselineQueue(boss);
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const repositoryId = 1411517943;
    const installationId = 159763114;
    const actor: AuthenticatedWorkspace = { sessionId: 'native-test-only',
      user: { id: ownerId, name: 'Test operator', email: 'operator@example.test' }, githubUserId: 'native-test',
      workspace: { id: workspaceId, ownerUserId: ownerId } };
    await databaseA.insert(schema.user).values({ id: ownerId, name: actor.user.name, email: actor.user.email });
    await databaseA.insert(schema.workspace).values({ id: workspaceId, ownerUserId: ownerId });
    await databaseA.insert(schema.githubInstallation).values({ installationId, workspaceId, githubAccountId: 1,
      accountLogin: 'octo', accountType: 'User', status: 'active' });
    await databaseA.insert(schema.repository).values({ githubRepositoryId: repositoryId, workspaceId, installationId,
      ownerId: 1, ownerLogin: 'octo', name: 'fixture', fullName: 'octo/fixture', isPrivate: false, isSelected: true, defaultBranch: 'main' });
    const profileInput = {
      baseCommitSha: COMMIT, build: { script: 'build' as const, tool: 'npm' as const }, githubRepositoryId: repositoryId,
      install: { operation: 'ci' as const, tool: 'npm' as const }, installationId,
      lockfileType: 'package-lock' as const, nodeMajor: 24 as const,
      packageJsonBlobSha: gitBlobSha(PACKAGE), packageJsonContentSha256: sha256(PACKAGE),
      packageLockBlobSha: gitBlobSha(LOCK), packageLockContentSha256: sha256(LOCK), packageManager: 'npm' as const,
      profileVersion: 2 as const, runtimeFamily: 'node' as const,
      test: { script: 'test' as const, tool: 'npm' as const }, testRunner: 'node-test' as const,
      typecheck: { script: 'typecheck' as const, tool: 'npm' as const }, workspaceId,
    };
    const profileIdentity = computeExecutionProfileIdentity(profileInput);
    await databaseA.insert(schema.executionProfile).values({ githubRepositoryId: repositoryId, workspaceId, installationId,
      profileVersion: 2, profileIdentity, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24,
      packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck',
      buildScript: 'build', testScript: 'test', testRunner: 'node-test', status: 'ready',
      packageJsonBlobSha: profileInput.packageJsonBlobSha, packageJsonContentSha256: profileInput.packageJsonContentSha256,
      packageLockBlobSha: profileInput.packageLockBlobSha, packageLockContentSha256: profileInput.packageLockContentSha256 });
    const input: ReviewedStagingInput = { kind: 'm77b_repair_v1', repairRunId: randomUUID(), idempotencyKey: randomUUID(),
      githubRepositoryId: repositoryId, installationId, profileIdentity, baseCommitSha: COMMIT, authorizedReleaseSha: RELEASE,
      objective: 'Investigate the controlled failing test.', expectedSourceIdentity: HASH,
      expiresAt: new Date(Date.now() + (kind === 'expiry_reservation_transition' ? 10_000 : kind.startsWith('expiry_') ? 7_000 : 3_600_000)).toISOString(), providerAccounts: {
        googleProjectId: 'gen-lang-client-0469095642', vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA',
        vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM',
      } };
    const second = kind === 'identical' ? input : { ...input, repairRunId: randomUUID(), idempotencyKey: randomUUID() };
    const identity = (value: ReviewedStagingInput) => buildReviewedStagingPlan({ workspaceId, reviewerUserId: ownerId }, value).planIdentity;
    const options = { runtimeReleaseSha: RELEASE, configuredProviderAccounts: input.providerAccounts };
    if (kind.startsWith('expiry_')) {
      const expiry = new Date(input.expiresAt);
      const waitForExpiry = async () => {
        for (let attempt = 0; attempt < 450; attempt += 1) {
          const [row] = await admin`select clock_timestamp() >= ${input.expiresAt}::timestamptz as expired`;
          if (row?.expired) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('disposable_authority_expiry_timeout');
      };
      const waitForBlocked = async () => {
        for (let attempt = 0; attempt < 250; attempt += 1) {
          const [row] = await admin`select wait_event_type as type from pg_stat_activity
            where datname = ${name} and application_name = 'vigilo-review-stage-b'`;
          if (row?.type === 'Lock') return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('expected_independent_connection_lock_wait');
      };
      const result = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
      if (kind === 'expiry_staging' || kind === 'expiry_staging_commit') {
        let pending!: ReturnType<typeof result<ReviewedStagingReceipt>>;
        if (kind === 'expiry_staging') {
          await clientA.begin(async (transaction) => {
            await transaction`select id from external_execution_semaphore where id = 'global' for update`;
            pending = result(stageReviewedRepairRun(databaseB, actor, input, identity(input), queue, options));
            await waitForBlocked();
            await waitForExpiry();
          });
        } else {
          let queued!: () => void;
          let release!: () => void;
          const jobQueued = new Promise<void>((resolve) => { queued = resolve; });
          const released = new Promise<void>((resolve) => { release = resolve; });
          const pausedQueue: TransactionalReviewedBaselineQueue = { enqueueReviewedBaseline: async (transaction, payload) => {
            const id = await queue.enqueueReviewedBaseline(transaction, payload);
            queued();
            await released;
            return id;
          } };
          pending = result(stageReviewedRepairRun(databaseB, actor, input, identity(input), pausedQueue, options));
          await jobQueued;
          await waitForExpiry();
          release();
        }
        const outcome = await pending;
        assert.ok('error' in outcome, 'staging must reject after authority expires across the lock');
        assert.equal((await databaseA.select().from(schema.repairRun)).length, 0);
        assert.equal((await databaseA.select().from(schema.repairRunSourceCheckpoint)).length, 0);
        assert.equal((await databaseA.select().from(schema.executionBudgetGrant)).length, 0);
        assert.equal((await databaseA.select().from(schema.repairRunEvent)).length, 0);
        assert.equal(await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId), null);
      } else {
        await stageReviewedRepairRun(databaseA, actor, input, identity(input), queue, options);
        let reachedFinalBarrier = false;
        const authority = new DurableExternalExecutionAuthorizer(databaseB, {
          runtimeReleaseSha: RELEASE,
          afterPostLockValidation: async () => {
            reachedFinalBarrier = true;
            if (kind !== 'expiry_reservation_transition') return;
            validated(); await releaseValidation;
          },
        });
        const scope = { workspaceId, repairRunId: input.repairRunId, githubRepositoryId: repositoryId,
          baseCommitSha: COMMIT, operationCategory: 'sandbox_baseline' as const, providerId: 'vercel' };
        const amounts = { logicalRequests: 1, providerAttempts: 1, inputTokens: 0, outputTokens: 0,
          sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' as const,
          verificationAttempts: 0, repairLoopIterations: 0 };
        let validated!: () => void;
        const postLockValidation = new Promise<void>((resolve) => { validated = resolve; });
        let release!: () => void;
        const releaseValidation = new Promise<void>((resolve) => { release = resolve; });
        const reserve = () => result(authority.reserve({ scope, amounts,
          providerAccountIdentity: vercelTeamProjectIdentity(input.providerAccounts.vercelTeamId, input.providerAccounts.vercelProjectId),
          sandbox: { name: 'disposable-only', teamId: input.providerAccounts.vercelTeamId,
            projectId: input.providerAccounts.vercelProjectId } }));
        let pending!: ReturnType<typeof reserve>;
        if (kind === 'expiry_reservation_wait') {
          await clientA.begin(async (transaction) => {
            await transaction`select id from external_execution_semaphore where id = 'global' for update`;
            pending = reserve();
            await waitForBlocked();
            await waitForExpiry();
          });
        } else {
          pending = reserve();
          const arrival = await Promise.race([
            postLockValidation.then(() => 'hook'),
            pending.then((outcome) => `settled:${'error' in outcome ? String(outcome.error) : 'success'}`),
            new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
          ]);
          assert.equal(arrival, 'hook', 'reservation must reach the post-validation barrier');
          await waitForExpiry();
          release();
        }
        const outcome = await pending;
        assert.ok('error' in outcome, 'reservation must reject after authority expires');
        assert.match(String(outcome.error), /execution_authority_expired|execution_authority_mismatch/, `reached final barrier: ${reachedFinalBarrier}`);
        assert.equal((await databaseA.select().from(schema.externalExecutionReservation)).length, 0);
        assert.equal((await databaseA.select().from(schema.externalExecutionEvent)).length, 0);
        assert.equal((await databaseA.select().from(schema.externalExecutionLease)).length, 0);
      }
      return true;
    } else if (kind === 'visibility') {
      let signalQueued!: () => void;
      const queued = new Promise<void>((resolve) => { signalQueued = resolve; });
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
      const pausedQueue: TransactionalReviewedBaselineQueue = { enqueueReviewedBaseline: async (transaction, payload) => {
        const id = await queue.enqueueReviewedBaseline(transaction, payload);
        signalQueued();
        await commitGate;
        return id;
      } };
      const staging = stageReviewedRepairRun(databaseA, actor, input, identity(input), pausedQueue, options);
      try {
        await queued;
        assert.equal(await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId), null);
        const switchCheck = databaseB.transaction(async (transaction) => {
          await lockExternalExecution(transaction);
          const [locked] = await transaction.select().from(schema.workspace)
            .where(eq(schema.workspace.id, workspaceId)).for('update').limit(1);
          assert.ok(locked);
          return hasRepositorySwitchConflict(transaction, workspaceId, new Date());
        });
        const packageJson = JSON.stringify({ engines: { node: '24.x' }, name: 'fixture', packageManager: 'npm@11.6.2',
          scripts: { build: 'tsc', test: 'node --test', typecheck: 'tsc --noEmit' }, version: '1.0.0' });
        const packageLock = JSON.stringify({ lockfileVersion: 3, name: 'fixture',
          packages: { '': { name: 'fixture', version: '1.0.0' } }, version: '1.0.0' });
        const files = { 'package.json': { content: packageJson, sha: gitBlobSha(packageJson) },
          'package-lock.json': { content: packageLock, sha: gitBlobSha(packageLock) } };
        const metadata = { defaultBranch: 'main', fullName: 'octo/fixture', id: repositoryId,
          isPrivate: false, name: 'fixture', ownerId: 1, ownerLogin: 'octo' };
        const fakeGateway: GitHubExecutionProfileGateway = {
          getInstallation: async () => ({ id: installationId, appId: 991, appSlug: 'vigilo-test',
            account: { id: 1, login: 'octo', type: 'User' }, permissions: { contents: 'read', metadata: 'read' }, suspendedAt: null }),
          createInstallationAccessToken: async () => ({ accessToken: 'disposable-test-token', repository: metadata }),
          getRepositoryMetadata: async () => metadata,
          resolveBranchCommit: async () => COMMIT,
          getRepositoryRoot: async () => Object.entries(files).map(([path, file]) => ({
            name: path, path, sha: file.sha, size: file.content.length, type: 'file' as const,
          })),
          getRepositoryFile: async ({ path }) => files[path],
          revokeInstallationAccessToken: async () => {},
        };
        const profileRefresh = detectSelectedRepositoryExecutionProfile(databaseB, actor, fakeGateway,
          { appId: 991, appSlug: 'vigilo-test', clientId: 'Iv1.disposable', baseUrl: 'http://localhost:3000' })
          .then(() => 'unexpected_success', (error: unknown) => error instanceof Error ? error.message : 'unexpected_failure');
        releaseCommit();
        await staging;
        assert.equal(await switchCheck, true);
        assert.equal(await profileRefresh, 'repository_state_changed');
        const [profileAfter] = await databaseA.select().from(schema.executionProfile)
          .where(eq(schema.executionProfile.githubRepositoryId, repositoryId));
        assert.equal(profileAfter?.profileIdentity, profileIdentity);
      } finally { releaseCommit(); }
    } else {
      const results = await Promise.allSettled([
        stageReviewedRepairRun(databaseA, actor, input, identity(input), queue, options),
        stageReviewedRepairRun(databaseB, actor, second, identity(second), queue, options),
      ]);
      const successes = results.filter((result) => result.status === 'fulfilled');
      if (kind === 'identical') {
        assert.equal(successes.length, 2, results.map((result) => result.status === 'rejected' ? String(result.reason) : 'ok').join(', '));
        assert.deepEqual((results[0] as PromiseFulfilledResult<unknown>).value, (results[1] as PromiseFulfilledResult<unknown>).value);
      } else {
        assert.equal(successes.length, 1);
        assert.match((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.message, /reviewed_staging_conflict/);
      }
    }
    assert.equal((await databaseA.select().from(schema.repairRun)).length, 1);
    assert.equal((await databaseA.select().from(schema.repairRunSourceCheckpoint)).length, 1);
    assert.equal((await databaseA.select().from(schema.executionBudgetGrant)).length, 6);
    const [run] = await databaseA.select().from(schema.repairRun);
    assert.ok(run);
    assert.ok(await boss.getJobById(REVIEWED_BASELINE_QUEUE, run.id));
    assert.equal((await databaseA.select().from(schema.externalExecutionReservation)).length, 0);
    return true;
  } finally {
    if (boss) await boss.stop({ graceful: false });
    if (clientA) await clientA.end();
    if (clientB) await clientB.end();
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database if exists "${name}"`);
  }
}

try {
  const identical = await scenario('identical');
  const conflicting = await scenario('conflicting');
  const visibility = await scenario('visibility');
  const expiryStaging = await scenario('expiry_staging');
  const expiryStagingCommit = await scenario('expiry_staging_commit');
  const expiryReservationWait = await scenario('expiry_reservation_wait');
  const expiryReservationTransition = await scenario('expiry_reservation_transition');
  assert.equal(identical && conflicting && visibility && expiryStaging && expiryStagingCommit && expiryReservationWait && expiryReservationTransition, true);
  process.stdout.write(JSON.stringify({ nativeIndependentConnectionScenarios: 7, result: 'passed' }) + '\n');
} finally { await admin.end(); }
