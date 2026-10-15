import { randomUUID } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';

import {
  executionBudgetGrant, executionBudgetGrantRevocation, executionProfile, githubInstallation,
  repairIntent, repairRun, repairRunEvent, repairRunSourceCheckpoint, repository, workspace,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { frozenBaselineProfile } from '../repository-baselines/authority.ts';
import { REPAIR_JOB_VERSION, type TransactionalRepairQueue } from '../repair-runs/queue.ts';
import { hasRepositorySwitchConflict } from '../github-repositories/switch-guard.ts';
import { lockExternalExecution } from './business-fence.ts';
import { buildReviewedStagingPlan, type ReviewedStagingInput } from './reviewed-plan.ts';
import { assertReviewedPlanIntegrity } from './reviewed-plan-integrity.ts';
import { stageReviewedSourceCheckpoint } from './source-checkpoint.ts';

const SHA = /^[0-9a-f]{40}$/;

export class ReviewedStagingError extends Error {
  constructor(public readonly code: 'reviewed_plan_mismatch' | 'reviewed_staging_conflict' | 'reviewed_staging_unauthorized' | 'reviewed_staging_authority_changed' | 'reviewed_staging_handoff_failed') {
    super(code);
    this.name = 'ReviewedStagingError';
  }
}

export interface ReviewedStagingReceipt {
  repairRunId: string;
  planIdentity: string;
  sourceCheckpointState: 'pending';
  accountGrantId: string;
  operationGrantIds: readonly string[];
  baselineJobId: string;
}

/** One supported, server-only, no-transport staging transaction. */
export async function stageReviewedRepairRun(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  input: ReviewedStagingInput,
  approvedPlanIdentity: string,
  queue: TransactionalRepairQueue,
  options: { runtimeReleaseSha: string; configuredProviderAccounts: ReviewedStagingInput['providerAccounts']; clock?: () => Date; randomId?: () => string },
): Promise<ReviewedStagingReceipt> {
  const now = options.clock?.() ?? new Date();
  const randomId = options.randomId ?? randomUUID;
  if (context.user.id !== context.workspace.ownerUserId) throw new ReviewedStagingError('reviewed_staging_unauthorized');
  if (!SHA.test(options.runtimeReleaseSha) || input.authorizedReleaseSha !== options.runtimeReleaseSha)
    throw new ReviewedStagingError('reviewed_staging_authority_changed');
  if (input.providerAccounts.googleProjectId !== options.configuredProviderAccounts.googleProjectId ||
      input.providerAccounts.vercelTeamId !== options.configuredProviderAccounts.vercelTeamId ||
      input.providerAccounts.vercelProjectId !== options.configuredProviderAccounts.vercelProjectId)
    throw new ReviewedStagingError('reviewed_staging_authority_changed');
  const planned = buildReviewedStagingPlan({ workspaceId: context.workspace.id, reviewerUserId: context.user.id }, input, now);
  if (planned.planIdentity !== approvedPlanIdentity) throw new ReviewedStagingError('reviewed_plan_mismatch');

  return database.transaction(async (transaction) => {
    // This is the same global -> workspace lock order as repository switching
    // and external-execution reservation. Profile refresh takes this order too.
    await lockExternalExecution(transaction);
    const [owner] = await transaction.select().from(workspace)
      .where(eq(workspace.id, context.workspace.id)).for('update').limit(1);
    if (!owner || owner.ownerUserId !== context.user.id) throw new ReviewedStagingError('reviewed_staging_unauthorized');

    // A byte-for-byte replay is the sole exception to the active-run conflict.
    const [existing] = await transaction.select().from(repairRun).where(and(
      eq(repairRun.workspaceId, context.workspace.id), eq(repairRun.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.id !== input.repairRunId) throw new ReviewedStagingError('reviewed_staging_conflict');
      const [checkpoint] = await transaction.select().from(repairRunSourceCheckpoint)
        .where(eq(repairRunSourceCheckpoint.repairRunId, existing.id)).limit(1);
      const [intent] = await transaction.select().from(repairIntent).where(eq(repairIntent.repairRunId, existing.id)).limit(1);
      const grants = await transaction.select().from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.repairRunId, existing.id));
      const operations = planned.operationGrants.map((grant) => grants.find((row) => row.grantIdentity === grant.grantIdentity));
      const [account] = await transaction.select().from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.grantIdentity, planned.accountGrant.grantIdentity)).limit(1);
      if (!checkpoint || checkpoint.planIdentity !== planned.planIdentity || !intent ||
          intent.objective !== planned.objective.objective || intent.objectiveHash !== planned.objective.objectiveHash ||
          existing.githubRepositoryId !== input.githubRepositoryId || existing.installationId !== input.installationId ||
          existing.profileIdentity !== input.profileIdentity || existing.baseCommitSha !== input.baseCommitSha ||
          grants.length !== 5 || operations.some((row) => !row) || !account) {
        throw new ReviewedStagingError('reviewed_staging_conflict');
      }
      await assertReviewedPlanIntegrity(transaction, existing.id, options.runtimeReleaseSha, now);
      return {
        repairRunId: existing.id, planIdentity: planned.planIdentity,
        sourceCheckpointState: 'pending' as const, accountGrantId: account.id,
        operationGrantIds: operations.map((row) => row!.id), baselineJobId: existing.id,
      };
    }

    const [idCollision] = await transaction.select({ id: repairRun.id }).from(repairRun).where(eq(repairRun.id, input.repairRunId)).limit(1);
    if (idCollision || await hasRepositorySwitchConflict(transaction, context.workspace.id, now))
      throw new ReviewedStagingError('reviewed_staging_conflict');
    const [activeAccount] = await transaction.select({ id: executionBudgetGrant.id }).from(executionBudgetGrant)
      .leftJoin(executionBudgetGrantRevocation, eq(executionBudgetGrantRevocation.grantId, executionBudgetGrant.id))
      .where(and(eq(executionBudgetGrant.scope, 'account'), gt(executionBudgetGrant.expiresAt, now), isNull(executionBudgetGrantRevocation.id))).limit(1);
    if (activeAccount) throw new ReviewedStagingError('reviewed_staging_conflict');

    const [selected] = await transaction.select().from(repository).where(and(
      eq(repository.workspaceId, context.workspace.id), eq(repository.isSelected, true),
    )).for('update').limit(1);
    if (!selected || selected.githubRepositoryId !== input.githubRepositoryId || selected.installationId !== input.installationId || selected.isPrivate)
      throw new ReviewedStagingError('reviewed_staging_authority_changed');
    const [installation] = await transaction.select().from(githubInstallation).where(and(
      eq(githubInstallation.installationId, input.installationId), eq(githubInstallation.workspaceId, context.workspace.id),
    )).limit(1);
    if (!installation || installation.status !== 'active') throw new ReviewedStagingError('reviewed_staging_authority_changed');
    const [profile] = await transaction.select().from(executionProfile).where(and(
      eq(executionProfile.githubRepositoryId, input.githubRepositoryId), eq(executionProfile.workspaceId, context.workspace.id),
    )).for('update').limit(1);
    if (!profile || profile.installationId !== input.installationId ||
      profile.profileIdentity !== input.profileIdentity || profile.baseCommitSha !== input.baseCommitSha)
      throw new ReviewedStagingError('reviewed_staging_authority_changed');
    frozenBaselineProfile(profile);

    await transaction.insert(repairRun).values({
      id: input.repairRunId, workspaceId: context.workspace.id, githubRepositoryId: input.githubRepositoryId,
      installationId: input.installationId, profileIdentity: input.profileIdentity,
      baseCommitSha: input.baseCommitSha, idempotencyKey: input.idempotencyKey,
      state: 'created', createdAt: now, stateChangedAt: now, updatedAt: now,
    });
    await transaction.insert(repairIntent).values({ id: randomId(), repairRunId: input.repairRunId,
      workspaceId: context.workspace.id, objective: planned.objective.objective,
      objectiveHash: planned.objective.objectiveHash, createdAt: now });
    await transaction.insert(repairRunEvent).values({ id: randomId(), repairRunId: input.repairRunId,
      fromState: null, toState: 'created', createdAt: now });
    await stageReviewedSourceCheckpoint(transaction, context, input.repairRunId,
      input.expectedSourceIdentity, planned.planIdentity);
    const accountGrantId = randomId();
    await transaction.insert(executionBudgetGrant).values({ ...planned.accountGrant, id: accountGrantId, createdAt: now });
    const operationGrantIds: string[] = [];
    for (const grant of planned.operationGrants) {
      const id = randomId();
      await transaction.insert(executionBudgetGrant).values({ ...grant, id, createdAt: now });
      operationGrantIds.push(id);
    }
    const baselineJobId = await queue.enqueue(transaction, { version: REPAIR_JOB_VERSION, repairRunId: input.repairRunId });
    if (baselineJobId !== input.repairRunId) throw new ReviewedStagingError('reviewed_staging_handoff_failed');
    return { repairRunId: input.repairRunId, planIdentity: planned.planIdentity,
      sourceCheckpointState: 'pending' as const, accountGrantId, operationGrantIds, baselineJobId };
  });
}
