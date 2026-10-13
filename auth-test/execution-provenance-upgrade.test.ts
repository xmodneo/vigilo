import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';

import { executionBudgetGrant, executionProfile, externalExecutionEvent, externalExecutionLease, externalExecutionReservation, githubInstallation, releaseAcceptance, repairRun,
  repository, repositoryBaseline, user, workspace } from '../db/schema.ts';
import { computeExecutionGrantIdentity, computeExecutionReservationIdentity, executionGrantIdentityMatches,
  executionReservationIdentityMatches } from '../lib/external-execution/identity.ts';
import { acceptanceIdentityPayload, verifyAcceptanceExecutionAudit } from '../lib/release-acceptance/resolver.ts';
import { computeReleaseAcceptanceIdentity } from '../lib/external-execution/identity.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { googleProjectIdentity } from '../lib/external-execution/provider-account.ts';
import { MIGRATION_MANIFEST, validateMigrationFiles } from '../lib/operations/migrations.ts';

const root = resolve(process.cwd(), 'drizzle');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('disposable 0023→0024 upgrade preserves provenance-free historical rows and ordered hashes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vigilo-provenance-upgrade-'));
  const client = new PGlite();
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, 'meta'));
  const journal = JSON.parse(await readFile(join(root, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  assert.equal(journal.entries.length, 26);
  await writeFile(join(directory, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 24) }));
  for (const entry of journal.entries.slice(0, 24)) await copyFile(join(root, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  const database = drizzle(client);
  await migrate(database, { migrationsFolder: directory });
  const now = new Date('2031-01-02T03:04:05.000Z'); const expiresAt = new Date('2031-01-03T03:04:05.000Z');
  const workspaceId = randomUUID(); const userId = randomUUID(); const runId = randomUUID(); const baselineId = randomUUID();
  const accountId = randomUUID(); const grantId = randomUUID(); const reservationId = randomUUID();
  await database.insert(user).values({ id: userId, name: 'Historical operator', email: `${userId}@test.invalid`, emailVerified: true });
  await database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: 42, installationId: 73,
    profileIdentity: 'c'.repeat(64), baseCommitSha: 'd'.repeat(40), idempotencyKey: randomUUID(), state: 'created' });
  await database.insert(githubInstallation).values({ installationId: 73, workspaceId, githubAccountId: 23,
    accountLogin: 'operator', accountType: 'User', status: 'active' });
  await database.execute(sql`insert into repository
    (github_repository_id,workspace_id,installation_id,owner_id,owner_login,name,full_name,default_branch,is_private)
    values (42,${workspaceId},73,23,'operator','repo','operator/repo','main',false)`);
  await database.insert(executionProfile).values({ githubRepositoryId: 42, workspaceId, installationId: 73, profileVersion: 2,
    profileIdentity: 'c'.repeat(64), baseCommitSha: 'd'.repeat(40), runtimeFamily: 'node', nodeMajor: 24,
    packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build',
    testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: '1'.repeat(40), packageJsonContentSha256: '2'.repeat(64),
    packageLockBlobSha: '3'.repeat(40), packageLockContentSha256: '4'.repeat(64), status: 'ready' });
  await database.insert(repositoryBaseline).values({ id: baselineId, workspaceId, githubRepositoryId: 42,
    installationId: 73, evidenceVersion: 1, profileIdentity: 'c'.repeat(64), baseCommitSha: 'd'.repeat(40),
    archiveSha256: '5'.repeat(64), sandboxName: 'historical-baseline', sourceIdentityBefore: 'e'.repeat(64),
    sourceIdentityAfter: 'e'.repeat(64), sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all',
    installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0,
    typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'failed',
    testExitCode: 1, testTimedOut: false, executionOutcome: 'test_failed', overallOutcome: 'test_failed',
    cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'npm_command_failed',
    startedAt: now, completedAt: now, durationMs: 1 });
  await database.update(repairRun).set({ state: 'ready_for_investigation', baselineId, baselineOutcome: 'test_failed',
    failureClassification: 'customer_baseline_failure', failureCode: 'test_failed', baselineStartedAt: now,
    completedAt: now, stateChangedAt: now, updatedAt: now }).where(eq(repairRun.id, runId));
  const accountLimits = { logicalRequests: 2, providerAttempts: 2, inputTokens: 200, outputTokens: 200,
    sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0, maxConcurrentExternalOperations: 1 };
  const operationLimits = { ...accountLimits, maxConcurrentExternalOperations: 0 };
  const accountGrant = { id: accountId, version: 1, scope: 'account' as const,
    maxLogicalRequests: 2, maxProviderAttempts: 2, maxInputTokens: 200, maxOutputTokens: 200,
    maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0,
    maxConcurrentExternalOperations: 1, expiresAt, authorizedBy: 'historical-operator', createdAt: now,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null,
      githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null,
      acceptancePurpose: null, limits: accountLimits, expiresAt: expiresAt.toISOString(), authorizedBy: 'historical-operator' }) };
  await database.execute(sql`insert into execution_budget_grant
    (id,version,scope,max_logical_requests,max_provider_attempts,max_input_tokens,max_output_tokens,max_sandbox_identities,
     max_sandbox_runtime_ms,max_verification_attempts,max_repair_loop_iterations,max_concurrent_external_operations,
     expires_at,authorized_by,grant_identity,created_at)
    values (${accountId},1,'account',2,2,200,200,0,0,0,0,1,${expiresAt},'historical-operator',${accountGrant.grantIdentity},${now})`);
  const scope = { workspaceId, repairRunId: runId, githubRepositoryId: 42, baseCommitSha: 'd'.repeat(40),
    operationCategory: 'gemini_investigation' as const, providerId: 'google', modelId: 'gemini-3.1-flash-lite' };
  const legacyGrantIdentity = computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId, repairRunId: runId,
      githubRepositoryId: 42, baseCommitSha: scope.baseCommitSha, operationCategory: scope.operationCategory,
      providerId: scope.providerId, modelId: scope.modelId, acceptancePurpose: null, limits: operationLimits,
      expiresAt: expiresAt.toISOString(), authorizedBy: 'historical-operator' });
  await database.execute(sql`insert into execution_budget_grant
    (id,version,scope,workspace_id,repair_run_id,github_repository_id,base_commit_sha,operation_category,provider_id,model_id,
     max_logical_requests,max_provider_attempts,max_input_tokens,max_output_tokens,max_sandbox_identities,max_sandbox_runtime_ms,
     max_verification_attempts,max_repair_loop_iterations,max_concurrent_external_operations,expires_at,authorized_by,grant_identity,created_at)
    values (${grantId},1,'operation',${workspaceId},${runId},42,${scope.baseCommitSha},${scope.operationCategory},
      ${scope.providerId},${scope.modelId},2,2,200,200,0,0,0,0,0,${expiresAt},'historical-operator',${legacyGrantIdentity},${now})`);
  const amounts = { logicalRequests: 1, providerAttempts: 1, inputTokens: 10, outputTokens: 10,
    sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0 };
  const operationKey = randomUUID();
  const legacyReservationIdentity = computeExecutionReservationIdentity({ version: 1, grantId, accountGrantId: accountId,
    scope, amounts, operationKey, fence: 1 });
  await database.execute(sql`insert into external_execution_reservation
    (id,version,grant_id,account_grant_id,workspace_id,repair_run_id,github_repository_id,base_commit_sha,
     operation_category,provider_id,model_id,operation_key,reserved_logical_requests,reserved_provider_attempts,
     reserved_input_tokens,reserved_output_tokens,reserved_sandbox_identities,reserved_sandbox_runtime_ms,
     reserved_verification_attempts,reserved_repair_loop_iterations,fence,reservation_identity,created_at)
    values (${reservationId},1,${grantId},${accountId},${workspaceId},${runId},42,${scope.baseCommitSha},
      ${scope.operationCategory},${scope.providerId},${scope.modelId},${operationKey},1,1,10,10,0,0,0,0,1,${legacyReservationIdentity},${now})`);
  const completedAt = new Date(now.getTime() + 1000);
  await database.insert(externalExecutionLease).values({ reservationId, ownershipToken: randomUUID(), fence: 1,
    state: 'active', heartbeatAt: now, leaseExpiresAt: expiresAt });
  await database.insert(externalExecutionEvent).values({ id: randomUUID(), reservationId, eventType: 'reserved', createdAt: now });
  await database.insert(externalExecutionEvent).values({ id: randomUUID(), reservationId, eventType: 'attempt_started',
    attemptOrdinal: 1, createdAt: now });
  await database.insert(externalExecutionEvent).values({ id: randomUUID(), reservationId, eventType: 'attempt_succeeded',
    attemptOrdinal: 1, inputTokens: 5, outputTokens: 5, createdAt: completedAt });
  await database.update(externalExecutionLease).set({ state: 'succeeded', completedAt }).where(eq(externalExecutionLease.reservationId, reservationId));
  await database.insert(externalExecutionEvent).values({ id: randomUUID(), reservationId, eventType: 'completed', createdAt: completedAt });
  const acceptance = { id: randomUUID(), version: 1, kind: 'security_cost_control', state: 'pending',
    boundaryVersion: 'external-authority-v1', releasedCommitSha: 'a'.repeat(40), workspaceId,
    protocolVersion: null, repairRunId: null, repairLoopId: null, repairLoopIterationId: null,
    aiCandidateGenerationId: null, repairCandidateId: null, candidateIdentity: null,
    candidateVerificationId: null, verificationEvidenceId: null, verificationEvidenceIdentity: null,
    objectiveContractHash: null, objectiveEvidenceHash: null, humanReviewDecisionId: null,
    repairPublicationId: null, providerId: null, modelId: null, sandboxExecutionIdentity: null,
    executionBudgetGrantId: accountId, executionReservationIds: [reservationId], reviewedBy: 'historical-operator',
    acceptedAt: now, createdAt: now, acceptanceIdentity: '' } as typeof releaseAcceptance.$inferInsert;
  acceptance.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(acceptance as typeof releaseAcceptance.$inferSelect));
  await database.insert(releaseAcceptance).values(acceptance);

  const originalLedger = (await client.query<{ hash: string; created_at: string }>('select hash, created_at from drizzle.__drizzle_migrations order by id')).rows;
  assert.equal(originalLedger.length, 24);
  await migrate(database, { migrationsFolder: root });
  await validateMigrationFiles(process.cwd());
  const ledger = (await client.query<{ hash: string; created_at: string }>('select hash, created_at from drizzle.__drizzle_migrations order by id')).rows;
  assert.equal(ledger.length, 26);
  assert.deepEqual(ledger.slice(0, 24), originalLedger);
  assert.deepEqual(ledger.map((row) => row.hash), MIGRATION_MANIFEST.map((entry) => entry.hash));
  assert.equal(ledger[24]?.hash, sha256(await readFile(join(root, '0024_execution-provenance.sql'), 'utf8')));
  const [oldGrant] = await database.select().from(executionBudgetGrant).where(eq(executionBudgetGrant.id, grantId));
  const [oldReservation] = await database.select().from(externalExecutionReservation).where(eq(externalExecutionReservation.id, reservationId));
  const [oldAcceptance] = await database.select().from(releaseAcceptance).where(eq(releaseAcceptance.id, acceptance.id));
  const [oldRun] = await database.select().from(repairRun).where(eq(repairRun.id, runId));
  assert.ok(oldGrant); assert.ok(oldReservation); assert.ok(oldAcceptance); assert.ok(oldRun);
  assert.equal(oldGrant.version, 1); assert.equal(oldGrant.authorizedReleaseSha, null);
  assert.equal(oldGrant.authorizedProviderAccountIdentity, null); assert.equal(executionGrantIdentityMatches(oldGrant), true);
  assert.equal(oldReservation.version, 1); assert.equal(oldReservation.executingReleaseSha, null);
  assert.equal(oldReservation.executingProviderAccountIdentity, null); assert.equal(executionReservationIdentityMatches(oldReservation), true);
  assert.equal(await verifyAcceptanceExecutionAudit(database as never, [reservationId]), true);
  assert.equal(await verifyAcceptanceExecutionAudit(database as never, [reservationId], 'a'.repeat(40)), false);
  assert.equal(oldAcceptance.id, acceptance.id); assert.equal(oldRun.id, runId); assert.equal(oldRun.baselineId, baselineId);
  const [oldBaseline] = await database.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, baselineId));
  assert.ok(oldBaseline);
  assert.equal(oldBaseline.id, baselineId); assert.equal(oldBaseline.sourceIdentityBefore, 'e'.repeat(64));
  await assert.rejects(new DurableExternalExecutionAuthorizer(database as never, { clock: () => now,
    runtimeReleaseSha: 'a'.repeat(40) }).reserve({ scope, amounts,
    providerAccountIdentity: googleProjectIdentity('historical-project') }), /execution_authority_mismatch/);
  await assert.rejects(database.insert(executionBudgetGrant).values({ ...accountGrant, id: randomUUID(), scope: 'operation',
    workspaceId, repairRunId: runId, githubRepositoryId: 42, baseCommitSha: 'd'.repeat(40),
    operationCategory: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite' }));
  await assert.rejects(database.update(repairRun).set({ baseCommitSha: 'f'.repeat(40) }).where(eq(repairRun.id, runId)));
  await assert.rejects(database.update(repositoryBaseline).set({ sourceIdentityBefore: '0'.repeat(64) }).where(eq(repositoryBaseline.id, baselineId)));
});
