import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { buildReviewedStagingPlan, computeReviewedPlanIdentity, isReviewedStagingPlanIdentity, REVIEWED_STAGING_PLAN_TAG } from '../lib/external-execution/reviewed-plan.ts';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const INPUT = {
  kind: 'm77b_repair_v1',
  repairRunId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
  githubRepositoryId: 1411517943,
  installationId: 159763114,
  profileIdentity: 'a'.repeat(64),
  baseCommitSha: '3575b04ff48cf07f9f52b5b3f8cf529520619307',
  authorizedReleaseSha: 'db8a70cd7ad97ebf912d458ae7fd4518d2b1c88a',
  objective: 'Repair the deterministic test failure without changing tests.',
  expectedSourceIdentity: '6429fda80481a0ad3330ffc233dc449e44c6041762eab2dab88a3a479416f3ea',
  expiresAt: '2026-10-14T10:00:00.000Z',
  providerAccounts: {
    googleProjectId: 'gen-lang-client-0469095642',
    vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA',
    vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM',
  },
} as const;

const OWNER = { workspaceId: 'workspace-1', reviewerUserId: 'user-1' };

test('reviewed staging plan is deterministic and includes exactly the fixed six v2 grants', () => {
  const first = buildReviewedStagingPlan(OWNER, INPUT, NOW);
  const second = buildReviewedStagingPlan(OWNER, structuredClone(INPUT), NOW);
  assert.equal(first.planIdentity, second.planIdentity);
  assert.equal(first.planIdentity.startsWith(REVIEWED_STAGING_PLAN_TAG), true);
  assert.equal(isReviewedStagingPlanIdentity(first.planIdentity), true);
  assert.equal(isReviewedStagingPlanIdentity('8'.repeat(64)), false);
  assert.equal(first.accountGrant.version, 2);
  assert.equal(first.accountGrant.scope, 'account');
  assert.equal(first.accountGrant.maxLogicalRequests, 8);
  assert.equal(first.accountGrant.maxProviderAttempts, 197);
  assert.equal(first.accountGrant.maxInputTokens, 32_768);
  assert.equal(first.accountGrant.maxOutputTokens, 23_000);
  assert.equal(first.accountGrant.maxConcurrentExternalOperations, 1);
  assert.equal(first.accountGrant.maxSandboxIdentities, 2);
  assert.equal(first.accountGrant.maxSandboxRuntimeMs, 1_200_000);
  assert.equal(first.accountGrant.maxVerificationAttempts, 1);
  assert.equal(first.accountGrant.maxRepairLoopIterations, 1);
  assert.equal(first.operationGrants.length, 5);
  assert.deepEqual(first.operationGrants.map((grant) => grant.operationCategory).sort(), [
    'gemini_candidate_generation', 'gemini_investigation', 'repair_loop_iteration', 'sandbox_baseline', 'sandbox_verification',
  ]);
  assert.ok(first.operationGrants.every((grant) => grant.version === 2 && grant.authorizedReleaseSha === INPUT.authorizedReleaseSha));
  assert.ok(first.operationGrants.every((grant) => grant.repairRunId === INPUT.repairRunId && grant.githubRepositoryId === INPUT.githubRepositoryId));
  const byCategory = Object.fromEntries(first.operationGrants.map((grant) => [grant.operationCategory, grant]));
  assert.deepEqual([
    byCategory.gemini_investigation?.maxLogicalRequests, byCategory.gemini_investigation?.maxProviderAttempts,
    byCategory.gemini_investigation?.maxInputTokens, byCategory.gemini_investigation?.maxOutputTokens,
  ], [2, 2, 12_288, 5_000]);
  assert.deepEqual([
    byCategory.gemini_candidate_generation?.maxLogicalRequests, byCategory.gemini_candidate_generation?.maxProviderAttempts,
    byCategory.gemini_candidate_generation?.maxInputTokens, byCategory.gemini_candidate_generation?.maxOutputTokens,
  ], [3, 3, 20_480, 18_000]);
  for (const category of ['sandbox_baseline', 'sandbox_verification']) {
    const grant = byCategory[category];
    assert.deepEqual([grant?.providerId, grant?.maxLogicalRequests, grant?.maxProviderAttempts,
      grant?.maxSandboxIdentities, grant?.maxSandboxRuntimeMs, grant?.sandboxResourceClass],
    ['vercel', 1, 96, 1, 600_000, 'vcpu_1']);
  }
  assert.equal(byCategory.sandbox_verification?.maxVerificationAttempts, 1);
  assert.equal(byCategory.repair_loop_iteration?.maxRepairLoopIterations, 1);
  assert.equal(byCategory.repair_loop_iteration?.providerId, 'vigilo');
  assert.equal(byCategory.repair_loop_iteration?.authorizedProviderAccountIdentity, null);
  assert.equal(first.operationGrants.every((grant) => grant.expiresAt.toISOString() === INPUT.expiresAt), true);
});

