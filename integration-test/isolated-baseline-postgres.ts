import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { computeExecutionProfileIdentity, gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { buildReviewedStagingPlan, type ReviewedStagingInput } from '../lib/external-execution/reviewed-plan.ts';
import { assertReviewedPlanIntegrity } from '../lib/external-execution/reviewed-plan-integrity.ts';
import { retireReviewedStagedRun } from '../lib/external-execution/reviewed-retirement.ts';
import { readHistoricalRetirement, retireExactHistoricalRun } from '../lib/external-execution/local-retirement.ts';
import { stageReviewedRepairRun } from '../lib/external-execution/reviewed-staging.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { claimExactReviewedBaselineJob, type ExactBaselineRequest } from '../lib/repair-runs/exact-baseline-job.ts';
import { claimExactPhaseJob, type ExactPhaseRequest } from '../lib/repair-runs/exact-phase-job.ts';
import { assertSourceReadAuthority, executeExactPhaseOnce } from '../lib/repair-runs/exact-phase-service.ts';
import { AI_CANDIDATE_GENERATION_QUEUE, createRepairBoss, PgBossAiInvestigationQueue, PgBossAiCandidateGenerationQueue, PgBossCandidateVerificationQueue, PgBossInvestigationQueue, PgBossRepairLoopQueue, PgBossRepairQueue, PgBossReviewedBaselineQueue, REPAIR_BASELINE_QUEUE, REVIEWED_BASELINE_QUEUE, REPAIR_WORK_OPTIONS } from '../lib/repair-runs/queue.ts';
import { createInvestigation } from '../lib/investigations/flow.ts';
import { processInvestigationJob } from '../lib/investigations/worker.ts';
import { startAiInvestigation } from '../lib/ai-investigations/flow.ts';
import { startRepairLoop } from '../lib/repair-loops/flow.ts';
import { executeExactBaselineOnce } from '../lib/repair-runs/one-shot-service.ts';
import { processRepairJob } from '../lib/repair-runs/worker.ts';
import { getReadinessResult } from '../lib/operations/readiness.ts';
import { PostgresWorkerHeartbeatStore, WorkerHeartbeatLifecycle } from '../lib/operations/worker-heartbeat.ts';
import { canonicalRepairQueues } from '../lib/operations/queues.ts';
import { createCanonicalRepairSupervisor, startCanonicalRepairSupervision } from '../lib/operations/queue-supervision.ts';

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
const HISTORICAL_RELEASE = 'fb373deb5a50f4bba38ea7d8c9af4b2fc581e24f';
const COMMIT = 'a'.repeat(40);
const HASH = 'c'.repeat(64);
const PACKAGE = '{"name":"app"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function waitForDatabaseExpiry(expiresAt: string): Promise<void> {
  for (let i = 0; i < 350; i++) {
    const [time] = await admin<{ expired: boolean }[]>`
      select clock_timestamp() >= ${expiresAt}::timestamptz as expired
    `;
    if (time?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('database authority clock did not cross grant expiry');
}

async function scenario(kind: 'claim' | 'signal_blocked_claim' | 'signal_after_claim' | 'authority_denied' | 'expiry_before_claim' | 'expiry_while_waiting' | 'expiry_before_transition' | 'unreviewed_checkpoint' | 'queue_policy' | 'retire' | 'retire_attempt' | 'retire_reservation' | 'historical_retire' | 'local_retire' | 'local_retire_reviewed' | 'malformed_normal' | 'race' | 'general_race' | 'supervision_characterization' | 'supervision' | 'supervision_blocked' | 'supervision_recovery' | 'execute' | 'execute_failure' | 'phase_context' | 'phase_context_race' | 'phase_context_revoked' | 'phase_context_late_revocation' | 'phase_context_expired' | 'phase_context_service' | 'phase_context_interrupted' | 'phase_ai' | 'phase_loop' | 'phase_generation' | 'phase_verification') {
  const name = `vigilo_one_shot_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(configured); url.pathname = `/${name}`;
  let first: ReturnType<typeof postgres> | undefined;
  let second: ReturnType<typeof postgres> | undefined;
  let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;
  let supervisor: ReturnType<typeof startCanonicalRepairSupervision> | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    first = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
    second = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const raw = drizzle(first, { schema });
    const db = raw as unknown as VigiloDatabase;
    const db2 = drizzle(second, { schema }) as unknown as VigiloDatabase;
    await migrate(raw, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    boss = await createRepairBoss(url.toString(), ['general_race', 'supervision_characterization', 'supervision', 'supervision_blocked', 'supervision_recovery'].includes(kind) ? 'worker' : 'publisher');
    const ownerId = randomUUID(); const workspaceId = randomUUID();
    const repositoryId = 1411517943; const installationId = 159763114;
    const actor: AuthenticatedWorkspace = { sessionId: 'native-test-only',
      user: { id: ownerId, name: 'Test operator', email: 'operator@example.test' }, githubUserId: 'native-test',
      workspace: { id: workspaceId, ownerUserId: ownerId } };
    await db.insert(schema.user).values({ id: ownerId, name: actor.user.name, email: actor.user.email });
    await db.insert(schema.workspace).values({ id: workspaceId, ownerUserId: ownerId });
    await db.insert(schema.githubInstallation).values({ installationId, workspaceId, githubAccountId: 1,
      accountLogin: 'octo', accountType: 'User', status: 'active' });
    await db.insert(schema.repository).values({ githubRepositoryId: repositoryId, workspaceId, installationId,
      ownerId: 1, ownerLogin: 'octo', name: 'fixture', fullName: 'octo/fixture', isPrivate: false,
      isSelected: true, defaultBranch: 'main' });
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
    await db.insert(schema.executionProfile).values({ githubRepositoryId: repositoryId, workspaceId, installationId,
      profileVersion: 2, profileIdentity, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24,
      packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck',
      buildScript: 'build', testScript: 'test', testRunner: 'node-test', status: 'ready',
      packageJsonBlobSha: profileInput.packageJsonBlobSha, packageJsonContentSha256: profileInput.packageJsonContentSha256,
      packageLockBlobSha: profileInput.packageLockBlobSha, packageLockContentSha256: profileInput.packageLockContentSha256 });
    const shortExpiry = kind.startsWith('expiry_') || kind === 'local_retire_reviewed' || kind === 'phase_context_expired';
    const input: ReviewedStagingInput = { kind: 'm77b_repair_v1', repairRunId: randomUUID(), idempotencyKey: randomUUID(),
      githubRepositoryId: repositoryId, installationId, profileIdentity, baseCommitSha: COMMIT,
      authorizedReleaseSha: ['historical_retire', 'local_retire'].includes(kind) ? HISTORICAL_RELEASE : RELEASE,
      objective: 'Investigate the controlled failing test.', expectedSourceIdentity: HASH,
      expiresAt: new Date(Date.now() + (shortExpiry ? 6_000 : 3_600_000)).toISOString(), providerAccounts: {
        googleProjectId: 'gen-lang-client-0469095642', vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA',
        vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM',
      } };
    const plan = buildReviewedStagingPlan({ workspaceId, reviewerUserId: ownerId }, input);
    const reviewedQueue = new PgBossReviewedBaselineQueue(boss);
    const oldQueue = new PgBossRepairQueue(boss);
    const stagingQueue = ['historical_retire', 'local_retire'].includes(kind)
      ? { enqueueReviewedBaseline: oldQueue.enqueue.bind(oldQueue) } : reviewedQueue;
    const staged = await stageReviewedRepairRun(db, actor, input, plan.planIdentity, stagingQueue,
      { runtimeReleaseSha: input.authorizedReleaseSha, configuredProviderAccounts: input.providerAccounts });
    const request: ExactBaselineRequest = { repairRunId: input.repairRunId, jobId: input.repairRunId,
      planIdentity: plan.planIdentity, repositoryId, revision: COMMIT, releaseSha: input.authorizedReleaseSha };
    const retirement = { repairRunId: input.repairRunId, planIdentity: plan.planIdentity,
      accountGrantIdentity: plan.accountGrant.grantIdentity, repositoryId, revision: COMMIT,
      authorizedReleaseSha: input.authorizedReleaseSha };
    if (kind === 'claim') {
      const store = new PostgresWorkerHeartbeatStore(first);
      await assert.rejects(first`
        insert into operational_worker_heartbeat
          (id, service, release_sha, expected_schema_version, registered_queues, target_repair_run_id, target_job_id, state)
        values (${randomUUID()}, 'vigilo-baseline-one-shot', ${RELEASE}, '0026', '["repair-baseline-v1"]'::jsonb,
          ${input.repairRunId}, ${input.repairRunId}, 'starting')
      `, /operational_worker_heartbeat_queues_check/);
      await assert.rejects(first`
        insert into operational_worker_heartbeat
          (id, service, release_sha, expected_schema_version, registered_queues, target_repair_run_id, target_job_id, state)
        values (${randomUUID()}, 'vigilo-baseline-one-shot', ${RELEASE}, '0026', '["repair-baseline-reviewed-v1"]'::jsonb,
          ${input.repairRunId}, ${null}, 'starting')
      `, /operational_worker_heartbeat_queues_check/);
      await assert.rejects(first`
        insert into operational_worker_heartbeat
          (id, service, release_sha, expected_schema_version, registered_queues, target_repair_run_id, target_job_id, state)
        values (${randomUUID()}, 'vigilo-baseline-one-shot', ${RELEASE}, '0026', '["repair-baseline-reviewed-v1"]'::jsonb,
          ${null}, ${input.repairRunId}, 'starting')
      `, /operational_worker_heartbeat_queues_check/);
      const oneShot = new WorkerHeartbeatLifecycle(store, { id: randomUUID(), releaseSha: RELEASE,
        kind: 'baseline-one-shot', targetRepairRunId: input.repairRunId, targetJobId: input.repairRunId });
      await oneShot.start(); await oneShot.ready();
      const readinessEnvironment = { DATABASE_URL: url.toString(), VIGILO_RELEASE_SHA: RELEASE };
      assert.equal((await getReadinessResult(readinessEnvironment)).body.reason, 'worker_missing');
      await assert.rejects(first`
        insert into operational_worker_heartbeat
          (id, service, release_sha, expected_schema_version, registered_queues, target_repair_run_id, target_job_id, state)
        values (${randomUUID()}, 'vigilo-baseline-one-shot', ${RELEASE}, '0026', '["repair-baseline-reviewed-v1"]'::jsonb,
          ${input.repairRunId}, ${input.repairRunId}, 'starting')
      `, /operational_one_shot_live_target_unique/);
      await assert.rejects(first`
        insert into operational_worker_heartbeat
          (id, service, release_sha, expected_schema_version, registered_queues, target_repair_run_id, target_job_id, state)
        values (${randomUUID()}, 'vigilo-baseline-one-shot', ${RELEASE}, '0026', '["repair-baseline-reviewed-v1"]'::jsonb,
          ${input.repairRunId}, ${randomUUID()}, 'starting')
      `, /operational_worker_heartbeat_queues_check/);
      const general = new WorkerHeartbeatLifecycle(store, { id: randomUUID(), releaseSha: RELEASE });
      await general.start(); await general.ready();
      assert.equal((await getReadinessResult(readinessEnvironment)).status, 200);
      await assert.rejects(claimExactReviewedBaselineJob(db, request, RELEASE));
      await general.draining(); await general.stopped();
      for (const changed of [
        { jobId: randomUUID() }, { repairRunId: randomUUID(), jobId: randomUUID() },
        { repositoryId: repositoryId + 1 }, { revision: 'd'.repeat(40) },
        { releaseSha: 'd'.repeat(40) }, { planIdentity: 'd'.repeat(64) },
      ]) await assert.rejects(claimExactReviewedBaselineJob(db, { ...request, ...changed }, RELEASE));
      const unrelatedJob = randomUUID();
      await boss.send(REPAIR_BASELINE_QUEUE, { version: 1, repairRunId: unrelatedJob }, { id: unrelatedJob });
      const results = await Promise.allSettled([
        claimExactReviewedBaselineJob(db, request, RELEASE), claimExactReviewedBaselineJob(db2, request, RELEASE),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1,
        JSON.stringify(results.map((result) => result.status === 'rejected'
          ? { name: result.reason?.name, code: result.reason?.code,
            ...(result.reason?.name === 'TypeError' ? { message: result.reason.message } : {}) } : { status: result.status })));
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const requestedJob = await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId);
      const unrelated = await boss.getJobById(REPAIR_BASELINE_QUEUE, unrelatedJob);
      assert.equal(requestedJob?.state, 'active');
      assert.equal(unrelated?.state, 'created');
      await assert.rejects(claimExactReviewedBaselineJob(db, request, RELEASE));
      assert.equal((await boss.complete(REVIEWED_BASELINE_QUEUE, request.jobId) as { affected?: number }).affected, 1);
      await assert.rejects(claimExactReviewedBaselineJob(db, request, RELEASE));
      await oneShot.draining(); await oneShot.stopped();
    } else if (kind === 'signal_blocked_claim') {
      const directory = await mkdtemp(join(tmpdir(), 'vigilo-exact-signal-'));
      const keyPath = join(directory, 'test-key.pem');
      const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
      await writeFile(keyPath, key, { mode: 0o600 });
      let releaseLock!: () => void;
      let lockReady!: () => void;
      const held = new Promise<void>((resolve) => { releaseLock = resolve; });
      const ready = new Promise<void>((resolve) => { lockReady = resolve; });
      const locking = first.begin(async (connection) => {
        await connection`select id from external_execution_semaphore where id = 'global' for update`;
        lockReady();
        await held;
      });
      let child: ReturnType<typeof spawn> | undefined;
      try {
        await ready;
        child = spawn(process.execPath, ['--import', 'tsx', 'worker/baseline-once.ts',
          '--repair-run', request.repairRunId, '--job', request.jobId, '--plan-identity', request.planIdentity,
          '--repository-id', String(request.repositoryId), '--revision', request.revision, '--release', request.releaseSha], {
          cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, DATABASE_URL: url.toString(), VIGILO_RELEASE_SHA: RELEASE,
            GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 'vigilo-test', GITHUB_APP_CLIENT_ID: 'Iv1.test',
            GITHUB_APP_PRIVATE_KEY_PATH: keyPath, VIGILO_DISPOSABLE_NATIVE_POSTGRES: 'true' },
        });
        let childOutput = '';
        child.stdout!.resume();
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { childOutput += chunk.slice(0, 500); });
        let waiting = false;
        for (let i = 0; i < 500; i++) {
          const [activity] = await second<{ waiting: boolean }[]>`
            select exists(select 1 from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and cardinality(pg_blocking_pids(pid)) > 0
                and query like '%external_execution_semaphore%') as waiting`;
          if (activity?.waiting) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const heartbeatCount = (await db.select().from(schema.operationalWorkerHeartbeat)).length;
        assert.equal(waiting, true, `exact claimant must be waiting on the held PostgreSQL lock: child=${childOutput} heartbeatRows=${heartbeatCount}`);
        const activeChild = child;
        const exit = new Promise<number | null>((resolve, reject) => {
          const deadline = setTimeout(() => { activeChild.kill('SIGKILL'); reject(new Error('blocked_exact_claim_did_not_exit')); }, 12_000);
          activeChild.once('error', (error) => { clearTimeout(deadline); reject(error); });
          activeChild.once('close', (code) => { clearTimeout(deadline); resolve(code); });
        });
        activeChild.kill('SIGTERM');
        assert.equal(await exit, 1);
        assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
        assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
        assert.equal((await db.select().from(schema.repositoryBaseline)).length, 0);
      } finally {
        child?.kill('SIGKILL');
        releaseLock();
        await locking;
        await rm(directory, { recursive: true, force: true });
      }
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
    } else if (kind === 'signal_after_claim') {
      const shutdown = new AbortController();
      let transportCalls = 0;
      await assert.rejects(executeExactBaselineOnce(db, boss, request, RELEASE, {
        database: db, configuration: {} as never,
        gateway: { createInstallationAccessToken: async () => { transportCalls++; throw new Error('transport_forbidden'); } } as never,
        logger: { write: () => {} },
      }, shutdown.signal, { afterClaim: () => shutdown.abort() }));
      assert.equal(transportCalls, 0);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'active');
      assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
      assert.equal((await db.select().from(schema.repositoryBaseline)).length, 0);
      assert.equal((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, request.repairRunId)))[0]?.state, 'created');
    } else if (kind === 'expiry_before_claim') {
      await waitForDatabaseExpiry(input.expiresAt);
      await assert.rejects(claimExactReviewedBaselineJob(db, request, RELEASE));
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
      assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
      assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
    } else if (kind === 'expiry_while_waiting') {
      let releaseLock!: () => void;
      let lockAcquired!: () => void;
      const released = new Promise<void>((resolve) => { releaseLock = resolve; });
      const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
      const lockTransaction = first.begin(async (connection) => {
        await connection`select id from external_execution_semaphore where id = 'global' for update`;
        lockAcquired();
        await released;
      });
      try {
        await acquired;
        const [connectionIdentity] = await second<{ pid: number }[]>`select pg_backend_pid() as pid`;
        assert.ok(connectionIdentity);
        const pid = connectionIdentity.pid;
        const pendingClaim = claimExactReviewedBaselineJob(db2, request, RELEASE);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const [activity] = await admin<{ blocking: number[] }[]>`
            select pg_blocking_pids(${pid}) as blocking from pg_stat_activity where pid = ${pid}
          `;
          if (activity?.blocking.length) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(waiting, true, 'claim must be waiting on the held global authority lock');
        await waitForDatabaseExpiry(input.expiresAt);
        releaseLock();
        await lockTransaction;
        await assert.rejects(pendingClaim);
        assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
        assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
        assert.equal((await db.select().from(schema.repositoryBaseline)).length, 0);
        assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
        assert.equal((await db.select().from(schema.externalExecutionEvent)).length, 0);
        assert.equal((await db.select().from(schema.operationalWorkerHeartbeat)).length, 0);
        assert.equal((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, request.repairRunId)))[0]?.state, 'created');
      } finally {
        releaseLock();
        await lockTransaction;
      }
    } else if (kind === 'expiry_before_transition') {
      let validationReached!: () => void;
      let releaseTransition!: () => void;
      const reached = new Promise<void>((resolve) => { validationReached = resolve; });
      const released = new Promise<void>((resolve) => { releaseTransition = resolve; });
      const pendingClaim = claimExactReviewedBaselineJob(db2, request, RELEASE, {
        afterPostLockValidation: async () => { validationReached(); await released; },
      });
      try {
        await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('validation_barrier_not_reached')), 3_000))]);
        await waitForDatabaseExpiry(input.expiresAt);
        releaseTransition();
        await assert.rejects(pendingClaim);
        assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
        assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
        assert.equal((await db.select().from(schema.repositoryBaseline)).length, 0);
        assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
        assert.equal((await db.select().from(schema.externalExecutionEvent)).length, 0);
        assert.equal((await db.select().from(schema.operationalWorkerHeartbeat)).length, 0);
        assert.equal((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, request.repairRunId)))[0]?.state, 'created');
      } finally { releaseTransition(); }
    } else if (kind === 'unreviewed_checkpoint') {
      // A historical-style checkpoint must never be accepted merely because
      // its hash matches the operator argument. Inject only in a disposable DB.
      const historicalHash = 'd'.repeat(64);
      await first.unsafe('alter table repair_run_source_checkpoint disable trigger user');
      try {
        await first.unsafe('update repair_run_source_checkpoint set plan_identity = $1 where repair_run_id = $2',
          [historicalHash, input.repairRunId]);
      } finally {
        await first.unsafe('alter table repair_run_source_checkpoint enable trigger user');
      }
      await assert.rejects(claimExactReviewedBaselineJob(db, { ...request, planIdentity: historicalHash }, RELEASE));
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
    } else if (kind === 'queue_policy') {
      await first.unsafe("update pgboss.queue set policy = 'singleton' where name = 'repair-baseline-reviewed-v1'");
      await assert.rejects(claimExactReviewedBaselineJob(db, request, RELEASE));
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
    } else if (kind === 'authority_denied') {
      const [grant] = await db.select({ id: schema.executionBudgetGrant.id }).from(schema.executionBudgetGrant)
        .where(eq(schema.executionBudgetGrant.repairRunId, input.repairRunId)).limit(1);
      assert.ok(grant);
      await db.insert(schema.executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: grant.id,
        reasonCode: 'operator_revoked', revokedBy: ownerId });
      await assert.rejects(claimExactReviewedBaselineJob(db, request, RELEASE));
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
    } else if (kind === 'execute' || kind === 'execute_failure' || kind.startsWith('phase_')) {
      await db.insert(schema.account).values({ id: randomUUID(), issuer: 'github', accountId: 'native-test',
        providerId: 'github', userId: ownerId });
      const sentinels = new Map<string, string>();
      for (const queueName of canonicalRepairQueues.filter((queue) => queue !== REPAIR_BASELINE_QUEUE)) {
        const id = randomUUID();
        assert.equal(await boss.send(queueName, { sentinel: true }, { id }), id);
        sentinels.set(queueName, id);
      }
      let baselineCalls = 0;
      const alreadyAborted = new AbortController(); alreadyAborted.abort();
      await assert.rejects(executeExactBaselineOnce(db, boss, request, RELEASE, {} as never, alreadyAborted.signal));
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, request.jobId))?.state, 'created');
      const receipt = await executeExactBaselineOnce(db, boss, request, RELEASE, {
        database: db,
        configuration: { appId: 991, appSlug: 'test', clientId: 'Iv1.test', baseUrl: 'http://localhost:3000' },
        gateway: {} as never, logger: { write: () => {} },
        executionAuthority: new DurableExternalExecutionAuthorizer(db, { runtimeReleaseSha: RELEASE }),
        baselineExecutor: (async (_database: unknown, _context: unknown, _gateway: unknown,
          _config: unknown, options: { evidenceId: string }) => {
          baselineCalls++;
          if (kind === 'execute_failure') throw new Error('inert_injected_failure');
          const at = new Date();
          const [evidence] = await db.insert(schema.repositoryBaseline).values({ id: options.evidenceId,
            workspaceId, githubRepositoryId: repositoryId, installationId, evidenceVersion: 1,
            profileIdentity, baseCommitSha: COMMIT, archiveSha256: '3'.repeat(64),
            sandboxName: 'native-inert-baseline', sourceIdentityBefore: HASH,
            sourceIdentityAfter: HASH, sourceUnchanged: true, credentialsExposure: 'absent',
            networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false,
            typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false,
            buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false,
            testStatus: 'failed', testExitCode: 1, testTimedOut: false, executionOutcome: 'test_failed',
            overallOutcome: 'test_failed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed',
            cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'npm_command_failed',
            startedAt: at, completedAt: at, durationMs: 1 }).returning();
          assert.ok(evidence);
          return { evidenceVersion: 1, runId: input.repairRunId, workspaceId, githubRepositoryId: repositoryId,
            installationId, profileIdentity, baseCommitSha: COMMIT, archiveSha256: '3'.repeat(64),
            sandbox: { name: 'native-inert-baseline', sessionId: null, runtime: 'node', persistent: false },
            source: { materialized: true, identityBeforeExecution: HASH, identityAfterExecution: HASH,
              unchangedAfterExecution: true }, credentialsExposure: 'absent',
            networkPolicyBeforeRepositoryExecution: 'deny-all', install: { status: 'completed' },
            typecheck: { status: 'completed' }, build: { status: 'completed' }, test: { status: 'failed' },
            executionOutcome: 'test_failed', overallOutcome: 'test_failed',
            cleanup: { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' },
            error: { phase: 'test', code: 'npm_command_failed' }, startedAt: at, completedAt: at, durationMs: 1 };
        }) as never,
      }, new AbortController().signal);
      assert.equal(receipt.result, kind === 'execute_failure' ? 'failed' : 'completed');
      assert.equal(receipt.repairRunState, kind === 'execute_failure' ? 'infrastructure_failed' : 'ready_for_investigation');
      assert.equal(baselineCalls, 1);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state,
        kind === 'execute_failure' ? 'failed' : 'completed');
      for (const [queueName, id] of sentinels)
        assert.equal((await boss.getJobById(queueName, id))?.state, 'created');
      assert.equal((await db.select().from(schema.repairRunAttempt)).length, 1);
      assert.equal((await db.select().from(schema.repositoryBaseline)).length, kind === 'execute_failure' ? 0 : 1);
      assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
      if (kind.startsWith('phase_')) {
        const context = await createInvestigation(db, actor, input.repairRunId, randomUUID(), new PgBossInvestigationQueue(boss));
        const fakeGateway = {
          getInstallation: async () => ({ id: installationId, appId: 991, appSlug: 'test', suspendedAt: null }),
          createInstallationAccessToken: async () => ({ accessToken: 'disposable-test-token', repository: {
            id: repositoryId, isPrivate: false, name: 'fixture', ownerLogin: 'octo',
          } }),
          getCommitTree: async () => ({ commitSha: COMMIT, treeSha: 'd'.repeat(40) }),
          getTree: async () => ({ entries: [], truncated: false }),
          getBlob: async () => ({ bytes: Buffer.alloc(0), sha: 'e'.repeat(40) }),
          revokeInstallationAccessToken: async () => {},
        };
        if (['phase_ai', 'phase_loop', 'phase_generation', 'phase_verification'].includes(kind)) {
          const result = await processInvestigationJob({
            id: context.id, data: { version: 1, investigationId: context.id }, signal: new AbortController().signal,
          } as never, { database: db, gateway: fakeGateway, configuration: {
            appId: 991, appSlug: 'test', clientId: 'Iv1.test', baseUrl: 'http://localhost:3000',
          }, logger: { write: () => {} } });
          assert.equal(result.status, 'completed');
          assert.equal((await db.select({ state: schema.investigation.state }).from(schema.investigation)
            .where(eq(schema.investigation.id, context.id)))[0]?.state, 'ready');
          const ai = await startAiInvestigation(db, actor, context.id, new PgBossAiInvestigationQueue(boss));
          if (kind !== 'phase_ai') {
            const completedAt = new Date();
            await db.update(schema.aiInvestigation).set({ state: 'investigating',
              investigationStartedAt: completedAt, updatedAt: completedAt,
            }).where(eq(schema.aiInvestigation.id, ai.id));
            await db.update(schema.aiInvestigation).set({ state: 'completed',
              completedAt, updatedAt: completedAt,
              completionReason: 'model_conclusion', conclusionStatus: 'diagnosis_found',
              summary: 'Mocked diagnosis from the measured baseline.',
              suspectedFiles: [{ path: 'src/fixture.ts', reason: 'Measured failure.' }],
              evidenceReferences: [{ kind: 'baseline', reference: input.repairRunId }],
              proposedApproach: 'Fix the underlying fixture defect.', confidence: 'medium',
            }).where(eq(schema.aiInvestigation.id, ai.id));
            const loop = await startRepairLoop(db, actor, input.repairRunId, {
              enqueueRepairLoop: new PgBossRepairLoopQueue(boss).enqueueRepairLoop.bind(new PgBossRepairLoopQueue(boss)),
              enqueueAiCandidateGeneration: new PgBossAiCandidateGenerationQueue(boss).enqueueAiCandidateGeneration.bind(new PgBossAiCandidateGenerationQueue(boss)),
            });
            const [generation] = await db.select().from(schema.aiCandidateGeneration)
              .where(eq(schema.aiCandidateGeneration.repairRunId, input.repairRunId)).limit(1);
            assert.ok(generation);
            const phase = kind === 'phase_loop' ? 'loop' : kind === 'phase_generation' ? 'generation' : 'verification';
            let targetJobId = kind === 'phase_loop' ? (await db.select().from(schema.repairLoop)
              .where(eq(schema.repairLoop.id, loop.id)))[0]!.wakeJobId! : generation.id;
            if (kind === 'phase_verification') {
              const candidateId = randomUUID(); const verificationId = randomUUID(); const candidateIdentity = '4'.repeat(64);
              const [currentRun] = await db.select({ baselineId: schema.repairRun.baselineId }).from(schema.repairRun)
                .where(eq(schema.repairRun.id, input.repairRunId));
              assert.ok(currentRun?.baselineId);
              await db.insert(schema.repairCandidate).values({ id: candidateId, investigationId: context.id,
                repairRunId: input.repairRunId, workspaceId, githubRepositoryId: repositoryId,
                installationId, baseCommitSha: COMMIT, profileIdentity, formatVersion: 1,
                ordinal: 1, proposalKey: generation.id, proposalIdentity: '5'.repeat(64),
                candidateIdentity, state: 'frozen', changedFileCount: 1, totalResultBytes: 1,
                freezingStartedAt: completedAt, completedAt, updatedAt: completedAt });
              await db.insert(schema.candidateVerification).values({ id: verificationId, candidateId,
                investigationId: context.id, repairRunId: input.repairRunId, baselineId: currentRun.baselineId,
                workspaceId, githubRepositoryId: repositoryId, installationId,
                baseCommitSha: COMMIT, profileIdentity, candidateIdentity, formatVersion: 1,
                state: 'queued', queuedAt: completedAt, updatedAt: completedAt });
              const queued = await new PgBossCandidateVerificationQueue(boss).enqueueVerification(db as never,
                { version: 1, verificationId });
              assert.equal(queued, verificationId);
              targetJobId = verificationId;
            }
            const workerId = randomUUID();
            const heartbeat = new WorkerHeartbeatLifecycle(new PostgresWorkerHeartbeatStore(first), {
              id: workerId, releaseSha: RELEASE, kind: 'exact-phase-one-shot', phase,
              targetRepairRunId: input.repairRunId, targetJobId,
            });
            await heartbeat.start(); await heartbeat.ready();
            try {
              const phaseRequest: ExactPhaseRequest = { phase, repairRunId: input.repairRunId,
                jobId: targetJobId, planIdentity: plan.planIdentity, repositoryId, revision: COMMIT, releaseSha: RELEASE };
              assert.equal((await claimExactPhaseJob(db, phaseRequest, RELEASE, workerId)).id, targetJobId);
              await assert.rejects(claimExactPhaseJob(db, phaseRequest, RELEASE, workerId));
              for (const [queueName, id] of sentinels)
                assert.equal((await boss.getJobById(queueName, id))?.state, 'created');
              if (kind === 'phase_loop') assert.equal((await boss.getJobById(AI_CANDIDATE_GENERATION_QUEUE, generation.id))?.state, 'created');
              if (kind === 'phase_generation') assert.equal((await boss.getJobById('repair-loop-v1',
                (await db.select().from(schema.repairLoop).where(eq(schema.repairLoop.id, loop.id)))[0]!.wakeJobId!))?.state, 'created');
            } finally { await heartbeat.draining(); await heartbeat.stopped(); }
            return true;
          }
          const workerId = randomUUID();
          const heartbeat = new WorkerHeartbeatLifecycle(new PostgresWorkerHeartbeatStore(first), {
            id: workerId, releaseSha: RELEASE, kind: 'exact-phase-one-shot', phase: 'investigation',
            targetRepairRunId: input.repairRunId, targetJobId: ai.id,
          });
          await heartbeat.start(); await heartbeat.ready();
          try {
            const aiRequest: ExactPhaseRequest = { phase: 'investigation', repairRunId: input.repairRunId,
              jobId: ai.id, planIdentity: plan.planIdentity, repositoryId, revision: COMMIT, releaseSha: RELEASE };
            assert.equal((await claimExactPhaseJob(db, aiRequest, RELEASE, workerId)).id, ai.id);
            await assert.rejects(claimExactPhaseJob(db, aiRequest, RELEASE, workerId));
            assert.equal((await boss.getJobById('ai-investigation-v1', ai.id))?.state, 'active');
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'created');
            for (const [queueName, id] of sentinels)
              assert.equal((await boss.getJobById(queueName, id))?.state, 'created');
          } finally { await heartbeat.draining(); await heartbeat.stopped(); }
          return true;
        }
        const workerId = randomUUID();
        const heartbeat = new WorkerHeartbeatLifecycle(new PostgresWorkerHeartbeatStore(first), {
          id: workerId, releaseSha: RELEASE, kind: 'exact-phase-one-shot', phase: 'context',
          targetRepairRunId: input.repairRunId, targetJobId: context.id,
        });
        await heartbeat.start(); await heartbeat.ready();
        const phaseRequest: ExactPhaseRequest = { phase: 'context', repairRunId: input.repairRunId,
          jobId: context.id, planIdentity: plan.planIdentity, repositoryId, revision: COMMIT, releaseSha: RELEASE };
        try {
          for (const changed of [
            { jobId: randomUUID() }, { planIdentity: 'f'.repeat(64) }, { repositoryId: repositoryId + 1 },
            { revision: 'f'.repeat(40) }, { releaseSha: 'e'.repeat(40) },
          ]) await assert.rejects(claimExactPhaseJob(db, { ...phaseRequest, ...changed }, RELEASE, workerId));
          assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'created');
          if (kind === 'phase_context_revoked') {
            const [grant] = await db.select().from(schema.executionBudgetGrant).where(eq(schema.executionBudgetGrant.repairRunId, input.repairRunId)).limit(1);
            assert.ok(grant);
            await db.insert(schema.executionBudgetGrantRevocation).values({
              id: randomUUID(), grantId: grant.id, reasonCode: 'operator_revoked', revokedBy: ownerId,
            });
            await assert.rejects(claimExactPhaseJob(db, phaseRequest, RELEASE, workerId));
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'created');
          } else if (kind === 'phase_context_late_revocation') {
            assert.equal((await claimExactPhaseJob(db, phaseRequest, RELEASE, workerId)).id, context.id);
            const [grant] = await db.select().from(schema.executionBudgetGrant)
              .where(eq(schema.executionBudgetGrant.repairRunId, input.repairRunId)).limit(1);
            assert.ok(grant);
            await db.insert(schema.executionBudgetGrantRevocation).values({
              id: randomUUID(), grantId: grant.id, reasonCode: 'operator_revoked', revokedBy: ownerId,
            });
            await assert.rejects(assertSourceReadAuthority(db, phaseRequest, RELEASE,
              new AbortController().signal));
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'active');
          } else if (kind === 'phase_context_expired') {
            await waitForDatabaseExpiry(input.expiresAt);
            await assert.rejects(claimExactPhaseJob(db, phaseRequest, RELEASE, workerId));
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'created');
          } else if (kind === 'phase_context_service') {
            const outcome = await executeExactPhaseOnce(phaseRequest, {
              database: db, boss, configuration: {
                appId: 991, appSlug: 'test', clientId: 'Iv1.test', baseUrl: 'http://localhost:3000',
              }, gateway: fakeGateway as never, workerHeartbeatId: workerId,
              runtimeReleaseSha: RELEASE,
              executionAuthority: new DurableExternalExecutionAuthorizer(db, { runtimeReleaseSha: RELEASE }),
            }, new AbortController().signal);
            assert.equal(outcome.result, 'completed');
            assert.equal(outcome.subjectState, 'ready');
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'completed');
          } else if (kind === 'phase_context_interrupted') {
            const shutdown = new AbortController();
            const outcome = await executeExactPhaseOnce(phaseRequest, {
              database: db, boss, configuration: {
                appId: 991, appSlug: 'test', clientId: 'Iv1.test', baseUrl: 'http://localhost:3000',
              }, gateway: fakeGateway as never, workerHeartbeatId: workerId,
              runtimeReleaseSha: RELEASE,
              executionAuthority: new DurableExternalExecutionAuthorizer(db, { runtimeReleaseSha: RELEASE }),
            }, shutdown.signal, { runJob: async () => {
              shutdown.abort();
              throw new Error('inert_interruption');
            } });
            assert.equal(outcome.result, 'failed');
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'failed');
            assert.equal((await db.select({ state: schema.investigation.state }).from(schema.investigation)
              .where(eq(schema.investigation.id, context.id)))[0]?.state, 'created');
          } else if (kind === 'phase_context_race') {
            const settled = await Promise.allSettled([
              claimExactPhaseJob(db, phaseRequest, RELEASE, workerId),
              claimExactPhaseJob(db2, phaseRequest, RELEASE, workerId),
            ]);
            assert.equal(settled.filter((value) => value.status === 'fulfilled').length, 1);
            assert.equal(settled.filter((value) => value.status === 'rejected').length, 1);
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'active');
          } else {
            const claimed = await claimExactPhaseJob(db, phaseRequest, RELEASE, workerId);
            assert.equal(claimed.id, context.id);
            assert.equal((await boss.getJobById('investigation-context-v1', context.id))?.state, 'active');
            await assert.rejects(claimExactPhaseJob(db, phaseRequest, RELEASE, workerId));
          }
          for (const [queueName, id] of sentinels)
            assert.equal((await boss.getJobById(queueName, id))?.state, 'created');
        } finally { await heartbeat.draining(); await heartbeat.stopped(); }
      }
    } else if (kind === 'retire_attempt' || kind === 'retire_reservation') {
      if (kind === 'retire_attempt') {
        const at = new Date();
        await db.insert(schema.repairRunAttempt).values({ id: randomUUID(), repairRunId: input.repairRunId,
          queueJobId: input.repairRunId, attemptNumber: 1, expectedBaselineId: randomUUID(),
          ownershipToken: randomUUID(), state: 'active', claimedAt: at, heartbeatAt: at,
          leaseExpiresAt: new Date(at.getTime() + 60_000) });
      } else {
        const [account] = await db.select().from(schema.executionBudgetGrant)
          .where(eq(schema.executionBudgetGrant.scope, 'account')).limit(1);
        const [grant] = await db.select().from(schema.executionBudgetGrant)
          .where(eq(schema.executionBudgetGrant.operationCategory, 'sandbox_baseline')).limit(1);
        assert.ok(account && grant);
        // Only a corrupted historical state can contain a reservation while the
        // checkpoint is pending. Inject it in this disposable DB to prove that
        // retirement still refuses it, then restore the production guard.
        await first.unsafe('alter table external_execution_reservation disable trigger user');
        try {
          await db.insert(schema.externalExecutionReservation).values({ id: randomUUID(), version: 2,
            grantId: grant.id, accountGrantId: account.id, workspaceId, repairRunId: input.repairRunId,
            githubRepositoryId: repositoryId, baseCommitSha: COMMIT, operationCategory: 'sandbox_baseline',
            providerId: 'vercel', executingReleaseSha: RELEASE,
            executingProviderAccountIdentity: grant.authorizedProviderAccountIdentity,
            operationKey: randomUUID(), reservedLogicalRequests: 0,
            reservedProviderAttempts: 0, reservedInputTokens: 0, reservedOutputTokens: 0,
            reservedSandboxIdentities: 1, reservedSandboxRuntimeMs: 1, reservedVerificationAttempts: 0,
            reservedRepairLoopIterations: 0, fence: 1, reservationIdentity: HASH });
        } finally {
          await first.unsafe('alter table external_execution_reservation enable trigger user');
        }
      }
      await assert.rejects(retireReviewedStagedRun(db, actor, retirement, boss));
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 0);
      assert.equal((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, input.repairRunId)))[0]?.state, 'created');
    } else if (kind === 'retire') {
      await assert.rejects(retireReviewedStagedRun(db, actor, { ...retirement, planIdentity: 'd'.repeat(64) }, boss));
      await assert.rejects(retireReviewedStagedRun(db, actor, { ...retirement, accountGrantIdentity: 'd'.repeat(64) }, boss));
      const failureBoss = { cancel: async () => ({ affected: 0 }) } as unknown as Pick<typeof boss, 'cancel'>;
      await assert.rejects(retireReviewedStagedRun(db, actor, retirement, failureBoss));
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 0);
      assert.equal((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, input.repairRunId)))[0]?.state, 'created');
      await first.unsafe(`create function injected_retirement_revocation_failure() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`);
      await first.unsafe(`create trigger injected_retirement_revocation_failure before insert on execution_budget_grant_revocation for each row execute function injected_retirement_revocation_failure()`);
      await assert.rejects(retireReviewedStagedRun(db, actor, retirement, boss));
      await first.unsafe(`drop trigger injected_retirement_revocation_failure on execution_budget_grant_revocation`);
      await first.unsafe(`drop function injected_retirement_revocation_failure()`);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 0);
      await first.unsafe(`create function injected_retirement_run_failure() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`);
      await first.unsafe(`create trigger injected_retirement_run_failure before update on repair_run for each row execute function injected_retirement_run_failure()`);
      await assert.rejects(retireReviewedStagedRun(db, actor, retirement, boss));
      await first.unsafe(`drop trigger injected_retirement_run_failure on repair_run`);
      await first.unsafe(`drop function injected_retirement_run_failure()`);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 0);
      const receipt = await retireReviewedStagedRun(db, actor, retirement, boss);
      assert.equal(receipt.result, 'retired');
      assert.equal((await retireReviewedStagedRun(db, actor, retirement, boss)).result, 'already_retired');
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 6);
      assert.equal((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, input.repairRunId)))[0]?.state, 'cancelled');
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'cancelled');
      assert.equal((await db.select().from(schema.repairRunSourceCheckpoint))[0]?.planIdentity, plan.planIdentity);
      assert.equal((await db.select().from(schema.repairIntent)).length, 1);
      const fresh: ReviewedStagingInput = { ...input, repairRunId: randomUUID(), idempotencyKey: randomUUID(),
        authorizedReleaseSha: 'd'.repeat(40), expiresAt: new Date(Date.now() + 4_000_000).toISOString() };
      const freshPlan = buildReviewedStagingPlan({ workspaceId, reviewerUserId: ownerId }, fresh);
      const freshStaged = await stageReviewedRepairRun(db, actor, fresh, freshPlan.planIdentity, new PgBossReviewedBaselineQueue(boss),
        { runtimeReleaseSha: fresh.authorizedReleaseSha, configuredProviderAccounts: fresh.providerAccounts });
      assert.notEqual(freshStaged.repairRunId, staged.repairRunId);
      assert.equal((await db.select().from(schema.executionBudgetGrant)).length, 12);
      assert.equal((await db.select().from(schema.repairRun)).length, 2);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, fresh.repairRunId))?.state, 'created');
      assert.equal(await assertReviewedPlanIntegrity(db, fresh.repairRunId, fresh.authorizedReleaseSha), true);
    } else if (kind === 'local_retire' || kind === 'local_retire_reviewed') {
      const queue = kind === 'local_retire' ? REPAIR_BASELINE_QUEUE : REVIEWED_BASELINE_QUEUE;
      const exact = { workspaceId, repairRunId: input.repairRunId, planIdentity: plan.planIdentity,
        repositoryId, revision: COMMIT, authorizedReleaseSha: input.authorizedReleaseSha };
      const preview = await readHistoricalRetirement(db, actor, exact);
      assert.equal(preview.preview.eligible, true);
      assert.equal(preview.request.accountGrantIdentity, plan.accountGrant.grantIdentity);
      await assert.rejects(readHistoricalRetirement(db, actor, { ...exact, planIdentity: 'd'.repeat(64) }));
      await assert.rejects(readHistoricalRetirement(db, actor, { ...exact, authorizedReleaseSha: 'e'.repeat(40) }));
      await assert.rejects(readHistoricalRetirement(db, actor, { ...exact, workspaceId: randomUUID() }));
      await assert.rejects(retireExactHistoricalRun(db, actor, boss, { ...exact, repairRunId: randomUUID() }));
      if (kind === 'local_retire_reviewed') {
        await first`update pgboss.job set name = ${REPAIR_BASELINE_QUEUE}
          where id = ${input.repairRunId}::uuid and name = ${queue}`;
        await assert.rejects(readHistoricalRetirement(db, actor, exact));
        await first`update pgboss.job set name = ${queue}
          where id = ${input.repairRunId}::uuid and name = ${REPAIR_BASELINE_QUEUE}`;
        await waitForDatabaseExpiry(input.expiresAt);
        assert.equal((await readHistoricalRetirement(db, actor, exact)).preview.eligible, true);
        await assert.rejects(claimExactReviewedBaselineJob(db, request, input.authorizedReleaseSha));
      }
      await first`update pgboss.job set state = 'active', started_on = clock_timestamp()
        where id = ${input.repairRunId}::uuid and name = ${queue}`;
      assert.equal((await readHistoricalRetirement(db, actor, exact)).preview.eligible, false);
      await assert.rejects(retireExactHistoricalRun(db, actor, boss, exact));
      await first`update pgboss.job set state = 'created', started_on = null
        where id = ${input.repairRunId}::uuid and name = ${queue}`;
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 0);
      const [firstRetirement, secondRetirement] = await Promise.all([
        retireExactHistoricalRun(db, actor, boss, exact),
        retireExactHistoricalRun(db2, actor, boss, exact),
      ]);
      assert.deepEqual(new Set([firstRetirement.result, secondRetirement.result]),
        new Set(['retired', 'already_retired']));
      assert.equal((await db.select().from(schema.executionBudgetGrantRevocation)).length, 6);
      assert.equal((await db.select().from(schema.repairRunEvent)
        .where(eq(schema.repairRunEvent.repairRunId, input.repairRunId))).filter((event) =>
          event.failureCode === 'pre_execution_operator_retirement').length, 1);
      assert.equal((await boss.getJobById(queue, input.repairRunId))?.state, 'cancelled');
      assert.equal((await readHistoricalRetirement(db, actor, exact)).preview.eligible, false);
    } else if (kind === 'historical_retire') {
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      assert.equal(await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId), null);
      await assert.rejects(claimExactReviewedBaselineJob(db, request, HISTORICAL_RELEASE));
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      const retired = await retireReviewedStagedRun(db, actor, retirement, boss);
      assert.equal(retired.result, 'retired');
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, input.repairRunId))?.state, 'cancelled');
      assert.equal((await retireReviewedStagedRun(db, actor, retirement, boss)).result, 'already_retired');
    } else if (kind === 'malformed_normal') {
      let transports = 0;
      const result = await processRepairJob({ id: input.repairRunId, name: REPAIR_BASELINE_QUEUE,
        data: { version: 1, repairRunId: input.repairRunId } } as never, {
        database: db, configuration: { appId: 991, appSlug: 'test', clientId: 'Iv1.test', baseUrl: 'http://localhost:3000' },
        gateway: {} as never, logger: { write: () => {} }, runtimeReleaseSha: RELEASE,
        baselineExecutor: (async () => { transports++; throw new Error('must_not_execute'); }) as never,
      });
      assert.equal(result.status, 'deadletter');
      assert.equal(result.output?.code, 'reviewed_one_shot_required');
      assert.equal(transports, 0);
      assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
    } else if (kind === 'supervision_characterization') {
      // Installed pg-boss's unscoped pass is the old worker's automatic path.
      await first`update pgboss.job set keep_until = clock_timestamp() - interval '1 second'
        where name = ${REVIEWED_BASELINE_QUEUE} and id = ${input.repairRunId}::uuid`;
      await boss.supervise();
      assert.equal(await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId), null,
        'the old unscoped supervisor deletes a correctly staged reviewed job');
    } else if (kind === 'supervision') {
      supervisor = await createCanonicalRepairSupervisor(url.toString(), () => { throw new Error('canonical_supervision_failed'); });
      const normalCreated = randomUUID();
      const normalActive = randomUUID();
      const normalRetry = randomUUID();
      assert.equal(await boss.send(REPAIR_BASELINE_QUEUE, { version: 1, repairRunId: normalCreated }, { id: normalCreated }), normalCreated);
      assert.equal(await boss.send(REPAIR_BASELINE_QUEUE, { version: 1, repairRunId: normalActive }, { id: normalActive }), normalActive);
      assert.equal(await boss.send(REPAIR_BASELINE_QUEUE, { version: 1, repairRunId: normalRetry }, { id: normalRetry }), normalRetry);
      await first`update pgboss.job set keep_until = clock_timestamp() - interval '1 second'
        where id in (${input.repairRunId}::uuid, ${normalCreated}::uuid)`;
      await first`update pgboss.job set state = 'active'::pgboss.job_state,
        started_on = clock_timestamp() - interval '13 minutes',
        heartbeat_on = clock_timestamp() - interval '2 minutes', retry_limit = 0
        where id = ${normalActive}::uuid`;
      await first`update pgboss.job set state = 'active'::pgboss.job_state,
        started_on = clock_timestamp() - interval '13 minutes',
        heartbeat_on = clock_timestamp() - interval '2 minutes'
        where id = ${normalRetry}::uuid`;
      await supervisor.runNow();
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      assert.equal(await boss.getJobById(REPAIR_BASELINE_QUEUE, normalCreated), null,
        'normal queue retention must still run');
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, normalActive))?.state, 'failed',
        'normal queue timeout recovery must still run');
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, normalRetry))?.state, 'retry',
        'normal queue retry recovery must still run');
      const otherJobs = new Map<string, string>();
      for (const name of canonicalRepairQueues.filter((name) => name !== REPAIR_BASELINE_QUEUE)) {
        const id = randomUUID();
        assert.equal(await boss.send(name, { version: 1 }, { id }), id);
        otherJobs.set(name, id);
      }
      await first`update pgboss.job set keep_until = clock_timestamp() - interval '1 second'
        where id in ${first([...otherJobs.values()])}`;
      await first`update pgboss.queue set maintain_on = clock_timestamp() - interval '49 hours'
        where name in ${first([...otherJobs.keys()])}`;
      await supervisor.runNow();
      for (const [name, id] of otherJobs) assert.equal(await boss.getJobById(name, id), null,
        `normal queue retention must still run for ${name}`);
      await first`update pgboss.job set keep_until = clock_timestamp() + interval '7 days'
        where name = ${REVIEWED_BASELINE_QUEUE} and id = ${input.repairRunId}::uuid`;
      assert.equal((await claimExactReviewedBaselineJob(db2, request, RELEASE)).id, input.repairRunId);
      await first`update pgboss.job set started_on = clock_timestamp() - interval '13 minutes',
        heartbeat_on = clock_timestamp() - interval '2 minutes'
        where name = ${REVIEWED_BASELINE_QUEUE} and id = ${input.repairRunId}::uuid`;
      await first`update pgboss.queue set monitor_claim_on = clock_timestamp() - interval '2 minutes',
        maintain_on = clock_timestamp() - interval '49 hours'
        where name in (${REPAIR_BASELINE_QUEUE}, ${REVIEWED_BASELINE_QUEUE})`;
      await supervisor.runNow();
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'active',
        'normal maintenance must not fail the exact one-shot owner');
      assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
      assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
    } else if (kind === 'supervision_blocked') {
      const normalJob = randomUUID();
      assert.equal(await boss.send(AI_CANDIDATE_GENERATION_QUEUE, { version: 1 }, { id: normalJob }), normalJob);
      await first`update pgboss.job set keep_until = clock_timestamp() - interval '1 second'
        where id in (${normalJob}::uuid, ${input.repairRunId}::uuid)`;
      let locked!: () => void;
      let unlock!: () => void;
      const lockReady = new Promise<void>((resolve) => { locked = resolve; });
      const lockHeld = new Promise<void>((resolve) => { unlock = resolve; });
      const lockTransaction = first.begin(async (transaction) => {
        await transaction`select name from pgboss.queue where name = ${AI_CANDIDATE_GENERATION_QUEUE} for update`;
        locked();
        await lockHeld;
      });
      await lockReady;
      supervisor = await createCanonicalRepairSupervisor(url.toString(), () => {});
      try {
        void supervisor.runNow().catch(() => undefined);
        let waiting = false;
        for (let i = 0; i < 150; i++) {
          const [row] = await second<{ waiting: boolean }[]>`
            select exists(select 1 from pg_stat_activity
              where datname = current_database() and application_name = 'vigilo-queue-supervisor'
                and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0) as waiting`;
          if (row?.waiting) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(waiting, true, 'real pg-boss supervision must be waiting on the queue-row lock');
        const stopped = supervisor.stop();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const bounded = await Promise.race([
          stopped.then(() => true),
          new Promise<false>((resolve) => { deadline = setTimeout(() => resolve(false), 8_000); }),
        ]);
        if (deadline) clearTimeout(deadline);
        assert.equal(bounded, true, 'supervisor shutdown must settle while the database lock is held');
        const [activity] = await second<{ active: number }[]>`
          select count(*)::int as active from pg_stat_activity
          where datname = current_database() and application_name = 'vigilo-queue-supervisor'`;
        assert.equal(activity?.active, 0, 'no maintenance SQL connection may remain after successful shutdown');
      } finally {
        unlock();
        await lockTransaction;
        await supervisor.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await boss.getJobById(AI_CANDIDATE_GENERATION_QUEUE, normalJob))?.state, 'created',
        'a stopped pass must not delete a normal job after the lock is released');
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created',
        'reviewed job must remain outside normal-queue supervision');
    } else if (kind === 'supervision_recovery') {
      const normalJob = randomUUID();
      assert.equal(await boss.send(AI_CANDIDATE_GENERATION_QUEUE, { version: 1 }, { id: normalJob }), normalJob);
      await first`update pgboss.job set keep_until = clock_timestamp() - interval '1 second'
        where id = ${normalJob}::uuid`;
      let unlocked!: () => void;
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => { locked = resolve; });
      const held = new Promise<void>((resolve) => { unlocked = resolve; });
      const transaction = first.begin(async (tx) => {
        await tx`select name from pgboss.queue where name = ${AI_CANDIDATE_GENERATION_QUEUE} for update`;
        locked();
        await held;
      });
      await ready;
      supervisor = await createCanonicalRepairSupervisor(url.toString(), () => {});
      try {
        await assert.rejects(supervisor.runNow());
      } finally {
        unlocked();
        await transaction;
      }
      await supervisor.runNow();
      assert.equal(await boss.getJobById(AI_CANDIDATE_GENERATION_QUEUE, normalJob), null,
        'maintenance must recover after an earlier lock timeout');
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
    } else if (kind === 'general_race') {
      supervisor = await createCanonicalRepairSupervisor(url.toString(), () => { throw new Error('canonical_supervision_failed'); });
      const normalJob = randomUUID();
      const concurrentNormalJob = randomUUID();
      assert.equal(await boss.send(REPAIR_BASELINE_QUEUE, { version: 1, repairRunId: normalJob }, { id: normalJob }), normalJob);
      let generalClaims = 0;
      const workOptions = { ...REPAIR_WORK_OPTIONS, perJobResults: true as const };
      await boss.work<unknown, { code?: string }, typeof workOptions>(REPAIR_BASELINE_QUEUE, workOptions, async (jobs) => {
        const job = jobs[0]; if (!job) return [];
        generalClaims++;
        assert.ok(job.id === normalJob || job.id === concurrentNormalJob,
          'general consumer must never receive the reviewed job');
        return [{ id: job.id, status: 'completed' as const }];
      });
      for (let i = 0; i < 150 && generalClaims === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(generalClaims, 1);
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, normalJob))?.state, 'completed');
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'created');
      assert.equal((await db.select().from(schema.repairRunAttempt)).length, 0);
      assert.equal((await db.select().from(schema.repositoryBaseline)).length, 0);
      assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
      assert.equal(await boss.send(REPAIR_BASELINE_QUEUE,
        { version: 1, repairRunId: concurrentNormalJob }, { id: concurrentNormalJob }), concurrentNormalJob);
      const child = spawn(process.execPath, ['--import', 'tsx', 'integration-test/fixtures/exact-claim-child.ts'], {
        cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, DATABASE_URL: url.toString(),
          ...(process.env.VIGILO_DISPOSABLE_NATIVE_POSTGRES === 'true' ? { VIGILO_DISPOSABLE_NATIVE_POSTGRES: 'true' } : {}) },
      });
      let childOutput = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { childOutput += chunk; });
      child.stderr.resume();
      child.stdin.end(JSON.stringify({ request, release: RELEASE }));
      const pendingExact = new Promise<{ id: string }>((resolve, reject) => {
        const deadline = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('exact_claim_child_timeout')); }, 10_000);
        child.once('error', (error) => { clearTimeout(deadline); reject(error); });
        child.once('close', (code) => {
          clearTimeout(deadline);
          if (code !== 0) { reject(new Error('exact_claim_child_failed')); return; }
          try { resolve(JSON.parse(childOutput) as { id: string }); }
          catch { reject(new Error('exact_claim_child_receipt_invalid')); }
        });
      });
      for (let i = 0; i < 150 && generalClaims < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const exact = await pendingExact;
      assert.equal(exact.id, input.repairRunId);
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'active');
      await supervisor.runNow();
      assert.equal((await boss.getJobById(REVIEWED_BASELINE_QUEUE, input.repairRunId))?.state, 'active');
      assert.equal(generalClaims, 2);
      assert.equal((await boss.getJobById(REPAIR_BASELINE_QUEUE, concurrentNormalJob))?.state, 'completed');
    } else {
      const results = await Promise.allSettled([
        claimExactReviewedBaselineJob(db, request, RELEASE),
        retireReviewedStagedRun(db2, actor, retirement, boss),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const [job] = await first<{ state: string }[]>`select state::text as state from pgboss.job where id = ${request.jobId}::uuid`;
      assert.ok(job?.state === 'active' || job?.state === 'cancelled');
    }
    return true;
  } finally {
    await supervisor?.stop();
    if (boss) await boss.stop({ graceful: false });
    if (first) await first.end({ timeout: 1 });
    if (second) await second.end({ timeout: 1 });
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database if exists "${name}"`);
  }
}

