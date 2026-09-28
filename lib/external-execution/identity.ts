import { canonicalRecord } from '../repair-loops/canonical.ts';
import { executionBudgetGrant, externalExecutionReservation } from '../../db/schema.ts';
import type { ExternalExecutionAmounts, ExternalExecutionScope } from './types.ts';

export function computeExecutionGrantIdentity(input: {
  version: 1;
  scope: 'account' | 'operation' | 'one_shot';
  workspaceId: string | null;
  repairRunId: string | null;
  githubRepositoryId: number | null;
  baseCommitSha: string | null;
  operationCategory: ExternalExecutionScope['operationCategory'] | null;
  providerId: string | null;
  modelId: string | null;
  acceptancePurpose: string | null;
  limits: ExternalExecutionAmounts & { maxConcurrentExternalOperations: number };
  expiresAt: string;
  authorizedBy: string;
}): string {
  return canonicalRecord(input, 16 * 1024).hash;
}

export function computeExecutionReservationIdentity(input: {
  version: 1;
  grantId: string;
  accountGrantId: string;
  scope: ExternalExecutionScope;
  amounts: ExternalExecutionAmounts;
  operationKey: string;
  fence: number;
}): string {
  return canonicalRecord(input, 16 * 1024).hash;
}

export function computeReleaseAcceptanceIdentity(input: Record<string, unknown>): string {
  return canonicalRecord({ version: 1, ...input }, 32 * 1024).hash;
}

export function executionGrantIdentityMatches(grant: typeof executionBudgetGrant.$inferSelect): boolean {
  return grant.grantIdentity === computeExecutionGrantIdentity({
    version: 1,
    scope: grant.scope as 'account' | 'operation' | 'one_shot',
    workspaceId: grant.workspaceId,
    repairRunId: grant.repairRunId,
    githubRepositoryId: grant.githubRepositoryId,
    baseCommitSha: grant.baseCommitSha,
    operationCategory: grant.operationCategory as ExternalExecutionScope['operationCategory'] | null,
    providerId: grant.providerId,
    modelId: grant.modelId,
    acceptancePurpose: grant.acceptancePurpose,
    limits: {
      logicalRequests: grant.maxLogicalRequests,
      providerAttempts: grant.maxProviderAttempts,
      inputTokens: grant.maxInputTokens,
      outputTokens: grant.maxOutputTokens,
      sandboxIdentities: grant.maxSandboxIdentities,
      sandboxRuntimeMs: grant.maxSandboxRuntimeMs,
      ...(grant.sandboxResourceClass ? { sandboxResourceClass: grant.sandboxResourceClass as NonNullable<ExternalExecutionAmounts['sandboxResourceClass']> } : {}),
      verificationAttempts: grant.maxVerificationAttempts,
      repairLoopIterations: grant.maxRepairLoopIterations,
      maxConcurrentExternalOperations: grant.maxConcurrentExternalOperations,
    },
    expiresAt: grant.expiresAt.toISOString(),
    authorizedBy: grant.authorizedBy,
  });
}

export function executionReservationIdentityMatches(reservation: typeof externalExecutionReservation.$inferSelect): boolean {
  return reservation.reservationIdentity === computeExecutionReservationIdentity({
    version: 1,
    grantId: reservation.grantId,
    accountGrantId: reservation.accountGrantId,
    scope: {
      workspaceId: reservation.workspaceId,
      ...(reservation.repairRunId ? { repairRunId: reservation.repairRunId } : {}),
      ...(reservation.githubRepositoryId !== null ? { githubRepositoryId: reservation.githubRepositoryId } : {}),
      ...(reservation.baseCommitSha ? { baseCommitSha: reservation.baseCommitSha } : {}),
      operationCategory: reservation.operationCategory as ExternalExecutionScope['operationCategory'],
      providerId: reservation.providerId,
      ...(reservation.modelId ? { modelId: reservation.modelId } : {}),
      ...(reservation.acceptancePurpose ? { acceptancePurpose: reservation.acceptancePurpose } : {}),
    },
    amounts: {
      logicalRequests: reservation.reservedLogicalRequests,
      providerAttempts: reservation.reservedProviderAttempts,
      inputTokens: reservation.reservedInputTokens,
      outputTokens: reservation.reservedOutputTokens,
      sandboxIdentities: reservation.reservedSandboxIdentities,
      sandboxRuntimeMs: reservation.reservedSandboxRuntimeMs,
      ...(reservation.sandboxResourceClass ? { sandboxResourceClass: reservation.sandboxResourceClass as NonNullable<ExternalExecutionAmounts['sandboxResourceClass']> } : {}),
      verificationAttempts: reservation.reservedVerificationAttempts,
      repairLoopIterations: reservation.reservedRepairLoopIterations,
    },
    operationKey: reservation.operationKey,
    fence: reservation.fence,
  });
}
