import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { APIError, Sandbox } from '@vercel/sandbox';

import { executionProfile, githubInstallation, repository, repositoryBaseline } from '../db/schema.ts';
import { resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { expectedCandidateManifest, runFrozenCandidateVerification } from '../lib/candidate-verifications/runner.ts';
import type { FrozenVerificationInput } from '../lib/candidate-verifications/types.ts';
import { detectExecutionProfile, gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { ExternalExecutionAuthorityError } from '../lib/external-execution/types.ts';
import { computeCandidateIdentity } from '../lib/repair-candidates/identity.ts';
import type { FrozenCandidateFile } from '../lib/repair-candidates/types.ts';
import { deriveBaselineRecoveryContract, evaluateBaselineRecovery, type BaselineRecoveryEvidence } from '../lib/repair-loops/objective-contract.ts';
import { executeSelectedRepositoryBaseline } from '../lib/repository-baselines/flow.ts';
import { runFrozenRepositoryBaseline, type SourceManifest } from '../lib/repository-baselines/runner.ts';
import type { BaselineEvidence, FrozenBaselineInput } from '../lib/repository-baselines/types.ts';
import { configureSandboxTestCredentials, createTestExternalExecutionAuthorizer } from './external-execution-support.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const PACKAGE = '{"name":"integrity-regression","scripts":{"typecheck":"node --check src/threshold.js","build":"node --check src/threshold.js","test":"node --test"},"engines":{"node":"24.x"}}\n';
const LOCK = '{"name":"integrity-regression","lockfileVersion":3,"packages":{"":{"name":"integrity-regression","engines":{"node":"24.x"}}}}\n';
const ORIGINAL = 'export const qualifies = amount => amount > 100;\n';
const REPAIRED = 'export const qualifies = amount => amount >= 100;\n';
const entries = [
  ['package-lock.json', LOCK], ['package.json', PACKAGE], ['src/threshold.js', ORIGINAL],
].map(([path, content]) => ({ path: path!, type: 'file', mode: 644, sha256: hash(content!), blobSha: gitBlobSha(content!) }));
const manifest = (values: SourceManifest['entries'] = entries): SourceManifest => ({ entries: values, identity: hash(JSON.stringify(values)) });
const pristine = manifest();
const profile: FrozenBaselineInput['profile'] = {
  baseCommitSha: 'a'.repeat(40), buildScript: 'build', githubRepositoryId: 8101, installationId: 9001,
  packageJsonBlobSha: gitBlobSha(PACKAGE), packageJsonContentSha256: hash(PACKAGE),
  packageLockBlobSha: gitBlobSha(LOCK), packageLockContentSha256: hash(LOCK),
  profileIdentity: 'b'.repeat(64), profileVersion: 2, testRunner: 'node-test', testScript: 'test',
  typecheckScript: 'typecheck', workspaceId: 'workspace-one',
};
const input: FrozenBaselineInput = {
  archive: Buffer.from('fake-reviewed-archive'), archiveSha256: hash('fake-reviewed-archive'),
  repository: { defaultBranch: 'main', fullName: 'example/fixture', id: 8101, isPrivate: false, name: 'fixture', ownerId: 3001, ownerLogin: 'example' },
  runId: 'baseline-one', startedAt: new Date('2026-09-09T10:00:00Z'), profile,
};

type Phase = 'typecheck' | 'build' | 'test';
type Scenario = {
  failure?: Phase | 'install';
  finalManifest?: SourceManifest;
  manifestError?: 'read' | 'session' | 'authority';
  abnormal?: 'timeout' | 'cancelled' | 'authority' | 'lease' | 'transport' | 'malformed' | 'session' | 'spawn' | 'overall_timeout';
  controller?: AbortController;
  cleanupFails?: boolean;
  verifier?: boolean;
  stoppedBeforeManifest?: boolean;
  stoppedDuringManifest?: boolean;
};

function fakeSandbox(t: test.TestContext, scenario: Scenario = {}) {
  configureSandboxTestCredentials(t);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('live fetch forbidden'));
  t.mock.method(console, 'log', () => {});
  const events: string[] = [];
  let policy: unknown = { allow: ['registry.npmjs.org'] };
  let deleted = false;
  let sessionChanged = false;
  let manifestCalls = 0;
  let phaseFailed = false;
  // Exercise the installed SDK's resume behavior with an in-memory API client.
  // A stopped-session response must never cause getSandbox({ resume: true }).
  const sdk = new Sandbox({
    client: {
      async runCommand() {
        events.push('manifest:2');
        throw new APIError(new Response(null, { status: 410 }));
      },
      async getSandbox(params: { resume: boolean }) {
        assert.equal(params.resume, true);
        events.push('resume');
        return { json: { routes: [], session: { id: 'replacement-session', status: 'running' } } };
      },
    } as never,
    routes: [], session: { id: 'baseline-session', status: 'running' } as never,
    sandbox: { name: 'controlled-baseline' } as never, projectId: 'project_test',
  });
  const sandbox = {
    persistent: false, timeout: 600_000,
    get networkPolicy() { return policy; },
    currentSession() {
      if (scenario.stoppedDuringManifest) return sdk.currentSession();
      return {
        sessionId: sessionChanged ? 'lost-session' : scenario.verifier ? 'verification-session' : 'baseline-session',
        status: phaseFailed && scenario.stoppedBeforeManifest ? 'stopped' : 'running',
        runCommand: sandbox.runCommand.bind(sandbox),
      };
    },
    async writeFiles() { events.push('write'); },
    async runCommand(params: { cmd: string; args: string[]; signal: AbortSignal }) {
      assert.equal(params.cmd, 'node');
      params.signal.throwIfAborted();
      assert.equal(deleted, false, 'no command after destructive cleanup');
      if (params.args[0] === '--version') return { exitCode: 0, stdout: async () => 'v24.13.0' };
      const script = params.args[1]!;
      if (phaseFailed && scenario.stoppedDuringManifest && script.includes('const expected')) return sdk.runCommand(params);
      if (script.includes("'DATABASE_URL'")) return { exitCode: 0, stdout: async () => 'absent' };
      if (script.includes('createGunzip')) return { exitCode: 0, stdout: async () => '{}' };
      if (script.includes('const expected')) {
        manifestCalls++;
        events.push(`manifest:${manifestCalls}`);
        if (manifestCalls > 1) {
          if (scenario.manifestError === 'read') throw new Error('controlled unavailable manifest');
          if (scenario.manifestError === 'authority') throw new ExternalExecutionAuthorityError('execution_authority_expired');
          if (scenario.manifestError === 'session') sessionChanged = true;
        }
        const observed = scenario.verifier && manifestCalls > 1 ? reconstructed : manifestCalls > 1 ? scenario.finalManifest ?? pristine : pristine;
        return { exitCode: 0, stdout: async () => JSON.stringify(observed) };
      }
      if (script.includes('const operations')) return { exitCode: 0, stdout: async () => '' };
      const args = (JSON.parse(params.args[2]!) as { args: string[] }).args;
      const phase = args[0] === 'ci' ? 'install' : args.at(-1)!;
      events.push(phase);
      if (phase !== 'install') assert.equal(policy, 'deny-all');
      const failed = phase === scenario.failure;
      if (failed) phaseFailed = true;
      if (failed && scenario.abnormal === 'authority') throw new ExternalExecutionAuthorityError('execution_authority_expired');
      if (failed && scenario.abnormal === 'lease') throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
      if (failed && scenario.abnormal === 'transport') throw new APIError(new Response(null, { status: 503 }));
      if (failed && scenario.abnormal === 'malformed') return { exitCode: 0, stdout: async () => '{"exitCode":1}' };
      if (failed && scenario.abnormal === 'overall_timeout') throw new DOMException('deadline', 'TimeoutError');
      if (failed && scenario.abnormal === 'cancelled') scenario.controller!.abort();
      if (failed && scenario.abnormal === 'session') sessionChanged = true;
      const timedOut = failed && scenario.abnormal === 'timeout';
      const spawnFailed = failed && scenario.abnormal === 'spawn';
      return { exitCode: 0, stdout: async () => JSON.stringify({
        exitCode: timedOut || spawnFailed ? null : failed ? 1 : 0, timedOut,
        spawnFailed: timedOut || spawnFailed, signalTermination: timedOut,
        stdoutSha256: hash('bounded fake output'), stderrSha256: hash(''),
      }) };
    },
    async update(params: { networkPolicy: string }) { policy = params.networkPolicy; },
    async stop() { events.push('stop'); },
    async delete() { events.push('delete'); if (scenario.cleanupFails) throw new Error('controlled cleanup failure'); deleted = true; },
  };
  t.mock.method(Sandbox, 'create', async () => { events.push('create'); return sandbox as never; });
  t.mock.method(Sandbox, 'get', async () => {
    events.push('lookup');
    if (deleted) throw new APIError(new Response(null, { status: 404 }));
    return sandbox as never;
  });
  const authorizer = createTestExternalExecutionAuthorizer();
  const reserve = authorizer.reserve;
  authorizer.reserve = async (request) => {
    events.push('reserve');
    assert.equal(request.amounts.sandboxIdentities, 1);
    assert.equal(request.amounts.providerAttempts, 96);
    return reserve(request);
  };
  const scope = { workspaceId: profile.workspaceId, githubRepositoryId: profile.githubRepositoryId, baseCommitSha: profile.baseCommitSha, operationCategory: scenario.verifier ? 'sandbox_verification' as const : 'sandbox_baseline' as const, providerId: 'vercel' };
  return { events, authority: { authorizer, scope } };
}

for (const state of ['stoppedBeforeManifest', 'stoppedDuringManifest'] as const) {
  test(`post-failure ${state} never resumes or replaces the measured session`, async t => {
    const mock = fakeSandbox(t, { failure: 'test', [state]: true });
    const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
    assert.equal(result.executionOutcome, 'infrastructure_failed');
    assert.equal(result.test.status, 'failed');
    assert.equal(result.source.identityAfterExecution, null);
    assert.equal(result.source.unchangedAfterExecution, null);
    assert.equal(recoveryContract(result).measurable, false);
    assert.equal(mock.events.includes('resume'), false);
    if (state === 'stoppedBeforeManifest') assert.equal(mock.events.includes('manifest:2'), false);
    for (const once of ['reserve', 'create', 'stop', 'delete']) assert.equal(mock.events.filter(e => e === once).length, 1);
    assert.deepEqual(result.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
  });
}

// Map only measured runner fields, exactly as baseline persistence does.
function recoveryContract(report: BaselineEvidence) {
  return deriveBaselineRecoveryContract({ repairRunId: 'repair-run-one', profile: { ...profile, status: 'ready' }, baseline: {
    id: report.runId, workspaceId: report.workspaceId, githubRepositoryId: report.githubRepositoryId,
    installationId: report.installationId, evidenceVersion: report.evidenceVersion, profileIdentity: report.profileIdentity,
    baseCommitSha: report.baseCommitSha, sourceIdentityBefore: report.source.identityBeforeExecution,
    sourceIdentityAfter: report.source.identityAfterExecution, sourceUnchanged: report.source.unchangedAfterExecution,
    credentialsExposure: report.credentialsExposure, networkPolicy: report.networkPolicyBeforeRepositoryExecution,
    installStatus: report.install.status, installExitCode: report.install.exitCode, installTimedOut: report.install.timedOut,
    typecheckStatus: report.typecheck?.status ?? null, typecheckExitCode: report.typecheck?.exitCode ?? null, typecheckTimedOut: report.typecheck?.timedOut ?? null,
    buildStatus: report.build?.status ?? null, buildExitCode: report.build?.exitCode ?? null, buildTimedOut: report.build?.timedOut ?? null,
    testStatus: report.test.status, testExitCode: report.test.exitCode, testTimedOut: report.test.timedOut,
    executionOutcome: report.executionOutcome, overallOutcome: report.overallOutcome,
    cleanupStop: report.cleanup.stop, cleanupDelete: report.cleanup.delete, cleanupLookup: report.cleanup.lookup,
  } });
}

for (const phase of ['typecheck', 'build', 'test'] as const) {
  test(`ordinary ${phase} failure retains measured source integrity and stops later phases`, async (t) => {
    const mock = fakeSandbox(t, { failure: phase });
    const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
    assert.equal(result.executionOutcome, `${phase}_failed`);
    assert.equal(result.overallOutcome, `${phase}_failed`);
    assert.deepEqual(result.error, { phase, code: 'npm_command_failed' });
    assert.equal(result[phase]!.status, 'failed');
    assert.equal(result[phase]!.exitCode, 1);
    assert.equal(result.source.identityBeforeExecution, pristine.identity);
    assert.equal(result.source.identityAfterExecution, pristine.identity);
    assert.equal(result.source.unchangedAfterExecution, true);
    assert.deepEqual(result.cleanup, { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' });
    const contract = recoveryContract(result);
    assert.equal(contract.measurable, true);
    assert.deepEqual(contract.requiredChecks, [phase]);
    assert.ok(mock.events.indexOf('manifest:2') > mock.events.indexOf(phase));
    assert.ok(mock.events.indexOf('manifest:2') < mock.events.indexOf('stop'));
    for (const once of ['reserve', 'create', 'stop', 'delete']) assert.equal(mock.events.filter(e => e === once).length, 1);
    if (phase === 'typecheck') { assert.equal(result.build!.status, 'not_run'); assert.equal(result.test.status, 'not_run'); }
    if (phase === 'build') assert.equal(result.test.status, 'not_run');
  });
}

test('failing source/protected-file mutations never establish a measurable objective', async (t) => {
  const variants = [
    entries.map(e => e.path === 'src/threshold.js' ? { ...e, sha256: hash(REPAIRED), blobSha: gitBlobSha(REPAIRED) } : e),
    entries.map(e => e.path === 'package-lock.json' ? { ...e, sha256: hash(LOCK + ' '), blobSha: gitBlobSha(LOCK + ' ') } : e),
    entries.map(e => e.path === 'package.json' ? { ...e, sha256: hash(PACKAGE + ' '), blobSha: gitBlobSha(PACKAGE + ' ') } : e),
    entries.map(e => e.path === 'src/threshold.js' ? { ...e, mode: 755 } : e),
    entries.map(e => e.path === 'src/threshold.js' ? { ...e, type: 'symlink', mode: 0, sha256: hash('other.js'), blobSha: null } : e),
    [...entries, { path: 'src/added.js', type: 'file', mode: 644, sha256: hash('added'), blobSha: gitBlobSha('added') }],
  ];
  for (const [index, variant] of variants.entries()) await t.test(`mutation ${index}`, async child => {
    const changed = manifest(variant);
    const mock = fakeSandbox(child, { failure: 'test', finalManifest: changed });
    const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
    assert.equal(result.test.status, 'failed');
    assert.equal(result.source.identityAfterExecution, changed.identity);
    assert.equal(result.source.unchangedAfterExecution, false);
    assert.equal(result.executionOutcome, 'baseline_failed');
    assert.deepEqual(result.error, { phase: 'source_integrity_after_execution', code: 'source_mutated' });
    assert.equal(recoveryContract(result).measurable, false);
    assert.equal(result.cleanup.delete, 'confirmed');
  });
});

for (const manifestError of ['read', 'session', 'authority'] as const) {
  test(`post-failure manifest ${manifestError} loss fails closed before cleanup`, async t => {
    const mock = fakeSandbox(t, { failure: 'test', manifestError });
    const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
    assert.equal(result.test.status, 'failed');
    assert.equal(result.executionOutcome, 'infrastructure_failed');
    assert.equal(result.source.identityAfterExecution, null);
    assert.equal(result.source.unchangedAfterExecution, null);
    assert.equal(recoveryContract(result).measurable, false);
    assert.ok(mock.events.indexOf('manifest:2') < mock.events.indexOf('stop'));
    assert.equal(mock.events.filter(e => e === 'create').length, 1);
    assert.equal(result.cleanup.delete, 'confirmed');
  });
}

test('corrupt post-failure manifest never fabricates source integrity', async t => {
  const mock = fakeSandbox(t, { failure: 'test', finalManifest: { ...pristine, identity: '0'.repeat(64) } });
  const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
  assert.equal(result.source.identityAfterExecution, null);
  assert.equal(result.source.unchangedAfterExecution, null);
  assert.equal(result.executionOutcome, 'infrastructure_failed');
  assert.equal(recoveryContract(result).measurable, false);
});

test('post-failure manifest path, mode and type validation remains fail-closed', async t => {
  for (const [name, entry] of [
    ['path', { ...entries[2]!, path: '../outside.js' }],
    ['mode', { ...entries[2]!, mode: 600 }],
    ['type', { ...entries[2]!, type: 'directory' }],
  ] as const) await t.test(name, async child => {
    const mock = fakeSandbox(child, { failure: 'test', finalManifest: manifest([...entries.slice(0, 2), entry]) });
    const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
    assert.equal(result.source.identityAfterExecution, null);
    assert.equal(result.source.unchangedAfterExecution, null);
    assert.equal(result.executionOutcome, 'infrastructure_failed');
    assert.equal(result.cleanup.delete, 'confirmed');
    assert.equal(recoveryContract(result).measurable, false);
  });
});

for (const abnormal of ['timeout', 'cancelled', 'authority', 'lease', 'transport', 'malformed', 'session', 'spawn', 'overall_timeout'] as const) {
  test(`${abnormal} termination does not attempt post-failure integrity recovery`, async t => {
    const controller = new AbortController();
    const mock = fakeSandbox(t, { failure: 'test', abnormal, controller });
    const result = await runFrozenRepositoryBaseline(input, controller.signal, undefined, undefined, mock.authority);
    assert.equal(result.executionOutcome, abnormal === 'timeout' || abnormal === 'overall_timeout' ? 'timed_out' : abnormal === 'cancelled' ? 'cancelled' : 'infrastructure_failed');
    assert.equal(result.source.identityAfterExecution, null);
    assert.equal(result.source.unchangedAfterExecution, null);
    assert.equal(mock.events.includes('manifest:2'), false);
    assert.equal(mock.events.filter(e => e === 'reserve').length, 1);
    assert.equal(result.cleanup.delete, 'confirmed');
    assert.equal(recoveryContract(result).measurable, false);
  });
}

test('installation failure does not recapture or become recovery evidence', async t => {
  const mock = fakeSandbox(t, { failure: 'install' });
  const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
  assert.equal(result.executionOutcome, 'installation_failed');
  assert.equal(result.source.identityAfterExecution, null);
  assert.equal(mock.events.includes('manifest:2'), false);
});

test('cleanup failure retains the original phase and measured identity but prevents trust', async t => {
  const mock = fakeSandbox(t, { failure: 'test', cleanupFails: true });
  const result = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
  assert.equal(result.executionOutcome, 'test_failed');
  assert.equal(result.overallOutcome, 'cleanup_failed');
  assert.deepEqual(result.error, { phase: 'test', code: 'npm_command_failed' });
  assert.equal(result.source.identityAfterExecution, pristine.identity);
  assert.equal(result.source.unchangedAfterExecution, true);
  assert.equal(result.cleanup.delete, 'failed');
  assert.equal(mock.events.filter(e => e === 'delete').length, 1);
  assert.equal(recoveryContract(result).measurable, false);
});

const repair: FrozenCandidateFile = {
  path: 'src/threshold.js', operation: 'modify', baseBlobSha: gitBlobSha(ORIGINAL), baseContentSha256: hash(ORIGINAL),
  resultingContent: REPAIRED, resultContentSha256: hash(REPAIRED), resultByteLength: Buffer.byteLength(REPAIRED),
};
const reconstructed = expectedCandidateManifest(pristine, [repair]);

test('actual failing baseline to independent fresh verification satisfies baseline_recovery_v1', async t => {
  let baseline!: BaselineEvidence;
  await t.test('measure broken baseline', async child => {
    const mock = fakeSandbox(child, { failure: 'test' });
    baseline = await runFrozenRepositoryBaseline(input, undefined, undefined, undefined, mock.authority);
    assert.equal(baseline.typecheck!.exitCode, 0);
    assert.equal(baseline.build!.exitCode, 0);
    assert.equal(baseline.test.exitCode, 1);
  });
  const contract = recoveryContract(baseline);
  assert.equal(contract.measurable, true);
  assert.deepEqual(contract.requiredChecks, ['test']);
  await t.test('independently reconstruct and verify repaired bytes', async child => {
    const mock = fakeSandbox(child, { verifier: true });
    const verificationInput: FrozenVerificationInput = {
      ...profile, profile, archive: input.archive, archiveSha256: input.archiveSha256, startedAt: input.startedAt,
      files: [repair], verificationId: 'verification-one', attemptId: 'attempt-one', evidenceId: 'evidence-one', candidateId: 'candidate-one',
      candidateIdentity: computeCandidateIdentity({ formatVersion: 1, ...profile, files: [repair] }),
      baselineId: baseline.runId, baselineSandbox: { name: baseline.sandbox.name, sessionId: baseline.sandbox.sessionId }, baselineOutcome: baseline.overallOutcome,
    };
    const verified = await runFrozenCandidateVerification(verificationInput, undefined, undefined, undefined, mock.authority);
    assert.equal(verified.verificationContract, 'checks_passed');
    assert.equal(verified.distinctSandboxConfirmed, true);
    assert.equal(verified.reconstructedSourceIdentity, reconstructed.identity);
    assert.equal(verified.sourceIntegrityUnchanged, true);
    const evidence: BaselineRecoveryEvidence = {
      ...verified, id: verified.evidenceId, networkPolicy: verified.networkPolicyBeforeRepositoryExecution,
      installStatus: verified.install.status, installExitCode: verified.install.exitCode, installTimedOut: verified.install.timedOut,
      typecheckStatus: verified.typecheck!.status, typecheckExitCode: verified.typecheck!.exitCode, typecheckTimedOut: verified.typecheck!.timedOut,
      buildStatus: verified.build!.status, buildExitCode: verified.build!.exitCode, buildTimedOut: verified.build!.timedOut,
      testStatus: verified.test.status, testExitCode: verified.test.exitCode, testTimedOut: verified.test.timedOut,
      sourceIdentityAfter: verified.sourceIdentityAfterExecution,
      cleanupStop: verified.cleanup.stop, cleanupDelete: verified.cleanup.delete, cleanupLookup: verified.cleanup.lookup,
    };
    assert.deepEqual(evaluateBaselineRecovery(contract, evidence, {
      verificationId: verified.verificationId, candidateId: verified.candidateId, candidateIdentity: verified.candidateIdentity, evidenceId: verified.evidenceId,
    }), { result: 'satisfied', evaluatedChecks: ['test'] });
  });
});

test('baseline persistence stores actual failed-runner integrity without a schema change', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.client.close());
  const user = await saveGithubUser(ctx, '2001');
  const login = await ctx.testAuth.login({ userId: user.id });
  const auth = await resolveAuthenticatedWorkspace(headers => ctx.auth.api.getSession({ headers }), ctx.database, login.headers);
  const mock = fakeSandbox(t, { failure: 'test' });
  const installation = { account: { id: 3001, login: 'example', type: 'Organization' as const }, appId: 991, appSlug: 'vigilo-dev-test', id: 9001, permissions: { contents: 'read', metadata: 'read' }, suspendedAt: null };
  await ctx.database.insert(githubInstallation).values({ accountLogin: 'example', accountType: 'Organization', githubAccountId: 3001, installationId: 9001, status: 'active', workspaceId: auth.workspace.id });
  await ctx.database.insert(repository).values({ ...input.repository, githubRepositoryId: profile.githubRepositoryId, installationId: 9001, workspaceId: auth.workspace.id });
  const detected = detectExecutionProfile({
    ...profile, workspaceId: auth.workspace.id,
    rootEntries: entries.slice(0, 2).map(e => ({ name: e.path, path: e.path, type: 'file', sha: e.blobSha,
      size: Buffer.byteLength(e.path === 'package.json' ? PACKAGE : LOCK) })),
    packageJson: { content: PACKAGE, sha: gitBlobSha(PACKAGE) },
    packageLock: { content: LOCK, sha: gitBlobSha(LOCK) },
  });
  assert.ok(detected.status === 'ready');
  const profileIdentity = detected.profileIdentity;
  await ctx.database.insert(executionProfile).values({ ...profile, workspaceId: auth.workspace.id, profileIdentity,
    installOperation: 'ci', lockfileType: 'package-lock', nodeMajor: 24, packageManager: 'npm', runtimeFamily: 'node', status: 'ready' });
  const gateway = {
    getInstallation: async () => installation,
    createInstallationAccessToken: async () => ({ accessToken: 'fake-source-token', repository: input.repository }),
    getRepositoryMetadata: async () => input.repository,
    downloadRepositoryArchive: async () => input.archive,
    revokeInstallationAccessToken: async () => undefined,
  };
  const result = await executeSelectedRepositoryBaseline(ctx.database, auth, gateway,
    { appId: 991, appSlug: 'vigilo-dev-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' },
    { sandboxAuthority: mock.authority });
  const [stored] = await ctx.database.select().from(repositoryBaseline);
  assert.equal(result.overallOutcome, 'test_failed');
  assert.equal(stored!.sourceIdentityBefore, result.source.identityBeforeExecution);
  assert.equal(stored!.sourceIdentityAfter, pristine.identity);
  assert.equal(stored!.sourceUnchanged, true);
  assert.equal(stored!.testStatus, 'failed');
  assert.equal(stored!.testExitCode, 1);
  assert.equal(stored!.errorPhase, 'test');
  assert.equal(stored!.overallOutcome, 'test_failed');
  assert.equal(deriveBaselineRecoveryContract({ repairRunId: 'repair-run-one', baseline: stored!,
    profile: { ...profile, workspaceId: auth.workspace.id, profileIdentity, status: 'ready' } }).measurable, true);
});
