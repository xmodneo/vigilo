import { canonicalRecord } from './canonical.ts';

export const BASELINE_RECOVERY_CONTRACT_VERSION = 'baseline_recovery_v1' as const;
export const REPAIR_LOOP_OBJECTIVE_EVIDENCE = ['satisfied', 'failed', 'not_measured'] as const;

export type BaselineRecoveryCheck = 'typecheck' | 'build' | 'test';
export type RepairLoopObjectiveEvidence = (typeof REPAIR_LOOP_OBJECTIVE_EVIDENCE)[number];

type PhaseFacts = {
  status: string | null;
  exitCode: number | null;
  timedOut: boolean | null;
};

type BaselineAuthority = {
  id: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  evidenceVersion: number;
  profileIdentity: string;
  baseCommitSha: string;
  sourceIdentityBefore: string | null;
  sourceIdentityAfter: string | null;
  sourceUnchanged: boolean | null;
  credentialsExposure: string;
  networkPolicy: string;
  installStatus: string;
  installExitCode: number | null;
  installTimedOut: boolean;
  typecheckStatus: string | null;
  typecheckExitCode: number | null;
  typecheckTimedOut: boolean | null;
  buildStatus: string | null;
  buildExitCode: number | null;
  buildTimedOut: boolean | null;
  testStatus: string;
  testExitCode: number | null;
  testTimedOut: boolean;
  executionOutcome: string;
  overallOutcome: string;
  cleanupStop: string;
  cleanupDelete: string;
  cleanupLookup: string;
};

type ProfileAuthority = {
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  profileIdentity: string | null;
  baseCommitSha: string;
  status: string;
  typecheckScript: string | null;
  buildScript: string | null;
  testScript: string | null;
};

export interface BaselineRecoveryContract {
  version: typeof BASELINE_RECOVERY_CONTRACT_VERSION;
  repairRunId: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baselineId: string;
  profileIdentity: string;
  baseCommitSha: string;
  requiredChecks: BaselineRecoveryCheck[];
  baselineFailures: Partial<Record<BaselineRecoveryCheck, PhaseFacts>>;
  measurable: boolean;
  canonicalSnapshot: string;
  hash: string;
  bytes: number;
}

export interface BaselineRecoveryEvidence {
  id: string;
  verificationId: string;
  candidateId: string;
  candidateIdentity: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baselineId: string;
  profileIdentity: string;
  baseCommitSha: string;
  evidenceVersion: number;
  candidateArtifactIntegrity: string;
  distinctSandboxConfirmed: boolean;
  pristineBaseIntegrity: string;
  candidateReconstruction: string;
  credentialsExposure: string;
  networkPolicy: string;
  installStatus: string;
  installExitCode: number | null;
  installTimedOut: boolean;
  typecheckStatus: string | null;
  typecheckExitCode: number | null;
  typecheckTimedOut: boolean | null;
  buildStatus: string | null;
  buildExitCode: number | null;
  buildTimedOut: boolean | null;
  testStatus: string;
  testExitCode: number | null;
  testTimedOut: boolean;
  reconstructedSourceIdentity: string | null;
  sourceIdentityAfter: string | null;
  sourceIntegrityUnchanged: boolean | null;
  cleanupStop: string;
  cleanupDelete: string;
  cleanupLookup: string;
  verificationContract: string;
  baselineComparison: string;
  executionOutcome: string;
}

export interface ExactVerificationBinding {
  verificationId: string;
  candidateId: string;
  candidateIdentity: string;
  evidenceId: string;
}

