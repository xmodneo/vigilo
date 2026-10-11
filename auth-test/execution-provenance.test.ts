import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';

import { executionBudgetGrant, executionProfile, externalExecutionReservation, githubInstallation, repairRun, repairRunAttempt, repairRunSourceCheckpoint,
  repository, repositoryBaseline, user, workspace } from '../db/schema.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { readGeminiProviderConfiguration } from '../lib/ai-investigations/gemini-provider.ts';
import { computeExecutionGrantIdentity, executionReservationIdentityMatches } from '../lib/external-execution/identity.ts';
import type { ExternalExecutionAmounts, ExternalExecutionScope } from '../lib/external-execution/types.ts';
import {
  canonicalProviderAccountIdentity,
  googleProjectIdentity,
  vercelTeamProjectIdentity,
} from '../lib/external-execution/provider-account.ts';
import { createTestContext } from './support.ts';
import { transitionRepairRun } from '../lib/repair-runs/flow.ts';

const RELEASE_X = 'a'.repeat(40);
const RELEASE_Y = 'b'.repeat(40);
const PROJECT = googleProjectIdentity('gen-lang-client-0469095642');
const VERCEL = vercelTeamProjectIdentity('team_test', 'project_test');
const LIMITS: ExternalExecutionAmounts & { maxConcurrentExternalOperations: number } = {
  logicalRequests: 1, providerAttempts: 1, inputTokens: 100, outputTokens: 100,
  sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0,
  repairLoopIterations: 0, maxConcurrentExternalOperations: 1,
};
const AMOUNTS: ExternalExecutionAmounts = {
  logicalRequests: 1, providerAttempts: 1, inputTokens: 10, outputTokens: 10,
  sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0,
};

type CheckpointCase = 'pending' | 'matched' | 'before_mismatch' | 'after_mismatch' | 'unchanged_false' | 'untrusted' | 'unmeasured';

