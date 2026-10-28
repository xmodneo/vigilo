import { executionBudgetGrant } from '../../db/schema.ts';
import { AI_LIMITS } from '../ai-investigations/types.ts';
import { MAX_GEMINI_SERIALIZED_REQUEST_BYTES } from '../ai-investigations/request-budget.ts';
import { AI_CANDIDATE_GENERATION_LIMITS } from '../ai-candidate-generations/types.ts';
import { normalizeRepairObjective } from '../repair-runs/intent.ts';
import { canonicalRecord } from '../repair-loops/canonical.ts';
import { computeExecutionGrantIdentity } from './identity.ts';
import { googleProjectIdentity, vercelTeamProjectIdentity, type ProviderAccountIdentity } from './provider-account.ts';
import type { ExternalExecutionAmounts, ExternalOperationCategory } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_EXPIRY_MS = 4 * 60 * 60_000;
// The immutable checkpoint predates M7.7B and also holds historical plan hashes.
// A version tag within the 64-hex identity distinguishes this reviewed staging
// contract without reinterpreting (or migrating) earlier checkpoints.
export const REVIEWED_STAGING_PLAN_TAG = '77b00001';

export function isReviewedStagingPlanIdentity(identity: string): boolean {
  return identity.startsWith(REVIEWED_STAGING_PLAN_TAG) && HASH.test(identity);
}

export interface ReviewedStagingInput {
  kind: 'm77b_repair_v1';
  repairRunId: string;
  idempotencyKey: string;
  githubRepositoryId: number;
  installationId: number;
  profileIdentity: string;
  baseCommitSha: string;
  authorizedReleaseSha: string;
  objective: string;
  expectedSourceIdentity: string;
  expiresAt: string;
  providerAccounts: { googleProjectId: string; vercelTeamId: string; vercelProjectId: string };
}

export interface ReviewedStagingActor { workspaceId: string; reviewerUserId: string }

export type PlannedGrant = Omit<typeof executionBudgetGrant.$inferInsert, 'id' | 'createdAt'> & {
  grantIdentity: string;
  version: 2;
  scope: 'account' | 'operation';
};

type Limits = ExternalExecutionAmounts & { maxConcurrentExternalOperations: number };

const ZERO: Limits = {
  logicalRequests: 0, providerAttempts: 0, inputTokens: 0, outputTokens: 0,
  sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0,
  repairLoopIterations: 0, maxConcurrentExternalOperations: 0,
};

// Reviewed authority is pinned. Changes to protocol limits require a new
// explicit review; they must not silently enlarge grants at plan construction.
const INVESTIGATION_REQUESTS = 7;
const GENERATION_REQUESTS = 6;
const REVIEWED_REQUEST_BYTES = 256 * 1024;
const INVESTIGATION_INPUT_BYTES = INVESTIGATION_REQUESTS * REVIEWED_REQUEST_BYTES;
const GENERATION_INPUT_BYTES = GENERATION_REQUESTS * REVIEWED_REQUEST_BYTES;
const INVESTIGATION_OUTPUT_TOKENS = 17_500;
const GENERATION_OUTPUT_TOKENS = 36_000;

export const REVIEWED_ACCOUNT_LIMITS: Limits = Object.freeze({
  ...ZERO, logicalRequests: 16, providerAttempts: 205,
  inputTokens: INVESTIGATION_INPUT_BYTES + GENERATION_INPUT_BYTES,
  outputTokens: INVESTIGATION_OUTPUT_TOKENS + GENERATION_OUTPUT_TOKENS,
  sandboxIdentities: 2, sandboxRuntimeMs: 1_200_000,
  verificationAttempts: 1, repairLoopIterations: 1, maxConcurrentExternalOperations: 1,
});

