import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Sandbox } from '@vercel/sandbox';

import { GeminiInvestigationProvider } from '../lib/ai-investigations/gemini-provider.ts';
import { CONCLUSION_SCHEMA, MODEL_INSTRUCTIONS, MODEL_TOOLS } from '../lib/ai-investigations/protocol.ts';
import { AI_LIMITS, AI_MODEL_ID } from '../lib/ai-investigations/types.ts';
import { runFrozenRepositoryBaseline } from '../lib/repository-baselines/runner.ts';
import { readSandboxCredentials, recoverSandbox, VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE } from '../src/sandbox-boundary.ts';
import { observeSandbox } from '../src/failure-cleanup.ts';
import type { FrozenBaselineInput } from '../lib/repository-baselines/types.ts';
import { gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { createHash } from 'node:crypto';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const PACKAGE = '{"name":"fixture"}'; const LOCK = '{"lockfileVersion":3}';
const baselineInput: FrozenBaselineInput = {
  archive: Buffer.from('archive'), archiveSha256: sha256('archive'), runId: 'run', startedAt: new Date(),
  repository: { defaultBranch: 'main', fullName: 'o/r', id: 1, isPrivate: true, name: 'r', ownerId: 1, ownerLogin: 'o' },
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

test('installed provider retry policy is explicit and bounded by Vigilo accounting', async () => {
  const vercelRetrySource = await readFile('node_modules/@vercel/sandbox/dist/api-client/with-retry.js', 'utf8');
  assert.match(vercelRetrySource, /retries:\s*2/);
  assert.ok(VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE >= 3);
  const geminiSource = await readFile('lib/ai-investigations/gemini-provider.ts', 'utf8');
  assert.match(geminiSource, /retries:\s*\{\s*strategy:\s*'none'\s*\}/);
});

test('sandbox OIDC credentials are explicit, scoped, and expiry checked before SDK use', () => {
  const names = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN'] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const token = (payload: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
    process.env.VERCEL_OIDC_TOKEN = token({ owner_id: 'team_test', project_id: 'project_test' });
    assert.throws(() => readSandboxCredentials(), /credentials_invalid/);
    process.env.VERCEL_OIDC_TOKEN = token({ owner_id: 'team_test', project_id: 'project_test', exp: 1 });
    assert.throws(() => readSandboxCredentials(), /credentials_invalid/);
    const valid = token({ owner_id: 'team_test', project_id: 'project_test', exp: 4_102_444_800 });
    process.env.VERCEL_OIDC_TOKEN = valid;
    assert.deepEqual(readSandboxCredentials(), { token: valid, teamId: 'team_test', projectId: 'project_test' });
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
