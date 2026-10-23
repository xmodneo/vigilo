import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { readLocalStagingArtifact } from '../lib/external-execution/local-staging-artifact.ts';
import { createLocalStagingHandler } from '../lib/external-execution/local-staging-handler.ts';
import { buildReviewedStagingPlan } from '../lib/external-execution/reviewed-plan.ts';

const actor = { workspaceId: 'workspace-one', reviewerUserId: 'owner-one' };
const objective = 'Repair the controlled public fixture failure without changing its tests.';
const objectiveHash = createHash('sha256').update(objective).digest('hex');
const releaseSha = 'a'.repeat(40);
const providerAccounts = { googleProjectId: 'gen-lang-client-0469095642',
  vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA', vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM' };
const input = {
  kind: 'm77b_repair_v1' as const,
  repairRunId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
  githubRepositoryId: 1411517943, installationId: 159763114, profileIdentity: 'b'.repeat(64),
  baseCommitSha: '3575b04ff48cf07f9f52b5b3f8cf529520619307', authorizedReleaseSha: releaseSha,
  objective, expectedSourceIdentity: '6429fda80481a0ad3330ffc233dc449e44c6041762eab2dab88a3a479416f3ea',
  expiresAt: '2026-10-23T12:00:00.000Z', providerAccounts,
};
const approvedPlanIdentity = buildReviewedStagingPlan(actor, input, new Date('2026-10-23T10:00:00.000Z')).planIdentity;
const owner: AuthenticatedWorkspace = { sessionId: 'private-session',
  user: { id: 'owner-one', name: 'Owner', email: 'owner@example.test' }, githubUserId: 'github-owner',
  workspace: { id: actor.workspaceId, ownerUserId: 'owner-one' } };
const configuration = { enabled: true, nodeEnv: 'development', baseUrl: 'http://localhost:3000',
  operatorOrigin: 'http://localhost:3002', databaseUrl: 'postgres://user:pass@127.0.0.1:55432/vigilo',
  releaseSha, providerAccounts, objectiveHash };
const get = () => new Request('http://localhost:3002/', { headers: { host: 'localhost:3002', cookie: 'vigilo.session_token=opaque-test-cookie' } });
const post = (csrf: string, planIdentity = approvedPlanIdentity, headers: Record<string, string> = {}) =>
  new Request('http://localhost:3002/', { method: 'POST', headers: { host: 'localhost:3002',
    origin: 'http://localhost:3002', 'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded', cookie: 'vigilo.session_token=opaque-test-cookie', ...headers },
  body: new URLSearchParams({ confirmation: 'stage_exact_reviewed_plan', csrf, planIdentity }) });

function harness(overrides: { context?: AuthenticatedWorkspace | null; configuration?: Partial<typeof configuration>;
  plan?: typeof input; approvedPlanIdentity?: string; now?: Date } = {}) {
  let stages = 0;
  let currentTime = overrides.now ?? new Date('2026-10-23T10:00:00.000Z');
  const plan = overrides.plan ?? input;
  const handler = createLocalStagingHandler({ configuration: { ...configuration, ...overrides.configuration },
    artifact: { actor, plan, approvedPlanIdentity: overrides.approvedPlanIdentity ?? approvedPlanIdentity },
    csrfSecret: Buffer.alloc(32, 7), now: () => currentTime,
    resolveContext: async () => overrides.context === undefined ? owner : overrides.context,
    stage: async (context, submittedPlan, submittedIdentity) => {
      assert.deepEqual(context, owner);
      assert.deepEqual(submittedPlan, input);
      assert.equal(submittedIdentity, approvedPlanIdentity);
      stages++; return { repairRunId: input.repairRunId, planIdentity: approvedPlanIdentity,
      sourceCheckpointState: 'pending' as const, accountGrantId: 'account', operationGrantIds: ['1', '2', '3', '4', '5'], baselineJobId: input.repairRunId }; } });
  return { handler, stages: () => stages, setTime: (value: Date) => { currentTime = value; } };
}

