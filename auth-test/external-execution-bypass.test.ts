import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Sandbox } from '@vercel/sandbox';

import { GeminiInvestigationProvider } from '../lib/ai-investigations/gemini-provider.ts';
import { CONCLUSION_SCHEMA, MODEL_INSTRUCTIONS, MODEL_TOOLS } from '../lib/ai-investigations/protocol.ts';
import { AI_LIMITS, AI_MODEL_ID } from '../lib/ai-investigations/types.ts';
import { runFrozenRepositoryBaseline } from '../lib/repository-baselines/runner.ts';
import { readSandboxCredentials, recoverSandbox, SandboxBoundary, VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE } from '../src/sandbox-boundary.ts';
import { sandboxCredentials } from '../lib/external-execution/sandbox-auth.ts';
import { configureSandboxTestCredentials, createTestExternalExecutionAuthorizer } from './external-execution-support.ts';
import { observeSandbox } from '../src/failure-cleanup.ts';
import type { FrozenBaselineInput } from '../lib/repository-baselines/types.ts';
import { gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { createHash } from 'node:crypto';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const PACKAGE = '{"name":"fixture"}'; const LOCK = '{"lockfileVersion":3}';
const baselineInput: FrozenBaselineInput = {
  archive: Buffer.from('archive'), archiveSha256: sha256('archive'), runId: 'run', startedAt: new Date(),
  repository: { defaultBranch: 'main', fullName: 'o/r', id: 1, isPrivate: false, name: 'r', ownerId: 1, ownerLogin: 'o' },
  profile: { workspaceId: 'workspace', githubRepositoryId: 1, installationId: 1, baseCommitSha: 'a'.repeat(40), profileIdentity: 'b'.repeat(64), profileVersion: 2, packageJsonBlobSha: gitBlobSha(PACKAGE), packageJsonContentSha256: sha256(PACKAGE), packageLockBlobSha: gitBlobSha(LOCK), packageLockContentSha256: sha256(LOCK), typecheckScript: null, buildScript: null, testScript: 'test', testRunner: 'node-test' },
};

test('all registered Gemini and sandbox production gateways deny missing durable authority before transport', async (t) => {
  let geminiCalls = 0;
  const provider = new GeminiInvestigationProvider('test-secret-value-with-adequate-length', AI_MODEL_ID, { create: async () => { geminiCalls += 1; throw new Error('transport reached'); } } as never);
  const session = provider.createSession({ instructions: MODEL_INSTRUCTIONS, initialInput: '{}', tools: MODEL_TOOLS, conclusionSchema: CONCLUSION_SCHEMA, maxOutputTokens: AI_LIMITS.maxOutputTokens, externalExecutionScope: { workspaceId: 'workspace', operationCategory: 'gemini_investigation', providerId: 'google', modelId: AI_MODEL_ID } });
  await assert.rejects(session.next({ signal: new AbortController().signal }), /execution_authority_missing/);
  assert.equal(geminiCalls, 0);

  let sandboxCreates = 0;
  let sandboxGets = 0;
  t.mock.method(Sandbox, 'create', async () => { sandboxCreates += 1; throw new Error('transport reached'); });
  t.mock.method(Sandbox, 'get', async () => { sandboxGets += 1; throw new Error('transport reached'); });
  const baseline = await runFrozenRepositoryBaseline(baselineInput);
  assert.equal(baseline.error?.code, 'execution_authority_missing');
  assert.equal(sandboxCreates, 0);
  await assert.rejects(recoverSandbox({ name: 'sandbox', sessionId: null }), /execution_authority_missing/);
  await assert.rejects(observeSandbox('sandbox', 'session'), /execution_authority_missing/);
  assert.equal(sandboxGets, 0);

  const worker = await readFile('worker/main.ts', 'utf8');
  assert.match(worker, /DurableExternalExecutionAuthorizer/);
  assert.match(worker, /processRepairJob[\s\S]*executionAuthority/);
  assert.match(worker, /processCandidateVerificationJob[\s\S]*executionAuthority/);
  assert.match(worker, /processRepairLoopJob[\s\S]*executionAuthority/);
  assert.match(worker, /GeminiInvestigationProvider[\s\S]*executionAuthority/);
});

test('OIDC and refresh-shaped tokens fail before SDK create, recovery, observation, or logging', async (t) => {
  configureSandboxTestCredentials(t);
  const log: unknown[] = []; let sdkCalls = 0; let globalCalls = 0;
  t.mock.method(console, 'log', (...values: unknown[]) => { log.push(values); });
  t.mock.method(Sandbox, 'create', async () => { sdkCalls += 1; throw new Error('SDK reached'); });
  t.mock.method(Sandbox, 'get', async () => { sdkCalls += 1; throw new Error('SDK reached'); });
  t.mock.method(globalThis, 'fetch', async () => { globalCalls += 1; throw new Error('global refresh reached'); });
  const authority = createTestExternalExecutionAuthorizer();
  const scope = { workspaceId: 'workspace', operationCategory: 'sandbox_baseline' as const, providerId: 'vercel-sandbox' };
  for (const mode of ['oidc', 'jwt'] as const) {
    if (mode === 'oidc') process.env.VERCEL_OIDC_TOKEN = 'fake-oidc-value';
    else { delete process.env.VERCEL_OIDC_TOKEN; process.env.VERCEL_TOKEN = 'header.' + Buffer.from(JSON.stringify({ owner_id: true })).toString('base64url') + '.signature'; }
    await assert.rejects(new SandboxBoundary('test', 'deny-all', 60_000, undefined, authority, scope).run(async () => assert.fail('customer work reached')), { message: 'sandbox_auth_mode_unsupported' });
    await assert.rejects(recoverSandbox({ name: 'test', sessionId: null }, authority, scope), { message: 'sandbox_auth_mode_unsupported' });
    await assert.rejects(observeSandbox('test', 'session', authority, scope), { message: 'sandbox_auth_mode_unsupported' });
  }
  assert.equal(sdkCalls, 0); assert.equal(globalCalls, 0); assert.deepEqual(log, []);
});

test('local Sandbox configuration validation has no secret output or provider request and rejects incomplete fields', () => {
  const valid = { VERCEL_TOKEN: 'fake-opaque-access-token', VERCEL_TEAM_ID: 'team_test', VERCEL_PROJECT_ID: 'project_test' };
  assert.deepEqual(sandboxCredentials(valid), { token: valid.VERCEL_TOKEN, teamId: valid.VERCEL_TEAM_ID, projectId: valid.VERCEL_PROJECT_ID });
  for (const field of Object.keys(valid) as Array<keyof typeof valid>) {
    for (const bad of [undefined, '', ' ', 'value\n']) {
      const environment: NodeJS.ProcessEnv = { ...valid }; environment[field] = bad;
      assert.throws(() => sandboxCredentials(environment), { message: 'incomplete_credentials' });
    }
  }
});

test('real installed SDK baseline and verification boundaries, recovery, and observation never refresh through global fetch', async (t) => {
  configureSandboxTestCredentials(t);
  let globalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { globalCalls += 1; assert.fail('unmetered SDK transport'); });
  t.mock.method(console, 'log', () => undefined);
  for (const operationCategory of ['sandbox_baseline', 'sandbox_verification'] as const) {
    let deleted = false; let name = ''; const requests: string[] = [];
    const scope = { workspaceId: 'workspace', operationCategory, providerId: 'vercel-sandbox' };
    const authorizer = createTestExternalExecutionAuthorizer();
    const reserve = authorizer.reserve;
    authorizer.reserve = async (request) => {
      const permit = await reserve(request);
      permit.meteredFetch = async (input, init) => {
        const url = new URL(String(input)); requests.push(`${init?.method} ${url.pathname}`);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-sandbox-access-token');
        assert.equal(url.searchParams.get('teamId'), 'team_test');
        assert.ok(!String(init?.body).includes('fake-sandbox-access-token'));
        if (init?.method === 'POST' && url.pathname === '/api/v3/sandboxes') {
          name = JSON.parse(String(init.body)).name; deleted = false;
        }
        if (init?.method === 'DELETE') deleted = true;
        if (init?.method === 'GET' && deleted) return new Response('{}', { status: 404 });
        const stopped = url.pathname.endsWith('/stop');
        const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000, status: stopped ? 'stopped' : 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
        const sandbox = { name, persistent: false, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: session.status, timeout: 60_000, networkPolicy: { mode: 'deny-all' } };
        return Response.json({ session, sandbox, routes: [] });
      };
      return permit;
    };
    const boundary = new SandboxBoundary('test', 'deny-all', 60_000, undefined, authorizer, scope);
    await boundary.run(async (_sandbox, signal) => { await boundary.denyAll(signal); });
    assert.deepEqual(boundary.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
    assert.equal(boundary.transition.status, 'passed');
    deleted = false;
    const recovery = await recoverSandbox({ name, sessionId: 'test-session' }, authorizer, scope);
    assert.equal(recovery.lookup, 'absent'); assert.equal(recovery.stop, 'confirmed'); assert.equal(recovery.delete, 'confirmed');
    await observeSandbox(name, 'test-session', authorizer, scope);
    assert.ok(requests.some((request) => request.startsWith('PATCH ')));
    assert.ok(requests.some((request) => request.startsWith('DELETE ')));
  }
  assert.equal(globalCalls, 0);
});

test('private repository baseline is denied before authority reservation or sandbox transport', async (t) => {
  let sandboxCreates = 0; let authorityCalls = 0;
  t.mock.method(Sandbox, 'create', async () => { sandboxCreates += 1; throw new Error('transport reached'); });
  const evidence = await runFrozenRepositoryBaseline({ ...baselineInput, repository: { ...baselineInput.repository, isPrivate: true } }, undefined, () => new Date(), undefined, {
    authorizer: { reserve: async () => { authorityCalls += 1; throw new Error('authority reached'); } },
    scope: { workspaceId: 'workspace', operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
  });
  assert.equal(evidence.error?.code, 'private_repository_not_supported');
  assert.equal(authorityCalls, 0); assert.equal(sandboxCreates, 0);
});

test('installed provider retry policy is explicit and bounded by Vigilo accounting', async () => {
  const vercelRetrySource = await readFile('node_modules/@vercel/sandbox/dist/api-client/with-retry.js', 'utf8');
  assert.match(vercelRetrySource, /retries:\s*2/);
  assert.equal(VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE, 96);
  const geminiSource = await readFile('lib/ai-investigations/gemini-provider.ts', 'utf8');
  assert.match(geminiSource, /retries:\s*\{\s*strategy:\s*'none'\s*\}/);
});

test('installed security patch graph and scoped overrides match the approved exact versions', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.deepEqual(manifest.overrides, { '@vercel/sandbox@3.2.1': { undici: '7.29.1' }, 'postcss@8.5.23': { 'source-map-js': '1.2.2' } });
  for (const [name, version] of Object.entries({ next: '16.3.6', '@vercel/sandbox': '3.2.1', '@vercel/oidc': '3.2.0', undici: '7.29.1', postcss: '8.5.23', 'source-map-js': '1.2.2' })) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version, version);
  }
  assert.deepEqual(Object.keys(lock.packages).filter((path) => path.endsWith('/undici')), ['node_modules/undici']);
  assert.deepEqual(Object.keys(lock.packages).filter((path) => path.endsWith('/source-map-js')), ['node_modules/source-map-js']);
});

