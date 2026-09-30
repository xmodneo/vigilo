import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { executionBudgetGrant, executionBudgetGrantRevocation, externalExecutionEvent, externalExecutionLease, externalExecutionReservation, repairRun, user, workspace } from '../db/schema.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { resolveExecutionAvailability } from '../lib/external-execution/availability.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { computeExecutionGrantIdentity } from '../lib/external-execution/identity.ts';
import type { ExternalExecutionAmounts, ExternalExecutionScope } from '../lib/external-execution/types.ts';
import { createTestContext } from './support.ts';

test('read-only execution availability reports zero authority without mutating authority state', async () => {
  const context = await createTestContext();
  const now = new Date('2026-09-29T10:00:00.000Z');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'operator', email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });

  const before = {
    grants: (await context.database.select().from(executionBudgetGrant)).length,
    reservations: (await context.database.select().from(externalExecutionReservation)).length,
    leases: (await context.database.select().from(externalExecutionLease)).length,
    events: (await context.database.select().from(externalExecutionEvent)).length,
  };
  const result = await resolveExecutionAvailability(context.database, workspaceId, { clock: () => now, operationalReady: true });
  const after = {
    grants: (await context.database.select().from(executionBudgetGrant)).length,
    reservations: (await context.database.select().from(externalExecutionReservation)).length,
    leases: (await context.database.select().from(externalExecutionLease)).length,
    events: (await context.database.select().from(externalExecutionEvent)).length,
  };

  assert.deepEqual(result, { status: 'no_authority' });
  assert.deepEqual(after, before);
  await context.client.close();
});

const generous = {
  logicalRequests: 5, providerAttempts: 5, inputTokens: 10_000, outputTokens: 5_000,
  sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0,
};

async function seedAuthority(options: { expiresAt?: Date; operationLogicalRequests?: number; concurrency?: number; includeOperation?: boolean; invalidOperationIdentity?: boolean } = {}) {
  const context = await createTestContext();
  const now = new Date('2026-09-29T10:00:00.000Z');
  const expiresAt = options.expiresAt ?? new Date('2026-09-30T10:00:00.000Z');
  const userId = randomUUID(); const workspaceId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'operator', email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
  const accountId = randomUUID(); const accountLimits = { ...generous, maxConcurrentExternalOperations: options.concurrency ?? 1 };
  await context.database.insert(executionBudgetGrant).values({
    id: accountId, version: 1, scope: 'account', maxLogicalRequests: generous.logicalRequests, maxProviderAttempts: generous.providerAttempts,
    maxInputTokens: generous.inputTokens, maxOutputTokens: generous.outputTokens, maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0,
    maxVerificationAttempts: 0, maxRepairLoopIterations: 0, maxConcurrentExternalOperations: accountLimits.maxConcurrentExternalOperations,
    expiresAt, authorizedBy: 'test-operator', createdAt: now,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null, acceptancePurpose: null, limits: accountLimits, expiresAt: expiresAt.toISOString(), authorizedBy: 'test-operator' }),
  });
  const operationId = randomUUID();
  const limits = { ...generous, logicalRequests: options.operationLogicalRequests ?? generous.logicalRequests, maxConcurrentExternalOperations: 0 };
  const scope: ExternalExecutionScope = { workspaceId, operationCategory: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite' };
  if (options.includeOperation !== false) await context.database.insert(executionBudgetGrant).values({
    id: operationId, version: 1, scope: 'operation', workspaceId, operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId,
    maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts, maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
    maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0, maxConcurrentExternalOperations: 0,
    expiresAt, authorizedBy: 'test-operator', createdAt: now,
    grantIdentity: options.invalidOperationIdentity ? 'f'.repeat(64) : computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId ?? null, acceptancePurpose: null, limits, expiresAt: expiresAt.toISOString(), authorizedBy: 'test-operator' }),
  });
  return { context, now, workspaceId, scope, operationId, accountId };
}

