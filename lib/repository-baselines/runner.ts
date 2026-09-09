import { APIError, type Sandbox } from '@vercel/sandbox';
import { createHash } from 'node:crypto';

import { commandEvidence, fixtureExecutor, ROOT, ExecutionFailure } from '../../src/fixture-execution.ts';
import { ExecutionCancelled, requireNode24, SandboxBoundary, type SandboxLifecycleObserver } from '../../src/sandbox-boundary.ts';
import { ARCHIVE_LIMITS, SAFE_ARCHIVE_EXTRACTION_SCRIPT } from './archive.ts';
import { BASELINE_EVIDENCE_VERSION, type BaselineEvidence, type BaselineOutcome, type FrozenBaselineInput } from './types.ts';

const INSTALL_POLICY = { allow: ['registry.npmjs.org'] };
const INSTALL_ARGS = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=15000'];
const ARCHIVE_PATH = '/vercel/sandbox/vigilo-input/source.tar.gz';
const MAX_MANIFEST_BYTES = 512 * 1024;

const MANIFEST_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = ${JSON.stringify(ROOT)};
const expected = process.argv[1] ? JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8')) : null;
const sha = value => createHash('sha256').update(value).digest('hex');
const entries = [];
const expectedPaths = new Set(expected ? expected.map(entry => entry.path) : []);
const generatedRoots = new Set(['node_modules', '.next', 'dist', 'coverage', '.auth-test-dist', '.web-test-dist', '.vitest']);
const add = relative => {
  if (!relative || relative.length > 512 || /[\\0-\\x1f\\x7f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('unsafe_path');
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isFile()) {
    if (stat.size > 10 * 1024 * 1024) throw new Error('file_too_large');
    const content = fs.readFileSync(absolute);
    const blobSha = createHash('sha1').update('blob ' + content.byteLength + '\\0').update(content).digest('hex');
    entries.push({ path: relative, type: 'file', mode: stat.mode & 0o111 ? 755 : 644, sha256: sha(content), blobSha });
  } else if (stat.isSymbolicLink()) {
    entries.push({ path: relative, type: 'symlink', mode: 0, sha256: sha(Buffer.from(fs.readlinkSync(absolute), 'utf8')), blobSha: null });
  } else throw new Error('unsupported_type');
};
if (expected) {
  if (!Array.isArray(expected) || expected.length > 5000) throw new Error('invalid_expected');
  for (const entry of expected) add(entry.path);
}
const walk = (directory, prefix = '') => {
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? prefix + '/' + item.name : item.name;
    const generated = Boolean(expected) && (
      generatedRoots.has(relative.split('/')[0]) ||
      relative === 'next-env.d.ts' ||
      (!relative.includes('/') && relative.endsWith('.tsbuildinfo'))
    );
    if (item.isDirectory()) {
      if (!generated) walk(path.join(directory, item.name), relative);
    } else if (!expectedPaths.has(relative) && !generated) add(relative);
    if (entries.length > 5000) throw new Error('too_many_files');
  }
};
walk(root);
entries.sort((a, b) => a.path.localeCompare(b.path));
const output = JSON.stringify({ entries, identity: sha(JSON.stringify(entries)) });
if (Buffer.byteLength(output) > ${MAX_MANIFEST_BYTES}) throw new Error('manifest_too_large');
console.log(output);
`;

type SourceManifest = { entries: Array<{ path: string; type: string; mode: number; sha256: string; blobSha: string | null }>; identity: string };

function parseManifest(raw: string): SourceManifest {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('manifest_too_large');
  const value = JSON.parse(raw) as SourceManifest;
  if (!value || !Array.isArray(value.entries) || value.entries.length > 5000 || !/^[a-f0-9]{64}$/.test(value.identity)) throw new Error('manifest_invalid');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.length > 512 || entry.path.startsWith('/') || entry.path.split('/').includes('..') || seen.has(entry.path) ||
      !['file', 'symlink'].includes(entry.type) || ![0, 644, 755].includes(entry.mode) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (entry.type === 'file' ? !entry.blobSha || !/^[a-f0-9]{40}$/.test(entry.blobSha) : entry.blobSha !== null)) throw new Error('manifest_invalid');
    seen.add(entry.path);
  }
  const identity = createHash('sha256').update(JSON.stringify(value.entries)).digest('hex');
  if (identity !== value.identity) throw new Error('manifest_invalid');
  return value;
}

function safeError(error: unknown): { phase: string; code: string; outcome: BaselineOutcome } {
  if (error instanceof ExecutionCancelled) return { phase: 'execution', code: 'cancelled', outcome: 'cancelled' };
  if (error instanceof ExecutionFailure) {
    const outcome: BaselineOutcome = error.kind === 'dependency_installation_failure' ? 'installation_failed'
      : error.kind === 'typecheck_failure' ? 'typecheck_failed'
      : error.kind === 'build_failure' ? 'build_failed'
      : error.kind === 'test_failure' ? 'test_failed'
      : error.kind === 'baseline_failure' ? 'baseline_failed'
      : error.kind === 'command_timeout' ? 'timed_out' : 'infrastructure_failed';
    return { phase: 'execution', code: error.message, outcome };
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return { phase: 'execution', code: 'overall_timeout', outcome: 'timed_out' };
  return { phase: 'execution', code: error instanceof APIError ? `provider_http_${error.response.status}` : 'operation_failed', outcome: 'infrastructure_failed' };
}

export async function runFrozenRepositoryBaseline(
  input: FrozenBaselineInput,
  cancellation?: AbortSignal,
  clock: () => Date = () => new Date(),
  observer?: SandboxLifecycleObserver,
): Promise<BaselineEvidence> {
  const boundary = new SandboxBoundary('vigilo-repository-baseline', INSTALL_POLICY, 600_000, observer);
  const typecheck = input.profile.typecheckScript ? commandEvidence(['--ignore-scripts', 'run', 'typecheck'], 90_000) : null;
  const build = input.profile.buildScript ? commandEvidence(['--ignore-scripts', 'run', 'build'], 180_000) : null;
  const report: BaselineEvidence = {
    evidenceVersion: BASELINE_EVIDENCE_VERSION,
    runId: input.runId,
    workspaceId: input.profile.workspaceId,
    githubRepositoryId: input.profile.githubRepositoryId,
    installationId: input.profile.installationId,
    profileIdentity: input.profile.profileIdentity,
    baseCommitSha: input.profile.baseCommitSha,
    archiveSha256: input.archiveSha256,
    sandbox: { name: boundary.evidence.name, sessionId: null, runtime: boundary.evidence.image, persistent: false },
    source: { materialized: false, identityBeforeExecution: null, identityAfterExecution: null, unchangedAfterExecution: null },
    credentialsExposure: 'not_checked',
    networkPolicyBeforeRepositoryExecution: 'unconfirmed',
    install: commandEvidence(INSTALL_ARGS, 180_000),
    typecheck,
    build,
    test: commandEvidence(['--ignore-scripts', 'test'], 180_000),
    executionOutcome: 'infrastructure_failed',
    overallOutcome: 'infrastructure_failed',
    cleanup: boundary.cleanup,
    error: null,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    durationMs: 0,
  };
  let phase = 'sandbox';
  try {
    await boundary.run(async (sandbox, signal) => {
      const execution = fixtureExecutor(sandbox, boundary, signal);
      const captureManifest = async (expected?: SourceManifest) => {
        const argument = expected ? Buffer.from(JSON.stringify(expected.entries), 'utf8').toString('base64') : undefined;
        const args = ['-e', MANIFEST_SCRIPT, ...(argument ? [argument] : [])];
        return parseManifest(await execution.trustedNode(args));
      };

      phase = 'runtime';
      requireNode24(await execution.trustedNode(['--version']));
      await sandbox.writeFiles([{ path: ARCHIVE_PATH, content: input.archive, mode: 0o600 }], { signal });
      await execution.trustedNode(['-e', SAFE_ARCHIVE_EXTRACTION_SCRIPT, JSON.stringify({
        archivePath: ARCHIVE_PATH,
        expectedCommitSha: input.profile.baseCommitSha,
        limits: ARCHIVE_LIMITS,
        root: ROOT,
      })], 60_000);
      phase = 'source_integrity';
      const initial = await captureManifest();
      const packageJson = initial.entries.find((entry) => entry.path === 'package.json' && entry.type === 'file');
      const packageLock = initial.entries.find((entry) => entry.path === 'package-lock.json' && entry.type === 'file');
      if (packageJson?.sha256 !== input.profile.packageJsonContentSha256 || packageJson.blobSha !== input.profile.packageJsonBlobSha ||
        packageLock?.sha256 !== input.profile.packageLockContentSha256 || packageLock.blobSha !== input.profile.packageLockBlobSha) {
        throw new ExecutionFailure('infrastructure_failure', 'source_profile_mismatch');
      }
      report.source.materialized = true;
      report.source.identityBeforeExecution = initial.identity;

      phase = 'install';
      await execution.npm(report.install, 'dependency_installation_failure');
      await execution.credentialsAbsent();
      phase = 'network_policy';
      await boundary.denyAll(signal);
      await execution.credentialsAbsent();
      report.credentialsExposure = 'absent';
      report.networkPolicyBeforeRepositoryExecution = 'deny-all';

      if (report.typecheck) {
        phase = 'typecheck';
        await execution.npm(report.typecheck, 'typecheck_failure');
      }
      if (report.build) {
        phase = 'build';
        await execution.npm(report.build, 'build_failure');
      }
      phase = 'test';
      await execution.npm(report.test, 'test_failure');

      phase = 'source_integrity_after_execution';
      const final = await captureManifest(initial);
      report.source.identityAfterExecution = final.identity;
      report.source.unchangedAfterExecution = final.identity === initial.identity;
      if (!report.source.unchangedAfterExecution) throw new ExecutionFailure('baseline_failure', 'source_mutated');
      report.executionOutcome = 'baseline_passed';
    }, cancellation);
  } catch (error) {
    const classified = safeError(error);
    report.executionOutcome = classified.outcome;
    report.error = { phase, code: classified.code };
  }
  report.sandbox.sessionId = boundary.evidence.sessionId;
  const cleanupConfirmed = boundary.cleanup.stop === 'confirmed' && boundary.cleanup.delete === 'confirmed' && boundary.cleanup.lookup === 'absent';
  report.overallOutcome = cleanupConfirmed ? report.executionOutcome : 'cleanup_failed';
  if (!cleanupConfirmed && report.error === null) report.error = { phase: 'cleanup', code: 'cleanup_unconfirmed' };
  report.completedAt = clock();
  report.durationMs = Math.max(0, report.completedAt.getTime() - report.startedAt.getTime());
  return report;
}
