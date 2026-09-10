import type { CommandEvidence } from '../../src/fixture-execution.ts';
import type { FrozenCandidateFile } from '../repair-candidates/types.ts';
import type { FrozenBaselineProfile, GitHubBaselineGateway } from '../repository-baselines/types.ts';

export const CANDIDATE_VERIFICATION_VERSION = 1 as const;
export const CANDIDATE_VERIFICATION_STATES = ['created', 'queued', 'verifying', 'completed', 'infrastructure_failed', 'cancelled'] as const;
export type CandidateVerificationState = (typeof CANDIDATE_VERIFICATION_STATES)[number];
export type CandidateArtifactIntegrity = 'valid' | 'invalid';
export type VerificationContract = 'checks_passed' | 'checks_failed' | 'infrastructure_failed';
export type BaselineComparison = 'no_regression_detected' | 'regression_detected' | 'previous_baseline_failure_resolved' | 'previous_baseline_failure_still_present' | 'not_comparable';
export type VerificationExecutionOutcome = 'checks_passed' | 'typecheck_failed' | 'build_failed' | 'test_failed' | 'installation_failed' | 'timed_out' | 'cancelled' | 'infrastructure_failed' | 'cleanup_failed' | 'artifact_invalid';

export interface CandidateVerificationResult {
  id: string;
  candidateId: string;
  investigationId: string;
  repairRunId: string;
  baselineId: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
  candidateIdentity: string;
  formatVersion: 1;
  state: CandidateVerificationState;
  candidateArtifactIntegrity: CandidateArtifactIntegrity | null;
  verificationContract: VerificationContract | null;
  baselineComparison: BaselineComparison | null;
  repairObjectiveEvidence: 'not_measured';
  evidenceId: string | null;
  executionOutcome: VerificationExecutionOutcome | null;
  failingPhase: 'typecheck' | 'build' | 'test' | null;
  networkIsolation: 'confirmed' | 'unconfirmed';
  cleanup: 'confirmed' | 'unconfirmed';
  failureCode: string | null;
  createdAt: Date;
  queuedAt: Date;
  verificationStartedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface FrozenVerificationInput {
  verificationId: string;
  attemptId: string;
  evidenceId: string;
  candidateId: string;
  candidateIdentity: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
  baselineId: string;
  baselineSandbox: { name: string; sessionId: string | null };
  baselineOutcome: string;
  profile: FrozenBaselineProfile;
  files: FrozenCandidateFile[];
  archive: Buffer;
  archiveSha256: string;
  startedAt: Date;
}

export interface CandidateVerificationEvidence {
  evidenceVersion: 1;
  verificationId: string;
  attemptId: string;
  evidenceId: string;
  candidateId: string;
  candidateIdentity: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
  baselineId: string;
  candidateArtifactIntegrity: CandidateArtifactIntegrity;
  sandbox: { name: string; sessionId: string | null; runtime: string; persistent: false };
  distinctSandboxConfirmed: boolean;
  pristineSourceIdentity: string | null;
  pristineBaseIntegrity: 'valid' | 'invalid' | 'not_checked';
  reconstructedSourceIdentity: string | null;
  candidateReconstruction: 'valid' | 'invalid' | 'not_checked';
  credentialsExposure: 'absent' | 'present' | 'not_checked';
  networkPolicyBeforeRepositoryExecution: 'deny-all' | 'unconfirmed';
  install: CommandEvidence;
  typecheck: CommandEvidence | null;
  build: CommandEvidence | null;
  test: CommandEvidence;
  sourceIdentityAfterExecution: string | null;
  sourceIntegrityUnchanged: boolean | null;
  cleanup: { stop: string; delete: string; lookup: string };
  executionOutcome: VerificationExecutionOutcome;
  verificationContract: VerificationContract;
  baselineComparison: BaselineComparison;
  repairObjectiveEvidence: 'not_measured';
  error: { phase: string; code: string } | null;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

export type CandidateVerificationGateway = GitHubBaselineGateway;