async function seeded(options: { checkpoint?: CheckpointCase; provider?: 'google' | 'vercel' } = {}) {
  const context = await createTestContext();
  const now = new Date('2031-01-02T03:04:05.000Z');
  const expiresAt = new Date('2031-01-03T03:04:05.000Z');
  const userId = randomUUID(); const workspaceId = randomUUID(); const runId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'operator', email: `${userId}@test.invalid`, emailVerified: true });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await context.database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: 42,
    installationId: 73, profileIdentity: 'c'.repeat(64), baseCommitSha: 'd'.repeat(40),
    idempotencyKey: randomUUID(), state: 'created' });
  let baselineId: string | null = null;
  if (options.checkpoint) {
    await context.database.insert(repairRunSourceCheckpoint).values({ repairRunId: runId,
      expectedSourceIdentity: 'e'.repeat(64), reviewedBy: userId, planIdentity: 'f'.repeat(64) });
    if (options.checkpoint !== 'pending') {
      await context.database.insert(githubInstallation).values({ installationId: 73, workspaceId, githubAccountId: 23,
        accountLogin: 'operator', accountType: 'User', status: 'active' });
      await context.database.insert(repository).values({ githubRepositoryId: 42, workspaceId, installationId: 73,
        ownerId: 23, ownerLogin: 'operator', name: 'repo', fullName: 'operator/repo', defaultBranch: 'main', isPrivate: false });
      await context.database.insert(executionProfile).values({ githubRepositoryId: 42, workspaceId, installationId: 73,
        profileVersion: 2, profileIdentity: 'c'.repeat(64), baseCommitSha: 'd'.repeat(40), runtimeFamily: 'node', nodeMajor: 24,
        packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck',
        buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: '1'.repeat(40),
        packageJsonContentSha256: '2'.repeat(64), packageLockBlobSha: '3'.repeat(40), packageLockContentSha256: '4'.repeat(64), status: 'ready' });
      await context.database.update(repairRun).set({ state: 'baseline_running', baselineStartedAt: now,
        stateChangedAt: now, updatedAt: now }).where(eq(repairRun.id, runId));
      baselineId = randomUUID();
      const attemptId = randomUUID();
      await context.database.insert(repairRunAttempt).values({ id: attemptId, repairRunId: runId,
        queueJobId: randomUUID(), attemptNumber: 1, expectedBaselineId: baselineId,
        ownershipToken: randomUUID(), state: 'active', claimedAt: now, heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000) });
      const sourceBefore = options.checkpoint === 'unmeasured' ? null : options.checkpoint === 'before_mismatch' ? '9'.repeat(64) : 'e'.repeat(64);
      const sourceAfter = options.checkpoint === 'after_mismatch' ? '9'.repeat(64) : sourceBefore;
      await context.database.insert(repositoryBaseline).values({ id: baselineId, workspaceId, githubRepositoryId: 42,
        installationId: 73, evidenceVersion: 1, profileIdentity: 'c'.repeat(64), baseCommitSha: 'd'.repeat(40),
        archiveSha256: '5'.repeat(64), sandboxName: 'baseline-test', sourceIdentityBefore: sourceBefore,
        sourceIdentityAfter: sourceAfter, sourceUnchanged: options.checkpoint === 'unmeasured' ? null : options.checkpoint === 'unchanged_false' ? false : sourceBefore === sourceAfter,
        credentialsExposure: 'absent', networkPolicy: options.checkpoint === 'untrusted' ? 'unconfirmed' : 'deny-all',
        installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed',
        typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false,
        testStatus: 'failed', testExitCode: 1, testTimedOut: false, executionOutcome: 'test_failed', overallOutcome: 'test_failed',
        cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test',
        errorCode: 'npm_command_failed', startedAt: now, completedAt: now, durationMs: 1 });
      await context.database.update(repairRunAttempt).set({ state: 'customer_failed', baselineId,
        leaseExpiresAt: null, finishedAt: now, failureClassification: 'customer_baseline_failure', failureCode: 'test_failed' })
        .where(eq(repairRunAttempt.id, attemptId));
      await context.database.update(repairRun).set({ state: 'ready_for_investigation', baselineId,
        baselineOutcome: 'test_failed', failureClassification: 'customer_baseline_failure', failureCode: 'test_failed',
        baselineStartedAt: now, completedAt: now, stateChangedAt: now, updatedAt: now }).where(eq(repairRun.id, runId));
      await context.database.update(repairRunSourceCheckpoint).set({ baselineId }).where(eq(repairRunSourceCheckpoint.repairRunId, runId));
    }
  }
  const isVercel = options.provider === 'vercel';
  const providerAccount = isVercel ? VERCEL : PROJECT;
  const scope: ExternalExecutionScope = { workspaceId, repairRunId: runId, githubRepositoryId: 42,
    baseCommitSha: 'd'.repeat(40), operationCategory: isVercel ? 'sandbox_baseline' : 'gemini_investigation',
    providerId: isVercel ? 'vercel' : 'google', ...(isVercel ? {} : { modelId: 'gemini-3.1-flash-lite' }) };
  const accountId = randomUUID(); const grantId = randomUUID();
  await context.database.insert(executionBudgetGrant).values({ id: accountId, version: 1, scope: 'account',
    maxLogicalRequests: 1, maxProviderAttempts: 1, maxInputTokens: 100, maxOutputTokens: 100,
    maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0,
    maxConcurrentExternalOperations: 1, expiresAt, authorizedBy: 'operator', createdAt: now,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null,
      repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null,
      providerId: null, modelId: null, acceptancePurpose: null, limits: LIMITS,
      expiresAt: expiresAt.toISOString(), authorizedBy: 'operator' }) });
  await context.database.insert(executionBudgetGrant).values({ id: grantId, version: 2, scope: 'operation',
    workspaceId, repairRunId: runId, githubRepositoryId: 42, baseCommitSha: scope.baseCommitSha,
    operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId,
    authorizedReleaseSha: RELEASE_X, authorizedProviderAccountIdentity: providerAccount,
    maxLogicalRequests: 1, maxProviderAttempts: 1, maxInputTokens: 100, maxOutputTokens: 100,
    maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0,
    maxConcurrentExternalOperations: 0, expiresAt, authorizedBy: 'operator', createdAt: now,
    grantIdentity: computeExecutionGrantIdentity({ version: 2, scope: 'operation', workspaceId,
      repairRunId: runId, githubRepositoryId: 42, baseCommitSha: scope.baseCommitSha!, operationCategory: scope.operationCategory,
      providerId: scope.providerId, modelId: scope.modelId ?? null, acceptancePurpose: null, limits: { ...LIMITS, maxConcurrentExternalOperations: 0 },
      expiresAt: expiresAt.toISOString(), authorizedBy: 'operator', authorizedReleaseSha: RELEASE_X,
      authorizedProviderAccountIdentity: providerAccount }) });
  return { context, now, scope, grantId, baselineId, runId };
}

