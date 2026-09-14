import type { CandidateOperation } from '../repair-candidates/types.ts';

export const AI_CANDIDATE_GENERATION_PROTOCOL_VERSION = 3 as const;
export const AI_CANDIDATE_GENERATION_LIMITS = Object.freeze({
  maxModelTurns: 7,
  maxToolBearingTurns: 5,
  reservedFinalizationTurns: 1,
  maxToolCalls: 5,
  maxContextResultBytes: 128 * 1024,
  maxOutputTokens: 6_000,
  maxChangedFiles: 4,
  maxTotalResultBytes: 128 * 1024,
  timeoutMs: 180_000,
  perTool: Object.freeze({ listPaths: 1, readTextFile: 4, searchText: 2, readBaselineSummary: 1 }),
});

export type AiCandidateGenerationState = 'created' | 'queued' | 'generating' | 'frozen' | 'abstained' | 'failed' | 'cancelled';
export type AiCandidateGenerationCompletionReason = 'proposal_ready' | 'insufficient_evidence';

export interface AiCandidateGenerationResult {
  id: string;
  aiInvestigationId: string;
  executionOrdinal: number;
  investigationId: string;
  repairRunId: string;
  state: AiCandidateGenerationState;
  revision: string;
  providerId: string;
  modelId: string;
  protocolVersion: number;
  repairCandidateId: string | null;
  completionReason: AiCandidateGenerationCompletionReason | null;
  usage: { inputTokens: number; outputTokens: number; toolCallCount: number; modelTurnCount: number };
  failureCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AiCandidateProposal {
  files: Array<{
    path: string;
    operation: CandidateOperation;
    expectedBaseIdentity: string | null;
    resultingContent: string | null;
  }>;
}

export interface AiCandidateProposalIntent {
  files: Array<{
    path: string;
    operation: CandidateOperation;
    resultingContent: string | null;
  }>;
}

export type AiCandidateProposalParseResult =
  | { status: 'proposal_ready'; proposal: AiCandidateProposalIntent }
  | { status: 'insufficient_evidence' };

export type AiCandidateGenerationModelResult =
  | { status: 'proposal_ready'; proposal: AiCandidateProposal }
  | { status: 'insufficient_evidence' };
