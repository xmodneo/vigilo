import assert from 'node:assert/strict';
import test from 'node:test';

import { SandboxTransportPolicy } from '../lib/external-execution/sandbox-transport.ts';
import { ExternalExecutionAuthorityError } from '../lib/external-execution/types.ts';

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