test('provider account identities are typed, canonical, and contain no credentials', () => {
  const google = googleProjectIdentity('gen-lang-client-0469095642');
  const vercel = vercelTeamProjectIdentity('team_dQVJwtsj7JcMXmVUYyFgrCzA', 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM');
  assert.equal(canonicalProviderAccountIdentity(google), '{"kind":"google_project","projectId":"gen-lang-client-0469095642"}');
  assert.equal(canonicalProviderAccountIdentity(vercel), '{"kind":"vercel_team_project","projectId":"prj_i6HNc531erDzTtCZZJZqIy7vJ3oM","teamId":"team_dQVJwtsj7JcMXmVUYyFgrCzA"}');
  assert.throws(() => canonicalProviderAccountIdentity({ ...google, token: 'secret' }), /provider_account_identity_invalid/);
  assert.throws(() => googleProjectIdentity(''), /provider_account_identity_invalid/);
});

test('disposable clean migration reaches 0024 with immutable provenance guards', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const ledger = await context.client.query<{ count: number }>('select count(*)::int as count from drizzle.__drizzle_migrations');
  assert.equal(ledger.rows[0]?.count, 25);
  const triggers = await context.client.query<{ tgname: string }>(`select tgname from pg_trigger where not tgisinternal and tgname in
    ('execution_budget_grant_insert_provenance_guard','external_execution_reservation_provenance_guard',
     'external_execution_event_provenance_guard','repair_run_provenance_guard','repository_baseline_provenance_guard',
     'repair_run_source_checkpoint_guard') order by tgname`);
  assert.equal(triggers.rows.length, 6);
  const constraints = await context.client.query<{ conname: string }>(`select conname from pg_constraint where conname in
    ('execution_budget_grant_provenance_check','external_execution_reservation_provenance_check',
     'repair_run_source_checkpoint_hash_check','repair_run_source_checkpoint_state_check') order by conname`);
  assert.equal(constraints.rows.length, 4);
});

test('Gemini credential and attested project are captured from one configuration snapshot', () => {
  const configuration = readGeminiProviderConfiguration({ GEMINI_API_KEY: 'test-only-secret-key',
    GEMINI_PROJECT_ID: 'gen-lang-client-0469095642' });
  assert.equal(configuration.apiKey, 'test-only-secret-key');
  assert.deepEqual(configuration.accountIdentity, PROJECT);
  assert.equal(JSON.stringify(configuration.accountIdentity).includes(configuration.apiKey), false);
  assert.throws(() => readGeminiProviderConfiguration({ GEMINI_API_KEY: 'test-only-secret-key' }));
  assert.throws(() => readGeminiProviderConfiguration({ GEMINI_API_KEY: 'test-only-secret-key', GEMINI_PROJECT_ID: 'invalid/project' }));
});

test('release and declared Gemini account are admitted only when exact and are durable', async (t) => {
  const value = await seeded(); t.after(() => value.context.client.close());
  for (const [release, identity] of [[RELEASE_Y, PROJECT], [RELEASE_X, googleProjectIdentity('different-project')],
    [undefined, PROJECT], ['INVALID', PROJECT], [RELEASE_X, undefined]] as const) {
    await assert.rejects(new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now,
      ...(release ? { runtimeReleaseSha: release } : {}) }).reserve({ scope: value.scope, amounts: AMOUNTS,
      ...(identity ? { providerAccountIdentity: identity } : {}) }), /execution_authority_mismatch/);
  }
  assert.equal((await value.context.database.select().from(externalExecutionReservation)).length, 0);
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, runtimeReleaseSha: RELEASE_X });
  const permit = await authority.reserve({ scope: value.scope, amounts: AMOUNTS, providerAccountIdentity: PROJECT });
  const [row] = await value.context.database.select().from(externalExecutionReservation).where(eq(externalExecutionReservation.id, permit.reservationId));
  assert.equal(row?.version, 2); assert.equal(row.executingReleaseSha, RELEASE_X);
  assert.deepEqual(row.executingProviderAccountIdentity, PROJECT);
  assert.equal(executionReservationIdentityMatches(row), true);
  assert.equal(JSON.stringify(row).includes('API_KEY'), false);
});

