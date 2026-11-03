import { randomUUID } from 'node:crypto';

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss';

import {
  aiCandidateGeneration, aiInvestigation, aiInvestigationAttempt, aiInvestigationEvent,
  candidateVerification, executionBudgetGrant, executionBudgetGrantRevocation,
  externalExecutionEvent, externalExecutionLease, externalExecutionReservation, investigation, repairLoop,
  repairPublication, repairIntent, repairRun, repairRunSourceCheckpoint, workspace,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { assertRunBusinessAllowed, lockExternalExecution } from '../external-execution/business-fence.ts';
import { freshDatabaseTime } from '../external-execution/database-clock.ts';
import { verifyReviewedAuthoritySet } from '../external-execution/reviewed-plan-integrity.ts';
import { assertExactPgBossCompatibility } from '../repair-runs/exact-baseline-job.ts';
import { AI_INVESTIGATION_QUEUE, parseAiInvestigationJobPayload } from '../repair-runs/queue.ts';
import { assertMatchedSourceCheckpoint } from '../external-execution/source-checkpoint.ts';

export const EXPIRED_AI_RETIREMENT_REASON = 'expired_unstarted_owner_retirement';

export interface ExpiredAiRetirementTarget {
  repairRunId: string;
  contextInvestigationId: string;
  aiInvestigationId: string;
  planIdentity: string;
  authorizedReleaseSha: string;
  repositoryId: number;
  revision: string;
}

export class ExpiredAiRetirementError extends Error {
  constructor(public readonly code: 'expired_ai_retirement_denied') { super(code); }
}

function deny(): never { throw new ExpiredAiRetirementError('expired_ai_retirement_denied'); }

function rows<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

/** No grant renewal or run transition: only the never-claimed AI row and exact job become terminal. */
export async function retireExpiredUnstartedAiInvestigation(
  database: VigiloDatabase,
  actor: AuthenticatedWorkspace,
  target: ExpiredAiRetirementTarget,
  boss: Pick<PgBoss, 'cancel'>,
  randomId: () => string = randomUUID,
): Promise<'retired' | 'already_retired'> {
  if (actor.user.id !== actor.workspace.ownerUserId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.repairRunId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.contextInvestigationId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.aiInvestigationId) ||
      !/^77b00001[0-9a-f]{56}$/.test(target.planIdentity) ||
      !/^[0-9a-f]{40}$/.test(target.authorizedReleaseSha) ||
      !/^[0-9a-f]{40}$/.test(target.revision) ||
      !Number.isSafeInteger(target.repositoryId) || target.repositoryId <= 0) deny();
  assertExactPgBossCompatibility();

  return database.transaction(async (transaction) => {
    // Same order as the exact worker claim: global, workspace, run, exact job.
    await lockExternalExecution(transaction);
    const [owner] = await transaction.select().from(workspace)
      .where(eq(workspace.id, actor.workspace.id)).for('update').limit(1);
    if (!owner || owner.ownerUserId !== actor.user.id) deny();
    const [run] = await transaction.select().from(repairRun)
      .where(and(eq(repairRun.id, target.repairRunId), eq(repairRun.workspaceId, actor.workspace.id)))
      .for('update').limit(1);
    if (!run || run.state !== 'ready_for_investigation' || !run.baselineId ||
        run.githubRepositoryId !== target.repositoryId || run.baseCommitSha !== target.revision) deny();
    const [checkpoint] = await transaction.select().from(repairRunSourceCheckpoint)
      .where(eq(repairRunSourceCheckpoint.repairRunId, run.id)).limit(1);
    const [intent] = await transaction.select().from(repairIntent)
      .where(eq(repairIntent.repairRunId, run.id)).limit(1);
    const [context] = await transaction.select().from(investigation)
      .where(eq(investigation.id, target.contextInvestigationId)).limit(1);
    const [ai] = await transaction.select().from(aiInvestigation)
      .where(eq(aiInvestigation.id, target.aiInvestigationId)).for('update').limit(1);
    if (!checkpoint || checkpoint.state !== 'matched' || checkpoint.planIdentity !== target.planIdentity ||
        checkpoint.baselineId !== run.baselineId || !intent || !context || context.state !== 'ready' ||
        context.repairRunId !== run.id || context.baselineId !== run.baselineId ||
        context.workspaceId !== run.workspaceId || context.githubRepositoryId !== run.githubRepositoryId ||
        context.installationId !== run.installationId || context.profileIdentity !== run.profileIdentity ||
        context.baseCommitSha !== run.baseCommitSha ||
        !ai || ai.investigationId !== context.id || ai.repairRunId !== run.id ||
        ai.baselineId !== run.baselineId || ai.workspaceId !== run.workspaceId ||
        ai.githubRepositoryId !== run.githubRepositoryId || ai.installationId !== run.installationId ||
        ai.baseCommitSha !== run.baseCommitSha || ai.profileIdentity !== run.profileIdentity ||
        ai.providerId !== 'google' || ai.modelId !== 'gemini-3.1-flash-lite' ||
        !['queued', 'cancelled'].includes(ai.state) || !ai.queuedAt || ai.investigationStartedAt ||
        ai.inputTokens !== 0 || ai.outputTokens !== 0 || ai.toolCallCount !== 0 || ai.modelTurnCount !== 0 ||
        ai.completionReason || ai.conclusionStatus || ai.summary || ai.suspectedFiles || ai.evidenceReferences ||
        ai.proposedApproach || ai.confidence) deny();
    try { await assertMatchedSourceCheckpoint(transaction, run.id); } catch { deny(); }

    const operations = await transaction.select().from(executionBudgetGrant)
      .where(eq(executionBudgetGrant.repairRunId, run.id));
    if (operations.length !== 5 || new Set(operations.map((grant) => grant.operationCategory)).size !== 5) deny();
    const expiry = operations[0]!.expiresAt;
    const accounts = await transaction.select().from(executionBudgetGrant).where(and(
      eq(executionBudgetGrant.scope, 'account'), eq(executionBudgetGrant.authorizedBy, checkpoint.reviewedBy),
      eq(executionBudgetGrant.expiresAt, expiry),
    ));
    if (accounts.length !== 1 || operations.some((grant) => grant.expiresAt.getTime() !== expiry.getTime())) deny();
    const grantIds = [accounts[0]!.id, ...operations.map((grant) => grant.id)];
    const revocations = await transaction.select({ id: executionBudgetGrantRevocation.id })
      .from(executionBudgetGrantRevocation).where(inArray(executionBudgetGrantRevocation.grantId, grantIds));
    if (revocations.length) deny();
    try {
      verifyReviewedAuthoritySet({ run, intent, checkpoint, operationGrants: operations,
        accountGrants: accounts, revokedGrantIds: new Set(), runtimeReleaseSha: target.authorizedReleaseSha,
        now: new Date(expiry.getTime() - 1) });
    } catch { deny(); }

    const jobs = rows<{ id: string; name: string; state: string; data: unknown; retry_count: number;
      started_on: Date | null; completed_on: Date | null; heartbeat_on: Date | null;
      blocked: boolean; blocking: boolean; pending_dependencies: number; source_id: string | null }>(await transaction.execute(sql`
      select id::text as id, name, state::text as state, data, retry_count,
        started_on, completed_on, heartbeat_on, blocked, blocking, pending_dependencies, source_id
      from pgboss.job where id = ${ai.id}::uuid and name = ${AI_INVESTIGATION_QUEUE} for update
    `));
    const job = jobs[0];
    if (jobs.length !== 1 || !job || job.id !== ai.id || job.name !== AI_INVESTIGATION_QUEUE ||
        job.retry_count !== 0 || job.started_on !== null || job.heartbeat_on !== null ||
        job.blocked || job.blocking || job.pending_dependencies !== 0 || job.source_id !== null) deny();
    try { if (parseAiInvestigationJobPayload(job.data).aiInvestigationId !== ai.id) deny(); }
    catch { deny(); }
    const now = await freshDatabaseTime(transaction);
    if (now < expiry) deny();

    const attempts = await transaction.select({ id: aiInvestigationAttempt.id }).from(aiInvestigationAttempt)
      .where(eq(aiInvestigationAttempt.aiInvestigationId, ai.id)).limit(1);
    const reservations = await transaction.select().from(externalExecutionReservation)
      .where(or(eq(externalExecutionReservation.repairRunId, run.id),
        inArray(externalExecutionReservation.grantId, operations.map((grant) => grant.id))));
    if (attempts.length || reservations.some((row) => row.operationCategory !== 'sandbox_baseline' ||
      row.providerId !== 'vercel' || row.modelId !== null)) deny();
    if (reservations.length) {
      const reservationIds = reservations.map((row) => row.id);
      const leases = await transaction.select().from(externalExecutionLease)
        .where(inArray(externalExecutionLease.reservationId, reservationIds));
      const terminalEvents = await transaction.select({ reservationId: externalExecutionEvent.reservationId })
        .from(externalExecutionEvent).where(and(
          inArray(externalExecutionEvent.reservationId, reservationIds),
          inArray(externalExecutionEvent.eventType, ['completed', 'failed', 'expired']),
        ));
      if (leases.length !== reservations.length ||
          leases.some((lease) => !['succeeded', 'failed'].includes(lease.state)) ||
          reservations.some((row) => !terminalEvents.some((event) => event.reservationId === row.id))) deny();
    }
    try { await assertRunBusinessAllowed(transaction, { workspaceId: run.workspaceId, repairRunId: run.id }); }
    catch { deny(); }
    for (const table of [aiCandidateGeneration, candidateVerification, repairLoop, repairPublication] as const) {
      const [child] = await transaction.select({ id: table.id }).from(table)
        .where(eq(table.repairRunId, run.id)).limit(1);
      if (child) deny();
    }

    const events = await transaction.select().from(aiInvestigationEvent)
      .where(and(eq(aiInvestigationEvent.aiInvestigationId, ai.id),
        eq(aiInvestigationEvent.failureCode, EXPIRED_AI_RETIREMENT_REASON)));
    if (ai.state === 'cancelled') {
      if (job.state !== 'cancelled' || !job.completed_on || ai.failureCode !== EXPIRED_AI_RETIREMENT_REASON ||
          !ai.completedAt || events.length !== 1 || events[0]?.fromState !== 'queued' ||
          events[0]?.toState !== 'cancelled') deny();
      return 'already_retired';
    }
    if (ai.state !== 'queued' || ai.completedAt || ai.failureCode || job.state !== 'created' ||
        job.completed_on !== null || events.length) deny();
    const cancelled = await boss.cancel(AI_INVESTIGATION_QUEUE, ai.id, {
      db: fromDrizzle(transaction as unknown as DrizzleTransactionLike, sql),
    });
    if ((cancelled as { affected?: number }).affected !== 1) deny();
    const [updated] = await transaction.update(aiInvestigation)
      .set({ state: 'cancelled', failureCode: EXPIRED_AI_RETIREMENT_REASON,
        completedAt: now, updatedAt: now })
      .where(and(eq(aiInvestigation.id, ai.id), eq(aiInvestigation.state, 'queued')))
      .returning({ id: aiInvestigation.id });
    if (!updated) deny();
    await transaction.insert(aiInvestigationEvent).values({ id: randomId(), aiInvestigationId: ai.id,
      workspaceId: run.workspaceId, fromState: 'queued', toState: 'cancelled',
      failureCode: EXPIRED_AI_RETIREMENT_REASON, createdAt: now });
    return 'retired';
  });
}