test('sandbox credentials accept only explicit opaque access tokens and reject ambiguous/OIDC modes', () => {
  const names = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN'] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const token = (payload: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
    assert.throws(() => readSandboxCredentials(), /credentials_missing/);
    process.env.VERCEL_TOKEN = 'fake-opaque-access-token';
    assert.throws(() => readSandboxCredentials(), /incomplete_credentials/);
    process.env.VERCEL_TEAM_ID = 'team_test'; process.env.VERCEL_PROJECT_ID = 'project_test';
    assert.deepEqual(readSandboxCredentials(), { token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test' });
    for (const payload of [{ owner_id: 'team_test' }, { owner_id: true }, { owner_id: 'team_test', project_id: 'project_test', exp: 4_102_444_800 }]) {
      process.env.VERCEL_TOKEN = token(payload);
      assert.throws(() => readSandboxCredentials(), { message: 'sandbox_auth_mode_unsupported' });
    }
    process.env.VERCEL_TOKEN = 'fake-opaque-access-token';
    for (const oidc of ['fake-oidc', token({ owner_id: 'team_test' }), '']) {
      process.env.VERCEL_OIDC_TOKEN = oidc;
      assert.throws(() => readSandboxCredentials(), { message: 'sandbox_auth_mode_unsupported' });
    }
    delete process.env.VERCEL_TOKEN;
    assert.throws(() => readSandboxCredentials(), { message: 'sandbox_auth_mode_unsupported' });
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
