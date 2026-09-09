import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { getLatestRepairRun } from './flow.ts';
import { createRepairRunHandlers } from './handlers.ts';
import { PgBossRepairQueue } from './queue.ts';

async function getDependencies() {
  const infrastructure = await getJobPublisherInfrastructure();
  return { ...infrastructure, queue: new PgBossRepairQueue(infrastructure.boss) };
}

export async function getRepairRunHandlers() {
  return createRepairRunHandlers({ ...(await getDependencies()), resolveContext: resolveRequestWorkspace });
}

export async function getLatestRepairRunForContext(context: AuthenticatedWorkspace, githubRepositoryId: number) {
  return getLatestRepairRun((await getDependencies()).database, context, githubRepositoryId);
}
