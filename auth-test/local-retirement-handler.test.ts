import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { createLocalRetirementHandler } from '../lib/external-execution/local-retirement-handler.ts';
import type { HistoricalRetirementTarget } from '../lib/external-execution/local-retirement.ts';

const target: HistoricalRetirementTarget = {
  workspaceId: 'workspace-one',
  repairRunId: '11111111-1111-4111-8111-111111111111',
  planIdentity: 'a'.repeat(64),
  repositoryId: 1411517943,
  revision: 'b'.repeat(40),
  authorizedReleaseSha: 'c'.repeat(40),
};
const owner: AuthenticatedWorkspace = {
  sessionId: 'session-one',
  user: { id: 'owner-one', name: 'Owner', email: 'owner@example.test' },
  githubUserId: 'github-owner',
  workspace: { id: target.workspaceId, ownerUserId: 'owner-one' },
};
const configuration = {
  enabled: true,
  nodeEnv: 'development',
  baseUrl: 'http://localhost:3000',
  databaseUrl: 'postgres://user:pass@127.0.0.1:55432/vigilo',
  releaseSha: 'd'.repeat(40),
  operatorOrigin: 'http://localhost:3001',
};

function harness(overrides: {
  configuration?: Partial<typeof configuration>;
  context?: AuthenticatedWorkspace | null;
  preview?: { runState: string; checkpointState: string; jobState: string; eligible: boolean };
} = {}) {
  let previews = 0;
  let retirements = 0;
  const handler = createLocalRetirementHandler({
    configuration: { ...configuration, ...overrides.configuration },
    target,
    csrfSecret: Buffer.alloc(32, 7),
    resolveContext: async () => overrides.context === undefined ? owner : overrides.context,
    preview: async () => { previews++; return overrides.preview ?? {
      runState: 'created', checkpointState: 'pending', jobState: 'created', eligible: true,
    }; },
    retire: async () => { retirements++; return { kind: 'reviewed_stage_retirement',
      repairRunId: target.repairRunId, planIdentity: target.planIdentity,
      baselineJobId: target.repairRunId, result: 'retired', revokedGrantCount: 6 }; },
  });
  return { handler, counts: () => ({ previews, retirements }) };
}

