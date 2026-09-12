export const AI_INVESTIGATION_PROTOCOL_VERSION = 1 as const;
export const AI_PROVIDER_ID = 'google';
export const AI_MODEL_ID = 'gemini-3.1-flash-lite';

export const AI_LIMITS = Object.freeze({
  maxModelTurns: 8,
  maxToolBearingTurns: 6,
  reservedFinalizationTurns: 1,
  maxToolCalls: 20,
  maxContextResultBytes: 128 * 1024,
  maxOutputTokens: 2_500,
  timeoutMs: 180_000,
  perTool: Object.freeze({ listPaths: 2, readTextFile: 10, searchText: 5, readBaselineSummary: 2 }),
});

export type AiInvestigationState = 'created' | 'queued' | 'investigating' | 'completed' | 'failed' | 'cancelled';
export type ConclusionStatus = 'diagnosis_found' | 'insufficient_evidence' | 'objective_not_reproduced';
export type Confidence = 'low' | 'medium' | 'high';
export type EvidenceKind = 'baseline' | 'file' | 'search';
export type ToolName = 'listPaths' | 'readTextFile' | 'searchText' | 'readBaselineSummary';
export type ModelProviderFailureCode =
  | 'provider_rate_limited'
  | 'provider_quota_exhausted'
  | 'provider_infrastructure_failed'
  | 'provider_configuration_failed';

export class ModelProviderError extends Error {
  constructor(public readonly code: ModelProviderFailureCode, public readonly retryAfterMs: number | null = null) {
    super(code);
    this.name = 'ModelProviderError';
  }
}

export interface InvestigationConclusion {
  status: ConclusionStatus;
  summary: string;
  suspectedFiles: Array<{ path: string; reason: string }>;
  evidence: Array<{ kind: EvidenceKind; reference: string }>;
  proposedApproach: string;
  confidence: Confidence;
}

export interface ModelToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ModelTurn {
  toolCalls: ModelToolCall[];
  conclusion: unknown | null;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface InvestigationModelSession {
  next(input: { toolOutputs?: Array<{ callId: string; output: string }>; finalization?: boolean; signal: AbortSignal }): Promise<ModelTurn>;
}

export interface InvestigationModelProvider {
  readonly providerId: string;
  readonly modelId: string;
  createSession(input: {
    instructions: string;
    initialInput: string;
    tools: readonly ModelToolDefinition[];
    conclusionSchema: Record<string, unknown>;
    maxOutputTokens: number;
  }): InvestigationModelSession;
}

export interface AiInvestigationResult {
  id: string;
  investigationId: string;
  executionOrdinal: number;
  repairRunId: string;
  state: AiInvestigationState;
  revision: string;
  providerId: string;
  modelId: string;
  protocolVersion: number;
  completionReason: 'model_conclusion' | 'budget_exhausted' | null;
  conclusion: InvestigationConclusion | null;
  usage: { inputTokens: number; outputTokens: number; toolCallCount: number; modelTurnCount: number };
  failureCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
