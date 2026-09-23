import type { FrozenCandidateFile } from '../repair-candidates/types.ts';
import type { HumanReviewDecision } from './identity.ts';

export const TASK_4_3_LIVE_ACCEPTANCE_STATUSES = ['pending', 'passed', 'revoked', 'failed'] as const;
export type Task43LiveAcceptanceStatus = (typeof TASK_4_3_LIVE_ACCEPTANCE_STATUSES)[number];
export const TASK_4_3_LIVE_ACCEPTANCE_STATUS = 'pending' as const satisfies Task43LiveAcceptanceStatus;

export type HumanReviewIneligibleReason =
  | 'repair_loop_not_verified'
  | 'objective_not_measured'
  | 'candidate_invalid'
  | 'verification_not_passed'
  | 'evidence_invalid'
  | 'authority_mismatch'
  | 'active_conflict';

export interface HumanReviewDecisionResult {
  id: string;
  decision: HumanReviewDecision;
  reviewerUserId: string;
  decisionIdentity: string;
  createdAt: Date;
}

export interface HumanReviewSubject {
  authority: {
    workspaceId: string;
    repairRunId: string;
    repairLoopId: string;
    repairLoopIterationId: string;
    aiCandidateGenerationId: string;
    githubRepositoryId: number;
    installationId: number;
    baselineId: string;
    baseCommitSha: string;
    profileIdentity: string;
  };
  candidate: {
    id: string;
    identity: string;
    files: FrozenCandidateFile[];
  };
  verification: {
    id: string;
    evidenceId: string;
    state: string;
    verificationContract: string;
    baselineComparison: string;
    executionOutcome: string;
    networkIsolation: 'confirmed';
    cleanup: 'confirmed';
    phases: {
      install: { status: string; exitCode: number | null; timedOut: boolean };
      typecheck: { status: string | null; exitCode: number | null; timedOut: boolean | null };
      build: { status: string | null; exitCode: number | null; timedOut: boolean | null };
      test: { status: string; exitCode: number | null; timedOut: boolean };
    };
  };
  objective: {
    contractVersion: string;
    contractHash: string;
    evidenceHash: string;
    measurable: true;
    result: 'satisfied';
    evaluatedChecks: string[];
  };
}

export interface HumanReviewHistoryItem {
  kind: 'repair_loop_iteration' | 'ai_candidate_generation_attempt' | 'candidate_verification_attempt';
  id: string;
  state: string;
  ordinal: number;
  createdAt: Date;
  failureCode: string | null;
}

export interface HumanReviewResult {
  repairRunId: string;
  status: 'ineligible' | 'awaiting_decision' | 'decided';
  ineligibleReason: HumanReviewIneligibleReason | null;
  reviewSubjectIdentity: string | null;
  liveAcceptanceStatus: Task43LiveAcceptanceStatus;
  subject: HumanReviewSubject | null;
  decision: HumanReviewDecisionResult | null;
  history: { items: HumanReviewHistoryItem[]; truncated: boolean };
}

export interface ApprovedHumanReviewAuthority {
  humanReviewDecisionId: string;
  humanReviewDecisionIdentity: string;
  repairRunId: string;
  repairLoopId: string;
  repairLoopIterationId: string;
  aiCandidateGenerationId: string;
  repairCandidateId: string;
  candidateIdentity: string;
  candidateVerificationId: string;
  verificationEvidenceId: string;
  verificationEvidenceIdentity: string;
  reviewSubjectIdentity: string;
  workspaceId: string;
  reviewerUserId: string;
  githubRepositoryId: number;
  installationId: number;
  baselineId: string;
  baseCommitSha: string;
  profileIdentity: string;
  objectiveContractHash: string;
  objectiveEvidenceHash: string;
}