async function csrf(handler: ReturnType<typeof createLocalStagingHandler>) {
  const response = await handler(get(), '::1');
  assert.equal(response.status, 200);
  const body = await response.text();
  const value = body.match(/name="csrf" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(value);
  assert.match(body, new RegExp(approvedPlanIdentity));
  assert.match(body, new RegExp(input.baseCommitSha));
  assert.match(body, /maxInputTokens/);
  assert.match(body, /maxSandboxRuntimeMs/);
  assert.match(body, /stage_exact_reviewed_plan/);
  assert.doesNotMatch(body, /opaque-test-cookie|private-session/);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  return value;
}

test('GET shows complete reviewed plan without staging, while authenticated same-origin POST stages exact plan', async () => {
  const { handler, stages } = harness();
  const token = await csrf(handler);
  assert.equal(stages(), 0);
  const result = await handler(post(token), '::1');
  assert.equal(result.status, 200);
  assert.match(await result.text(), /staged/i);
  assert.equal(stages(), 1);
});

test('staging handoff fails closed for unauthenticated, non-owner, wrong workspace, and nonlocal requests', async () => {
  for (const context of [null, { ...owner, workspace: { ...owner.workspace, ownerUserId: 'other' } },
    { ...owner, workspace: { ...owner.workspace, id: 'other' } }]) {
    const { handler, stages } = harness({ context });
    assert.notEqual((await handler(get(), '::1')).status, 200);
    assert.equal(stages(), 0);
  }
  for (const change of [{ enabled: false }, { nodeEnv: 'production' },
    { baseUrl: 'https://vigilo.example' }, { databaseUrl: 'postgres://user:pass@db.example:5432/vigilo' }]) {
    const { handler, stages } = harness({ configuration: change });
    assert.equal((await handler(get(), '::1')).status, 404);
    assert.equal(stages(), 0);
  }
  const { handler } = harness();
  assert.equal((await handler(get(), '203.0.113.4')).status, 404);
  const badHost = new Request('http://localhost:3002/', { headers: { host: 'attacker.example' } });
  assert.equal((await handler(badHost, '::1')).status, 404);
});

test('POST rejects mismatched origin, null origin, Fetch Metadata, CSRF, and plan substitution', async () => {
  const { handler, stages } = harness();
  const token = await csrf(handler);
  for (const request of [post(token, approvedPlanIdentity, { origin: 'null' }),
    post(token, approvedPlanIdentity, { origin: 'http://localhost:3000' }),
    post(token, approvedPlanIdentity, { origin: 'https://attacker.example' }),
    post(token, approvedPlanIdentity, { 'sec-fetch-site': 'cross-site' }),
    post('0'.repeat(64)), post(token, 'f'.repeat(64)),
    new Request('http://localhost:3002/', { method: 'POST', headers: { host: 'localhost:3002',
      origin: 'http://localhost:3002', 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        confirmation: 'stage_exact_reviewed_plan', csrf: token, planIdentity: approvedPlanIdentity,
        githubRepositoryId: '999',
      }) })]) {
    assert.equal((await handler(request, '::1')).status, 403);
  }
  assert.equal(stages(), 0);
});

test('altered fixture, limits, objective, release, identity, and expired plan cannot be loaded or staged', async () => {
  for (const change of [{ githubRepositoryId: 99 }, { baseCommitSha: 'c'.repeat(40) },
    { expectedSourceIdentity: 'd'.repeat(64) }, { objective: 'different' },
    { authorizedReleaseSha: 'e'.repeat(40) }, { expiresAt: '2026-10-23T09:00:00.000Z' }]) {
    assert.throws(() => harness({ plan: { ...input, ...change } }));
  }
  assert.throws(() => harness({ approvedPlanIdentity: 'f'.repeat(64) }));
  assert.throws(() => createLocalStagingHandler({ configuration, artifact: {
    actor: { ...actor, sessionCookie: 'private-value' }, plan: input, approvedPlanIdentity,
  } as never, csrfSecret: Buffer.alloc(32, 7), resolveContext: async () => owner,
  stage: async () => { throw new Error('unreachable'); } }));
  assert.throws(() => harness({ configuration: { releaseSha: 'f'.repeat(40) } }));
  const { handler, stages, setTime } = harness({ now: new Date('2026-10-23T11:59:59.000Z') });
  const token = await csrf(handler);
  setTime(new Date(input.expiresAt));
  assert.equal((await handler(post(token), '::1')).status, 409);
  assert.equal(stages(), 0);
});

test('a repeated or concurrent browser submission cannot dispatch a second staging call', async () => {
  const { handler, stages } = harness();
  const token = await csrf(handler);
  const first = handler(post(token), '::1');
  const second = handler(post(token), '::1');
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(stages(), 1);
  assert.equal((await handler(post(token), '::1')).status, 409);
});

test('the fixed local artifact rejects loose permissions and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'vigilo-local-stage-'));
  const directory = join(root, '.vigilo');
  const file = join(directory, 'm77b-approved-plan.json');
  try {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, JSON.stringify({ actor, plan: input, approvedPlanIdentity }), { mode: 0o600 });
    assert.equal(readLocalStagingArtifact(root).approvedPlanIdentity, approvedPlanIdentity);
    chmodSync(file, 0o644);
    assert.throws(() => readLocalStagingArtifact(root));
    rmSync(file);
    symlinkSync(join(root, 'other.json'), file);
    assert.throws(() => readLocalStagingArtifact(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
