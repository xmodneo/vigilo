import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss';

import {
  aiCandidateGeneration, aiInvestigation, candidateVerification, executionBudgetGrant,
  executionBudgetGrantRevocation, externalExecutionReservation, investigation, repairIntent,
  repairLoop, repairPublication, repairRun, repairRunAttempt, repairRunEvent,
  repairRunSourceCheckpoint, workspace,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { REPAIR_BASELINE_QUEUE, REVIEWED_BASELINE_QUEUE } from '../repair-runs/queue.ts';
import { assertExactPgBossCompatibility } from '../repair-runs/exact-baseline-job.ts';
import { lockExternalExecution } from './business-fence.ts';
import { executionGrantIdentityMatches } from './identity.ts';
import { buildReviewedStagingPlan, type ReviewedStagingInput } from './reviewed-plan.ts';
import { verifyReviewedAuthoritySet } from './reviewed-plan-integrity.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RETIREMENT_CODE = 'pre_execution_operator_retirement';
// Only this published pre-isolation reviewed release staged on the general queue.
// Compatibility is for exact retirement only; exact execution never accepts it.
const HISTORICAL_GENERAL_QUEUE_RELEASE = 'fb373deb5a50f4bba38ea7d8c9af4b2fc581e24f';

export function retirementBaselineQueueForRelease(releaseSha: string): typeof REPAIR_BASELINE_QUEUE | typeof REVIEWED_BASELINE_QUEUE {
  return releaseSha === HISTORICAL_GENERAL_QUEUE_RELEASE ? REPAIR_BASELINE_QUEUE : REVIEWED_BASELINE_QUEUE;
}

export interface ReviewedRetirementRequest {
  repairRunId: string;
  planIdentity: string;
  accountGrantIdentity: string;
  repositoryId: number;
  revision: string;
  authorizedReleaseSha: string;
}

export interface ReviewedRetirementReceipt {
  kind: 'reviewed_stage_retirement';
  repairRunId: string;
  planIdentity: string;
  baselineJobId: string;
  result: 'retired' | 'already_retired';
  revokedGrantCount: 6;
}

export class ReviewedRetirementError extends Error {
  constructor(public readonly code: 'retirement_invalid' | 'retirement_unauthorized' | 'retirement_conflict') {
    super(code);
  }
}

function deny(): never { throw new ReviewedRetirementError('retirement_conflict'); }

function validRequest(input: ReviewedRetirementRequest): boolean {
  return UUID.test(input.repairRunId) && HASH.test(input.planIdentity) && HASH.test(input.accountGrantIdentity) &&
    Number.isSafeInteger(input.repositoryId) && input.repositoryId > 0 &&
    SHA.test(input.revision) && SHA.test(input.authorizedReleaseSha);
}

function rows<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

/** Only pre-execution reviewed runs are eligible. No HTTP endpoint or generic SQL operator interface. */
export async function retireReviewedStagedRun(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  request: ReviewedRetirementRequest,
  boss: Pick<PgBoss, 'cancel'>,
  options: { clock?: () => Date; randomId?: () => string } = {},
): Promise<ReviewedRetirementReceipt> {
  if (!validRequest(request)) throw new ReviewedRetirementError('retirement_invalid');
  if (context.user.id !== context.workspace.ownerUserId) throw new ReviewedRetirementError('retirement_unauthorized');
  assertExactPgBossCompatibility();
  const now = options.clock?.() ?? new Date();
  const randomId = options.randomId ?? randomUUID;
  return database.transaction(async (transaction) => {
    await lockExternalExecution(transaction);
    const [owner] = await transaction.select().from(workspace).where(eq(workspace.id, context.workspace.id)).for('update').limit(1);
    if (!owner || owner.ownerUserId !== context.user.id) throw new ReviewedRetirementError('retirement_unauthorized');
    const [run] = await transaction.select().from(repairRun).where(and(eq(repairRun.id, request.repairRunId),
      eq(repairRun.workspaceId, context.workspace.id))).for('update').limit(1);
    if (!run || !['created', 'cancelled'].includes(run.state) || run.baselineId ||
        run.githubRepositoryId !== request.repositoryId || run.baseCommitSha !== request.revision) deny();
    const [checkpoint] = await transaction.select().from(repairRunSourceCheckpoint)
      .where(eq(repairRunSourceCheckpoint.repairRunId, run.id)).limit(1);
    const [intent] = await transaction.select().from(repairIntent).where(eq(repairIntent.repairRunId, run.id)).limit(1);
    if (!checkpoint || checkpoint.planIdentity !== request.planIdentity || checkpoint.state !== 'pending' ||
        checkpoint.baselineId || checkpoint.observedSourceIdentity || !intent) deny();
    const operations = await transaction.select().from(executionBudgetGrant)
      .where(eq(executionBudgetGrant.repairRunId, run.id));
    if (operations.length !== 5 || new Set(operations.map((grant) => grant.operationCategory)).size !== 5) deny();
    const [account] = await transaction.select().from(executionBudgetGrant)
      .where(and(eq(executionBudgetGrant.scope, 'account'), eq(executionBudgetGrant.grantIdentity, request.accountGrantIdentity))).limit(1);
    const google = operations.find((grant) => grant.operationCategory === 'gemini_investigation')?.authorizedProviderAccountIdentity;
    const vercel = operations.find((grant) => grant.operationCategory === 'sandbox_baseline')?.authorizedProviderAccountIdentity;
    if (!account || google?.kind !== 'google_project' || vercel?.kind !== 'vercel_team_project') deny();
    const expiry = operations[0]!.expiresAt;
    const historicInput: ReviewedStagingInput = {
      kind: 'm77b_repair_v1', repairRunId: run.id, idempotencyKey: run.idempotencyKey,
      githubRepositoryId: run.githubRepositoryId, installationId: run.installationId,
      profileIdentity: run.profileIdentity, baseCommitSha: run.baseCommitSha,
      authorizedReleaseSha: request.authorizedReleaseSha, objective: intent.objective,
      expectedSourceIdentity: checkpoint.expectedSourceIdentity, expiresAt: expiry.toISOString(),
      providerAccounts: { googleProjectId: google.projectId, vercelTeamId: vercel.teamId, vercelProjectId: vercel.projectId },
    };
    let planned: ReturnType<typeof buildReviewedStagingPlan>;
    try { planned = buildReviewedStagingPlan({ workspaceId: run.workspaceId, reviewerUserId: checkpoint.reviewedBy },
      historicInput, new Date(expiry.getTime() - 1)); } catch { return deny(); }
    if (planned.planIdentity !== request.planIdentity || planned.accountGrant.grantIdentity !== account.grantIdentity ||
        account.expiresAt.getTime() !== expiry.getTime() || !executionGrantIdentityMatches(account) ||
        operations.some((grant) => !executionGrantIdentityMatches(grant) ||
          !planned.operationGrants.some((expected) => expected.grantIdentity === grant.grantIdentity))) deny();
    const baselineQueue = retirementBaselineQueueForRelease(request.authorizedReleaseSha);
    const grantIds = [account.id, ...operations.map((grant) => grant.id)];
    const revocations = await transaction.select().from(executionBudgetGrantRevocation)
      .where(inArray(executionBudgetGrantRevocation.grantId, grantIds));
    const jobRows = rows<{ id: string; name: string; state: string; started_on: Date | null }>(await transaction.execute(sql`
      select id::text as id, name, state::text as state, started_on
      from pgboss.job where id = ${run.id}::uuid and name = ${baselineQueue} for update
    `));
    const job = jobRows[0];
    if (jobRows.length !== 1 || job?.id !== run.id) deny();
    if (run.state === 'cancelled') {
      const [event] = await transaction.select({ id: repairRunEvent.id }).from(repairRunEvent)
        .where(and(eq(repairRunEvent.repairRunId, run.id), eq(repairRunEvent.failureCode, RETIREMENT_CODE))).limit(1);
      if (job.state !== 'cancelled' || !event || revocations.length !== 6 || run.failureCode !== RETIREMENT_CODE ||
          revocations.some((revocation) => revocation.reasonCode !== RETIREMENT_CODE)) deny();
      return { kind: 'reviewed_stage_retirement', repairRunId: run.id, planIdentity: request.planIdentity,
        baselineJobId: run.id, result: 'already_retired', revokedGrantCount: 6 };
    }
    if (job.state !== 'created' || job.started_on !== null || revocations.length || run.baselineStartedAt) deny();
    verifyReviewedAuthoritySet({ run, intent, checkpoint, operationGrants: operations,
      accountGrants: [account], revokedGrantIds: new Set(), runtimeReleaseSha: request.authorizedReleaseSha,
      now: new Date(expiry.getTime() - 1) });
    const [attempt] = await transaction.select({ id: repairRunAttempt.id }).from(repairRunAttempt)
      .where(eq(repairRunAttempt.repairRunId, run.id)).limit(1);
    const [reservation] = await transaction.select({ id: externalExecutionReservation.id }).from(externalExecutionReservation)
      .where(eq(externalExecutionReservation.repairRunId, run.id)).limit(1);
    if (attempt || reservation) deny();
    for (const table of [investigation, aiInvestigation, aiCandidateGeneration, candidateVerification, repairLoop, repairPublication] as const) {
      const [child] = await transaction.select({ id: table.id }).from(table)
        .where(eq(table.repairRunId, run.id)).limit(1);
      if (child) deny();
    }
    const cancelled = await boss.cancel(baselineQueue, run.id, {
      db: fromDrizzle(transaction as unknown as DrizzleTransactionLike, sql),
    });
    if ((cancelled as { affected?: number }).affected !== 1) deny();
    await transaction.insert(executionBudgetGrantRevocation).values(grantIds.map((grantId) => ({
      id: randomId(), grantId, reasonCode: RETIREMENT_CODE, revokedBy: context.user.id, createdAt: now,
    })));
    const [updated] = await transaction.update(repairRun).set({ state: 'cancelled', completedAt: now,
      failureClassification: 'cancelled', failureCode: RETIREMENT_CODE, stateChangedAt: now, updatedAt: now })
      .where(and(eq(repairRun.id, run.id), eq(repairRun.state, 'created'))).returning({ id: repairRun.id });
    if (!updated) deny();
    await transaction.insert(repairRunEvent).values({ id: randomId(), repairRunId: run.id, fromState: 'created',
      toState: 'cancelled', failureClassification: 'cancelled', failureCode: RETIREMENT_CODE, createdAt: now });
    return { kind: 'reviewed_stage_retirement', repairRunId: run.id, planIdentity: request.planIdentity,
      baselineJobId: run.id, result: 'retired', revokedGrantCount: 6 };
  });
}