const get = (host = 'localhost:3001') => new Request('http://localhost:3001/', { headers: { host, cookie: 'vigilo.session_token=opaque-test-cookie' } });
const post = (csrf: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) => new Request('http://localhost:3001/', {
  method: 'POST',
  headers: { host: 'localhost:3001', origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded', cookie: 'vigilo.session_token=opaque-test-cookie', ...headers },
  body: new URLSearchParams({ confirmation: 'retire_exact_staged_run', csrf, ...extra }),
});

async function token(handler: ReturnType<typeof createLocalRetirementHandler>) {
  const response = await handler(get(), '::1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/);
  const html = await response.text();
  const value = html.match(/name="csrf" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(value);
  assert.doesNotMatch(html, /opaque-test-cookie|session-one/);
  return value;
}

test('local retirement is disabled by default, in production, and on nonlocal configuration or peer', async () => {
  for (const change of [
    { enabled: false }, { nodeEnv: 'production' }, { baseUrl: 'https://vigilo.example' },
    { databaseUrl: 'postgres://user:pass@db.example:5432/vigilo' }, { releaseSha: 'invalid' },
  ]) {
    const { handler, counts } = harness({ configuration: change });
    assert.equal((await handler(get(), '::1')).status, 404);
    assert.deepEqual(counts(), { previews: 0, retirements: 0 });
  }
  const { handler, counts } = harness();
  assert.equal((await handler(get(), '203.0.113.4')).status, 404);
  assert.equal((await handler(get('attacker.example'), '::1')).status, 404);
  assert.equal((await handler(new Request('http://localhost:3001/', {
    headers: { host: 'localhost:3001', 'x-forwarded-host': 'attacker.example' },
  }), '::1')).status, 404);
  assert.deepEqual(counts(), { previews: 0, retirements: 0 });
});

test('GET requires the owner of the exact workspace and never retires', async () => {
  const anonymous = harness({ context: null });
  assert.equal((await anonymous.handler(get(), '::1')).status, 401);
  const nonOwner = harness({ context: { ...owner, workspace: { ...owner.workspace, ownerUserId: 'other' } } });
  assert.equal((await nonOwner.handler(get(), '::1')).status, 403);
  const wrongWorkspace = harness({ context: { ...owner, workspace: { ...owner.workspace, id: 'other' } } });
  assert.equal((await wrongWorkspace.handler(get(), '::1')).status, 403);
  const valid = harness();
  const response = await valid.handler(get(), '::1');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /irreversible/i);
  assert.deepEqual(valid.counts(), { previews: 1, retirements: 0 });
});

test('POST requires exact same-origin browser confirmation and a session-bound CSRF token', async () => {
  const { handler, counts } = harness();
  const csrf = await token(handler);
  for (const request of [
    post(csrf, {}, { origin: 'https://attacker.example' }),
    post(csrf, {}, { 'sec-fetch-site': 'cross-site' }),
    post(csrf, {}, { origin: '' }),
    post('0'.repeat(64)),
    post(csrf, { repairRunId: '22222222-2222-4222-8222-222222222222' }),
    post(csrf, { confirmation: 'cancel_any_job' }),
  ]) assert.notEqual((await handler(request, '::1')).status, 200);
  assert.equal(counts().retirements, 0);
  const response = await handler(post(csrf), '::1');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /retired/i);
  assert.doesNotMatch(body, /opaque-test-cookie|session-one/);
  assert.equal(counts().retirements, 1);
});

test('local Forbidden responses distinguish POST origin, fetch-site, and owner rejection without exposing request data', async () => {
  const valid = harness();
  const csrf = await token(valid.handler);
  const missingOrigin = post(csrf);
  missingOrigin.headers.delete('origin');
  for (const [request, code] of [
    [post(csrf, {}, { origin: 'https://attacker.example' }), 'post_origin_rejected'],
    [post(csrf, {}, { origin: '' }), 'post_origin_rejected'],
    [missingOrigin, 'post_origin_rejected'],
    [post(csrf, {}, { 'sec-fetch-site': 'cross-site' }), 'post_site_rejected'],
  ] as const) {
    const response = await valid.handler(request, '::1');
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, new RegExp(`Local rejection code: ${code}`));
    assert.doesNotMatch(body, /attacker\.example|opaque-test-cookie|session-one|[0-9a-f]{64}/);
  }
  assert.equal(valid.counts().retirements, 0);

  const nonOwner = harness({ context: { ...owner, workspace: { ...owner.workspace, ownerUserId: 'other' } } });
  for (const request of [get(), post(csrf)]) {
    const response = await nonOwner.handler(request, '::1');
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Local rejection code: owner_mismatch/);
  }
  assert.equal(nonOwner.counts().retirements, 0);

  const anonymous = harness({ context: null });
  assert.equal((await anonymous.handler(post(csrf), '::1')).status, 401);
  assert.equal(anonymous.counts().retirements, 0);
  const invalidCsrf = await valid.handler(post('0'.repeat(64)), '::1');
  assert.equal(invalidCsrf.status, 403);
  assert.match(await invalidCsrf.text(), /Confirmation invalid\. No action was taken\./);
  assert.equal(valid.counts().retirements, 0);
});

test('POST fails closed on missing session, changed session, and non-owner', async () => {
  const { handler } = harness();
  const csrf = await token(handler);
  for (const context of [null, { ...owner, sessionId: 'different' },
    { ...owner, workspace: { ...owner.workspace, ownerUserId: 'other' } }]) {
    const attempt = harness({ context });
    assert.notEqual((await attempt.handler(post(csrf), '::1')).status, 200);
    assert.equal(attempt.counts().retirements, 0);
  }
});

test('POST reports ambiguous failures safely and does not claim success', async () => {
  const { handler } = createFailureHarness();
  const csrf = await token(handler);
  const response = await handler(post(csrf), '::1');
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /database-secret|opaque-test-cookie/);
});

function createFailureHarness() {
  const valid = harness();
  const handler = createLocalRetirementHandler({
    configuration, target, csrfSecret: Buffer.alloc(32, 7),
    resolveContext: async () => owner,
    preview: async () => ({ runState: 'created', checkpointState: 'pending', jobState: 'created', eligible: true }),
    retire: async () => { throw new Error('database-secret'); },
  });
  return { ...valid, handler };
}