test('read-only execution availability distinguishes ready, readiness, expiry, exhaustion, and capacity', async (t) => {
  await t.test('available and operational readiness unavailable', async () => {
    const seeded = await seedAuthority();
    assert.deepEqual(await resolveExecutionAvailability(seeded.context.database, seeded.workspaceId, { clock: () => seeded.now, operationalReady: true }), { status: 'available' });
    assert.deepEqual(await resolveExecutionAvailability(seeded.context.database, seeded.workspaceId, { clock: () => seeded.now, operationalReady: false }), { status: 'operational_unavailable' });
    await seeded.context.client.close();
  });
  await t.test('expired', async () => {
    const seeded = await seedAuthority({ expiresAt: new Date('2026-09-29T09:00:00.000Z') });
    assert.deepEqual(await resolveExecutionAvailability(seeded.context.database, seeded.workspaceId, { clock: () => seeded.now, operationalReady: true }), { status: 'invalid_or_expired' });
    await seeded.context.client.close();
  });
  await t.test('exhausted', async () => {
    const seeded = await seedAuthority({ operationLogicalRequests: 0 });
    assert.deepEqual(await resolveExecutionAvailability(seeded.context.database, seeded.workspaceId, { clock: () => seeded.now, operationalReady: true }), { status: 'exhausted' });
    await seeded.context.client.close();
  });
  await t.test('capacity unavailable without resolver mutation', async () => {
    const seeded = await seedAuthority({ concurrency: 1 });
    const amounts: ExternalExecutionAmounts = { logicalRequests: 1, providerAttempts: 1, inputTokens: 100, outputTokens: 100, sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0 };
    await new DurableExternalExecutionAuthorizer(seeded.context.database, { clock: () => seeded.now }).reserve({ scope: seeded.scope, amounts });
    const before = (await seeded.context.database.select().from(externalExecutionReservation)).length;
    assert.deepEqual(await resolveExecutionAvailability(seeded.context.database, seeded.workspaceId, { clock: () => seeded.now, operationalReady: true }), { status: 'capacity_unavailable' });
    assert.equal((await seeded.context.database.select().from(externalExecutionReservation)).length, before);
    await seeded.context.client.close();
  });
  await t.test('revoked and identity-mismatched grants fail closed', async () => {
    const revoked = await seedAuthority();
    await revoked.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: revoked.operationId, reasonCode: 'operator_revoked', revokedBy: 'test-operator', createdAt: revoked.now });
    assert.deepEqual(await resolveExecutionAvailability(revoked.context.database, revoked.workspaceId, { clock: () => revoked.now, operationalReady: true }), { status: 'no_authority' });
    await revoked.context.client.close();
    const malformed = await seedAuthority({ invalidOperationIdentity: true });
    assert.deepEqual(await resolveExecutionAvailability(malformed.context.database, malformed.workspaceId, { clock: () => malformed.now, operationalReady: true }), { status: 'invalid_or_expired' });
    await malformed.context.client.close();
  });
  await t.test('one-shot release authority never enables general provider actions', async () => {
    const seeded = await seedAuthority({ includeOperation: false });
    const runId = randomUUID(); const repositoryId = 42; const baseCommitSha = 'a'.repeat(40); const purpose = 'task_4_3_live_acceptance';
    await seeded.context.database.insert(repairRun).values({ id: runId, workspaceId: seeded.workspaceId, githubRepositoryId: repositoryId, installationId: 77, profileIdentity: 'b'.repeat(64), baseCommitSha, idempotencyKey: randomUUID(), state: 'created', stateChangedAt: seeded.now, updatedAt: seeded.now });
    const limits = { ...generous, logicalRequests: 1, providerAttempts: 0, maxConcurrentExternalOperations: 0 };
    await seeded.context.database.insert(executionBudgetGrant).values({
      id: randomUUID(), version: 1, scope: 'one_shot', workspaceId: seeded.workspaceId, repairRunId: runId, githubRepositoryId: repositoryId, baseCommitSha,
      operationCategory: 'release_acceptance_one_shot', providerId: 'vigilo', acceptancePurpose: purpose,
      maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts, maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
      maxSandboxIdentities: limits.sandboxIdentities, maxSandboxRuntimeMs: limits.sandboxRuntimeMs, maxVerificationAttempts: limits.verificationAttempts,
      maxRepairLoopIterations: limits.repairLoopIterations, maxConcurrentExternalOperations: 0, expiresAt: new Date('2026-09-30T10:00:00.000Z'), authorizedBy: 'release-operator', createdAt: seeded.now,
      grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'one_shot', workspaceId: seeded.workspaceId, repairRunId: runId, githubRepositoryId: repositoryId, baseCommitSha, operationCategory: 'release_acceptance_one_shot', providerId: 'vigilo', modelId: null, acceptancePurpose: purpose, limits, expiresAt: '2026-09-30T10:00:00.000Z', authorizedBy: 'release-operator' }),
    });
    assert.deepEqual(await resolveExecutionAvailability(seeded.context.database, seeded.workspaceId, { clock: () => seeded.now, operationalReady: true }), { status: 'no_authority' });
    await seeded.context.client.close();
  });
  await t.test('database failures return unknown without mutation', async () => {
    const broken = { select: () => { throw new Error('database unavailable'); } } as unknown as VigiloDatabase;
    assert.deepEqual(await resolveExecutionAvailability(broken, randomUUID(), { operationalReady: true }), { status: 'unknown' });
  });
});
