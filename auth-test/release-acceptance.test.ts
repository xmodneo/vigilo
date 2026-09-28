import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { executionBudgetGrant, releaseAcceptance, releaseAcceptanceRevocation, user, workspace } from '../db/schema.ts';
import { computeExecutionGrantIdentity, computeReleaseAcceptanceIdentity } from '../lib/external-execution/identity.ts';
import { acceptanceIdentityPayload, ReleaseAcceptanceError, resolveReleaseAcceptance } from '../lib/release-acceptance/resolver.ts';
import { createTestContext } from './support.ts';

async function seedAcceptance(state: 'pending' | 'passed' = 'passed', malformedGrant = false) {
  const context = await createTestContext();
  const now = new Date('2026-09-23T10:00:00.000Z');
  const expiresAt = new Date('2026-09-24T10:00:00.000Z');
  const userId = randomUUID(); const workspaceId = randomUUID(); const grantId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'reviewer', email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
  const limits = { logicalRequests: 0, providerAttempts: 0, inputTokens: 0, outputTokens: 0, sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0, maxConcurrentExternalOperations: 1 };
  await context.database.insert(executionBudgetGrant).values({
    id: grantId, version: 1, scope: 'account', maxLogicalRequests: 0, maxProviderAttempts: 0,
    maxInputTokens: 0, maxOutputTokens: 0, maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0,
    maxVerificationAttempts: 0, maxRepairLoopIterations: 0, maxConcurrentExternalOperations: 1,
    expiresAt, authorizedBy: 'security-reviewer', createdAt: now,
    grantIdentity: malformedGrant ? 'f'.repeat(64) : computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null, acceptancePurpose: null, limits, expiresAt: expiresAt.toISOString(), authorizedBy: 'security-reviewer' }),
  });
  const row = {
    id: randomUUID(), version: 1, kind: 'security_cost_control', state,
    boundaryVersion: 'external-authority-v1', releasedCommitSha: '7'.repeat(40), protocolVersion: null,
    workspaceId, repairRunId: null, repairLoopId: null, repairLoopIterationId: null,
    aiCandidateGenerationId: null, repairCandidateId: null, candidateIdentity: null,
    candidateVerificationId: null, verificationEvidenceId: null, verificationEvidenceIdentity: null,
    objectiveContractHash: null, objectiveEvidenceHash: null, humanReviewDecisionId: null,
    repairPublicationId: null, providerId: null, modelId: null, sandboxExecutionIdentity: null,
    executionBudgetGrantId: grantId, executionReservationIds: [] as string[], reviewedBy: 'security-reviewer',
    acceptedAt: now, createdAt: now, acceptanceIdentity: '',
  } satisfies typeof releaseAcceptance.$inferInsert;
  row.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(row as typeof releaseAcceptance.$inferSelect));
  await context.database.insert(releaseAcceptance).values(row);
  return { context, row, workspaceId, now };
}

test('exact passed acceptance resolves only for its immutable release boundary', async () => {
  const seeded = await seedAcceptance();
  const boundary = { kind: 'security_cost_control' as const, workspaceId: seeded.workspaceId, releasedCommitSha: '7'.repeat(40), boundaryVersion: 'external-authority-v1' };
  assert.equal((await resolveReleaseAcceptance(seeded.context.database, boundary)).id, seeded.row.id);
  const newer = { ...seeded.row, id: randomUUID(), releasedCommitSha: '8'.repeat(40), acceptedAt: new Date(seeded.now.getTime() + 1_000), createdAt: new Date(seeded.now.getTime() + 1_000), acceptanceIdentity: '' };
  newer.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(newer));
  await seeded.context.database.insert(releaseAcceptance).values(newer);
  assert.equal((await resolveReleaseAcceptance(seeded.context.database, boundary)).id, seeded.row.id);
  assert.equal((await resolveReleaseAcceptance(seeded.context.database, { ...boundary, releasedCommitSha: '8'.repeat(40) })).id, newer.id);
  const duplicate = { ...seeded.row, id: randomUUID(), acceptedAt: new Date(seeded.now.getTime() + 2_000), createdAt: new Date(seeded.now.getTime() + 2_000), reviewedBy: 'other-reviewer', acceptanceIdentity: '' };
  duplicate.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(duplicate));
  await assert.rejects(seeded.context.database.insert(releaseAcceptance).values(duplicate));
  for (const changed of [
    { ...boundary, releasedCommitSha: '9'.repeat(40) },
    { ...boundary, boundaryVersion: 'external-authority-v2' },
    { ...boundary, workspaceId: randomUUID() },
  ]) await assert.rejects(resolveReleaseAcceptance(seeded.context.database, changed), (error: unknown) => error instanceof ReleaseAcceptanceError && ['acceptance_missing', 'acceptance_boundary_mismatch'].includes(error.code));
  await seeded.context.client.close();
});

test('pending, revoked, malformed, and unknown acceptance states fail closed', async () => {
  const pending = await seedAcceptance('pending');
  await assert.rejects(resolveReleaseAcceptance(pending.context.database, { kind: 'security_cost_control', workspaceId: pending.workspaceId, releasedCommitSha: '7'.repeat(40), boundaryVersion: 'external-authority-v1' }), (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_missing');
  await assert.rejects(pending.context.database.insert(releaseAcceptance).values({ ...pending.row, id: randomUUID(), state: 'unknown' as never, acceptanceIdentity: 'a'.repeat(64) }));
  await pending.context.client.close();

  const passed = await seedAcceptance();
  await passed.context.database.insert(releaseAcceptanceRevocation).values({ id: randomUUID(), acceptanceId: passed.row.id, reasonCode: 'boundary_changed', revokedBy: 'security-reviewer', createdAt: passed.now });
  await assert.rejects(resolveReleaseAcceptance(passed.context.database, { kind: 'security_cost_control', workspaceId: passed.workspaceId, releasedCommitSha: '7'.repeat(40), boundaryVersion: 'external-authority-v1' }), (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_revoked');
  await assert.rejects(passed.context.database.delete(releaseAcceptanceRevocation));
  await passed.context.client.close();

  const forged = await seedAcceptance('passed', true);
  await assert.rejects(resolveReleaseAcceptance(forged.context.database, { kind: 'security_cost_control', workspaceId: forged.workspaceId, releasedCommitSha: '7'.repeat(40), boundaryVersion: 'external-authority-v1' }),
    (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_boundary_mismatch');
  await forged.context.client.close();
});

test('concurrent passed records cannot duplicate an exact release boundary', async () => {
  const seeded = await seedAcceptance('pending');
  const passed = (reviewedBy: string) => {
    const row = { ...seeded.row, id: randomUUID(), state: 'passed' as const, reviewedBy, acceptanceIdentity: '' };
    row.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(row));
    return row;
  };
  const results = await Promise.allSettled([
    seeded.context.database.insert(releaseAcceptance).values(passed('reviewer-one')),
    seeded.context.database.insert(releaseAcceptance).values(passed('reviewer-two')),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  await seeded.context.client.close();
});

test('deterministic acceptance records cannot unlock production publication', async () => {
  const source = await readFile('lib/human-reviews/flow.ts', 'utf8');
  assert.match(source, /function assertTask43LiveAcceptanceReleaseGate\(\): never[\s\S]*throw new HumanReviewError\('live_acceptance_pending'\)/);
  assert.doesNotMatch(source, /resolveReleaseAcceptance/);
});
