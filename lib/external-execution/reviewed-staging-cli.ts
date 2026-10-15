import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { buildReviewedStagingPlan, type ReviewedStagingActor, type ReviewedStagingInput } from './reviewed-plan.ts';
import { ReviewedStagingError, type ReviewedStagingReceipt } from './reviewed-staging.ts';

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export interface ReviewedStagingCommandDependencies {
  resolveContext(cookie: string): Promise<AuthenticatedWorkspace>;
  apply(context: AuthenticatedWorkspace, plan: ReviewedStagingInput, approvedPlanIdentity: string): Promise<ReviewedStagingReceipt>;
}

/** No arbitrary grant JSON, database row, or provider transport is accepted. */
export async function runReviewedStagingCommand(
  mode: 'dry-run' | 'apply', request: unknown, dependencies: ReviewedStagingCommandDependencies,
): Promise<{ kind: 'review' | 'staged'; planIdentity: string; repairRunId: string; grantCount: number }> {
  if (!keys(request, mode === 'apply'
    ? ['actor', 'plan', 'approvedPlanIdentity', 'sessionCookie'] : ['actor', 'plan']) ||
    !keys(request.actor, ['workspaceId', 'reviewerUserId']) ||
    typeof request.actor.workspaceId !== 'string' || typeof request.actor.reviewerUserId !== 'string') {
    throw new ReviewedStagingError('reviewed_plan_mismatch');
  }
  const actor = request.actor as unknown as ReviewedStagingActor;
  const plan = request.plan as ReviewedStagingInput;
  const reviewed = buildReviewedStagingPlan(actor, plan);
  if (mode === 'dry-run') return { kind: 'review', planIdentity: reviewed.planIdentity,
    repairRunId: plan.repairRunId, grantCount: 6 };
  if (typeof request.approvedPlanIdentity !== 'string' || request.approvedPlanIdentity !== reviewed.planIdentity ||
      typeof request.sessionCookie !== 'string' || request.sessionCookie.length === 0 || request.sessionCookie.length > 8192)
    throw new ReviewedStagingError('reviewed_plan_mismatch');
  const context = await dependencies.resolveContext(request.sessionCookie);
  if (context.workspace.id !== actor.workspaceId || context.user.id !== actor.reviewerUserId ||
      context.workspace.ownerUserId !== context.user.id)
    throw new ReviewedStagingError('reviewed_staging_unauthorized');
  const receipt = await dependencies.apply(context, plan, request.approvedPlanIdentity);
  return { kind: 'staged', planIdentity: receipt.planIdentity, repairRunId: receipt.repairRunId, grantCount: 6 };
}
