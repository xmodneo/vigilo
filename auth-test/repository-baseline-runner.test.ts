import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { APIError, Sandbox } from '@vercel/sandbox';

import { gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { runFrozenRepositoryBaseline } from '../lib/repository-baselines/runner.ts';
import type { FrozenBaselineInput } from '../lib/repository-baselines/types.ts';

const PACKAGE = '{"name":"fixture"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"fixture"}}}';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const entries = [
  { path: 'package-lock.json', type: 'file', mode: 644, sha256: sha256(LOCK), blobSha: gitBlobSha(LOCK) },
  { path: 'package.json', type: 'file', mode: 644, sha256: sha256(PACKAGE), blobSha: gitBlobSha(PACKAGE) },
];
const manifest = { entries, identity: sha256(JSON.stringify(entries)) };

function input(overrides: Partial<FrozenBaselineInput['profile']> = {}): FrozenBaselineInput {
  return {
    archive: Buffer.from('trusted-provider-archive'), archiveSha256: sha256('trusted-provider-archive'),
    repository: { defaultBranch: 'main', fullName: 'octo/repo', id: 8101, isPrivate: true, name: 'repo', ownerId: 3001, ownerLogin: 'octo' },
    runId: 'run-one', startedAt: new Date('2026-09-09T10:00:00Z'),
    profile: {
      baseCommitSha: 'a'.repeat(40), buildScript: 'build', githubRepositoryId: 8101, installationId: 9001,
      packageJsonBlobSha: gitBlobSha(PACKAGE), packageJsonContentSha256: sha256(PACKAGE),
      packageLockBlobSha: gitBlobSha(LOCK), packageLockContentSha256: sha256(LOCK),
      profileIdentity: 'b'.repeat(64), profileVersion: 2, testRunner: 'node-test', testScript: 'test',
      typecheckScript: 'typecheck', workspaceId: 'workspace-one', ...overrides,
    },
  };
}

test('sandbox baseline installs before deny-all, runs only frozen npm phases, and confirms cleanup', async (t) => {
  const originalOidc = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = 'host-only-oidc-sentinel';
  t.after(() => { if (originalOidc === undefined) delete process.env.VERCEL_OIDC_TOKEN; else process.env.VERCEL_OIDC_TOKEN = originalOidc; });
  let policy: unknown = { allow: ['registry.npmjs.org'] };
  let deleted = false;
  const commands: string[][] = [];
  const sandbox = {
    persistent: false, timeout: 600_000,
    get networkPolicy() { return policy; },
    currentSession() { return { sessionId: 'fresh-baseline-session', status: 'running' }; },
    async writeFiles(files: Array<{ content: Uint8Array; path: string }>) {
      assert.equal(files.length, 1); assert.equal(Buffer.from(files[0]!.content).toString(), 'trusted-provider-archive');
      assert.doesNotMatch(JSON.stringify(files), /host-only-oidc-sentinel|installation-token/);
    },
    async runCommand(params: { cmd: string; args: string[]; env?: unknown }) {
      assert.equal(params.env, undefined);
      if (params.cmd !== 'node') return { exitCode: 0, stdout: async () => '' };
      if (params.args[0] === '--version') return { exitCode: 0, stdout: async () => 'v24.19.0' };
      if (params.args[1]?.includes("'DATABASE_URL'")) return { exitCode: 0, stdout: async () => 'absent' };
      if (params.args[1]?.includes('createGunzip')) return { exitCode: 0, stdout: async () => JSON.stringify({ entries: 2, totalFileBytes: 64 }) };
      if (params.args[1]?.includes('const expected')) return { exitCode: 0, stdout: async () => JSON.stringify(manifest) };
      const command = JSON.parse(params.args[2]!) as { args: string[] };
      commands.push(command.args);
      if (command.args[0] === 'ci') assert.deepEqual(policy, { allow: ['registry.npmjs.org'] });
      else assert.equal(policy, 'deny-all');
      return { exitCode: 0, stdout: async () => JSON.stringify({ exitCode: 0, timedOut: false, spawnFailed: false, signalTermination: false, stdoutSha256: 'c'.repeat(64), stderrSha256: 'd'.repeat(64), diagnostics: { stdoutBytes: 10, stderrBytes: 0, outputTruncated: false, spawnCode: null, npmCode: null } }) };
    },
    async update(params: { networkPolicy: string }) { policy = params.networkPolicy; },
    async stop() {},
    async delete() { deleted = true; },
  };
  t.mock.method(console, 'log', () => {});
  t.mock.method(Sandbox, 'create', async (params: { env?: unknown; image: string; networkPolicy: unknown; persistent: boolean; ports: unknown[] }) => {
    assert.equal(params.env, undefined); assert.equal(params.image, 'vercel/sandbox/node:24'); assert.equal(params.persistent, false); assert.deepEqual(params.ports, []);
    return sandbox as never;
  });
  t.mock.method(Sandbox, 'get', async (params: { resume: boolean }) => {
    assert.equal(params.resume, false);
    if (deleted) throw new APIError(new Response(null, { status: 404 }));
    return sandbox as never;
  });

  const result = await runFrozenRepositoryBaseline(input(), undefined, () => new Date('2026-09-09T10:00:01Z'));
  assert.equal(result.overallOutcome, 'baseline_passed');
  assert.equal(result.credentialsExposure, 'absent');
  assert.equal(result.networkPolicyBeforeRepositoryExecution, 'deny-all');
  assert.equal(result.source.unchangedAfterExecution, true);
  assert.deepEqual(commands, [
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=15000'],
    ['--ignore-scripts', 'run', 'typecheck'], ['--ignore-scripts', 'run', 'build'], ['--ignore-scripts', 'test'],
  ]);
  assert.deepEqual(result.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
  assert.doesNotMatch(JSON.stringify(result), /host-only-oidc-sentinel|installation-token|DATABASE_URL/);
});

test('optional frozen phases are skipped without inventing results', async () => {
  const value = input({ typecheckScript: null, buildScript: null });
  assert.equal(value.profile.typecheckScript, null);
  assert.equal(value.profile.buildScript, null);
});

test('baseline outcome vocabulary keeps failures, timeout, cancellation, and cleanup distinct', () => {
  const outcomes = ['baseline_passed', 'baseline_failed', 'installation_failed', 'typecheck_failed', 'build_failed', 'test_failed', 'timed_out', 'cancelled', 'infrastructure_failed', 'cleanup_failed'];
  assert.equal(new Set(outcomes).size, 10);
});

test('failure, timeout, cancellation, source-integrity, and cleanup outcomes fail closed', async (t) => {
  const originalOidc = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = 'host-only-oidc-sentinel';
  t.after(() => { if (originalOidc === undefined) delete process.env.VERCEL_OIDC_TOKEN; else process.env.VERCEL_OIDC_TOKEN = originalOidc; });
  const scenarios = {
    install: 'installation_failed', typecheck: 'typecheck_failed', build: 'build_failed', test: 'test_failed',
    command_timeout: 'timed_out', overall_timeout: 'timed_out', cancelled: 'cancelled',
    credentials: 'infrastructure_failed', source_mismatch: 'infrastructure_failed', source_mutation: 'baseline_failed', source_addition: 'baseline_failed',
    cleanup: 'cleanup_failed',
  } as const;

  for (const [scenario, expected] of Object.entries(scenarios)) {
    await t.test(scenario, async (child) => {
      let policy: unknown = { allow: ['registry.npmjs.org'] };
      let deleted = false;
      let stopped = false;
      let manifestCalls = 0;
      const controller = new AbortController();
      const mutatedEntries = entries.map((entry, index) => index === 0 ? { ...entry, sha256: 'e'.repeat(64) } : entry);
      const mutatedManifest = { entries: mutatedEntries, identity: sha256(JSON.stringify(mutatedEntries)) };
      const addedEntries = [...entries, { path: 'src/added.ts', type: 'file', mode: 644, sha256: 'e'.repeat(64), blobSha: 'f'.repeat(40) }];
      const addedManifest = { entries: addedEntries, identity: sha256(JSON.stringify(addedEntries)) };
      const sandbox = {
        persistent: false, timeout: 600_000,
        get networkPolicy() { return policy; },
        currentSession() { return { sessionId: 'failure-session', status: 'running' }; },
        async writeFiles() {},
        async runCommand(params: { cmd: string; args: string[] }) {
          if (scenario === 'overall_timeout' && params.cmd === 'node' && params.args[0] === '--version') throw new DOMException('deadline', 'TimeoutError');
          if (params.cmd !== 'node') return { exitCode: 0, stdout: async () => '' };
          if (params.args[0] === '--version') return { exitCode: 0, stdout: async () => 'v24.19.0' };
          if (params.args[1]?.includes("'DATABASE_URL'")) return { exitCode: 0, stdout: async () => scenario === 'credentials' ? 'present' : 'absent' };
          if (params.args[1]?.includes('createGunzip')) return { exitCode: 0, stdout: async () => JSON.stringify({ entries: 2, totalFileBytes: 64 }) };
          if (params.args[1]?.includes('const expected')) {
            manifestCalls += 1;
            if (scenario === 'source_mismatch' && manifestCalls === 1) return { exitCode: 0, stdout: async () => JSON.stringify(mutatedManifest) };
            if (scenario === 'source_mutation' && manifestCalls === 2) return { exitCode: 0, stdout: async () => JSON.stringify(mutatedManifest) };
            if (scenario === 'source_addition' && manifestCalls === 2) return { exitCode: 0, stdout: async () => JSON.stringify(addedManifest) };
            return { exitCode: 0, stdout: async () => JSON.stringify(manifest) };
          }
          const command = JSON.parse(params.args[2]!) as { args: string[] };
          const phase = command.args[0] === 'ci' ? 'install' : command.args.at(-1);
          if (scenario === 'cancelled' && phase === 'install') { controller.abort(); throw new Error('cancelled provider command'); }
          const timedOut = scenario === 'command_timeout' && phase === 'test';
          const failed = scenario === phase;
          return { exitCode: 0, stdout: async () => JSON.stringify({
            exitCode: timedOut ? null : failed ? 1 : 0, timedOut, spawnFailed: timedOut, signalTermination: timedOut,
            stdoutSha256: 'c'.repeat(64), stderrSha256: 'd'.repeat(64),
          }) };
        },
        async update(params: { networkPolicy: string }) { policy = params.networkPolicy; },
        async stop() { stopped = true; },
        async delete() { if (scenario === 'cleanup') throw new Error('delete failed'); deleted = true; },
      };
      child.mock.method(console, 'log', () => {});
      child.mock.method(Sandbox, 'create', async () => sandbox as never);
      child.mock.method(Sandbox, 'get', async () => {
        if (deleted) throw new APIError(new Response(null, { status: 404 }));
        return sandbox as never;
      });
      const result = await runFrozenRepositoryBaseline(input(), controller.signal, () => new Date('2026-09-09T10:00:01Z'));
      assert.equal(result.overallOutcome, expected);
      assert.equal(stopped, true);
      if (scenario !== 'cleanup') assert.deepEqual(result.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
      else assert.notEqual(result.cleanup.delete, 'confirmed');
      assert.doesNotMatch(JSON.stringify(result), /host-only-oidc-sentinel|cancelled provider command|delete failed/);
    });
  }
});
