import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fromDrizzle } from 'pg-boss';

import * as schema from '../db/schema.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { EXPIRED_AI_RETIREMENT_REASON, retireExpiredUnstartedAiInvestigation } from '../lib/ai-investigations/expired-retirement.ts';
import { computeExecutionProfileIdentity } from '../lib/execution-profiles/detector.ts';
import { buildReviewedStagingPlan } from '../lib/external-execution/reviewed-plan.ts';
import { hasRepositorySwitchConflict } from '../lib/github-repositories/switch-guard.ts';
import { AI_INVESTIGATION_QUEUE, createRepairBoss } from '../lib/repair-runs/queue.ts';

// The launcher supplies this value from a fresh, test-only container. No app
// environment loader is used, and the safety check runs before the first query.
const value = process.env.VIGILO_RETIREMENT_TEST_URL;
if (!value) throw new Error('isolated_database_required');
const targetUrl = new URL(value);
if (targetUrl.protocol !== 'postgres:' || targetUrl.hostname !== '127.0.0.1' ||
    !/^vigilo_retirement_[a-f0-9]{32}$/.test(targetUrl.pathname.slice(1)) ||
    !Number.isInteger(Number(targetUrl.port)) || Number(targetUrl.port) < 20000 ||
    Number(targetUrl.port) === 55432 || Number(targetUrl.port) === 55433 ||
    process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGHOST ||
    process.env.VIGILO_RELEASE_SHA) throw new Error('isolated_database_identity_mismatch');

const ownerId = randomUUID();
const workspaceId = randomUUID();
const runId = randomUUID();
const baselineId = randomUUID();
const contextId = randomUUID();
const aiId = randomUUID();
const intentId = randomUUID();
const repoId = 1411517943;
const installationId = 159763114;
const commit = 'a'.repeat(40);
const source = '3'.repeat(64);
const release = 'e'.repeat(40);
const objective = 'Fix the isolated deterministic fixture failure.';
const profile = computeExecutionProfileIdentity({ baseCommitSha: commit,
  build: { script: 'build', tool: 'npm' }, githubRepositoryId: repoId,
  install: { operation: 'ci', tool: 'npm' }, installationId,
  lockfileType: 'package-lock', nodeMajor: 24, packageJsonBlobSha: 'd'.repeat(40),
  packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40),
  packageLockContentSha256: '1'.repeat(64), packageManager: 'npm', profileVersion: 2,
  runtimeFamily: 'node', test: { script: 'test', tool: 'npm' }, testRunner: 'vitest',
  typecheck: { script: 'typecheck', tool: 'npm' }, workspaceId });
const actor = { user: { id: ownerId }, workspace: { id: workspaceId, ownerUserId: ownerId } } as AuthenticatedWorkspace;
const client = postgres(value, { max: 3, prepare: false, onnotice: () => {} });
const raw = drizzle(client, { schema });
const db = raw as unknown as VigiloDatabase;
let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;

async function state() {
  const [ai] = await db.select().from(schema.aiInvestigation).where(eq(schema.aiInvestigation.id, aiId));
  const [job] = await client<{ state: string; started_on: Date | null; completed_on: Date | null }[]>`
    select state::text as state, started_on, completed_on from pgboss.job where id = ${aiId}::uuid`;
  const events = await db.select().from(schema.aiInvestigationEvent)
    .where(eq(schema.aiInvestigationEvent.aiInvestigationId, aiId));
  return { ai, job, retireEvents: events.filter(event => event.failureCode === EXPIRED_AI_RETIREMENT_REASON) };
}