test('Vercel team and project provenance must match the same sandbox transport binding', async (t) => {
  const value = await seeded({ provider: 'vercel' }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, runtimeReleaseSha: RELEASE_X });
  const binding = { name: 'controlled-sandbox', teamId: 'team_test', projectId: 'project_test' };
  for (const [identity, sandbox] of [
    [vercelTeamProjectIdentity('other_team', 'project_test'), binding],
    [vercelTeamProjectIdentity('team_test', 'other_project'), binding],
    [undefined, binding],
    [VERCEL, { ...binding, teamId: 'other_team' }],
  ] as const) await assert.rejects(authority.reserve({ scope: value.scope, amounts: AMOUNTS, sandbox,
    ...(identity ? { providerAccountIdentity: identity } : {}) }), /execution_authority_mismatch/);
  assert.equal((await value.context.database.select().from(externalExecutionReservation)).length, 0);
  const permit = await authority.reserve({ scope: value.scope, amounts: AMOUNTS, sandbox: binding, providerAccountIdentity: VERCEL });
  const [row] = await value.context.database.select().from(externalExecutionReservation).where(eq(externalExecutionReservation.id, permit.reservationId));
  assert.ok(row);
  assert.deepEqual(row.executingProviderAccountIdentity, VERCEL);
  assert.equal(row.executingReleaseSha, RELEASE_X);
  assert.equal(JSON.stringify(row).includes('token'), false);
});

test('database rejects malformed v2 account identity, missing release, and new v1 operation grants', async (t) => {
  const value = await seeded(); t.after(() => value.context.client.close());
  const [grant] = await value.context.database.select().from(executionBudgetGrant).where(eq(executionBudgetGrant.id, value.grantId));
  assert.ok(grant);
  await assert.rejects(value.context.database.insert(executionBudgetGrant).values({ ...grant, id: randomUUID(),
    grantIdentity: '6'.repeat(64), authorizedProviderAccountIdentity: { kind: 'google_project' } as never }));
  await assert.rejects(value.context.database.insert(executionBudgetGrant).values({ ...grant, id: randomUUID(),
    grantIdentity: '7'.repeat(64), authorizedReleaseSha: null }));
  await assert.rejects(value.context.database.insert(executionBudgetGrant).values({ ...grant, id: randomUUID(), version: 1,
    grantIdentity: '8'.repeat(64), authorizedReleaseSha: null, authorizedProviderAccountIdentity: null }));
  const permit = await new DurableExternalExecutionAuthorizer(value.context.database,
    { clock: () => value.now, runtimeReleaseSha: RELEASE_X }).reserve({ scope: value.scope, amounts: AMOUNTS,
    providerAccountIdentity: PROJECT });
  await value.context.database.execute(sql`drop trigger external_execution_reservation_mutation_guard on external_execution_reservation`);
  await assert.rejects(value.context.database.update(externalExecutionReservation).set({ executingReleaseSha: null })
    .where(eq(externalExecutionReservation.id, permit.reservationId)));
});

test('reviewed source expectation is staged before baseline, derived by PostgreSQL, and cannot be replaced', async (t) => {
  const outcomes = {
    pending: 'pending', matched: 'matched', before_mismatch: 'mismatched', after_mismatch: 'mismatched',
    unchanged_false: 'unmeasured', untrusted: 'unmeasured', unmeasured: 'unmeasured',
  } as const;
  for (const [kind, expected] of Object.entries(outcomes) as Array<[CheckpointCase, string]>) {
    await t.test(kind, async (subtest) => {
      const value = await seeded({ checkpoint: kind }); subtest.after(() => value.context.client.close());
      const [checkpoint] = await value.context.database.select().from(repairRunSourceCheckpoint)
        .where(eq(repairRunSourceCheckpoint.repairRunId, value.runId));
      assert.ok(checkpoint);
      assert.equal(checkpoint.state, expected);
      assert.equal(checkpoint.baselineId, value.baselineId);
      assert.equal(checkpoint.observedSourceIdentity, kind === 'pending' ? null : kind === 'unmeasured' ? null : kind === 'before_mismatch' ? '9'.repeat(64) : 'e'.repeat(64));
      await assert.rejects(value.context.database.update(repairRunSourceCheckpoint).set({ expectedSourceIdentity: '0'.repeat(64) })
        .where(eq(repairRunSourceCheckpoint.repairRunId, value.runId)));
      await assert.rejects(value.context.database.delete(repairRunSourceCheckpoint)
        .where(eq(repairRunSourceCheckpoint.repairRunId, value.runId)));
      if (kind === 'pending') {
        await assert.rejects(value.context.database.update(repairRunSourceCheckpoint).set({ state: 'matched' })
          .where(eq(repairRunSourceCheckpoint.repairRunId, value.runId)));
      }
    });
  }
});

