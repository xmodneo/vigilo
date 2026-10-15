import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { workspace } from '../db/schema.ts';
import { resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';

import { runReviewedStagingCommand } from '../lib/external-execution/reviewed-staging-cli.ts';
import { createTestContext, saveGithubUser } from './support.ts';
import { buildReviewedStagingPlan, type ReviewedStagingInput } from '../lib/external-execution/reviewed-plan.ts';

const input: ReviewedStagingInput = {
  kind: 'm77b_repair_v1', repairRunId: randomUUID(), idempotencyKey: randomUUID(),
  githubRepositoryId: 1411517943, installationId: 159763114,
  profileIdentity: 'a'.repeat(64), baseCommitSha: 'b'.repeat(40), authorizedReleaseSha: 'c'.repeat(40),
  objective: 'Investigate the controlled failing test.', expectedSourceIdentity: 'd'.repeat(64),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  providerAccounts: { googleProjectId: 'gen-lang-client-0469095642', vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA', vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM' },
};
const actor = { workspaceId: randomUUID(), reviewerUserId: randomUUID() };

test('operator dry-run is pure and outputs only safe reviewed-plan facts', async () => {
  let called = false;
  const result = await runReviewedStagingCommand('dry-run', { actor, plan: input }, {
    apply: async () => { called = true; throw new Error('must_not_apply'); },
    resolveContext: async () => { called = true; throw new Error('must_not_authenticate'); },
  });
  assert.equal(called, false);
  assert.equal(result.kind, 'review');
  assert.match(result.planIdentity, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes(input.objective), false);
});

test('operator apply rejects forged actor and never exposes session material', async () => {
  const sessionCookie = 'session=opaque-private-cookie';
  let applied = false;
  const approvedPlanIdentity = buildReviewedStagingPlan(actor, input).planIdentity;
  await assert.rejects(runReviewedStagingCommand('apply', { actor, plan: input, approvedPlanIdentity, sessionCookie }, {
    resolveContext: async () => ({ workspace: { id: actor.workspaceId, ownerUserId: 'different' }, user: { id: 'different' } }) as never,
    apply: async () => { applied = true; throw new Error('must_not_apply'); },
  }), /reviewed_staging_unauthorized/);
  assert.equal(applied, false);
});

test('operator apply invokes only the reviewed domain service with authenticated ownership', async () => {
  const approvedPlanIdentity = buildReviewedStagingPlan(actor, input).planIdentity;
  const sessionCookie = 'session=opaque-private-cookie';
  let calls = 0;
  const result = await runReviewedStagingCommand('apply', { actor, plan: input, approvedPlanIdentity, sessionCookie }, {
    resolveContext: async (cookie) => {
      assert.equal(cookie, sessionCookie);
      return { workspace: { id: actor.workspaceId, ownerUserId: actor.reviewerUserId },
        user: { id: actor.reviewerUserId } } as never;
    },
    apply: async (context, plan, approved) => {
      calls += 1;
      assert.equal(context.user.id, actor.reviewerUserId);
      assert.deepEqual(plan, input);
      assert.equal(approved, approvedPlanIdentity);
      return { repairRunId: input.repairRunId, planIdentity: approvedPlanIdentity,
        sourceCheckpointState: 'pending', accountGrantId: randomUUID(),
        operationGrantIds: Array.from({ length: 5 }, () => randomUUID()), baselineJobId: input.repairRunId };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.kind, 'staged');
  assert.equal(result.grantCount, 6);
  assert.equal(JSON.stringify(result).includes(sessionCookie), false);
});

test('operator refuses arbitrary grant rows and unapproved hashes before authentication', async () => {
  let called = false;
  const dependencies = {
    resolveContext: async () => { called = true; throw new Error('must_not_authenticate'); },
    apply: async () => { called = true; throw new Error('must_not_apply'); },
  };
  await assert.rejects(runReviewedStagingCommand('dry-run', { actor, plan: input, grants: [] }, dependencies), /reviewed_plan_mismatch/);
  await assert.rejects(runReviewedStagingCommand('apply', { actor, plan: input,
    approvedPlanIdentity: 'f'.repeat(64), sessionCookie: 'session=opaque' }, dependencies), /reviewed_plan_mismatch/);
  assert.equal(called, false);
});

test('operator existing-workspace auth never provisions a workspace outside staging', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());
  const user = await saveGithubUser(context, 'operator-existing-only');
  const login = await context.testAuth.login({ userId: user.id });
  await context.database.delete(workspace);
  const getSession = (headers: Headers) => context.auth.api.getSession({ headers });
  await assert.rejects(resolveAuthenticatedWorkspace(getSession, context.database, login.headers,
    { existingWorkspaceOnly: true }), /unauthorized/);
  assert.equal((await context.database.select().from(workspace)).length, 0);
  const created = await resolveAuthenticatedWorkspace(getSession, context.database, login.headers);
  const existing = await resolveAuthenticatedWorkspace(getSession, context.database, login.headers,
    { existingWorkspaceOnly: true });
  assert.equal(existing.workspace.id, created.workspace.id);
  assert.equal((await context.database.select().from(workspace)).length, 1);
});
