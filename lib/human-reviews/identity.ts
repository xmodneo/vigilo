import { canonicalRecord } from '../repair-loops/canonical.ts';

export const HUMAN_REVIEW_VERSION = 1 as const;

export type HumanReviewDecision = 'approved' | 'rejected';

export interface VerificationEvidenceIdentityInput {
  evidenceVersion: number;
  verificationId: string;
  attemptId: string;
  attemptVerificationId: string;
  attemptExpectedEvidenceId: string;
  attemptEvidenceId: string | null;
  attemptState: string;
  evidenceId: string;
  candidateId: string;
  candidateIdentity: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
  baselineId: string;
  candidateArtifactIntegrity: string;
  distinctSandboxConfirmed: boolean;
  pristineSourceIdentity: string | null;
  pristineBaseIntegrity: string;
  reconstructedSourceIdentity: string | null;
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
  sourceIdentityAfter: string | null;
  sourceIntegrityUnchanged: boolean | null;
  cleanupStop: string;
  cleanupDelete: string;
  cleanupLookup: string;
  executionOutcome: string;
  verificationContract: string;
  baselineComparison: string;
  repairObjectiveEvidence: string;
  errorPhase: string | null;
  errorCode: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface HumanReviewSubjectIdentityInput {
  version: typeof HUMAN_REVIEW_VERSION;
  workspaceId: string;
  repairRunId: string;
  repairLoopId: string;
  repairLoopIterationId: string;
  aiCandidateGenerationId: string;
  repairCandidateId: string;
  candidateIdentity: string;
  candidateVerificationId: string;
  verificationEvidenceId: string;
  githubRepositoryId: number;
  installationId: number;
  baselineId: string;
  baseCommitSha: string;
  profileIdentity: string;
  objectiveContractHash: string;
  objectiveEvidenceHash: string;
  verificationEvidenceIdentity: string;
}

export function computeVerificationEvidenceIdentity(input: VerificationEvidenceIdentityInput): string {
  return canonicalRecord({ version: 1, ...input }, 32 * 1024).hash;
}

export function computeHumanReviewSubjectIdentity(input: HumanReviewSubjectIdentityInput): string {
  return canonicalRecord(input, 8 * 1024).hash;
}

export function computeHumanReviewDecisionIdentity(input: {
  subjectIdentity: string;
  reviewerUserId: string;
  decision: HumanReviewDecision;
}): string {
  return canonicalRecord({
    version: HUMAN_REVIEW_VERSION,
    reviewSubjectIdentity: input.subjectIdentity,
    reviewerUserId: input.reviewerUserId,
    decision: input.decision,
  }, 4 * 1024).hash;
}
