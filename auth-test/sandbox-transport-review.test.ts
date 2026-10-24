import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox } from '@vercel/sandbox';

import { SandboxTransportPolicy } from '../lib/external-execution/sandbox-transport.ts';
import { ExternalExecutionAuthorityError } from '../lib/external-execution/types.ts';
import { SandboxBoundary } from '../src/sandbox-boundary.ts';
import { configureSandboxTestCredentials, createTestExternalExecutionAuthorizer } from './external-execution-support.ts';

const binding = { name: 'test', projectId: 'project_test', teamId: 'team_test', sessionId: 'test-session' };
const limits = { runtimeMs: 60_000, vcpus: 1 };
const sessionPath = '/api/v2/sandboxes/sessions/test-session';
const policy = (recovery = false) => new SandboxTransportPolicy(binding, recovery, limits);
const sessionUrl = (suffix: string, query = '') => `https://vercel.com${sessionPath}/${suffix}?teamId=team_test${query}`;
const mismatch = (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_mismatch';
const createBody = JSON.stringify({
  name: binding.name, projectId: binding.projectId, image: 'vercel/sandbox/node:24',
  persistent: false, timeout: limits.runtimeMs, resources: { vcpus: limits.vcpus },
});

test('M7.7 transport review: installed SDK can transition the bound Sandbox to deny-all and read back its session', async () => {
  const transport = policy();
  const requests: string[] = [];
  let networkPolicy: 'allow-all' | 'deny-all' = 'allow-all';
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    transport.classify(url, init);
    if (url.pathname === '/api/v3/sandboxes') transport.confirm({ name: binding.name, sessionId: binding.sessionId });
    if (init?.method === 'PATCH') networkPolicy = 'deny-all';
    const session = { id: binding.sessionId, memory: 2048, vcpus: 1, region: 'test', timeout: limits.runtimeMs,
      status: 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1,
      networkPolicy: { mode: networkPolicy } };
    const sandbox = { name: binding.name, persistent: false, timeout: limits.runtimeMs,
      networkPolicy: { mode: networkPolicy }, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: session.status };
    const response = Response.json({ session,
      sandbox: init?.method === 'PATCH' ? { ...sandbox, networkPolicy: undefined } : sandbox, routes: [] });
    if (init?.method === 'GET') await transport.observeLookup(response);
    if (init?.method === 'PATCH') await transport.observeNetworkPolicyUpdate(response);
    return response;
  };
  const credentials = { token: 'fake-opaque-access-token', teamId: binding.teamId, projectId: binding.projectId,
    name: binding.name, fetch: fakeFetch };
  const sandbox = await Sandbox.create({ ...credentials, image: 'vercel/sandbox/node:24', persistent: false,
    timeout: limits.runtimeMs, resources: { vcpus: limits.vcpus } });
  await sandbox.update({ networkPolicy: 'deny-all' });
  const readBack = await Sandbox.get({ ...credentials, resume: false });
  assert.equal(readBack.networkPolicy, 'deny-all');
  assert.equal(readBack.currentSession().sessionId, binding.sessionId);
  assert.deepEqual(requests, [
    'POST /api/v3/sandboxes',
    'PATCH /api/v2/sandboxes/test',
    'POST /api/v2/sandboxes/sessions/test-session/network-policy',
    'GET /api/v2/sandboxes/test',
  ]);
});

const namedUrl = (query = '') => `https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test${query}`;
const denyAllPatch = JSON.stringify({ networkPolicy: { mode: 'deny-all' } });

test('M7.7 transport review: only the exact bound deny-all PATCH is admitted after creation', () => {
  const transport = new SandboxTransportPolicy({ ...binding, sessionId: null }, false, limits);
  assert.throws(() => transport.classify(namedUrl(), { method: 'PATCH', body: denyAllPatch }), mismatch);
  transport.confirm({ name: binding.name, sessionId: binding.sessionId });
  assert.equal(transport.classify(namedUrl(), { method: 'PATCH', body: denyAllPatch }), 'business');
  assert.throws(() => policy(true).classify(namedUrl(), { method: 'PATCH', body: denyAllPatch }), mismatch);
  for (const body of [
    '{}', '{', JSON.stringify({ networkPolicy: { mode: 'allow-all' } }),
    JSON.stringify({ networkPolicy: { mode: 'deny-all', allowedDomains: ['example.com'] } }),
    JSON.stringify({ networkPolicy: { mode: 'deny-all' }, timeout: 120_000 }),
  ]) assert.throws(() => transport.classify(namedUrl(), { method: 'PATCH', body }), mismatch);
});

test('M7.7 transport review: named PATCH rejects foreign binding, alternate query, method and lifecycle paths', () => {
  for (const url of [
    namedUrl('&resume=false'), namedUrl('&projectId=project_test'), namedUrl('&deleteOrphanSnapshots=true'),
    namedUrl().replace('teamId=team_test', 'teamId=other'),
    namedUrl().replace('projectId=project_test', 'projectId=other'),
    namedUrl().replace('/sandboxes/test?', '/sandboxes/test/fork?'),
  ]) assert.throws(() => policy().classify(url, { method: 'PATCH', body: denyAllPatch }), mismatch);
  for (const method of ['POST', 'PUT']) {
    assert.throws(() => policy().classify(namedUrl(), { method, body: denyAllPatch }), mismatch);
  }
});

