import type { RepairLoopIterationDecision, RepairLoopState } from './decision.ts';
import type { RepairLoopObjectiveEvidence } from './objective-contract.ts';

export const REPAIR_LOOP_PROTOCOL_VERSION = 1 as const;
export const REPAIR_LOOP_MAX_ITERATIONS = 2 as const;

export interface RepairLoopIterationResult {
  id: string;
  ordinal: number;
  aiCandidateGenerationId: string;
  candidateVerificationId: string | null;
  objectiveContractVersion: 'baseline_recovery_v1';
  objectiveContractHash: string;
  objectiveContractBytes: number;
  objectiveMeasurable: boolean;
  feedbackHash: string | null;
  feedbackBytes: number | null;
  objectiveEvidence: RepairLoopObjectiveEvidence | null;
  decision: RepairLoopIterationDecision | null;
  failureCode: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface RepairLoopResult {
  id: string;
  repairRunId: string;
  investigationId: string;
  aiInvestigationId: string;
  workspaceId: string;
  protocolVersion: 1;
  maxIterations: 2;
  state: RepairLoopState;
  selectedCandidateId: string | null;
  selectedVerificationId: string | null;
  selectedEvidenceId: string | null;
  failureClassification: string | null;
  failureCode: string | null;
  iterations: RepairLoopIterationResult[];
  createdAt: Date;
  completedAt: Date | null;
}
