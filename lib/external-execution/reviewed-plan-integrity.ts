import { and, eq, inArray } from 'drizzle-orm';

import {
  executionBudgetGrant, executionBudgetGrantRevocation, executionProfile, githubInstallation,
  repairIntent, repairRun, repairRunSourceCheckpoint, repository, workspace,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { frozenBaselineProfile } from '../repository-baselines/authority.ts';
import { executionGrantIdentityMatches } from './identity.ts';
import { buildReviewedStagingPlan, isReviewedStagingPlanIdentity, type ReviewedStagingInput } from './reviewed-plan.ts';
import { ExternalExecutionAuthorityError } from './types.ts';

type Grant = typeof executionBudgetGrant.$inferSelect;
type Run = typeof repairRun.$inferSelect;
type Intent = typeof repairIntent.$inferSelect;
type Checkpoint = typeof repairRunSourceCheckpoint.$inferSelect;

function deny(): never { throw new ExternalExecutionAuthorityError('execution_authority_mismatch'); }

function validAccount(grant: Grant | undefined, now: Date, revoked: ReadonlySet<string>) {
  if (!grant || grant.scope !== 'account' || grant.version !== 2 || !executionGrantIdentityMatches(grant) ||
      grant.expiresAt <= now || revoked.has(grant.id)) deny();
  return grant;
}

/** Pure complete-set comparison, also used by deterministic tampering tests. */
export function verifyReviewedAuthoritySet(facts: {
  run: Run; intent: Intent; checkpoint: Checkpoint; operationGrants: readonly Grant[];
  accountGrants: readonly Grant[]; revokedGrantIds: ReadonlySet<string>;
  runtimeReleaseSha: string; now: Date;
}): void {
  const { run, intent, checkpoint, operationGrants, accountGrants, revokedGrantIds, runtimeReleaseSha, now } = facts;
  if (checkpoint.repairRunId !== run.id || !['pending', 'matched'].includes(checkpoint.state) ||
      !['created', 'baseline_running', 'ready_for_investigation'].includes(run.state) ||
      checkpoint.reviewedBy.length === 0 ||
      intent.repairRunId !== run.id || intent.workspaceId !== run.workspaceId ||
      operationGrants.length !== 5 || new Set(operationGrants.map((grant) => grant.operationCategory)).size !== 5 ||
      operationGrants.some((grant) => grant.scope !== 'operation' || grant.version !== 2 ||
        grant.repairRunId !== run.id || grant.workspaceId !== run.workspaceId ||
        grant.githubRepositoryId !== run.githubRepositoryId || grant.baseCommitSha !== run.baseCommitSha ||
        grant.authorizedReleaseSha !== runtimeReleaseSha || grant.authorizedBy !== checkpoint.reviewedBy ||
        grant.expiresAt <= now || revokedGrantIds.has(grant.id) || !executionGrantIdentityMatches(grant))) deny();
  const expiry = operationGrants[0]!.expiresAt;
  if (operationGrants.some((grant) => grant.expiresAt.getTime() !== expiry.getTime())) deny();
  // An active global account grant could supplement the reviewed aggregate.
  // Historical expired/revoked accounts from other plans are not applicable.
  const applicableAccounts = accountGrants.filter((grant) =>
    (!revokedGrantIds.has(grant.id) && grant.expiresAt > now) ||
    (grant.authorizedBy === checkpoint.reviewedBy && grant.expiresAt.getTime() === expiry.getTime()));
  if (applicableAccounts.length !== 1) deny();
  const account = validAccount(applicableAccounts[0], now, revokedGrantIds);
  if (account.expiresAt.getTime() !== expiry.getTime() || account.authorizedBy !== checkpoint.reviewedBy) deny();
  const googleGrant = operationGrants.find((grant) => grant.operationCategory === 'gemini_investigation');
  const vercelGrant = operationGrants.find((grant) => grant.operationCategory === 'sandbox_baseline');
  const google = googleGrant?.authorizedProviderAccountIdentity;
  const vercel = vercelGrant?.authorizedProviderAccountIdentity;
  if (google?.kind !== 'google_project' || vercel?.kind !== 'vercel_team_project') deny();
  const input: ReviewedStagingInput = {
    kind: 'm77b_repair_v1', repairRunId: run.id, idempotencyKey: run.idempotencyKey,
    githubRepositoryId: run.githubRepositoryId, installationId: run.installationId,
    profileIdentity: run.profileIdentity, baseCommitSha: run.baseCommitSha,
    authorizedReleaseSha: runtimeReleaseSha, objective: intent.objective,
    expectedSourceIdentity: checkpoint.expectedSourceIdentity,
    expiresAt: expiry.toISOString(),
    providerAccounts: { googleProjectId: google.projectId, vercelTeamId: vercel.teamId, vercelProjectId: vercel.projectId },
  };
  let plan: ReturnType<typeof buildReviewedStagingPlan>;
  try { plan = buildReviewedStagingPlan({ workspaceId: run.workspaceId, reviewerUserId: checkpoint.reviewedBy }, input, now); }
  catch { deny(); }
  if (plan.planIdentity !== checkpoint.planIdentity || plan.objective.objectiveHash !== intent.objectiveHash ||
      plan.objective.objective !== intent.objective || plan.accountGrant.grantIdentity !== account.grantIdentity ||
      plan.operationGrants.some((expected) => !operationGrants.some((actual) => actual.grantIdentity === expected.grantIdentity))) deny();
}

/** Returns false for historical runs without an M7.7B-tagged checkpoint. */
export async function assertReviewedPlanIntegrity(
  database: VigiloDatabase, repairRunId: string, runtimeReleaseSha: string, now = new Date(),
): Promise<boolean> {
  const [checkpoint] = await database.select().from(repairRunSourceCheckpoint)
    .where(eq(repairRunSourceCheckpoint.repairRunId, repairRunId)).limit(1);
  if (!checkpoint || !isReviewedStagingPlanIdentity(checkpoint.planIdentity)) return false;
  const [run] = await database.select().from(repairRun).where(eq(repairRun.id, repairRunId)).limit(1);
  if (!run) deny();
  const [intent] = await database.select().from(repairIntent).where(eq(repairIntent.repairRunId, repairRunId)).limit(1);
  if (!intent) deny();
  const operations = await database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.repairRunId, repairRunId));
  const accounts = await database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.scope, 'account'));
  const relevantIds = [...operations, ...accounts].map((grant) => grant.id);
  const allRevocations = relevantIds.length > 0 ? await database.select().from(executionBudgetGrantRevocation)
    .where(inArray(executionBudgetGrantRevocation.grantId, relevantIds)) : [];
  const revoked = new Set(allRevocations.map((row) => row.grantId));
  verifyReviewedAuthoritySet({ run, intent, checkpoint, operationGrants: operations,
    accountGrants: accounts, revokedGrantIds: revoked, runtimeReleaseSha, now });
  const [selected] = await database.select().from(repository).where(and(
    eq(repository.workspaceId, run.workspaceId), eq(repository.isSelected, true),
  )).limit(1);
  const [profile] = await database.select().from(executionProfile)
    .where(eq(executionProfile.githubRepositoryId, run.githubRepositoryId)).limit(1);
  const [installation] = await database.select().from(githubInstallation)
    .where(eq(githubInstallation.installationId, run.installationId)).limit(1);
  const [owner] = await database.select().from(workspace).where(eq(workspace.id, run.workspaceId)).limit(1);
  if (!selected || selected.githubRepositoryId !== run.githubRepositoryId || selected.installationId !== run.installationId ||
      selected.isPrivate || !profile || profile.workspaceId !== run.workspaceId ||
      profile.installationId !== run.installationId || profile.profileIdentity !== run.profileIdentity ||
      profile.baseCommitSha !== run.baseCommitSha || !installation || installation.workspaceId !== run.workspaceId ||
      installation.status !== 'active' || !owner || owner.ownerUserId !== checkpoint.reviewedBy) deny();
  try { frozenBaselineProfile(profile); } catch { deny(); }
  return true;
}