test('checkpoint state gates Gemini admission before provider transport and cannot be selected late', async (t) => {
  for (const kind of ['pending', 'before_mismatch', 'untrusted'] as const) {
    await t.test(kind, async (subtest) => {
      const value = await seeded({ checkpoint: kind }); subtest.after(() => value.context.client.close());
      let transportCalls = 0;
      const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now,
        runtimeReleaseSha: RELEASE_X, fetch: async () => { transportCalls++; return Response.json({}); } });
      await assert.rejects(authority.reserve({ scope: value.scope, amounts: AMOUNTS, providerAccountIdentity: PROJECT }), /execution_authority_mismatch/);
      assert.equal(transportCalls, 0);
      assert.equal((await value.context.database.select().from(externalExecutionReservation)).length, 0);
    });
  }
  const matched = await seeded({ checkpoint: 'matched' }); t.after(() => matched.context.client.close());
  const permit = await new DurableExternalExecutionAuthorizer(matched.context.database,
    { clock: () => matched.now, runtimeReleaseSha: RELEASE_X }).reserve({ scope: matched.scope, amounts: AMOUNTS, providerAccountIdentity: PROJECT });
  assert.ok(permit.reservationId);
  const late = await seeded(); t.after(() => late.context.client.close());
  await assert.rejects(late.context.database.insert(repairRunSourceCheckpoint).values({ repairRunId: late.runId,
    expectedSourceIdentity: 'e'.repeat(64), reviewedBy: 'operator', planIdentity: 'f'.repeat(64) }));
});

test('checkpoint cannot select older matching baseline evidence without this run\'s completed attempt', async (t) => {
  const value = await seeded({ checkpoint: 'matched' }); t.after(() => value.context.client.close());
  const [historical] = await value.context.database.select().from(repositoryBaseline)
    .where(eq(repositoryBaseline.id, value.baselineId!));
  const [originalRun] = await value.context.database.select().from(repairRun).where(eq(repairRun.id, value.runId));
  assert.ok(historical); assert.ok(originalRun);
  const oldBaselineId = randomUUID(); const runId = randomUUID();
  await value.context.database.insert(repositoryBaseline).values({ ...historical, id: oldBaselineId,
    sandboxName: 'historical-baseline' });
  await value.context.database.insert(repairRun).values({ id: runId, workspaceId: originalRun.workspaceId,
    githubRepositoryId: originalRun.githubRepositoryId, installationId: originalRun.installationId,
    profileIdentity: originalRun.profileIdentity, baseCommitSha: originalRun.baseCommitSha,
    idempotencyKey: randomUUID(), state: 'created' });
  await value.context.database.insert(repairRunSourceCheckpoint).values({ repairRunId: runId,
    expectedSourceIdentity: historical.sourceIdentityBefore!, reviewedBy: 'operator', planIdentity: 'f'.repeat(64) });
  await transitionRepairRun(value.context.database, originalRun.workspaceId, runId, 'created', 'baseline_running',
    value.now, { eventId: randomUUID() });
  await transitionRepairRun(value.context.database, originalRun.workspaceId, runId, 'baseline_running',
    'ready_for_investigation', value.now, { baselineId: oldBaselineId, eventId: randomUUID() });
  assert.equal((await value.context.database.select().from(repairRunAttempt)
    .where(eq(repairRunAttempt.repairRunId, runId))).length, 0);
  await assert.rejects(value.context.database.update(repairRunSourceCheckpoint).set({ baselineId: oldBaselineId })
    .where(eq(repairRunSourceCheckpoint.repairRunId, runId)));
});

test('RepairRun authority and finalized baseline evidence are immutable in PostgreSQL', async (t) => {
  const value = await seeded({ checkpoint: 'matched' }); t.after(() => value.context.client.close());
  await assert.rejects(value.context.database.update(repairRun).set({ baseCommitSha: '9'.repeat(40) }).where(eq(repairRun.id, value.runId)));
  await assert.rejects(value.context.database.update(repairRun).set({ baselineId: null }).where(eq(repairRun.id, value.runId)));
  await assert.rejects(value.context.database.delete(repairRun).where(eq(repairRun.id, value.runId)));
  await value.context.database.update(repairRun).set({ updatedAt: new Date(value.now.getTime() + 1000) }).where(eq(repairRun.id, value.runId));
  await assert.rejects(value.context.database.update(repositoryBaseline).set({ networkPolicy: 'unconfirmed' }).where(eq(repositoryBaseline.id, value.baselineId!)));
  await assert.rejects(value.context.database.delete(repositoryBaseline).where(eq(repositoryBaseline.id, value.baselineId!)));
});
