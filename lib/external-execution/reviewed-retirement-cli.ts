import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { ReviewedRetirementReceipt, ReviewedRetirementRequest } from './reviewed-retirement.ts';

const expectedFields = ['sessionCookie', 'actor', 'retirement'] as const;
const actorFields = ['workspaceId', 'reviewerUserId'] as const;
const retirementFields = ['repairRunId', 'planIdentity', 'accountGrantIdentity', 'repositoryId', 'revision', 'authorizedReleaseSha'] as const;

function exactKeys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

export async function runReviewedRetirementCommand(input: unknown, dependencies: {
  resolveContext(cookie: string): Promise<AuthenticatedWorkspace>;
  retire(context: AuthenticatedWorkspace, request: ReviewedRetirementRequest): Promise<ReviewedRetirementReceipt>;
}): Promise<ReviewedRetirementReceipt> {
  if (!exactKeys(input, expectedFields) || !exactKeys(input.actor, actorFields) ||
      !exactKeys(input.retirement, retirementFields) ||
      typeof input.sessionCookie !== 'string' || input.sessionCookie.length === 0 || input.sessionCookie.length > 8192 ||
      typeof input.actor.workspaceId !== 'string' || typeof input.actor.reviewerUserId !== 'string')
    throw new Error('retirement_invalid');
  const context = await dependencies.resolveContext(input.sessionCookie);
  if (context.workspace.id !== input.actor.workspaceId || context.user.id !== input.actor.reviewerUserId ||
      context.workspace.ownerUserId !== context.user.id) throw new Error('retirement_unauthorized');
  return dependencies.retire(context, input.retirement as unknown as ReviewedRetirementRequest);
}
