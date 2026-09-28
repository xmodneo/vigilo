export type ExternalExecutionFailureCode =
  | 'execution_authority_missing'
  | 'execution_authority_expired'
  | 'execution_budget_exhausted'
  | 'external_concurrency_unavailable'
  | 'execution_authority_mismatch'
  | 'provider_attempt_ambiguous'
  | 'sandbox_cleanup_unresolved';

export type ExternalOperationCategory =
  | 'gemini_investigation'
  | 'gemini_candidate_generation'
  | 'sandbox_baseline'
  | 'sandbox_verification'
  | 'repair_loop_iteration'
  | 'release_acceptance_one_shot';

export type SandboxResourceClass = 'vcpu_1' | 'vcpu_2' | 'vcpu_4' | 'vcpu_8';

export interface ExternalExecutionScope {
  workspaceId: string;
  repairRunId?: string;
  githubRepositoryId?: number;
  baseCommitSha?: string;
  operationCategory: ExternalOperationCategory;
  providerId: string;
  modelId?: string;
  acceptancePurpose?: string;
}

export interface ExternalExecutionAmounts {
  logicalRequests: number;
  providerAttempts: number;
  inputTokens: number;
  outputTokens: number;
  sandboxIdentities: number;
  sandboxRuntimeMs: number;
  sandboxResourceClass?: SandboxResourceClass;
  verificationAttempts: number;
  repairLoopIterations: number;
}

export interface ExternalExecutionReservationRequest {
  scope: ExternalExecutionScope;
  amounts: ExternalExecutionAmounts;
  operationKey?: string;
  grantId?: string;
  accountGrantId?: string;
}

export type ProviderAttemptOutcome = 'succeeded' | 'failed' | 'ambiguous';

export interface ExternalExecutionPermit {
  readonly reservationId: string;
  readonly ownershipToken: string;
  readonly fence: number;
  readonly sandboxResourceClass: SandboxResourceClass | null;
  assertOwnership(): Promise<void>;
  beginProviderAttempt(): Promise<number>;
  finishProviderAttempt(ordinal: number, outcome: ProviderAttemptOutcome, usage?: { inputTokens?: number; outputTokens?: number }): Promise<void>;
  renew(): Promise<void>;
  complete(outcome: 'succeeded' | 'failed' | 'ambiguous', failureCode?: ExternalExecutionFailureCode): Promise<void>;
  meteredFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface ExternalExecutionAuthorizer {
  reserve(request: ExternalExecutionReservationRequest): Promise<ExternalExecutionPermit>;
}

export class ExternalExecutionAuthorityError extends Error {
  constructor(public readonly code: ExternalExecutionFailureCode) {
    super(code);
    this.name = 'ExternalExecutionAuthorityError';
  }
}

export const ZERO_EXTERNAL_EXECUTION_AUTHORITY: ExternalExecutionAuthorizer = Object.freeze({
  reserve: async () => {
    throw new ExternalExecutionAuthorityError('execution_authority_missing');
  },
});