test('M7.7 transport review: update and lookup metadata reject changed sessions, while final readback proves policy', async () => {
  const transport = policy();
  const sandbox = { name: binding.name, currentSessionId: binding.sessionId, persistent: false,
    networkPolicy: { mode: 'deny-all' } };
  await transport.observeNetworkPolicyUpdate(Response.json({ sandbox }));
  await transport.observeNetworkPolicyUpdate(Response.json({ sandbox: { ...sandbox, networkPolicy: undefined } }));
  await transport.observeLookup(Response.json({ sandbox, session: { id: binding.sessionId } }));
  for (const changed of [
    { ...sandbox, name: 'other' }, { ...sandbox, currentSessionId: 'other' },
    { ...sandbox, persistent: true },
  ]) await assert.rejects(transport.observeNetworkPolicyUpdate(Response.json({ sandbox: changed })), mismatch);
  await assert.rejects(transport.observeLookup(Response.json({ sandbox, session: { id: 'other' } })), mismatch);
});

for (const failure of ['stale_readback', 'changed_patch_session'] as const) test(`M7.7 transport review: ${failure} stops before fixture commands and cleans one Sandbox`, async (t) => {
  configureSandboxTestCredentials(t);
  t.mock.method(console, 'log', () => undefined);
  let name = ''; let deleted = false; let creates = 0; let fixtureCommands = 0;
  const requests: string[] = [];
  const authorizer = createTestExternalExecutionAuthorizer();
  const reserve = authorizer.reserve;
  authorizer.reserve = async (request) => {
    const permit = await reserve(request);
    const transport = new SandboxTransportPolicy({ name: request.sandbox!.name, teamId: 'team_test', projectId: 'project_test' }, false,
      { runtimeMs: 60_000, vcpus: 1 });
    permit.resolveSandboxCreation = async (identity) => { if (identity) transport.confirm(identity); };
    permit.meteredFetch = async (input, init) => {
      const url = new URL(String(input));
      const kind = transport.classify(url, init);
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (kind === 'create') { creates += 1; name = JSON.parse(String(init?.body)).name; }
      if (url.pathname.endsWith('/cmd')) fixtureCommands += 1;
      if (init?.method === 'DELETE') deleted = true;
      if (init?.method === 'GET' && deleted) return new Response('{}', { status: 404 });
      const isStop = url.pathname.endsWith('/stop');
      const networkPolicy = kind === 'create' ? 'allow-all'
        : init?.method === 'PATCH' || url.pathname.endsWith('/network-policy') ? 'deny-all'
        : failure === 'stale_readback' ? 'allow-all' : 'deny-all';
      const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000,
        status: isStop ? 'stopped' : 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1,
        networkPolicy: { mode: networkPolicy } };
      const sandbox = { name, currentSessionId: failure === 'changed_patch_session' && init?.method === 'PATCH' ? 'other-session' : session.id,
        persistent: false, timeout: 60_000,
        status: session.status, networkPolicy: { mode: networkPolicy }, createdAt: 1, updatedAt: 1 };
      const response = Response.json({ session, sandbox, routes: [] });
      if (init?.method === 'PATCH') await transport.observeNetworkPolicyUpdate(response).catch((error: unknown) => {
        // Production meteredFetch marks local authority denials as terminal to
        // the SDK's hidden retry wrapper.
        if (error instanceof ExternalExecutionAuthorityError) Object.assign(error, { bail: true });
        throw error;
      });
      if (init?.method === 'GET') await transport.observeLookup(response);
      return response;
    };
    return permit;
  };
  const boundary = new SandboxBoundary('test', 'allow-all', 60_000, undefined, authorizer,
    { workspaceId: 'test-workspace', operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' });
  await assert.rejects(boundary.run(async (_sandbox, signal) => {
    await boundary.denyAll(signal);
    fixtureCommands += 1;
  }), failure === 'changed_patch_session' ? mismatch : /network_policy_transition_failed/);
  assert.equal(boundary.transition.status, 'failed');
  assert.equal(boundary.transition.sameSession, failure === 'stale_readback');
  assert.deepEqual(boundary.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
  assert.equal(creates, 1);
  assert.equal(fixtureCommands, 0);
  assert.equal(requests.filter((request) => request === 'PATCH /api/v2/sandboxes/' + name).length, 1);
  assert.equal(requests.includes('POST /api/v2/sandboxes/sessions/test-session/network-policy'), failure === 'stale_readback');
});

// Compatibility paths/methods were checked in installed @vercel/sandbox 3.2.1
// dist/api-client/api-client.js (runCommand, mkDir, getFileWriter, readFile,
// getCommand, getLogs, updateNetworkPolicy, killCommand, stopSession,
// getSandbox, deleteSandbox), and base-client.js (default GET).
const supportedBusiness = [
  { method: 'POST', suffix: 'cmd' },
  { method: 'POST', suffix: 'fs/mkdir' },
  { method: 'POST', suffix: 'fs/write' },
  { method: 'POST', suffix: 'fs/read' },
  { method: 'POST', suffix: 'network-policy' },
  { method: 'GET', suffix: 'cmd/test-command' },
  { method: 'GET', suffix: 'cmd/test-command', query: '&wait=true' },
  { method: 'GET', suffix: 'cmd/test-command/logs' },
  { method: 'POST', suffix: 'cmd/test-command/kill' },
] as const;

for (const operation of supportedBusiness) {
  const query = 'query' in operation ? operation.query : '';
  test(`M7.7 transport review: SDK ${operation.method} ${operation.suffix}${query} remains business`, () => {
    assert.equal(policy().classify(sessionUrl(operation.suffix, query), { method: operation.method }), 'business');
  });
  test(`M7.7 transport review: recovery rejects business ${operation.method} ${operation.suffix}${query}`, () => {
    assert.throws(() => policy(true).classify(sessionUrl(operation.suffix, query), { method: operation.method }), mismatch);
  });
}

test('M7.7 transport review: SDK creation remains admitted with its bound body', () => {
  assert.equal(policy().classify('https://vercel.com/api/v3/sandboxes?teamId=team_test', { method: 'POST', body: createBody }), 'create');
});

for (const recovery of [false, true]) {
  for (const operation of [
    { method: 'POST', url: sessionUrl('stop') },
    { method: 'GET', url: 'https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&resume=false' },
    { method: 'DELETE', url: 'https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&deleteOrphanSnapshots=true' },
  ]) {
    test(`M7.7 transport review: exact cleanup ${operation.method} remains cleanup (recovery=${recovery})`, () => {
      assert.equal(policy(recovery).classify(operation.url, { method: operation.method }), 'cleanup');
    });
  }
}

// Actual SDK endpoints are session /extend-timeout and /snapshot, name /fork,
// and name lookup with resume=true. Other session suffixes below are hostile
// policy probes, not claims that the provider implements those routes.
for (const suffix of ['extend-timeout', 'snapshot', 'snapshots', 'fork', 'resume']) {
  test(`M7.7 transport review: plain forbidden session suffix ${suffix} is rejected`, () => {
    assert.throws(() => policy().classify(sessionUrl(suffix), { method: 'POST' }), mismatch);
  });
  const encoded = `%${suffix.charCodeAt(0).toString(16)}${suffix.slice(1)}`;
  test(`M7.7 transport review: percent-encoded forbidden suffix ${encoded} is rejected`, () => {
    assert.throws(() => policy().classify(sessionUrl(encoded), { method: 'POST' }), mismatch);
  });
}

for (const url of [
  'https://vercel.com/api/v2/sandboxes/test/fork?teamId=team_test&projectId=project_test',
  'https://vercel.com/api/v2/sandboxes/test/%66ork?teamId=team_test&projectId=project_test',
  'https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&resume=true',
]) {
  test(`M7.7 transport review: alternate sandbox identity path is rejected: ${new URL(url).pathname}${new URL(url).search}`, () => {
    assert.throws(() => policy().classify(url, { method: url.includes('resume=') ? 'GET' : 'POST' }), mismatch);
  });
}

for (const suffix of ['unknown-mutation', 'interactive', 'fs/delete', 'cmd/test-command/unknown-mutation', 'cmd/test-command/logs/extra']) {
  test(`M7.7 transport review: unexpected session POST ${suffix} is rejected`, () => {
    assert.throws(() => policy().classify(sessionUrl(suffix), { method: 'POST' }), mismatch);
  });
}

for (const operation of [
  { method: 'GET', suffix: 'cmd' },
  { method: 'DELETE', suffix: 'cmd/test-command' },
  { method: 'POST', suffix: 'cmd/test-command/logs' },
  { method: 'GET', suffix: 'cmd/test-command/kill' },
  { method: 'GET', suffix: 'fs/read' },
  { method: 'PUT', suffix: 'fs/write' },
  { method: 'DELETE', suffix: 'fs/mkdir' },
  { method: 'PATCH', suffix: 'network-policy' },
  { method: 'GET', suffix: 'stop' },
]) {
  test(`M7.7 transport review: unsupported method ${operation.method} ${operation.suffix} is rejected`, () => {
    assert.throws(() => policy().classify(sessionUrl(operation.suffix), { method: operation.method }), mismatch);
  });
}

test('M7.7 transport review: stop with extra query cannot fall through to business', () => {
  assert.throws(() => policy().classify(sessionUrl('stop', '&resume=true'), { method: 'POST' }), mismatch);
});

for (const query of ['&resume=true', '&fork=true', '&snapshot=true', '&extend-timeout=60000']) {
  test(`M7.7 transport review: creation rejects unexpected action query ${query}`, () => {
    assert.throws(() => policy().classify(`https://vercel.com/api/v3/sandboxes?teamId=team_test${query}`, {
      method: 'POST', body: createBody,
    }), mismatch);
  });
}
