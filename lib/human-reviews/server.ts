import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { readServerEnvironment } from '../auth/environment.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getAuthDatabase } from '../auth/server.ts';
import { getHumanReview } from './flow.ts';
import { createHumanReviewHandlers } from './handlers.ts';

function dependencies() {
  return {
    configuration: { baseUrl: readServerEnvironment().baseUrl },
    database: getAuthDatabase(),
    resolveContext: resolveRequestWorkspace,
  };
}

export function getHumanReviewHandlers() {
  return createHumanReviewHandlers(dependencies());
}

export function getHumanReviewForContext(context: AuthenticatedWorkspace, repairRunId: string) {
  return getHumanReview(getAuthDatabase(), context, repairRunId);
}