export interface BaselineRecoveryContractAuthority {
  repairRunId: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baselineId: string;
  profileIdentity: string;
  baseCommitSha: string;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateStoredBaselineRecoveryContract(
  value: unknown,
  hash: string,
  bytes: number,
  authority: BaselineRecoveryContractAuthority,
): BaselineRecoveryContract {
  const canonical = canonicalRecord(value, 16 * 1024);
  const record = canonical.snapshot;
  const keys = ['version', 'repairRunId', 'workspaceId', 'githubRepositoryId', 'installationId', 'baselineId', 'profileIdentity', 'baseCommitSha', 'requiredChecks', 'baselineFailures', 'measurable'];
  if (canonical.hash !== hash || canonical.bytes !== bytes || !exactRecord(record, keys) || record.version !== BASELINE_RECOVERY_CONTRACT_VERSION ||
      record.repairRunId !== authority.repairRunId || record.workspaceId !== authority.workspaceId || record.githubRepositoryId !== authority.githubRepositoryId ||
      record.installationId !== authority.installationId || record.baselineId !== authority.baselineId || record.profileIdentity !== authority.profileIdentity ||
      record.baseCommitSha !== authority.baseCommitSha || !Array.isArray(record.requiredChecks) || !exactRecord(record.baselineFailures, record.requiredChecks as string[]) ||
      record.measurable !== (record.requiredChecks.length > 0)) throw new Error('objective_contract_invalid');
  const allowed: BaselineRecoveryCheck[] = ['typecheck', 'build', 'test'];
  const checks = record.requiredChecks;
  let previousIndex = -1;
  for (const check of checks) {
    const checkIndex = allowed.indexOf(check as BaselineRecoveryCheck);
    if (checkIndex <= previousIndex) throw new Error('objective_contract_invalid');
    previousIndex = checkIndex;
    const facts = record.baselineFailures[check as string];
    if (!exactRecord(facts, ['status', 'exitCode', 'timedOut']) || facts.status !== 'failed' || !Number.isSafeInteger(facts.exitCode) || Number(facts.exitCode) === 0 || facts.timedOut !== false) throw new Error('objective_contract_invalid');
  }
  return { ...(record as unknown as Omit<BaselineRecoveryContract, 'canonicalSnapshot' | 'hash' | 'bytes'>), canonicalSnapshot: canonical.canonical, hash: canonical.hash, bytes: canonical.bytes };
}

function failedPhase(status: string | null, exitCode: number | null, timedOut: boolean | null): boolean {
  return status === 'failed' && exitCode !== null && exitCode !== 0 && timedOut === false;
}

function baselineIsTrustworthy(baseline: BaselineAuthority, profile: ProfileAuthority): boolean {
  const customerFailure = ['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed'].includes(baseline.overallOutcome);
  return baseline.evidenceVersion === 1 && customerFailure && baseline.executionOutcome === baseline.overallOutcome &&
    baseline.workspaceId === profile.workspaceId && baseline.githubRepositoryId === profile.githubRepositoryId &&
    baseline.installationId === profile.installationId && baseline.profileIdentity === profile.profileIdentity &&
    baseline.baseCommitSha === profile.baseCommitSha && profile.status === 'ready' && profile.testScript === 'test' &&
    baseline.sourceIdentityBefore !== null && baseline.sourceIdentityBefore === baseline.sourceIdentityAfter && baseline.sourceUnchanged === true &&
    baseline.credentialsExposure === 'absent' && baseline.networkPolicy === 'deny-all' &&
    baseline.installStatus === 'completed' && baseline.installExitCode === 0 && !baseline.installTimedOut &&
    baseline.cleanupStop === 'confirmed' && baseline.cleanupDelete === 'confirmed' && baseline.cleanupLookup === 'absent';
}

export function deriveBaselineRecoveryContract(input: {
  repairRunId: string;
  baseline: BaselineAuthority;
  profile: ProfileAuthority;
}): BaselineRecoveryContract {
  const requiredChecks: BaselineRecoveryCheck[] = [];
  const baselineFailures: Partial<Record<BaselineRecoveryCheck, PhaseFacts>> = {};
  if (baselineIsTrustworthy(input.baseline, input.profile)) {
    const phases: Array<[BaselineRecoveryCheck, boolean, PhaseFacts]> = [
      ['typecheck', input.profile.typecheckScript === 'typecheck', { status: input.baseline.typecheckStatus, exitCode: input.baseline.typecheckExitCode, timedOut: input.baseline.typecheckTimedOut }],
      ['build', input.profile.buildScript === 'build', { status: input.baseline.buildStatus, exitCode: input.baseline.buildExitCode, timedOut: input.baseline.buildTimedOut }],
      ['test', input.profile.testScript === 'test', { status: input.baseline.testStatus, exitCode: input.baseline.testExitCode, timedOut: input.baseline.testTimedOut }],
    ];
    for (const [name, required, facts] of phases) {
      if (required && failedPhase(facts.status, facts.exitCode, facts.timedOut)) {
        requiredChecks.push(name);
        baselineFailures[name] = facts;
      }
    }
  }
  const snapshot = {
    version: BASELINE_RECOVERY_CONTRACT_VERSION,
    repairRunId: input.repairRunId,
    workspaceId: input.baseline.workspaceId,
    githubRepositoryId: input.baseline.githubRepositoryId,
    installationId: input.baseline.installationId,
    baselineId: input.baseline.id,
    profileIdentity: input.baseline.profileIdentity,
    baseCommitSha: input.baseline.baseCommitSha,
    requiredChecks,
    baselineFailures,
    measurable: requiredChecks.length > 0,
  };
  const canonical = canonicalRecord(snapshot, 16 * 1024);
  return { ...snapshot, canonicalSnapshot: canonical.canonical, hash: canonical.hash, bytes: canonical.bytes };
}

export function isTrustworthyBaselineRecoveryEvidence(contract: BaselineRecoveryContract, evidence: BaselineRecoveryEvidence): boolean {
  return evidence.evidenceVersion === 1 && evidence.workspaceId === contract.workspaceId &&
    evidence.githubRepositoryId === contract.githubRepositoryId && evidence.installationId === contract.installationId &&
    evidence.baselineId === contract.baselineId && evidence.profileIdentity === contract.profileIdentity &&
    evidence.baseCommitSha === contract.baseCommitSha && evidence.candidateArtifactIntegrity === 'valid' &&
    evidence.distinctSandboxConfirmed && evidence.pristineBaseIntegrity === 'valid' && evidence.candidateReconstruction === 'valid' &&
    evidence.credentialsExposure === 'absent' && evidence.networkPolicy === 'deny-all' &&
    evidence.installStatus === 'completed' && evidence.installExitCode === 0 && !evidence.installTimedOut &&
    evidence.reconstructedSourceIdentity !== null && evidence.reconstructedSourceIdentity === evidence.sourceIdentityAfter &&
    evidence.sourceIntegrityUnchanged === true && evidence.cleanupStop === 'confirmed' &&
    evidence.cleanupDelete === 'confirmed' && evidence.cleanupLookup === 'absent' &&
    ['checks_passed', 'checks_failed'].includes(evidence.verificationContract);
}

function evidencePhase(evidence: BaselineRecoveryEvidence, check: BaselineRecoveryCheck): PhaseFacts {
  if (check === 'typecheck') return { status: evidence.typecheckStatus, exitCode: evidence.typecheckExitCode, timedOut: evidence.typecheckTimedOut };
  if (check === 'build') return { status: evidence.buildStatus, exitCode: evidence.buildExitCode, timedOut: evidence.buildTimedOut };
  return { status: evidence.testStatus, exitCode: evidence.testExitCode, timedOut: evidence.testTimedOut };
}

export function evaluateBaselineRecovery(
  contract: BaselineRecoveryContract,
  evidence: BaselineRecoveryEvidence,
  exact?: ExactVerificationBinding,
): { result: RepairLoopObjectiveEvidence; evaluatedChecks: BaselineRecoveryCheck[] } {
  if (!contract.measurable || contract.requiredChecks.length === 0 || !isTrustworthyBaselineRecoveryEvidence(contract, evidence) ||
      (exact !== undefined && (evidence.verificationId !== exact.verificationId || evidence.candidateId !== exact.candidateId ||
        evidence.candidateIdentity !== exact.candidateIdentity || evidence.id !== exact.evidenceId))) {
    return { result: 'not_measured', evaluatedChecks: [] };
  }
  let failed = false;
  for (const check of contract.requiredChecks) {
    const phase = evidencePhase(evidence, check);
    if (phase.status === 'completed' && phase.exitCode === 0 && phase.timedOut === false) continue;
    if (failedPhase(phase.status, phase.exitCode, phase.timedOut)) {
      failed = true;
      continue;
    }
    return { result: 'not_measured', evaluatedChecks: [] };
  }
  return { result: failed ? 'failed' : 'satisfied', evaluatedChecks: [...contract.requiredChecks] };
}
