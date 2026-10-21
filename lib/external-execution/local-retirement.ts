import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import {
  executionBudgetGrant, executionBudgetGrantRevocation, externalExecutionReservation,
  repairIntent, repairRun, repairRunAttempt, repairRunSourceCheckpoint,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { REPAIR_BASELINE_QUEUE } from '../repair-runs/queue.ts';
import { executionGrantIdentityMatches } from './identity.ts';
import type { LocalRetirementPreview } from './local-retirement-handler.ts';
import { buildReviewedStagingPlan, type ReviewedStagingInput } from './reviewed-plan.ts';
import { retireReviewedStagedRun, type ReviewedRetirementRequest } from './reviewed-retirement.ts';

export interface HistoricalRetirementTarget {
  workspaceId: string;
  repairRunId: string;
  planIdentity: string;
  repositoryId: number;
  revision: string;
  authorizedReleaseSha: string;
}

/** The sole production target. The browser cannot select or override any of these facts. */
export const HISTORICAL_RETIREMENT_TARGET: HistoricalRetirementTarget = Object.freeze({
  workspaceId: '3c9fb74c-ff50-495a-a01f-92646b85ba95',
  repairRunId: 'd159eccc-2773-4916-8860-12bd736d7e5e',
  planIdentity: '77b0000131e93122e482fa49bf362b2fdb6a5756f52a9bf543da3e82ac67dc44',
  repositoryId: 1411517943,
  revision: '3575b04ff48cf07f9f52b5b3f8cf529520619307',
  authorizedReleaseSha: 'fb373deb5a50f4bba38ea7d8c9af4b2fc581e24f',
});

function conflict(): never { throw new Error('historical_retirement_conflict'); }

function records<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

/** Read-only preflight. The reviewed service repeats all authority checks under its transaction locks. */
export async function readHistoricalRetirement(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  target: HistoricalRetirementTarget = HISTORICAL_RETIREMENT_TARGET,
): Promise<{ request: ReviewedRetirementRequest; preview: LocalRetirementPreview }> {
  if (context.workspace.id !== target.workspaceId || context.workspace.ownerUserId !== context.user.id) conflict();
  const [run] = await database.select().from(repairRun).where(and(eq(repairRun.id, target.repairRunId),
    eq(repairRun.workspaceId, target.workspaceId))).limit(1);
  if (!run || !['created', 'cancelled'].includes(run.state) || run.githubRepositoryId !== target.repositoryId ||
      run.baseCommitSha !== target.revision || run.baselineId || run.baselineStartedAt) conflict();
  const [checkpoint] = await database.select().from(repairRunSourceCheckpoint)
    .where(eq(repairRunSourceCheckpoint.repairRunId, run.id)).limit(1);
  const [intent] = await database.select().from(repairIntent)
    .where(eq(repairIntent.repairRunId, run.id)).limit(1);
  if (!checkpoint || !intent || checkpoint.planIdentity !== target.planIdentity ||
      checkpoint.state !== 'pending' || checkpoint.baselineId || checkpoint.observedSourceIdentity ||
      !checkpoint.reviewedBy) conflict();
  const operations = await database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.repairRunId, run.id));
  if (operations.length !== 5 || new Set(operations.map((grant) => grant.operationCategory)).size !== 5 ||
      operations.some((grant) => grant.scope !== 'operation' || grant.authorizedReleaseSha !== target.authorizedReleaseSha ||
        grant.expiresAt.getTime() !== operations[0]!.expiresAt.getTime() || !executionGrantIdentityMatches(grant))) conflict();
  const google = operations.find((grant) => grant.operationCategory === 'gemini_investigation')?.authorizedProviderAccountIdentity;
  const vercel = operations.find((grant) => grant.operationCategory === 'sandbox_baseline')?.authorizedProviderAccountIdentity;
  if (google?.kind !== 'google_project' || vercel?.kind !== 'vercel_team_project') conflict();
  const expiry = operations[0]!.expiresAt;
  const input: ReviewedStagingInput = {
    kind: 'm77b_repair_v1', repairRunId: run.id, idempotencyKey: run.idempotencyKey,
    githubRepositoryId: run.githubRepositoryId, installationId: run.installationId,
    profileIdentity: run.profileIdentity, baseCommitSha: run.baseCommitSha,
    authorizedReleaseSha: target.authorizedReleaseSha, objective: intent.objective,
    expectedSourceIdentity: checkpoint.expectedSourceIdentity, expiresAt: expiry.toISOString(),
    providerAccounts: { googleProjectId: google.projectId, vercelTeamId: vercel.teamId,
      vercelProjectId: vercel.projectId },
  };
  let planned: ReturnType<typeof buildReviewedStagingPlan>;
  try { planned = buildReviewedStagingPlan({ workspaceId: target.workspaceId, reviewerUserId: checkpoint.reviewedBy },
    input, new Date(expiry.getTime() - 1)); } catch { return conflict(); }
  if (planned.planIdentity !== target.planIdentity ||
      operations.some((grant) => !planned.operationGrants.some((expected) => expected.grantIdentity === grant.grantIdentity))) conflict();
  const [account] = await database.select().from(executionBudgetGrant)
    .where(and(eq(executionBudgetGrant.scope, 'account'), eq(executionBudgetGrant.grantIdentity,
      planned.accountGrant.grantIdentity))).limit(1);
  if (!account || account.expiresAt.getTime() !== expiry.getTime() || !executionGrantIdentityMatches(account)) conflict();
  const request = {
    repairRunId: target.repairRunId, planIdentity: target.planIdentity,
    accountGrantIdentity: account.grantIdentity, repositoryId: target.repositoryId,
    revision: target.revision, authorizedReleaseSha: target.authorizedReleaseSha,
  };
  const jobRows = records<{ state: string; started_on: Date | null }>(await database.execute(sql`
    select state::text as state, started_on from pgboss.job
    where id = ${target.repairRunId}::uuid and name = ${REPAIR_BASELINE_QUEUE}
  `));
  if (jobRows.length !== 1) conflict();
  const [attempt] = await database.select({ id: repairRunAttempt.id }).from(repairRunAttempt)
    .where(eq(repairRunAttempt.repairRunId, run.id)).limit(1);
  const [reservation] = await database.select({ id: externalExecutionReservation.id }).from(externalExecutionReservation)
    .where(eq(externalExecutionReservation.repairRunId, run.id)).limit(1);
  const revocations = await database.select({ id: executionBudgetGrantRevocation.id })
    .from(executionBudgetGrantRevocation).where(inArray(executionBudgetGrantRevocation.grantId,
      [account.id, ...operations.map((grant) => grant.id)]));
  return { request, preview: {
    runState: run.state, checkpointState: checkpoint.state, jobState: jobRows[0]!.state,
    eligible: run.state === 'created' && jobRows[0]!.state === 'created' && jobRows[0]!.started_on === null &&
      !attempt && !reservation && revocations.length === 0,
  } };
}

export async function retireExactHistoricalRun(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  boss: Pick<PgBoss, 'cancel'>,
  target: HistoricalRetirementTarget = HISTORICAL_RETIREMENT_TARGET,
) {
  const { request } = await readHistoricalRetirement(database, context, target);
  return retireReviewedStagedRun(database, context, request, boss);
}