try {
  const kinds = ['claim', 'signal_blocked_claim', 'signal_after_claim', 'authority_denied', 'expiry_before_claim', 'expiry_while_waiting', 'expiry_before_transition', 'unreviewed_checkpoint', 'queue_policy', 'retire', 'retire_attempt', 'retire_reservation', 'historical_retire', 'local_retire', 'local_retire_reviewed', 'malformed_normal', 'race', 'general_race', 'supervision_characterization', 'supervision', 'supervision_blocked', 'supervision_recovery', 'execute', 'execute_failure', 'phase_context', 'phase_context_race', 'phase_context_revoked', 'phase_context_late_revocation', 'phase_context_expired', 'phase_context_service', 'phase_context_interrupted', 'phase_ai', 'phase_loop', 'phase_generation', 'phase_verification'] as const;
  const selected = process.argv[2];
  if (selected && !kinds.includes(selected as typeof kinds[number])) throw new Error('unknown_isolated_baseline_scenario');
  for (const kind of selected ? [selected as typeof kinds[number]] : kinds) assert.equal(await scenario(kind), true);
  process.stdout.write(JSON.stringify({ nativeIndependentConnectionScenarios: selected ? 1 : kinds.length, result: 'passed' }) + '\n');
} finally { await admin.end({ timeout: 1 }); }
