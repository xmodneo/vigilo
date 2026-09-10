import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { APIError, Sandbox } from '@vercel/sandbox';

import { gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { computeCandidateIdentity, sha256 } from '../lib/repair-candidates/identity.ts';
import type { FrozenCandidateFile } from '../lib/repair-candidates/types.ts';
import { expectedCandidateManifest, runFrozenCandidateVerification } from '../lib/candidate-verifications/runner.ts';
import type { FrozenVerificationInput } from '../lib/candidate-verifications/types.ts';
import type { SourceManifest } from '../lib/repository-baselines/runner.ts';

const PACKAGE = '{"name":"fixture"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"fixture"}}}';
const ORIGINAL = 'export const fixed = false;\n';
const REPAIRED = 'export const fixed = true;\n';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const entries = [
  { path: 'package-lock.json', type: 'file' as const, mode: 644, sha256: hash(LOCK), blobSha: gitBlobSha(LOCK) },
  { path: 'package.json', type: 'file' as const, mode: 644, sha256: hash(PACKAGE), blobSha: gitBlobSha(PACKAGE) },
  { path: 'src/fix.ts', type: 'file' as const, mode: 644, sha256: hash(ORIGINAL), blobSha: gitBlobSha(ORIGINAL) },
];
const pristine: SourceManifest = { entries, identity: hash(JSON.stringify(entries)) };
const file: FrozenCandidateFile = {
  path: 'src/fix.ts', operation: 'modify', baseBlobSha: gitBlobSha(ORIGINAL), baseContentSha256: hash(ORIGINAL),
  resultContentSha256: hash(REPAIRED), resultByteLength: Buffer.byteLength(REPAIRED), resultingContent: REPAIRED,
};
const reconstructed = expectedCandidateManifest(pristine, [file]);

function input(overrides: Partial<FrozenVerificationInput> = {}): FrozenVerificationInput {
  const workspaceId = randomUUID();
  const baseCommitSha = 'a'.repeat(40);
  const profileIdentity = 'b'.repeat(64);
  const githubRepositoryId = 8101;
  return {
    verificationId: randomUUID(), attemptId: randomUUID(), evidenceId: randomUUID(), candidateId: randomUUID(),
    candidateIdentity: computeCandidateIdentity({ formatVersion: 1, githubRepositoryId, baseCommitSha, profileIdentity, files: [file] }),
    workspaceId, githubRepositoryId, installationId: 9001, baseCommitSha, profileIdentity, baselineId: randomUUID(),
    baselineSandbox: { name: 'vigilo-baseline-original', sessionId: 'baseline-session' }, baselineOutcome: 'baseline_passed',
    profile: {
      baseCommitSha, buildScript: 'build', githubRepositoryId, installationId: 9001,
      packageJsonBlobSha: gitBlobSha(PACKAGE), packageJsonContentSha256: hash(PACKAGE),
      packageLockBlobSha: gitBlobSha(LOCK), packageLockContentSha256: hash(LOCK),
      profileIdentity, profileVersion: 2, testRunner: 'node-test', testScript: 'test', typecheckScript: 'typecheck', workspaceId,
    },
    files: [file], archive: Buffer.from('trusted-archive'), archiveSha256: hash('trusted-archive'),
    startedAt: new Date('2026-09-10T10:00:00Z'), ...overrides,
  };
}

interface Scenario {
  candidateManifest?: SourceManifest;
  cleanupFails?: boolean;
  commandFailure?: 'typecheck' | 'build' | 'test';
  credentialsPresent?: boolean;
  finalManifest?: SourceManifest;
  sessionId?: string;
}

function installSandboxMock(t: test.TestContext, scenario: Scenario, commands: string[][], writes: string[]) {
  let policy: unknown = { allow: ['registry.npmjs.org'] };
  let deleted = false;
  let manifestCalls = 0;
  const sandbox = {
    persistent: false, timeout: 600_000,
    get networkPolicy() { return policy; },
    currentSession() { return { sessionId: scenario.sessionId ?? 'fresh-verifier-session', status: 'running' }; },
    async writeFiles(files: Array<{ content: Uint8Array; path: string }>) {
      writes.push(...files.map((item) => item.path));
      assert.doesNotMatch(JSON.stringify(files), /host-secret|installation-token|PRIVATE KEY/);
    },
    async runCommand(params: { cmd: string; args: string[]; env?: unknown }) {
      assert.equal(params.env, undefined);
      if (params.cmd !== 'node') return { exitCode: 0, stdout: async () => '' };
      if (params.args[0] === '--version') return { exitCode: 0, stdout: async () => 'v24.20.0' };
      if (params.args[1]?.includes("'DATABASE_URL'")) return { exitCode: 0, stdout: async () => scenario.credentialsPresent ? 'present' : 'absent' };
      if (params.args[1]?.includes('createGunzip')) return { exitCode: 0, stdout: async () => JSON.stringify({ entries: 3, totalFileBytes: 100 }) };
      if (params.args[1]?.includes('const expected')) {
        manifestCalls += 1;
        const value = manifestCalls === 1 ? pristine : manifestCalls === 2 ? (scenario.candidateManifest ?? reconstructed) : (scenario.finalManifest ?? reconstructed);
        return { exitCode: 0, stdout: async () => JSON.stringify(value) };
      }
      if (params.args[1]?.includes('const operations')) return { exitCode: 0, stdout: async () => '' };
      const command = JSON.parse(params.args[2]!) as { args: string[] };
      commands.push(command.args);
      const phase = command.args[0] === 'ci' ? 'install' : command.args.at(-1);
      if (phase === 'install') assert.deepEqual(policy, { allow: ['registry.npmjs.org'] });
      else assert.equal(policy, 'deny-all');
      const failed = scenario.commandFailure === phase;
      return { exitCode: 0, stdout: async () => JSON.stringify({
        exitCode: failed ? 1 : 0, timedOut: false, spawnFailed: false, signalTermination: false,
        stdoutSha256: 'c'.repeat(64), stderrSha256: 'd'.repeat(64),
      }) };
    },
    async update(params: { networkPolicy: string }) { policy = params.networkPolicy; },
    async stop() {},
    async delete() { if (scenario.cleanupFails) throw new Error('controlled cleanup failure'); deleted = true; },
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
}

test('fresh verifier reconstructs exact persisted bytes after deny-all and runs only frozen npm descriptors', async (t) => {
  const original = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = 'host-secret';
  t.after(() => { if (original === undefined) delete process.env.VERCEL_OIDC_TOKEN; else process.env.VERCEL_OIDC_TOKEN = original; });
  const commands: string[][] = []; const writes: string[] = [];
  installSandboxMock(t, {}, commands, writes);
  const result = await runFrozenCandidateVerification(input(), undefined, () => new Date('2026-09-10T10:00:01Z'));
  assert.equal(result.candidateArtifactIntegrity, 'valid');
  assert.equal(result.distinctSandboxConfirmed, true);
  assert.equal(result.pristineBaseIntegrity, 'valid');
  assert.equal(result.candidateReconstruction, 'valid');
  assert.equal(result.credentialsExposure, 'absent');
  assert.equal(result.networkPolicyBeforeRepositoryExecution, 'deny-all');
  assert.equal(result.verificationContract, 'checks_passed');
  assert.equal(result.baselineComparison, 'no_regression_detected');
  assert.equal(result.repairObjectiveEvidence, 'not_measured');
  assert.equal(result.sourceIntegrityUnchanged, true);
  assert.deepEqual(result.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
  assert.deepEqual(commands, [
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=15000'],
    ['--ignore-scripts', 'run', 'typecheck'], ['--ignore-scripts', 'run', 'build'], ['--ignore-scripts', 'test'],
  ]);
  assert.equal(writes.length, 2);
  assert.match(writes[1]!, /src\/fix\.ts$/);
  assert.doesNotMatch(JSON.stringify(result), /host-secret|trusted-archive|export const fixed|PRIVATE KEY/);
});

test('verifier failures, source mutation, sandbox reuse, and missing cleanup fail closed', async (t) => {
  const original = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = 'host-secret';
  t.after(() => { if (original === undefined) delete process.env.VERCEL_OIDC_TOKEN; else process.env.VERCEL_OIDC_TOKEN = original; });
  const addedEntries = [...reconstructed.entries, { path: 'src/unexpected.ts', type: 'file' as const, mode: 644, sha256: 'e'.repeat(64), blobSha: 'f'.repeat(40) }];
  const mutated: SourceManifest = { entries: addedEntries, identity: hash(JSON.stringify(addedEntries)) };
  const scenarios: Array<[string, Scenario, Partial<FrozenVerificationInput>, string, string]> = [
    ['typecheck failure', { commandFailure: 'typecheck' }, {}, 'checks_failed', 'regression_detected'],
    ['build failure', { commandFailure: 'build' }, {}, 'checks_failed', 'regression_detected'],
    ['test failure', { commandFailure: 'test' }, {}, 'checks_failed', 'regression_detected'],
    ['credential exposure', { credentialsPresent: true }, {}, 'infrastructure_failed', 'not_comparable'],
    ['candidate reconstruction mismatch', { candidateManifest: pristine }, {}, 'infrastructure_failed', 'not_comparable'],
    ['post-execution source mutation', { finalManifest: mutated }, {}, 'infrastructure_failed', 'not_comparable'],
    ['cleanup failure', { cleanupFails: true }, {}, 'infrastructure_failed', 'not_comparable'],
    ['baseline session reuse', { sessionId: 'baseline-session' }, {}, 'infrastructure_failed', 'not_comparable'],
  ];
  for (const [name, scenario, overrides, contract, comparison] of scenarios) {
    await t.test(name, async (child) => {
      const commands: string[][] = []; const writes: string[] = [];
      installSandboxMock(child, scenario, commands, writes);
      const result = await runFrozenCandidateVerification(input(overrides));
      assert.equal(result.verificationContract, contract, JSON.stringify(result));
      assert.equal(result.baselineComparison, comparison);
      if (name === 'typecheck failure') assert.equal(commands.length, 2);
      if (name === 'build failure') assert.equal(commands.length, 3);
      if (name === 'test failure') assert.deepEqual(result.error, { phase: 'test', code: 'npm_command_failed' });
      if (name === 'candidate reconstruction mismatch') assert.equal(commands.length, 1);
      if (name === 'post-execution source mutation') assert.equal(result.sourceIntegrityUnchanged, false);
      if (name === 'cleanup failure') assert.notEqual(result.cleanup.delete, 'confirmed');
    });
  }
});

test('candidate artifact corruption and baseline sandbox name reuse are rejected before project execution', async (t) => {
  for (const [name, overrides] of [
    ['identity mismatch', { candidateIdentity: '0'.repeat(64) }],
    ['sandbox name reuse', { baselineSandbox: { name: 'vigilo-candidate-verifier', sessionId: null } }],
  ] satisfies Array<[string, Partial<FrozenVerificationInput>]>) {
    await t.test(name, async (child) => {
      const commands: string[][] = []; const writes: string[] = [];
      installSandboxMock(child, {}, commands, writes);
      const result = await runFrozenCandidateVerification(input(overrides));
      assert.equal(result.verificationContract, 'infrastructure_failed');
      assert.equal(commands.length, 0);
      assert.deepEqual(result.cleanup, { stop: 'not_needed', delete: 'not_needed', lookup: 'not_run' });
    });
  }
});