const OPERATION_SPECS = Object.freeze([
  { category: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite', limits: { ...ZERO, logicalRequests: INVESTIGATION_REQUESTS, providerAttempts: INVESTIGATION_REQUESTS, inputTokens: INVESTIGATION_INPUT_BYTES, outputTokens: INVESTIGATION_OUTPUT_TOKENS } },
  { category: 'gemini_candidate_generation', providerId: 'google', modelId: 'gemini-3.1-flash-lite', limits: { ...ZERO, logicalRequests: GENERATION_REQUESTS, providerAttempts: GENERATION_REQUESTS, inputTokens: GENERATION_INPUT_BYTES, outputTokens: GENERATION_OUTPUT_TOKENS } },
  { category: 'sandbox_baseline', providerId: 'vercel', modelId: null, limits: { ...ZERO, logicalRequests: 1, providerAttempts: 96, sandboxIdentities: 1, sandboxRuntimeMs: 600_000, sandboxResourceClass: 'vcpu_1' as const } },
  { category: 'sandbox_verification', providerId: 'vercel', modelId: null, limits: { ...ZERO, logicalRequests: 1, providerAttempts: 96, sandboxIdentities: 1, sandboxRuntimeMs: 600_000, sandboxResourceClass: 'vcpu_1' as const, verificationAttempts: 1 } },
  { category: 'repair_loop_iteration', providerId: 'vigilo', modelId: null, limits: { ...ZERO, logicalRequests: 1, repairLoopIterations: 1 } },
] as const);

export const REVIEWED_OPERATION_CATEGORIES = Object.freeze(OPERATION_SPECS.map((spec) => spec.category));

/** Fail closed if a protocol or grant constant changes without the other. */
export function assertReviewedBudgetCompatibility(): void {
  const investigation = OPERATION_SPECS[0].limits;
  const generation = OPERATION_SPECS[1].limits;
  if (AI_LIMITS.maxToolBearingTurns + AI_LIMITS.reservedFinalizationTurns !== INVESTIGATION_REQUESTS ||
      AI_CANDIDATE_GENERATION_LIMITS.maxToolBearingTurns + AI_CANDIDATE_GENERATION_LIMITS.reservedFinalizationTurns !== GENERATION_REQUESTS ||
      AI_LIMITS.maxModelTurns !== INVESTIGATION_REQUESTS ||
      AI_CANDIDATE_GENERATION_LIMITS.maxModelTurns !== GENERATION_REQUESTS ||
      MAX_GEMINI_SERIALIZED_REQUEST_BYTES !== REVIEWED_REQUEST_BYTES ||
      INVESTIGATION_REQUESTS * AI_LIMITS.maxOutputTokens !== INVESTIGATION_OUTPUT_TOKENS ||
      GENERATION_REQUESTS * AI_CANDIDATE_GENERATION_LIMITS.maxOutputTokens !== GENERATION_OUTPUT_TOKENS ||
      investigation.logicalRequests !== INVESTIGATION_REQUESTS || investigation.providerAttempts !== INVESTIGATION_REQUESTS ||
      investigation.inputTokens !== INVESTIGATION_INPUT_BYTES || investigation.outputTokens !== INVESTIGATION_OUTPUT_TOKENS ||
      generation.logicalRequests !== GENERATION_REQUESTS || generation.providerAttempts !== GENERATION_REQUESTS ||
      generation.inputTokens !== GENERATION_INPUT_BYTES || generation.outputTokens !== GENERATION_OUTPUT_TOKENS) {
    throw new Error('reviewed_plan_budget_invalid');
  }
  for (const field of ['logicalRequests', 'providerAttempts', 'inputTokens', 'outputTokens',
    'sandboxIdentities', 'sandboxRuntimeMs', 'verificationAttempts', 'repairLoopIterations'] as const) {
    const total = OPERATION_SPECS.reduce((sum, spec) => sum + spec.limits[field], 0);
    if (REVIEWED_ACCOUNT_LIMITS[field] !== total) throw new Error('reviewed_plan_budget_invalid');
  }
  if (REVIEWED_ACCOUNT_LIMITS.maxConcurrentExternalOperations !== 1) throw new Error('reviewed_plan_budget_invalid');
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateInput(input: ReviewedStagingInput, now: Date): Date {
  if (!exactKeys(input, ['kind', 'repairRunId', 'idempotencyKey', 'githubRepositoryId', 'installationId',
    'profileIdentity', 'baseCommitSha', 'authorizedReleaseSha', 'objective', 'expectedSourceIdentity',
    'expiresAt', 'providerAccounts']) || input.kind !== 'm77b_repair_v1' || !UUID.test(input.repairRunId) ||
    !UUID.test(input.idempotencyKey) || !Number.isSafeInteger(input.githubRepositoryId) || input.githubRepositoryId <= 0 ||
    !Number.isSafeInteger(input.installationId) || input.installationId <= 0 || !HASH.test(input.profileIdentity) ||
    !SHA.test(input.baseCommitSha) || !SHA.test(input.authorizedReleaseSha) || !HASH.test(input.expectedSourceIdentity) ||
    !exactKeys(input.providerAccounts, ['googleProjectId', 'vercelTeamId', 'vercelProjectId'])) {
    throw new Error('reviewed_plan_invalid');
  }
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== input.expiresAt ||
    expiry.getTime() <= now.getTime() || expiry.getTime() - now.getTime() > MAX_EXPIRY_MS) {
    throw new Error('reviewed_plan_expiry_invalid');
  }
  return expiry;
}

function grantIdentity(grant: Omit<PlannedGrant, 'grantIdentity'>, limits: Limits): string {
  return computeExecutionGrantIdentity({
    version: 2, scope: grant.scope, workspaceId: grant.workspaceId ?? null,
    repairRunId: grant.repairRunId ?? null, githubRepositoryId: grant.githubRepositoryId ?? null,
    baseCommitSha: grant.baseCommitSha ?? null,
    operationCategory: (grant.operationCategory ?? null) as ExternalOperationCategory | null,
    providerId: grant.providerId ?? null, modelId: grant.modelId ?? null,
    acceptancePurpose: grant.acceptancePurpose ?? null, limits,
    expiresAt: grant.expiresAt.toISOString(), authorizedBy: grant.authorizedBy,
    authorizedReleaseSha: grant.authorizedReleaseSha ?? null,
    authorizedProviderAccountIdentity: grant.authorizedProviderAccountIdentity ?? null,
  });
}

function plannedGrant(grant: Omit<PlannedGrant, 'grantIdentity'>, limits: Limits): PlannedGrant {
  return { ...grant, grantIdentity: grantIdentity(grant, limits) };
}

export interface ReviewedPlanIdentityFacts {
  workspaceId: string;
  reviewerUserId: string;
  repairRunId: string;
  idempotencyKey: string;
  githubRepositoryId: number;
  installationId: number;
  profileIdentity: string;
  baseCommitSha: string;
  authorizedReleaseSha: string;
  objectiveHash: string;
  expectedSourceIdentity: string;
  expiresAt: string;
  accountGrantIdentity: string;
  operationGrantIdentities: readonly string[];
}

export function computeReviewedPlanIdentity(facts: ReviewedPlanIdentityFacts): string {
  if (facts.operationGrantIdentities.length !== 5 || new Set(facts.operationGrantIdentities).size !== 5 ||
    !facts.operationGrantIdentities.every((identity) => HASH.test(identity))) throw new Error('reviewed_plan_invalid');
  const digest = canonicalRecord({
    kind: 'm77b_repair_v1', version: 1,
    workspaceId: facts.workspaceId, reviewerUserId: facts.reviewerUserId,
    repairRunId: facts.repairRunId, idempotencyKey: facts.idempotencyKey,
    githubRepositoryId: facts.githubRepositoryId, installationId: facts.installationId,
    profileIdentity: facts.profileIdentity, baseCommitSha: facts.baseCommitSha,
    authorizedReleaseSha: facts.authorizedReleaseSha, objectiveHash: facts.objectiveHash,
    expectedSourceIdentity: facts.expectedSourceIdentity, expiresAt: facts.expiresAt,
    accountGrantIdentity: facts.accountGrantIdentity,
    operationGrantIdentities: [...facts.operationGrantIdentities].sort(),
  }, 16 * 1024).hash;
  return REVIEWED_STAGING_PLAN_TAG + digest.slice(REVIEWED_STAGING_PLAN_TAG.length);
}

export function buildReviewedStagingPlan(actor: ReviewedStagingActor, input: ReviewedStagingInput, now = new Date()) {
  assertReviewedBudgetCompatibility();
  const expiry = validateInput(input, now);
  if (!actor.workspaceId || !actor.reviewerUserId) throw new Error('reviewed_plan_invalid');
  const objective = normalizeRepairObjective(input.objective);
  const google = googleProjectIdentity(input.providerAccounts.googleProjectId);
  const vercel = vercelTeamProjectIdentity(input.providerAccounts.vercelTeamId, input.providerAccounts.vercelProjectId);
  const base = { version: 2 as const, expiresAt: expiry, authorizedBy: actor.reviewerUserId };
  const accountGrant = plannedGrant({
    ...base, scope: 'account', workspaceId: null, repairRunId: null, githubRepositoryId: null,
    baseCommitSha: null, operationCategory: null, providerId: null, modelId: null,
    acceptancePurpose: null, authorizedReleaseSha: null, authorizedProviderAccountIdentity: null,
    maxLogicalRequests: REVIEWED_ACCOUNT_LIMITS.logicalRequests,
    maxProviderAttempts: REVIEWED_ACCOUNT_LIMITS.providerAttempts,
    maxInputTokens: REVIEWED_ACCOUNT_LIMITS.inputTokens,
    maxOutputTokens: REVIEWED_ACCOUNT_LIMITS.outputTokens,
    maxSandboxIdentities: REVIEWED_ACCOUNT_LIMITS.sandboxIdentities,
    maxSandboxRuntimeMs: REVIEWED_ACCOUNT_LIMITS.sandboxRuntimeMs,
    sandboxResourceClass: null,
    maxVerificationAttempts: REVIEWED_ACCOUNT_LIMITS.verificationAttempts,
    maxRepairLoopIterations: REVIEWED_ACCOUNT_LIMITS.repairLoopIterations,
    maxConcurrentExternalOperations: REVIEWED_ACCOUNT_LIMITS.maxConcurrentExternalOperations,
  }, REVIEWED_ACCOUNT_LIMITS);
  const operationGrants = OPERATION_SPECS.map((spec) => {
    const limits: Limits = spec.limits;
    const providerAccount: ProviderAccountIdentity | null = spec.providerId === 'google' ? google : spec.providerId === 'vercel' ? vercel : null;
    return plannedGrant({
      ...base, scope: 'operation', workspaceId: actor.workspaceId, repairRunId: input.repairRunId,
      githubRepositoryId: input.githubRepositoryId, baseCommitSha: input.baseCommitSha,
      operationCategory: spec.category, providerId: spec.providerId, modelId: spec.modelId,
      acceptancePurpose: null, authorizedReleaseSha: input.authorizedReleaseSha,
      authorizedProviderAccountIdentity: providerAccount,
      maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts,
      maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
      maxSandboxIdentities: limits.sandboxIdentities, maxSandboxRuntimeMs: limits.sandboxRuntimeMs,
      sandboxResourceClass: limits.sandboxResourceClass ?? null,
      maxVerificationAttempts: limits.verificationAttempts, maxRepairLoopIterations: limits.repairLoopIterations,
      maxConcurrentExternalOperations: 0,
    }, limits);
  });
  const planIdentity = computeReviewedPlanIdentity({
    workspaceId: actor.workspaceId, reviewerUserId: actor.reviewerUserId,
    repairRunId: input.repairRunId, idempotencyKey: input.idempotencyKey,
    githubRepositoryId: input.githubRepositoryId, installationId: input.installationId,
    profileIdentity: input.profileIdentity, baseCommitSha: input.baseCommitSha,
    authorizedReleaseSha: input.authorizedReleaseSha, objectiveHash: objective.objectiveHash,
    expectedSourceIdentity: input.expectedSourceIdentity, expiresAt: expiry.toISOString(),
    accountGrantIdentity: accountGrant.grantIdentity,
    operationGrantIdentities: operationGrants.map((grant) => grant.grantIdentity),
  });
  return { objective, accountGrant, operationGrants, planIdentity, expiresAt: expiry };
}
