import { and, eq, gt, inArray } from 'drizzle-orm';

import {
  executionBudgetGrant,
  executionBudgetGrantRevocation,
  externalExecutionLease,
  externalExecutionReservation,
  externalExecutionSemaphore,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { ExecutionAvailabilityStatus } from '../presentation/policy.ts';
import { executionGrantIdentityMatches } from './identity.ts';

export interface ExecutionAvailabilityResult {
  status: ExecutionAvailabilityStatus;
}

type Grant = typeof executionBudgetGrant.$inferSelect;
type Usage = {
  logicalRequests: number;
  providerAttempts: number;
  inputTokens: number;
  outputTokens: number;
  sandboxIdentities: number;
  sandboxRuntimeMs: number;
  verificationAttempts: number;
  repairLoopIterations: number;
};

const emptyUsage = (): Usage => ({
  logicalRequests: 0,
  providerAttempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  sandboxIdentities: 0,
  sandboxRuntimeMs: 0,
  verificationAttempts: 0,
  repairLoopIterations: 0,
});

function addReservation(usage: Usage, row: typeof externalExecutionReservation.$inferSelect): void {
  usage.logicalRequests += row.reservedLogicalRequests;
  usage.providerAttempts += row.reservedProviderAttempts;
  usage.inputTokens += row.reservedInputTokens;
  usage.outputTokens += row.reservedOutputTokens;
  usage.sandboxIdentities += row.reservedSandboxIdentities;
  usage.sandboxRuntimeMs += row.reservedSandboxRuntimeMs;
  usage.verificationAttempts += row.reservedVerificationAttempts;
  usage.repairLoopIterations += row.reservedRepairLoopIterations;
}

function hasUsefulCapacity(grant: Grant, used: Usage): boolean {
  if (used.logicalRequests >= grant.maxLogicalRequests) return false;
  if (grant.operationCategory?.startsWith('gemini_')) {
    return used.providerAttempts < grant.maxProviderAttempts
      && used.inputTokens < grant.maxInputTokens
      && used.outputTokens < grant.maxOutputTokens;
  }
  if (grant.operationCategory === 'sandbox_baseline') {
    return used.providerAttempts < grant.maxProviderAttempts
      && used.sandboxIdentities < grant.maxSandboxIdentities
      && used.sandboxRuntimeMs < grant.maxSandboxRuntimeMs;
  }
  if (grant.operationCategory === 'sandbox_verification') {
    return used.providerAttempts < grant.maxProviderAttempts
      && used.sandboxIdentities < grant.maxSandboxIdentities
      && used.sandboxRuntimeMs < grant.maxSandboxRuntimeMs
      && used.verificationAttempts < grant.maxVerificationAttempts;
  }
  if (grant.operationCategory === 'repair_loop_iteration') {
    return used.repairLoopIterations < grant.maxRepairLoopIterations;
  }
  return true;
}

function duplicateOperationScope(grants: Grant[]): boolean {
  const scopes = new Set<string>();
  for (const grant of grants) {
    const key = JSON.stringify([
      grant.scope, grant.workspaceId, grant.repairRunId, grant.githubRepositoryId,
      grant.baseCommitSha, grant.operationCategory, grant.providerId, grant.modelId,
      grant.acceptancePurpose, grant.sandboxResourceClass,
    ]);
    if (scopes.has(key)) return true;
    scopes.add(key);
  }
  return false;
}

/**
 * A read-only hint for UI rendering. It never reserves authority; every real
 * external operation must still pass DurableExternalExecutionAuthorizer.
 */
export async function resolveExecutionAvailability(
  database: VigiloDatabase,
  workspaceId: string,
  options: { clock?: () => Date; operationalReady?: boolean } = {},
): Promise<ExecutionAvailabilityResult> {
  const now = (options.clock ?? (() => new Date()))();
  try {
    const [semaphore] = await database.select({ id: externalExecutionSemaphore.id }).from(externalExecutionSemaphore)
      .where(eq(externalExecutionSemaphore.id, 'global')).limit(1);
    if (!semaphore) return { status: 'operational_unavailable' };

    const grants = await database.select().from(executionBudgetGrant);
    const ids = grants.map((grant) => grant.id);
    const revocations = ids.length === 0 ? [] : await database.select({ grantId: executionBudgetGrantRevocation.grantId })
      .from(executionBudgetGrantRevocation).where(inArray(executionBudgetGrantRevocation.grantId, ids));
    const revoked = new Set(revocations.map((row) => row.grantId));
    const unrevoked = grants.filter((grant) => !revoked.has(grant.id));
    const accountCandidates = unrevoked.filter((grant) => grant.scope === 'account');
    // Release-acceptance one-shot authority is independently governed and must
    // never advertise general provider-backed workflow actions as available.
    const operationCandidates = unrevoked.filter((grant) => grant.scope === 'operation' && grant.workspaceId === workspaceId);

    if (accountCandidates.length === 0 || operationCandidates.length === 0) return { status: 'no_authority' };
    if (accountCandidates.some((grant) => grant.expiresAt <= now) || operationCandidates.every((grant) => grant.expiresAt <= now)) {
      return { status: 'invalid_or_expired' };
    }
    const accounts = accountCandidates.filter((grant) => grant.expiresAt > now);
    const operations = operationCandidates.filter((grant) => grant.expiresAt > now);
    if (accounts.length !== 1 || operations.length === 0 || duplicateOperationScope(operations)
      || !executionGrantIdentityMatches(accounts[0]!) || operations.some((grant) => !executionGrantIdentityMatches(grant))) {
      return { status: 'invalid_or_expired' };
    }

    const reservations = await database.select().from(externalExecutionReservation);
    const accountUsage = emptyUsage();
    for (const row of reservations) if (row.accountGrantId === accounts[0]!.id) addReservation(accountUsage, row);
    const operationsWithCapacity = operations.filter((grant) => {
      const operationUsage = emptyUsage();
      for (const row of reservations) if (row.grantId === grant.id) addReservation(operationUsage, row);
      return hasUsefulCapacity(grant, operationUsage) && hasUsefulCapacity({ ...accounts[0]!, operationCategory: grant.operationCategory }, accountUsage);
    });
    if (operationsWithCapacity.length === 0) return { status: 'exhausted' };

    const activeLeases = await database.select({ reservationId: externalExecutionLease.reservationId })
      .from(externalExecutionLease)
      .where(and(eq(externalExecutionLease.state, 'active'), gt(externalExecutionLease.leaseExpiresAt, now)));
    if (activeLeases.length >= accounts[0]!.maxConcurrentExternalOperations) return { status: 'capacity_unavailable' };
    if (options.operationalReady === false) return { status: 'operational_unavailable' };
    if (options.operationalReady !== true) return { status: 'unknown' };
    return { status: 'available' };
  } catch {
    return { status: 'unknown' };
  }
}
