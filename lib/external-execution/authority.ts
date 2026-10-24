import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';

import {
  executionBudgetGrant,
  executionBudgetGrantRevocation,
  externalExecutionEvent,
  externalExecutionLease,
  externalExecutionReservation,
  externalExecutionSemaphore,
  repairRunAttempt, repairRun, candidateVerificationAttempt, candidateVerification,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { computeExecutionReservationIdentity, executionGrantIdentityMatches } from './identity.ts';
import { accountIdentityMatches, canonicalProviderAccountIdentity, vercelTeamProjectIdentity } from './provider-account.ts';
import { SandboxTransportError } from './sandbox-auth.ts';
import { assertRunBusinessAllowed, lockExternalExecution } from './business-fence.ts';
import { freshDatabaseTime } from './database-clock.ts';
import { SandboxTransportPolicy, type SandboxTransportBinding, type SandboxTransportKind } from './sandbox-transport.ts';
import { assertMatchedSourceCheckpoint } from './source-checkpoint.ts';
import { assertReviewedPlanIntegrity } from './reviewed-plan-integrity.ts';
import {
  ExternalExecutionAuthorityError,
  type ExternalExecutionAuthorizer,
  type ExternalExecutionFailureCode,
  type ExternalExecutionPermit,
  type ExternalExecutionReservationRequest,
  type ProviderAttemptOutcome,
} from './types.ts';

const DEFAULT_LEASE_MS = 15 * 60_000;

function databaseFailure(error: unknown): ExternalExecutionAuthorityError {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  const text = messages.join('\n');
  const codes: ExternalExecutionFailureCode[] = [
    'execution_authority_missing', 'execution_authority_expired', 'execution_budget_exhausted',
    'external_concurrency_unavailable', 'execution_authority_mismatch',
  ];
  return new ExternalExecutionAuthorityError(codes.find((code) => text.includes(code)) ?? 'execution_authority_mismatch');
}

async function authorityOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ExternalExecutionAuthorityError) throw error;
    throw databaseFailure(error);
  }
}

function exactOptional<T>(actual: T | null, expected: T | undefined): boolean {
  return actual === (expected ?? null);
}

function terminalEvent(outcome: ProviderAttemptOutcome): 'attempt_succeeded' | 'attempt_failed' | 'attempt_ambiguous' {
  return outcome === 'succeeded' ? 'attempt_succeeded' : outcome === 'failed' ? 'attempt_failed' : 'attempt_ambiguous';
}

export class DurableExternalExecutionAuthorizer implements ExternalExecutionAuthorizer {
  constructor(
    private readonly database: VigiloDatabase,
    private readonly options: { clock?: () => Date; randomId?: () => string; leaseMs?: number; fetch?: typeof fetch; runtimeReleaseSha?: string;
      afterPostLockValidation?: () => Promise<void> } = {},
  ) {}