test('reviewed plan identity is independent of operation-grant ordering', () => {
  const plan = buildReviewedStagingPlan(OWNER, INPUT, NOW);
  const facts = {
    workspaceId: OWNER.workspaceId, reviewerUserId: OWNER.reviewerUserId,
    repairRunId: INPUT.repairRunId, idempotencyKey: INPUT.idempotencyKey,
    githubRepositoryId: INPUT.githubRepositoryId, installationId: INPUT.installationId,
    profileIdentity: INPUT.profileIdentity, baseCommitSha: INPUT.baseCommitSha,
    authorizedReleaseSha: INPUT.authorizedReleaseSha, objectiveHash: plan.objective.objectiveHash,
    expectedSourceIdentity: INPUT.expectedSourceIdentity, expiresAt: INPUT.expiresAt,
    accountGrantIdentity: plan.accountGrant.grantIdentity,
    operationGrantIdentities: plan.operationGrants.map((grant) => grant.grantIdentity),
  };
  assert.equal(computeReviewedPlanIdentity(facts), plan.planIdentity);
  assert.equal(computeReviewedPlanIdentity({ ...facts, operationGrantIdentities: [...facts.operationGrantIdentities].reverse() }), plan.planIdentity);
  assert.notEqual(computeReviewedPlanIdentity({ ...facts, accountGrantIdentity: 'f'.repeat(64) }), plan.planIdentity);
  const replaced = [...facts.operationGrantIdentities]; replaced[0] = 'f'.repeat(64);
  assert.notEqual(computeReviewedPlanIdentity({ ...facts, operationGrantIdentities: replaced }), plan.planIdentity);
  assert.throws(() => computeReviewedPlanIdentity({ ...facts, operationGrantIdentities: [...facts.operationGrantIdentities, 'e'.repeat(64)] }));
});

test('reviewed staging plan identity changes for every authority-critical input', () => {
  const original = buildReviewedStagingPlan(OWNER, INPUT, NOW).planIdentity;
  for (const change of [
    { repairRunId: randomUUID() }, { idempotencyKey: randomUUID() }, { githubRepositoryId: 88 },
    { installationId: 99 }, { profileIdentity: 'b'.repeat(64) }, { baseCommitSha: 'b'.repeat(40) },
    { authorizedReleaseSha: 'c'.repeat(40) }, { objective: 'A different repair objective.' },
    { expectedSourceIdentity: 'd'.repeat(64) }, { expiresAt: '2026-10-14T09:00:00.000Z' },
    { providerAccounts: { ...INPUT.providerAccounts, googleProjectId: 'another-project' } },
    { providerAccounts: { ...INPUT.providerAccounts, vercelProjectId: 'another-project' } },
  ]) {
    const changed = buildReviewedStagingPlan(OWNER, { ...INPUT, ...change }, NOW);
    assert.notEqual(changed.planIdentity, original, JSON.stringify(change));
  }
  assert.notEqual(buildReviewedStagingPlan({ ...OWNER, reviewerUserId: 'user-2' }, INPUT, NOW).planIdentity, original);
  assert.notEqual(buildReviewedStagingPlan({ ...OWNER, workspaceId: 'workspace-2' }, INPUT, NOW).planIdentity, original);
});

test('reviewed staging input is allowlisted and expiry cannot exceed four hours', () => {
  assert.throws(() => buildReviewedStagingPlan(OWNER, { ...INPUT, extraGrant: true } as never, NOW));
  assert.throws(() => buildReviewedStagingPlan(OWNER, { ...INPUT, expiresAt: '2026-10-14T12:00:00.001Z' }, NOW));
  assert.throws(() => buildReviewedStagingPlan(OWNER, { ...INPUT, expiresAt: '2026-10-14T08:00:00.000Z' }, NOW));
});