try {
  const [identity] = await client<{ database: string; port: number }[]>`
    select current_database() as database, inet_server_port() as port`;
  assert.equal(identity?.database, targetUrl.pathname.slice(1));
  assert.equal(identity?.port, 5432);
  await migrate(raw, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  boss = await createRepairBoss(value, 'publisher');

  await db.insert(schema.user).values({ id: ownerId, name: 'Test owner', email: 'owner@example.test' });
  await db.insert(schema.workspace).values({ id: workspaceId, ownerUserId: ownerId });
  await db.insert(schema.githubInstallation).values({ installationId, workspaceId,
    githubAccountId: 1, accountLogin: 'test', accountType: 'User', status: 'active' });
  await db.insert(schema.repository).values({ githubRepositoryId: repoId, workspaceId, installationId,
    ownerId: 1, ownerLogin: 'test', name: 'fixture', fullName: 'test/fixture',
    isPrivate: false, isSelected: true, defaultBranch: 'main' });
  await db.insert(schema.executionProfile).values({ githubRepositoryId: repoId, workspaceId,
    installationId, profileVersion: 2, profileIdentity: profile, baseCommitSha: commit,
    runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock',
    installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build',
    testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'd'.repeat(40),
    packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40),
    packageLockContentSha256: '1'.repeat(64), status: 'ready' });
  const expiry = new Date(Date.now() + 30_000);
  const input = { kind: 'm77b_repair_v1' as const, repairRunId: runId,
    idempotencyKey: randomUUID(), githubRepositoryId: repoId, installationId,
    profileIdentity: profile, baseCommitSha: commit, authorizedReleaseSha: release,
    objective, expectedSourceIdentity: source, expiresAt: expiry.toISOString(),
    providerAccounts: { googleProjectId: 'gen-lang-client-0469095642',
      vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA',
      vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM' } };
  const plan = buildReviewedStagingPlan({ workspaceId, reviewerUserId: ownerId }, input,
    new Date(expiry.getTime() - 60 * 60_000));
  const historical = new Date(expiry.getTime() - 30 * 60_000);
  await db.insert(schema.repairRun).values({ id: runId, workspaceId, githubRepositoryId: repoId,
    installationId, profileIdentity: profile, baseCommitSha: commit, idempotencyKey: input.idempotencyKey,
    state: 'created', createdAt: historical, stateChangedAt: historical, updatedAt: historical });
  await db.insert(schema.repairIntent).values({ id: intentId, repairRunId: runId, workspaceId,
    objective, objectiveHash: plan.objective.objectiveHash, createdAt: historical });
  await db.insert(schema.repairRunSourceCheckpoint).values({ repairRunId: runId,
    expectedSourceIdentity: source, reviewedBy: ownerId, planIdentity: plan.planIdentity });
  await db.insert(schema.executionBudgetGrant).values({ ...plan.accountGrant,
    id: randomUUID(), createdAt: historical });
  await db.insert(schema.executionBudgetGrant).values(plan.operationGrants.map(grant => ({
    ...grant, id: randomUUID(), createdAt: historical })));
  await db.update(schema.repairRun).set({ state: 'baseline_running', baselineStartedAt: historical,
    stateChangedAt: historical, updatedAt: historical }).where(eq(schema.repairRun.id, runId));
  await db.insert(schema.repositoryBaseline).values({ id: baselineId, workspaceId,
    githubRepositoryId: repoId, installationId, evidenceVersion: 1,
    profileIdentity: profile, baseCommitSha: commit, archiveSha256: '2'.repeat(64),
    sandboxName: 'isolated-retirement-baseline', sourceIdentityBefore: source,
    sourceIdentityAfter: source, sourceUnchanged: true, credentialsExposure: 'absent',
    networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0,
    installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0,
    typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0,
    buildTimedOut: false, testStatus: 'failed', testExitCode: 1,
    testTimedOut: false, executionOutcome: 'test_failed', overallOutcome: 'test_failed',
    cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent',
    errorPhase: 'test', errorCode: 'npm_command_failed', startedAt: historical,
    completedAt: historical, durationMs: 1 });
  await db.insert(schema.repairRunAttempt).values({ id: randomUUID(), repairRunId: runId,
    queueJobId: runId, attemptNumber: 1, expectedBaselineId: baselineId, baselineId,
    ownershipToken: randomUUID(), state: 'customer_failed', claimedAt: historical,
    heartbeatAt: historical, leaseExpiresAt: null, finishedAt: historical,
    failureClassification: 'customer_baseline_failure', failureCode: 'test_failed' });
  await db.update(schema.repairRun).set({ state: 'ready_for_investigation', baselineId,
    baselineOutcome: 'test_failed', failureClassification: 'customer_baseline_failure',
    failureCode: 'test_failed', completedAt: historical, stateChangedAt: historical,
    updatedAt: historical }).where(eq(schema.repairRun.id, runId));
  await db.update(schema.repairRunSourceCheckpoint).set({ baselineId })
    .where(eq(schema.repairRunSourceCheckpoint.repairRunId, runId));
  await db.insert(schema.investigation).values({ id: contextId, repairRunId: runId,
    repairIntentId: intentId, workspaceId, githubRepositoryId: repoId, installationId,
    baseCommitSha: commit, profileIdentity: profile, baselineId, idempotencyKey: randomUUID(),
    state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536,
    maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: 'c'.repeat(40),
    indexedPathCount: 1, attemptNumber: 1, completedAt: historical, updatedAt: historical });
  await db.insert(schema.aiInvestigation).values({ id: aiId, investigationId: contextId,
    executionOrdinal: 1, idempotencyKey: randomUUID(), repairRunId: runId, baselineId,
    workspaceId, githubRepositoryId: repoId, installationId, baseCommitSha: commit,
    profileIdentity: profile, providerId: 'google', modelId: 'gemini-3.1-flash-lite',
    protocolVersion: 1, state: 'queued', createdAt: historical, queuedAt: historical,
    updatedAt: historical });
  await db.insert(schema.aiInvestigationEvent).values([
    { id: randomUUID(), aiInvestigationId: aiId, workspaceId, fromState: null,
      toState: 'created', createdAt: historical },
    { id: randomUUID(), aiInvestigationId: aiId, workspaceId, fromState: 'created',
      toState: 'queued', createdAt: historical },
  ]);
  assert.equal(await boss.send(AI_INVESTIGATION_QUEUE,
    { version: 1, aiInvestigationId: aiId }, { id: aiId }), aiId);

  const target = { repairRunId: runId, contextInvestigationId: contextId,
    aiInvestigationId: aiId, planIdentity: plan.planIdentity,
    authorizedReleaseSha: release, repositoryId: repoId, revision: commit };
  const beforeRun = (await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, runId)))[0];
  const beforeContext = (await db.select().from(schema.investigation).where(eq(schema.investigation.id, contextId)))[0];
  const beforeBaseline = (await db.select().from(schema.repositoryBaseline).where(eq(schema.repositoryBaseline.id, baselineId)))[0];
  const beforeGrants = await db.select().from(schema.executionBudgetGrant);
  assert.equal(await hasRepositorySwitchConflict(db, workspaceId, new Date()), true);

  await assert.rejects(retireExpiredUnstartedAiInvestigation(db, actor, target, boss));
  assert.equal((await state()).job?.state, 'created');
  for (let poll = 0; poll < 200; poll++) {
    const [clock] = await client<{ expired: boolean }[]>`
      select clock_timestamp() >= ${expiry.toISOString()}::timestamptz as expired`;
    if (clock?.expired) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const [clock] = await client<{ expired: boolean }[]>`
    select clock_timestamp() >= ${expiry.toISOString()}::timestamptz as expired`;
  assert.equal(clock?.expired, true, 'disposable_grant_expiry_timeout');

  // A real cancellation inside the transaction must roll back with the AI row.
  const rollbackBoss = { cancel: async (name: string, id: string,
    options: { db: ReturnType<typeof fromDrizzle> }) => {
    const result = await boss!.cancel(name, id, options);
    assert.equal(result.affected, 1);
    throw new Error('injected_cancel_failure');
  } };
  await assert.rejects(retireExpiredUnstartedAiInvestigation(db, actor, target,
    rollbackBoss as never), /injected_cancel_failure/);
  assert.equal((await state()).ai?.state, 'queued');
  assert.equal((await state()).job?.state, 'created');

  // An exact claim can win while retirement waits on the global lock; once
  // claimed, the retirement transaction must reject without changing AI state.
  let releaseClaim!: () => void;
  let claimLocked!: () => void;
  const claimHeld = new Promise<void>(resolve => { releaseClaim = resolve; });
  const claimReady = new Promise<void>(resolve => { claimLocked = resolve; });
  const claiming = client.begin(async connection => {
    await connection`select id from external_execution_semaphore where id = 'global' for update`;
    const claimed = await connection`update pgboss.job set state = 'active', started_on = clock_timestamp()
      where id = ${aiId}::uuid and state = 'created' returning id`;
    assert.equal(claimed.length, 1);
    claimLocked();
    await claimHeld;
  });
  await claimReady;
  const losingRetirement = retireExpiredUnstartedAiInvestigation(db, actor, target, boss);
  releaseClaim();
  await claiming;
  await assert.rejects(losingRetirement);
  assert.equal((await state()).ai?.state, 'queued');
  assert.equal((await state()).job?.state, 'active');
  await client`update pgboss.job set state = 'created', started_on = null where id = ${aiId}::uuid`;

  const attemptRollback = new Error('isolated_attempt_case_rollback');
  await assert.rejects(db.transaction(async transaction => {
    await transaction.insert(schema.aiInvestigationAttempt).values({ id: randomUUID(),
      aiInvestigationId: aiId, queueJobId: aiId, attemptNumber: 1,
      ownershipToken: randomUUID(), state: 'exhausted', claimedAt: historical,
      heartbeatAt: historical, leaseExpiresAt: null, finishedAt: historical,
      failureCode: 'test_attempt' });
    await assert.rejects(retireExpiredUnstartedAiInvestigation(
      transaction as unknown as VigiloDatabase, actor, target, boss));
    throw attemptRollback;
  }), error => error === attemptRollback);

  const accountGrant = beforeGrants.find(grant => grant.scope === 'account');
  const modelGrant = beforeGrants.find(grant => grant.operationCategory === 'gemini_investigation');
  assert.ok(accountGrant && modelGrant);
  const reservationRollback = new Error('isolated_reservation_case_rollback');
  await assert.rejects(db.transaction(async transaction => {
    await transaction.insert(schema.externalExecutionReservation).values({
      id: randomUUID(), version: 2, grantId: modelGrant.id,
      accountGrantId: accountGrant.id, workspaceId, repairRunId: runId,
      githubRepositoryId: repoId, baseCommitSha: commit,
      operationCategory: 'gemini_investigation', providerId: 'google',
      modelId: 'gemini-3.1-flash-lite', executingReleaseSha: release,
      executingProviderAccountIdentity: modelGrant.authorizedProviderAccountIdentity,
      operationKey: randomUUID(), fence: 999, reservationIdentity: 'f'.repeat(64),
      reservedLogicalRequests: 1, reservedProviderAttempts: 1,
      reservedInputTokens: 0, reservedOutputTokens: 0,
      reservedSandboxIdentities: 0, reservedSandboxRuntimeMs: 0,
      sandboxResourceClass: null, reservedVerificationAttempts: 0,
      reservedRepairLoopIterations: 0, createdAt: historical });
    await assert.rejects(retireExpiredUnstartedAiInvestigation(
      transaction as unknown as VigiloDatabase, actor, target, boss));
    throw reservationRollback;
  }), error => error === reservationRollback);
  assert.equal((await db.select().from(schema.externalExecutionReservation)).length, 0);
  assert.equal((await db.select().from(schema.aiInvestigationAttempt)).length, 0);
  assert.equal((await state()).ai?.state, 'queued');
  assert.equal((await state()).job?.state, 'created');

  assert.equal(await retireExpiredUnstartedAiInvestigation(db, actor, target, boss), 'retired');
  assert.equal(await retireExpiredUnstartedAiInvestigation(db, actor, target, boss), 'already_retired');
  const final = await state();
  assert.equal(final.ai?.state, 'cancelled');
  assert.equal(final.ai.failureCode, EXPIRED_AI_RETIREMENT_REASON);
  assert.equal(final.job?.state, 'cancelled');
  assert.equal(final.job.started_on, null);
  assert.ok(final.job.completed_on);
  assert.equal(final.retireEvents.length, 1);
  assert.equal(await hasRepositorySwitchConflict(db, workspaceId, new Date()), false);
  assert.deepEqual((await db.select().from(schema.repairRun).where(eq(schema.repairRun.id, runId)))[0], beforeRun);
  assert.deepEqual((await db.select().from(schema.investigation).where(eq(schema.investigation.id, contextId)))[0], beforeContext);
  assert.deepEqual((await db.select().from(schema.repositoryBaseline).where(eq(schema.repositoryBaseline.id, baselineId)))[0], beforeBaseline);
  assert.deepEqual(await db.select().from(schema.executionBudgetGrant), beforeGrants);
  assert.equal((await client`update pgboss.job set state = 'active' where id = ${aiId}::uuid
    and state = 'created' returning id`).length, 0);
  process.stdout.write(JSON.stringify({ result: 'passed', cases: [
    'unexpired_denied', 'transactional_cancel_rollback', 'claim_wins_retirement_denied',
    'started_attempt_denied', 'provider_reservation_denied', 'real_cancel_and_ai_terminalization',
    'idempotence', 'conflict_clearance', 'history_preserved' ] }) + '\n');
} catch (error) {
  try {
    const observed = await state();
    process.stderr.write(JSON.stringify({ result: 'failed',
      aiState: observed.ai?.state ?? null, jobState: observed.job?.state ?? null,
      retirementEventCount: observed.retireEvents.length }) + '\n');
  } catch {
    process.stderr.write(JSON.stringify({ result: 'failed', state: 'unavailable' }) + '\n');
  }
  throw error;
} finally {
  if (boss) await boss.stop({ graceful: false });
  await client.end({ timeout: 1 });
}