  async reserve(request: ExternalExecutionReservationRequest): Promise<ExternalExecutionPermit> {
    const clock = this.options.clock ?? (() => new Date());
    const randomId = this.options.randomId ?? randomUUID;
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    try {
      const stored = await this.database.transaction(async (transaction) => {
        await lockExternalExecution(transaction);
        const [semaphore] = await transaction.select().from(externalExecutionSemaphore)
          .where(eq(externalExecutionSemaphore.id, 'global')).limit(1);
        if (!semaphore) throw new ExternalExecutionAuthorityError('execution_authority_missing');
        const grants = await transaction.select().from(executionBudgetGrant)
          .orderBy(asc(executionBudgetGrant.id)).for('update');
        // Global and grant locks are both held before taking authority time.
        const now = await freshDatabaseTime(transaction);

        let binding: SandboxTransportBinding | undefined = request.sandbox;
        if (request.cleanup) {
          const { kind, attemptId } = request.cleanup;
          if (!binding || !request.scope.repairRunId || request.amounts.sandboxIdentities !== 0
            || request.amounts.verificationAttempts !== 0 || request.amounts.repairLoopIterations !== 0
            || request.amounts.inputTokens !== 0 || request.amounts.outputTokens !== 0
            || request.scope.operationCategory !== (kind === 'baseline' ? 'sandbox_baseline' : 'sandbox_verification')) {
            throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
          }
          const rows = kind === 'baseline'
            ? await transaction.select({ name: repairRunAttempt.sandboxName, sessionId: repairRunAttempt.sandboxSessionId, workspaceId: repairRun.workspaceId, repairRunId: repairRun.id, githubRepositoryId: repairRun.githubRepositoryId, baseCommitSha: repairRun.baseCommitSha })
              .from(repairRunAttempt).innerJoin(repairRun, eq(repairRunAttempt.repairRunId, repairRun.id)).where(eq(repairRunAttempt.id, attemptId))
            : await transaction.select({ name: candidateVerificationAttempt.sandboxName, sessionId: candidateVerificationAttempt.sandboxSessionId, workspaceId: candidateVerification.workspaceId, repairRunId: candidateVerification.repairRunId, githubRepositoryId: candidateVerification.githubRepositoryId, baseCommitSha: candidateVerification.baseCommitSha })
              .from(candidateVerificationAttempt).innerJoin(candidateVerification, eq(candidateVerificationAttempt.verificationId, candidateVerification.id)).where(eq(candidateVerificationAttempt.id, attemptId));
          const row = rows[0];
          if (!row?.name || row.name !== binding.name || row.workspaceId !== request.scope.workspaceId || row.repairRunId !== request.scope.repairRunId
            || row.githubRepositoryId !== request.scope.githubRepositoryId || row.baseCommitSha !== request.scope.baseCommitSha) {
            throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
          }
          binding = { ...binding, sessionId: row.sessionId };
        } else {
          await assertRunBusinessAllowed(transaction, request.scope, now);
          if (request.scope.repairRunId)
            await assertReviewedPlanIntegrity(transaction, request.scope.repairRunId, this.options.runtimeReleaseSha ?? '', now);
          if (request.scope.repairRunId && request.scope.operationCategory.startsWith('gemini_'))
            await assertMatchedSourceCheckpoint(transaction, request.scope.repairRunId);
        }

        const candidateIds = grants.map((grant) => grant.id);
        const revocations = candidateIds.length === 0 ? [] : await transaction.select({ grantId: executionBudgetGrantRevocation.grantId })
          .from(executionBudgetGrantRevocation).where(inArray(executionBudgetGrantRevocation.grantId, candidateIds));
        const revoked = new Set(revocations.map((value) => value.grantId));
        const unrevoked = grants.filter((grant) => !revoked.has(grant.id));
        const active = unrevoked.filter((grant) => grant.expiresAt > now);
        const accounts = active.filter((grant) => grant.scope === 'account' && (!request.accountGrantId || grant.id === request.accountGrantId));
        if (accounts.length !== 1) {
          const expiredAccount = unrevoked.some((grant) => grant.scope === 'account' && (!request.accountGrantId || grant.id === request.accountGrantId));
          throw new ExternalExecutionAuthorityError(accounts.length === 0 ? (expiredAccount ? 'execution_authority_expired' : 'execution_authority_missing') : 'execution_authority_mismatch');
        }
        const operationCandidates = unrevoked.filter((grant) =>
          ['operation', 'one_shot'].includes(grant.scope) && (!request.grantId || grant.id === request.grantId));
        const operations = active.filter((grant) =>
          ['operation', 'one_shot'].includes(grant.scope)
          && (!request.grantId || grant.id === request.grantId)
          && grant.workspaceId === request.scope.workspaceId
          && exactOptional(grant.repairRunId, request.scope.repairRunId)
          && exactOptional(grant.githubRepositoryId, request.scope.githubRepositoryId)
          && exactOptional(grant.baseCommitSha, request.scope.baseCommitSha)
          && grant.operationCategory === request.scope.operationCategory
          && grant.providerId === request.scope.providerId
          && exactOptional(grant.modelId, request.scope.modelId)
          && exactOptional(grant.acceptancePurpose, request.scope.acceptancePurpose)
          && exactOptional(grant.sandboxResourceClass, request.amounts.sandboxResourceClass));
        if (operations.length !== 1) {
          const expiredOperation = unrevoked.some((grant) => ['operation', 'one_shot'].includes(grant.scope)
            && (!request.grantId || grant.id === request.grantId)
            && grant.workspaceId === request.scope.workspaceId
            && exactOptional(grant.repairRunId, request.scope.repairRunId)
            && exactOptional(grant.githubRepositoryId, request.scope.githubRepositoryId)
            && exactOptional(grant.baseCommitSha, request.scope.baseCommitSha)
            && grant.operationCategory === request.scope.operationCategory
            && grant.providerId === request.scope.providerId
            && exactOptional(grant.modelId, request.scope.modelId)
            && exactOptional(grant.acceptancePurpose, request.scope.acceptancePurpose)
            && exactOptional(grant.sandboxResourceClass, request.amounts.sandboxResourceClass)
            && grant.expiresAt <= now);
          throw new ExternalExecutionAuthorityError(operations.length === 0
            ? (expiredOperation ? 'execution_authority_expired' : operationCandidates.length > 0 ? 'execution_authority_mismatch' : 'execution_authority_missing')
            : 'execution_authority_mismatch');
        }
        const account = accounts[0]!;
        const grant = operations[0]!;
        if (!executionGrantIdentityMatches(account) || !executionGrantIdentityMatches(grant)) {
          throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        }
        const runtimeReleaseSha = this.options.runtimeReleaseSha;
        const providerAccountIdentity = request.scope.providerId === 'vigilo' ? null : request.providerAccountIdentity ?? null;
        if (!runtimeReleaseSha || !/^[0-9a-f]{40}$/.test(runtimeReleaseSha) || grant.version !== 2 ||
            grant.authorizedReleaseSha !== runtimeReleaseSha ||
            !accountIdentityMatches(request.scope.providerId, providerAccountIdentity) ||
            !accountIdentityMatches(request.scope.providerId, grant.authorizedProviderAccountIdentity) ||
            (providerAccountIdentity === null ? grant.authorizedProviderAccountIdentity !== null :
              canonicalProviderAccountIdentity(providerAccountIdentity) !== canonicalProviderAccountIdentity(grant.authorizedProviderAccountIdentity))) {
          throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        }
        if ((request.scope.providerId === 'vercel' || request.scope.providerId === 'vercel-sandbox') &&
            (!request.sandbox || canonicalProviderAccountIdentity(providerAccountIdentity) !==
              canonicalProviderAccountIdentity(vercelTeamProjectIdentity(request.sandbox.teamId, request.sandbox.projectId)))) {
          throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        }

        const [used] = await transaction.select({
          logicalRequests: sql<number>`coalesce(sum(${externalExecutionReservation.reservedLogicalRequests}),0)::int`,
          providerAttempts: sql<number>`coalesce(sum(${externalExecutionReservation.reservedProviderAttempts}),0)::int`,
          inputTokens: sql<number>`coalesce(sum(${externalExecutionReservation.reservedInputTokens}),0)::int`,
          outputTokens: sql<number>`coalesce(sum(${externalExecutionReservation.reservedOutputTokens}),0)::int`,
          sandboxIdentities: sql<number>`coalesce(sum(${externalExecutionReservation.reservedSandboxIdentities}),0)::int`,
          sandboxRuntimeMs: sql<number>`coalesce(sum(${externalExecutionReservation.reservedSandboxRuntimeMs}),0)::int`,
          verificationAttempts: sql<number>`coalesce(sum(${externalExecutionReservation.reservedVerificationAttempts}),0)::int`,
          repairLoopIterations: sql<number>`coalesce(sum(${externalExecutionReservation.reservedRepairLoopIterations}),0)::int`,
        }).from(externalExecutionReservation).where(eq(externalExecutionReservation.grantId, grant.id));
        const [accountUsed] = await transaction.select({
          logicalRequests: sql<number>`coalesce(sum(${externalExecutionReservation.reservedLogicalRequests}),0)::int`,
          providerAttempts: sql<number>`coalesce(sum(${externalExecutionReservation.reservedProviderAttempts}),0)::int`,
          inputTokens: sql<number>`coalesce(sum(${externalExecutionReservation.reservedInputTokens}),0)::int`,
          outputTokens: sql<number>`coalesce(sum(${externalExecutionReservation.reservedOutputTokens}),0)::int`,
          sandboxIdentities: sql<number>`coalesce(sum(${externalExecutionReservation.reservedSandboxIdentities}),0)::int`,
          sandboxRuntimeMs: sql<number>`coalesce(sum(${externalExecutionReservation.reservedSandboxRuntimeMs}),0)::int`,
          verificationAttempts: sql<number>`coalesce(sum(${externalExecutionReservation.reservedVerificationAttempts}),0)::int`,
          repairLoopIterations: sql<number>`coalesce(sum(${externalExecutionReservation.reservedRepairLoopIterations}),0)::int`,
        }).from(externalExecutionReservation).where(eq(externalExecutionReservation.accountGrantId, account.id));
        const exhausted = !used || !accountUsed
          || used.logicalRequests + request.amounts.logicalRequests > grant.maxLogicalRequests
          || used.providerAttempts + request.amounts.providerAttempts > grant.maxProviderAttempts
          || used.inputTokens + request.amounts.inputTokens > grant.maxInputTokens
          || used.outputTokens + request.amounts.outputTokens > grant.maxOutputTokens
          || used.sandboxIdentities + request.amounts.sandboxIdentities > grant.maxSandboxIdentities
          || used.sandboxRuntimeMs + request.amounts.sandboxRuntimeMs > grant.maxSandboxRuntimeMs
          || used.verificationAttempts + request.amounts.verificationAttempts > grant.maxVerificationAttempts
          || used.repairLoopIterations + request.amounts.repairLoopIterations > grant.maxRepairLoopIterations
          || accountUsed.logicalRequests + request.amounts.logicalRequests > account.maxLogicalRequests
          || accountUsed.providerAttempts + request.amounts.providerAttempts > account.maxProviderAttempts
          || accountUsed.inputTokens + request.amounts.inputTokens > account.maxInputTokens
          || accountUsed.outputTokens + request.amounts.outputTokens > account.maxOutputTokens
          || accountUsed.sandboxIdentities + request.amounts.sandboxIdentities > account.maxSandboxIdentities
          || accountUsed.sandboxRuntimeMs + request.amounts.sandboxRuntimeMs > account.maxSandboxRuntimeMs
          || accountUsed.verificationAttempts + request.amounts.verificationAttempts > account.maxVerificationAttempts
          || accountUsed.repairLoopIterations + request.amounts.repairLoopIterations > account.maxRepairLoopIterations;
        if (exhausted) throw new ExternalExecutionAuthorityError('execution_budget_exhausted');

        const expired = await transaction.update(externalExecutionLease).set({
          state: 'expired', completedAt: now, failureCode: 'execution_authority_expired',
        }).where(and(eq(externalExecutionLease.state, 'active'), lte(externalExecutionLease.leaseExpiresAt, now)))
          .returning({ reservationId: externalExecutionLease.reservationId });
        for (const lease of expired) await transaction.insert(externalExecutionEvent).values({
          id: randomId(), reservationId: lease.reservationId, eventType: 'expired',
          failureCode: 'execution_authority_expired', createdAt: now,
        });
        const [countRow] = await transaction.select({ count: sql<number>`count(*)::int` }).from(externalExecutionLease)
          .where(and(eq(externalExecutionLease.state, 'active'), gt(externalExecutionLease.leaseExpiresAt, now)));
        const count = countRow?.count ?? 0;
        if (count >= account.maxConcurrentExternalOperations) throw new ExternalExecutionAuthorityError('external_concurrency_unavailable');

        const fence = semaphore.nextFence + 1;
        await transaction.update(externalExecutionSemaphore).set({ nextFence: fence, updatedAt: now })
          .where(eq(externalExecutionSemaphore.id, 'global'));
        await this.options.afterPostLockValidation?.();
        const id = randomId();
        const operationKey = request.operationKey ?? randomId();
        const ownershipToken = randomId();
        const reservationIdentity = computeExecutionReservationIdentity({
          version: 2, grantId: grant.id, accountGrantId: account.id, scope: request.scope,
          amounts: request.amounts, operationKey, fence,
          executingReleaseSha: runtimeReleaseSha, executingProviderAccountIdentity: providerAccountIdentity,
        });
        const [reservation] = await transaction.insert(externalExecutionReservation).values({
          id, version: 2, grantId: grant.id, accountGrantId: account.id,
          workspaceId: request.scope.workspaceId, repairRunId: request.scope.repairRunId ?? null,
          githubRepositoryId: request.scope.githubRepositoryId ?? null, baseCommitSha: request.scope.baseCommitSha ?? null,
          operationCategory: request.scope.operationCategory, providerId: request.scope.providerId,
          modelId: request.scope.modelId ?? null, acceptancePurpose: request.scope.acceptancePurpose ?? null,
          executingReleaseSha: runtimeReleaseSha, executingProviderAccountIdentity: providerAccountIdentity,
          operationKey, reservedLogicalRequests: request.amounts.logicalRequests,
          reservedProviderAttempts: request.amounts.providerAttempts, reservedInputTokens: request.amounts.inputTokens,
          reservedOutputTokens: request.amounts.outputTokens, reservedSandboxIdentities: request.amounts.sandboxIdentities,
          reservedSandboxRuntimeMs: request.amounts.sandboxRuntimeMs,
          sandboxResourceClass: request.amounts.sandboxResourceClass ?? null,
          reservedVerificationAttempts: request.amounts.verificationAttempts,
          reservedRepairLoopIterations: request.amounts.repairLoopIterations,
          // The existing INSERT trigger compares NEW.created_at with both
          // locked grants. Database time here is the atomic final expiry guard.
          fence, reservationIdentity, createdAt: sql`clock_timestamp()`,
        }).returning();
        if (!reservation) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        const reservationTime = reservation.createdAt;
        await transaction.insert(externalExecutionLease).values({
          reservationId: id, ownershipToken, fence, state: 'active', heartbeatAt: reservationTime,
          leaseExpiresAt: new Date(Math.min(reservationTime.getTime() + leaseMs, grant.expiresAt.getTime(), account.expiresAt.getTime())),
        });
        await transaction.insert(externalExecutionEvent).values({ id: randomId(), reservationId: id, eventType: 'reserved', createdAt: reservationTime });
        return { reservation, ownershipToken, binding };
      });
      return this.permit(stored.reservation, stored.ownershipToken, clock, randomId, leaseMs, stored.binding, request.cleanup !== undefined);
    } catch (error) {
      if (error instanceof ExternalExecutionAuthorityError) throw error;
      throw databaseFailure(error);
    }
  }

