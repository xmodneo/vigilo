import { APIError, type Sandbox } from '@vercel/sandbox';
import { createHash } from 'node:crypto';

import { commandEvidence, ExecutionFailure, fixtureExecutor, ROOT } from '../../src/fixture-execution.ts';
import { ExecutionCancelled, requireNode24, SandboxBoundary, type SandboxLifecycleObserver } from '../../src/sandbox-boundary.ts';
import { computeCandidateIdentity, sha256 } from '../repair-candidates/identity.ts';
import { candidatePath } from '../repair-candidates/policy.ts';
import type { FrozenCandidateFile } from '../repair-candidates/types.ts';
import {
  captureRepositoryManifest,
  materializeRepositoryArchive,
  REPOSITORY_INSTALL_ARGS,
  REPOSITORY_INSTALL_POLICY,
  type SourceManifest,
} from '../repository-baselines/runner.ts';
import { compareWithBaseline, verificationContractFor } from './classification.ts';
import type { CandidateVerificationEvidence, FrozenVerificationInput, VerificationExecutionOutcome } from './types.ts';

const APPLY_LAYOUT_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(ROOT)};
const prefix = root + path.sep;
const operations = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
for (const item of operations) {
  if (!item || typeof item.path !== 'string' || !['add','delete'].includes(item.operation)) throw new Error('invalid_candidate_operation');
  const target = path.resolve(root, item.path);
  if (!target.startsWith(prefix)) throw new Error('invalid_candidate_path');
  if (item.operation === 'add') {
    if (fs.existsSync(target)) throw new Error('candidate_add_conflict');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  } else {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('candidate_delete_invalid');
    fs.unlinkSync(target);
  }
}
`;

function blobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

export function expectedCandidateManifest(base: SourceManifest, files: FrozenCandidateFile[]): SourceManifest {
  const entries = new Map(base.entries.map((entry) => [entry.path, { ...entry }]));
  for (const file of files) {
    const path = candidatePath(file.path);
    const current = entries.get(path);
    if (file.operation === 'add') {
      if (current || base.entries.some((entry) => entry.path.startsWith(`${path}/`) || path.startsWith(`${entry.path}/`))) throw new Error('candidate_base_mismatch');
      const content = Buffer.from(file.resultingContent!, 'utf8');
      entries.set(path, { path, type: 'file', mode: 644, sha256: sha256(content), blobSha: blobSha(content) });
      continue;
    }
    if (!current || current.type !== 'file' || current.mode !== 644 || current.sha256 !== file.baseContentSha256 || current.blobSha !== file.baseBlobSha) throw new Error('candidate_base_mismatch');
    if (file.operation === 'delete') {
      entries.delete(path);
      continue;
    }
    const content = Buffer.from(file.resultingContent!, 'utf8');
    entries.set(path, { path, type: 'file', mode: 644, sha256: sha256(content), blobSha: blobSha(content) });
  }
  const sorted = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  return { entries: sorted, identity: sha256(JSON.stringify(sorted)) };
}

function manifestEquals(left: SourceManifest, right: SourceManifest): boolean {
  return left.identity === right.identity && JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

async function applyCandidate(sandbox: Sandbox, execution: ReturnType<typeof fixtureExecutor>, files: FrozenCandidateFile[], signal: AbortSignal): Promise<void> {
  const layout = files.filter((file) => file.operation !== 'modify').map((file) => ({ path: candidatePath(file.path), operation: file.operation }));
  if (layout.length) await execution.trustedNode(['-e', APPLY_LAYOUT_SCRIPT, Buffer.from(JSON.stringify(layout), 'utf8').toString('base64')]);
  const writes = files.filter((file) => file.operation !== 'delete').map((file) => ({
    path: `${ROOT}/${candidatePath(file.path)}`,
    content: Buffer.from(file.resultingContent!, 'utf8'),
    mode: 0o644,
  }));
  if (writes.length) await sandbox.writeFiles(writes, { signal });
}

function safeOutcome(error: unknown): { outcome: VerificationExecutionOutcome; code: string } {
  if (error instanceof ExecutionCancelled) return { outcome: 'cancelled', code: 'cancelled' };
  if (error instanceof ExecutionFailure) {
    if (error.kind === 'typecheck_failure') return { outcome: 'typecheck_failed', code: error.message };
    if (error.kind === 'build_failure') return { outcome: 'build_failed', code: error.message };
    if (error.kind === 'test_failure') return { outcome: 'test_failed', code: error.message };
    if (error.kind === 'dependency_installation_failure') return { outcome: 'installation_failed', code: error.message };
    if (error.kind === 'command_timeout') return { outcome: 'timed_out', code: error.message };
    return { outcome: 'infrastructure_failed', code: error.message };
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return { outcome: 'timed_out', code: 'overall_timeout' };
  return { outcome: 'infrastructure_failed', code: error instanceof APIError ? `provider_http_${error.response.status}` : 'verification_operation_failed' };
}

export async function runFrozenCandidateVerification(
  input: FrozenVerificationInput,
  cancellation?: AbortSignal,
  clock: () => Date = () => new Date(),
  observer?: SandboxLifecycleObserver,
): Promise<CandidateVerificationEvidence> {
  const boundary = new SandboxBoundary('vigilo-candidate-verifier', REPOSITORY_INSTALL_POLICY, 600_000, observer);
  const typecheck = input.profile.typecheckScript ? commandEvidence(['--ignore-scripts', 'run', input.profile.typecheckScript], 90_000) : null;
  const build = input.profile.buildScript ? commandEvidence(['--ignore-scripts', 'run', input.profile.buildScript], 180_000) : null;
  const report: CandidateVerificationEvidence = {
    evidenceVersion: 1, verificationId: input.verificationId, attemptId: input.attemptId, evidenceId: input.evidenceId,
    candidateId: input.candidateId, candidateIdentity: input.candidateIdentity, workspaceId: input.workspaceId,
    githubRepositoryId: input.githubRepositoryId, installationId: input.installationId, baseCommitSha: input.baseCommitSha,
    profileIdentity: input.profileIdentity, baselineId: input.baselineId, candidateArtifactIntegrity: 'valid',
    sandbox: { name: boundary.evidence.name, sessionId: null, runtime: boundary.evidence.image, persistent: false },
    distinctSandboxConfirmed: false, pristineSourceIdentity: null, pristineBaseIntegrity: 'not_checked',
    reconstructedSourceIdentity: null, candidateReconstruction: 'not_checked', credentialsExposure: 'not_checked',
    networkPolicyBeforeRepositoryExecution: 'unconfirmed', install: commandEvidence(REPOSITORY_INSTALL_ARGS, 180_000),
    typecheck, build, test: commandEvidence(['--ignore-scripts', input.profile.testScript], 180_000),
    sourceIdentityAfterExecution: null, sourceIntegrityUnchanged: null,
    cleanup: boundary.cleanup, executionOutcome: 'infrastructure_failed', verificationContract: 'infrastructure_failed',
    baselineComparison: 'not_comparable', repairObjectiveEvidence: 'not_measured', error: null,
    startedAt: input.startedAt, completedAt: input.startedAt, durationMs: 0,
  };
  let phase = 'sandbox';
  try {
    if (boundary.evidence.name === input.baselineSandbox.name) throw new Error('sandbox_not_fresh');
    const recomputed = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: input.githubRepositoryId, baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity, files: input.files });
    if (recomputed !== input.candidateIdentity) throw new Error('candidate_artifact_invalid');
    await boundary.run(async (sandbox, signal) => {
      const execution = fixtureExecutor(sandbox, boundary, signal);
      report.sandbox.sessionId = boundary.evidence.sessionId;
      report.distinctSandboxConfirmed = boundary.evidence.name !== input.baselineSandbox.name &&
        (!input.baselineSandbox.sessionId || boundary.evidence.sessionId !== input.baselineSandbox.sessionId);
      if (!report.distinctSandboxConfirmed) throw new Error('sandbox_not_fresh');
      phase = 'runtime';
      requireNode24(await execution.trustedNode(['--version']));
      phase = 'pristine_source';
      const pristine = await materializeRepositoryArchive(sandbox, execution, { archive: input.archive, baseCommitSha: input.baseCommitSha }, signal);
      const packageJson = pristine.entries.find((entry) => entry.path === 'package.json' && entry.type === 'file');
      const packageLock = pristine.entries.find((entry) => entry.path === 'package-lock.json' && entry.type === 'file');
      if (packageJson?.sha256 !== input.profile.packageJsonContentSha256 || packageJson.blobSha !== input.profile.packageJsonBlobSha ||
          packageLock?.sha256 !== input.profile.packageLockContentSha256 || packageLock.blobSha !== input.profile.packageLockBlobSha) throw new Error('source_profile_mismatch');
      const expected = expectedCandidateManifest(pristine, input.files);
      report.pristineSourceIdentity = pristine.identity;
      report.pristineBaseIntegrity = 'valid';
      phase = 'install';
      await execution.npm(report.install, 'dependency_installation_failure');
      await execution.credentialsAbsent();
      phase = 'network_policy';
      await boundary.denyAll(signal);
      await execution.credentialsAbsent();
      report.credentialsExposure = 'absent';
      report.networkPolicyBeforeRepositoryExecution = 'deny-all';
      phase = 'candidate_application';
      await applyCandidate(sandbox, execution, input.files, signal);
      const reconstructed = await captureRepositoryManifest(execution, pristine);
      report.reconstructedSourceIdentity = reconstructed.identity;
      report.candidateReconstruction = manifestEquals(reconstructed, expected) ? 'valid' : 'invalid';
      if (report.candidateReconstruction !== 'valid') throw new Error('candidate_reconstruction_mismatch');

      let checkFailure: { error: unknown; phase: string } | undefined;
      try {
        if (report.typecheck) { phase = 'typecheck'; await execution.npm(report.typecheck, 'typecheck_failure'); }
        if (report.build) { phase = 'build'; await execution.npm(report.build, 'build_failure'); }
        phase = 'test';
        await execution.npm(report.test, 'test_failure');
      } catch (error) { checkFailure = { error, phase }; }

      phase = 'source_integrity_after_execution';
      const after = await captureRepositoryManifest(execution, expected);
      report.sourceIdentityAfterExecution = after.identity;
      report.sourceIntegrityUnchanged = manifestEquals(after, expected);
      if (!report.sourceIntegrityUnchanged) throw new Error('candidate_source_mutated');
      if (checkFailure) {
        phase = checkFailure.phase;
        throw checkFailure.error;
      }
      report.executionOutcome = 'checks_passed';
    }, cancellation);
  } catch (error) {
    const classified = safeOutcome(error);
    report.executionOutcome = classified.outcome;
    report.error = { phase, code: classified.code };
    if (classified.code === 'candidate_artifact_invalid') report.candidateArtifactIntegrity = 'invalid';
    if (phase === 'pristine_source') report.pristineBaseIntegrity = 'invalid';
    if (phase === 'candidate_application') report.candidateReconstruction = 'invalid';
  }
  report.sandbox.sessionId = boundary.evidence.sessionId;
  const clean = boundary.cleanup.stop === 'confirmed' && boundary.cleanup.delete === 'confirmed' && boundary.cleanup.lookup === 'absent';
  if (!clean) {
    report.executionOutcome = 'cleanup_failed';
    if (!report.error) report.error = { phase: 'cleanup', code: 'cleanup_unconfirmed' };
  }
  report.verificationContract = verificationContractFor(report.executionOutcome);
  report.baselineComparison = compareWithBaseline({ baselineMatches: true, baselineOutcome: input.baselineOutcome, verificationContract: report.verificationContract });
  report.completedAt = clock();
  report.durationMs = Math.max(0, report.completedAt.getTime() - report.startedAt.getTime());
  return report;
}
