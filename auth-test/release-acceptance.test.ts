import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sql } from 'drizzle-orm';

import { executionBudgetGrant, releaseAcceptance, releaseAcceptanceRevocation, user, workspace } from '../db/schema.ts';
import { computeExecutionGrantIdentity, computeReleaseAcceptanceIdentity } from '../lib/external-execution/identity.ts';
import { acceptanceIdentityPayload, ReleaseAcceptanceError, resolveReleaseAcceptance } from '../lib/release-acceptance/resolver.ts';
import {
  PUBLICATION_ACCEPTANCE_BOUNDARIES,
  computePublicationBootstrapPurpose,
} from '../lib/release-acceptance/publication-gate.ts';
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
    { ...boundary, protocolVersion: 1 },
    { ...boundary, providerId: 'fake-provider' },
    { ...boundary, modelId: 'fake-model' },
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

test('resolver rejects an ambiguous passed boundary even if catalog guards are deliberately removed', async () => {
  const seeded = await seedAcceptance();
  await seeded.context.database.execute(sql`drop trigger release_acceptance_insert_guard on release_acceptance`);
  await seeded.context.database.execute(sql`drop index release_acceptance_passed_boundary_unique`);
  const duplicate = { ...seeded.row, id: randomUUID(), reviewedBy: 'second-reviewer', acceptanceIdentity: '' };
  duplicate.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(duplicate));
  await seeded.context.database.insert(releaseAcceptance).values(duplicate);
  await assert.rejects(resolveReleaseAcceptance(seeded.context.database, {
    kind: 'security_cost_control', workspaceId: seeded.workspaceId, releasedCommitSha: '7'.repeat(40), boundaryVersion: 'external-authority-v1',
  }), (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_boundary_mismatch');
  await seeded.context.client.close();
});

test('production publication uses the immutable composite acceptance resolver', async () => {
  const source = await readFile('lib/human-reviews/flow.ts', 'utf8');
  assert.doesNotMatch(source, /assertTask43LiveAcceptanceReleaseGate/);
  assert.match(source, /resolvePublicationReleaseAuthority/);
});

test('worker artifacts exclude publication test adapters and runtime rejects injected resolvers outside the test harness', async () => {
  const configuration = JSON.parse(await readFile('tsconfig.worker.json', 'utf8')) as { exclude: string[] };
  assert.ok(configuration.exclude.includes('lib/repair-publications/testing.ts'));
  const { processRepairPublicationJobWithResolverInternal } = await import('../lib/repair-publications/worker.ts');
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let calls = 0;
  try {
    await assert.rejects(processRepairPublicationJobWithResolverInternal({} as never, {} as never, async () => {
      calls += 1; throw new Error('test_override');
    }), /publication_authority_mismatch/);
    assert.equal(calls, 0);
  } finally {
    if (previous !== undefined) process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('production release identity has no Git or test-only fallback', async () => {
  const source = await readFile('lib/operations/release.ts', 'utf8');
  assert.doesNotMatch(source, /testReleaseSha|git\s+rev-parse|exec(File|Sync)?/);
  assert.match(source, /environment\.VIGILO_RELEASE_SHA/);
});

test('publication acceptance boundaries require the exact complete live set', () => {
  assert.deepEqual(PUBLICATION_ACCEPTANCE_BOUNDARIES, {
    repair_loop_live: { boundaryVersion: 'repair-loop-live-v1', protocolVersion: 4, providerId: 'google', modelId: 'gemini-3.1-flash-lite' },
    human_review_live: { boundaryVersion: 'human-review-v1' },
    draft_publication_live: { boundaryVersion: 'draft-publication-v1' },
    security_cost_control: { boundaryVersion: 'external-authority-v1' },
  });
});

test('publication bootstrap purpose binds every publication subject identity and the release', () => {
  const subject = {
    workspaceId: randomUUID(), installationId: 101, githubRepositoryId: 202, baseCommitSha: '1'.repeat(40),
    repairRunId: randomUUID(), repairLoopId: randomUUID(), repairLoopIterationId: randomUUID(),
    aiCandidateGenerationId: randomUUID(), repairCandidateId: randomUUID(), candidateIdentity: '2'.repeat(64),
    candidateVerificationId: randomUUID(), verificationEvidenceId: randomUUID(), verificationEvidenceIdentity: '3'.repeat(64),
    humanReviewDecisionId: randomUUID(), humanReviewDecisionIdentity: '4'.repeat(64), reviewSubjectIdentity: '5'.repeat(64),
  };
  const purpose = computePublicationBootstrapPurpose(subject, '6'.repeat(40));
  assert.match(purpose, /^draft-pr-v1:[0-9a-f]{64}$/);
  assert.ok(purpose.length <= 80);
  for (const changed of [
    { ...subject, workspaceId: randomUUID() },
    { ...subject, installationId: 102 },
    { ...subject, githubRepositoryId: 203 },
    { ...subject, baseCommitSha: '7'.repeat(40) },
    { ...subject, repairRunId: randomUUID() },
    { ...subject, repairLoopId: randomUUID() },
    { ...subject, repairLoopIterationId: randomUUID() },
    { ...subject, aiCandidateGenerationId: randomUUID() },
    { ...subject, repairCandidateId: randomUUID() },
    { ...subject, candidateIdentity: '8'.repeat(64) },
    { ...subject, candidateVerificationId: randomUUID() },
    { ...subject, verificationEvidenceId: randomUUID() },
    { ...subject, verificationEvidenceIdentity: '9'.repeat(64) },
    { ...subject, humanReviewDecisionId: randomUUID() },
    { ...subject, humanReviewDecisionIdentity: 'a'.repeat(64) },
    { ...subject, reviewSubjectIdentity: 'b'.repeat(64) },
  ]) assert.notEqual(computePublicationBootstrapPurpose(changed, '6'.repeat(40)), purpose);
  assert.notEqual(computePublicationBootstrapPurpose(subject, 'c'.repeat(40)), purpose);
});