  private permit(
    reservation: typeof externalExecutionReservation.$inferSelect,
    ownershipToken: string,
    clock: () => Date,
    randomId: () => string,
    leaseMs: number,
    binding: SandboxTransportBinding | undefined,
    recovery: boolean,
  ): ExternalExecutionPermit {
    const database = this.database;
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    const sandbox = reservation.operationCategory === 'sandbox_baseline' || reservation.operationCategory === 'sandbox_verification';
    const policy = sandbox && binding ? new SandboxTransportPolicy(binding, recovery, {
      runtimeMs: reservation.reservedSandboxRuntimeMs, vcpus: Number(reservation.sandboxResourceClass?.slice('vcpu_'.length)),
    }) : undefined;
    // The global fence and both grant rows are locked before protected writes.
    // Repeat time-sensitive checks at the write itself: a lease can expire while
    // a transaction waits for its row lock, even after an earlier valid read.
    const liveGrants = sql`exists (
      select 1 from execution_budget_grant operation_grant
      join execution_budget_grant account_grant on account_grant.id = ${reservation.accountGrantId}
      where operation_grant.id = ${reservation.grantId}
        and operation_grant.version = 2
        and operation_grant.authorized_release_sha = ${reservation.executingReleaseSha}
        and operation_grant.expires_at > clock_timestamp()
        and account_grant.expires_at > clock_timestamp()
        and not exists (select 1 from execution_budget_grant_revocation revocation
          where revocation.grant_id in (${reservation.grantId}, ${reservation.accountGrantId}))
    )`;
    const insertActiveEvent = async (transaction: VigiloDatabase,
      eventType: 'attempt_started' | 'attempt_succeeded' | 'lease_renewed', ordinal: number | null = null,
      usage: { inputTokens?: number; outputTokens?: number } = {}) => {
      const inserted = await transaction.execute(sql`
        insert into external_execution_event (id, reservation_id, event_type, attempt_ordinal, input_tokens, output_tokens, created_at)
        select ${randomId()}, ${reservation.id}, ${eventType}, ${ordinal}, ${usage.inputTokens ?? null}, ${usage.outputTokens ?? null}, clock_timestamp()
        from external_execution_lease lease
        where lease.reservation_id = ${reservation.id}
          and lease.ownership_token = ${ownershipToken} and lease.fence = ${reservation.fence}
          and lease.state = 'active' and lease.lease_expires_at > clock_timestamp()
          and ${liveGrants}
        returning id
      `);
      const rows = (inserted as unknown as { rows?: { id: string }[] }).rows ?? inserted as unknown as { id: string }[];
      if (rows.length !== 1) throw new ExternalExecutionAuthorityError('execution_authority_expired');
    };
    const owned = async (transaction: VigiloDatabase, options: { lock?: boolean; requireFresh?: boolean; requireGrant?: boolean } = {}) => {
      const { lock = false, requireFresh = true, requireGrant = true } = options;
      let query = transaction.select({ id: externalExecutionLease.reservationId }).from(externalExecutionLease).where(and(
        eq(externalExecutionLease.reservationId, reservation.id), eq(externalExecutionLease.ownershipToken, ownershipToken),
        eq(externalExecutionLease.fence, reservation.fence), eq(externalExecutionLease.state, 'active'),
        ...(requireFresh ? [sql`${externalExecutionLease.leaseExpiresAt} > clock_timestamp()`] : []),
        ...(requireGrant ? [liveGrants] : []),
      ));
      if (requireGrant) {
        let grantQuery = transaction.select().from(executionBudgetGrant)
          .where(inArray(executionBudgetGrant.id, [reservation.accountGrantId, reservation.grantId]))
          .orderBy(asc(executionBudgetGrant.id));
        if (lock) grantQuery = grantQuery.for('update') as typeof grantQuery;
        const grants = await grantQuery;
        if (grants.length !== 2) throw new ExternalExecutionAuthorityError('execution_authority_missing');
        if (grants.some((grant) => !executionGrantIdentityMatches(grant))) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        const operation = grants.find((grant) => grant.id === reservation.grantId);
        if (!operation || operation.version !== 2 || reservation.version !== 2 ||
            operation.authorizedReleaseSha !== reservation.executingReleaseSha ||
            reservation.executingReleaseSha !== this.options.runtimeReleaseSha ||
            !accountIdentityMatches(reservation.providerId, operation.authorizedProviderAccountIdentity) ||
            !accountIdentityMatches(reservation.providerId, reservation.executingProviderAccountIdentity) ||
            (reservation.executingProviderAccountIdentity === null
              ? operation.authorizedProviderAccountIdentity !== null
              : canonicalProviderAccountIdentity(reservation.executingProviderAccountIdentity) !== canonicalProviderAccountIdentity(operation.authorizedProviderAccountIdentity))) {
          throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        }
        const revocations = await transaction.select({ grantId: executionBudgetGrantRevocation.grantId })
          .from(executionBudgetGrantRevocation).where(inArray(executionBudgetGrantRevocation.grantId, [reservation.accountGrantId, reservation.grantId]));
        if (revocations.length > 0) throw new ExternalExecutionAuthorityError('execution_authority_missing');
        const now = await freshDatabaseTime(transaction);
        if (grants.some((grant) => grant.expiresAt <= now)) throw new ExternalExecutionAuthorityError('execution_authority_expired');
      }
      if (lock) query = query.for('update') as typeof query;
      const [row] = await query.limit(1);
      if (!row) throw new ExternalExecutionAuthorityError('execution_authority_expired');
    };
    const begin = async (kind: SandboxTransportKind = 'business') => authorityOperation(() => database.transaction(async (transaction) => {
      await lockExternalExecution(transaction);
      await owned(transaction, { lock: true });
      const starts = await transaction.select().from(externalExecutionEvent).where(and(eq(externalExecutionEvent.reservationId, reservation.id), eq(externalExecutionEvent.eventType, 'attempt_started')));
      // Cleanup requires either a server-resolved recovery capability or a
      // recorded dispatch against the exact identity bound to this permit.
      if (kind === 'cleanup' && (!policy || (!recovery && (reservation.reservedSandboxIdentities !== 1 || starts.length === 0)))) {
        await assertRunBusinessAllowed(transaction, reservation, clock());
      } else if (kind !== 'cleanup') {
        if (recovery) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        await assertRunBusinessAllowed(transaction, reservation, clock());
        if (reservation.repairRunId)
          await assertReviewedPlanIntegrity(transaction, reservation.repairRunId, this.options.runtimeReleaseSha ?? '', clock());
        if (reservation.repairRunId && reservation.operationCategory.startsWith('gemini_'))
          await assertMatchedSourceCheckpoint(transaction, reservation.repairRunId);
      }
      const ordinal = starts.length + 1;
      if (sandbox && !recovery && reservation.reservedSandboxIdentities === 1 && ordinal === 1 && kind !== 'create') throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
      if (kind === 'create' && (reservation.reservedSandboxIdentities !== 1 || ordinal !== 1)) throw new ExternalExecutionAuthorityError('sandbox_creation_failed');
      if (ordinal > reservation.reservedProviderAttempts) throw new ExternalExecutionAuthorityError('execution_budget_exhausted');
      await insertActiveEvent(transaction, 'attempt_started', ordinal);
      return ordinal;
    }));
    const finish = async (ordinal: number, outcome: ProviderAttemptOutcome, usage: { inputTokens?: number; outputTokens?: number } = {}, kind: SandboxTransportKind = 'business') => authorityOperation(() => database.transaction(async (transaction) => {
      await lockExternalExecution(transaction);
      await owned(transaction, { lock: true, requireFresh: outcome === 'succeeded', requireGrant: outcome === 'succeeded' });
      // A valid lease is insufficient once another operation fences this run.
      // Only the privately classified exact cleanup transport may still succeed.
      if (outcome === 'succeeded' && kind !== 'cleanup') {
        await assertRunBusinessAllowed(transaction, reservation, clock());
        if (reservation.repairRunId)
          await assertReviewedPlanIntegrity(transaction, reservation.repairRunId, this.options.runtimeReleaseSha ?? '', clock());
      }
      if (outcome === 'succeeded') await insertActiveEvent(transaction, 'attempt_succeeded', ordinal, usage);
      else await transaction.insert(externalExecutionEvent).values({
        id: randomId(), reservationId: reservation.id, eventType: terminalEvent(outcome), attemptOrdinal: ordinal,
        failureCode: outcome === 'ambiguous' ? 'provider_attempt_ambiguous' : null,
        inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, createdAt: sql`clock_timestamp()`,
      });
    }));
    const permit: ExternalExecutionPermit = {
      reservationId: reservation.id,
      ownershipToken,
      fence: reservation.fence,
      sandboxResourceClass: reservation.sandboxResourceClass as ExternalExecutionPermit['sandboxResourceClass'],
      assertOwnership: () => authorityOperation(() => database.transaction(async (transaction) => {
        await lockExternalExecution(transaction);
        await owned(transaction, { lock: true });
      })),
      beginProviderAttempt: () => begin(),
      finishProviderAttempt: (ordinal, outcome, usage) => finish(ordinal, outcome, usage),
      renew: async () => authorityOperation(() => database.transaction(async (transaction) => {
        await lockExternalExecution(transaction);
        await owned(transaction, { lock: true });
        const updated = await transaction.update(externalExecutionLease).set({
          heartbeatAt: sql`clock_timestamp()`,
          leaseExpiresAt: sql`least(clock_timestamp() + ${leaseMs} * interval '1 millisecond',
            (select expires_at from execution_budget_grant where id = ${reservation.grantId}),
            (select expires_at from execution_budget_grant where id = ${reservation.accountGrantId}))`,
        }).where(and(
          eq(externalExecutionLease.reservationId, reservation.id), eq(externalExecutionLease.ownershipToken, ownershipToken),
          eq(externalExecutionLease.fence, reservation.fence), eq(externalExecutionLease.state, 'active'),
          sql`${externalExecutionLease.leaseExpiresAt} > clock_timestamp()`, liveGrants,
        )).returning({ reservationId: externalExecutionLease.reservationId });
        if (updated.length !== 1) throw new ExternalExecutionAuthorityError('execution_authority_expired');
        await insertActiveEvent(transaction, 'lease_renewed');
      })),
      complete: async (outcome, failureCode) => authorityOperation(() => database.transaction(async (transaction) => {
        await lockExternalExecution(transaction);
        const audit = await transaction.select().from(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, reservation.id));
        const uncertain = audit.some((event) => event.eventType === 'attempt_ambiguous') || audit.some((event) => event.eventType === 'attempt_started'
          && !audit.some((terminal) => terminal.attemptOrdinal === event.attemptOrdinal && ['attempt_succeeded', 'attempt_failed', 'attempt_ambiguous'].includes(terminal.eventType)));
        if (uncertain) { outcome = 'ambiguous'; failureCode = 'provider_attempt_ambiguous'; }
        await owned(transaction, { lock: true, requireFresh: outcome === 'succeeded', requireGrant: outcome === 'succeeded' });
        if (outcome === 'succeeded' && !recovery) {
          await assertRunBusinessAllowed(transaction, reservation, clock());
          if (reservation.repairRunId)
            await assertReviewedPlanIntegrity(transaction, reservation.repairRunId, this.options.runtimeReleaseSha ?? '', clock());
        }
        const now = clock();
        const state = outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'ambiguous';
        const code = state === 'succeeded' ? null : failureCode ?? (state === 'ambiguous' ? 'provider_attempt_ambiguous' : 'execution_authority_mismatch');
        const completed = await transaction.update(externalExecutionLease).set({ state, completedAt: now, failureCode: code }).where(and(
          eq(externalExecutionLease.reservationId, reservation.id), eq(externalExecutionLease.ownershipToken, ownershipToken),
          eq(externalExecutionLease.fence, reservation.fence), eq(externalExecutionLease.state, 'active'),
          ...(state === 'succeeded' ? [sql`${externalExecutionLease.leaseExpiresAt} > clock_timestamp()`, liveGrants] : []),
        )).returning({ reservationId: externalExecutionLease.reservationId });
        if (completed.length !== 1) throw new ExternalExecutionAuthorityError('execution_authority_expired');
        await transaction.insert(externalExecutionEvent).values({ id: randomId(), reservationId: reservation.id, eventType: state === 'succeeded' ? 'completed' : 'failed', failureCode: code, createdAt: now });
      })),
      resolveSandboxCreation: async (identity) => {
        if (!policy || recovery) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
        await authorityOperation(() => database.transaction(async (transaction) => {
          await lockExternalExecution(transaction);
          await owned(transaction, { lock: true, requireFresh: identity !== undefined, requireGrant: identity !== undefined });
          const audit = await transaction.select().from(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, reservation.id));
          const started = audit.some((event) => event.attemptOrdinal === 1 && event.eventType === 'attempt_started');
          const existing = audit.find((event) => event.attemptOrdinal === 1 && ['attempt_succeeded', 'attempt_failed', 'attempt_ambiguous'].includes(event.eventType));
          if (identity) {
            if (!started) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
            if (existing && existing.eventType !== 'attempt_succeeded') throw new ExternalExecutionAuthorityError(existing.eventType === 'attempt_ambiguous' ? 'provider_attempt_ambiguous' : 'sandbox_creation_failed');
            // Retain exact parsed identity for cleanup, not as business success.
            policy.confirm(identity);
            await assertRunBusinessAllowed(transaction, reservation, clock());
            if (reservation.repairRunId)
              await assertReviewedPlanIntegrity(transaction, reservation.repairRunId, this.options.runtimeReleaseSha ?? '', clock());
          }
          if (started && !existing) {
            if (identity) await insertActiveEvent(transaction, 'attempt_succeeded', 1);
            else await transaction.insert(externalExecutionEvent).values({ id: randomId(), reservationId: reservation.id,
              eventType: 'attempt_ambiguous', attemptOrdinal: 1, failureCode: 'provider_attempt_ambiguous', createdAt: sql`clock_timestamp()` });
          }
        }));
      },
      meteredFetch: async (input, init) => {
        try {
          if (sandbox && !policy) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
          const kind = policy ? policy.classify(input, init) : 'business';
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          signal?.throwIfAborted();
          const ordinal = await begin(kind);
          try {
            signal?.throwIfAborted();
            await permit.assertOwnership();
          } catch (error) {
            // Admission committed, but no transport was attempted. Record a
            // local failure; if settlement itself is fenced, retain the
            // conservative unmatched-start ambiguity.
            try { await finish(ordinal, 'failed', {}, kind); }
            catch { throw new ExternalExecutionAuthorityError('provider_attempt_ambiguous'); }
            throw error;
          }
          let response: Response;
          try {
            signal?.throwIfAborted();
            response = await fetchImplementation(input, sandbox ? { ...init, redirect: 'manual' } : init);
          } catch (error) {
            if (kind === 'create') {
              try { await permit.finishProviderAttempt(ordinal, 'ambiguous'); }
              finally { throw new ExternalExecutionAuthorityError('provider_attempt_ambiguous'); }
            }
            await permit.finishProviderAttempt(ordinal, 'ambiguous');
            throw error;
          }
          if (kind === 'create' && response.status >= 500) {
            try { await permit.finishProviderAttempt(ordinal, 'ambiguous'); }
            finally {
              await response.body?.cancel().catch(() => undefined);
              throw new ExternalExecutionAuthorityError('provider_attempt_ambiguous');
            }
          }
          // A successful create remains unresolved until the SDK has parsed its
          // response and the boundary confirms the exact identity. Malformed
          // responses cannot be prematurely recorded as trustworthy success.
          if (!(kind === 'create' && response.ok)) {
            if (kind === 'cleanup') await finish(ordinal, response.ok ? 'succeeded' : 'failed', {}, kind);
            else await permit.finishProviderAttempt(ordinal, response.ok ? 'succeeded' : 'failed');
          }
          if (sandbox && response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new SandboxTransportError();
          }
          if (kind === 'create' && !response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new ExternalExecutionAuthorityError('sandbox_creation_failed');
          }
          if (policy && kind === 'cleanup' && (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'GET') await policy.observeLookup(response);
          if (policy && (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'PATCH') await policy.observeNetworkPolicyUpdate(response);
          return response;
        } catch (error) {
          // async-retry honors `bail` without replacing the stable domain error.
          // Policy denials are terminal; network/429/5xx retries remain metered.
          if (sandbox && (error instanceof ExternalExecutionAuthorityError || error instanceof SandboxTransportError)) {
            Object.assign(error, { bail: true });
          }
          throw error;
        }
      },
    };
    return permit;
  }
}
