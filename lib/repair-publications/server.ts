import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { PgBossRepairPublicationQueue } from '../repair-runs/queue.ts';
import { getRepairPublicationHistory } from './flow.ts';
import { createRepairPublicationHandlers } from './handlers.ts';

async function dependencies() {
  const infrastructure = await getJobPublisherInfrastructure();
  const queue = new PgBossRepairPublicationQueue(infrastructure.boss);
  return { ...infrastructure, queue: { enqueuePublication: queue.enqueuePublication.bind(queue) }, resolveContext: resolveRequestWorkspace };
}

export async function getRepairPublicationHandlers() { return createRepairPublicationHandlers(await dependencies()); }
export async function getRepairPublicationForContext(context: AuthenticatedWorkspace, repairRunId: string) { return getRepairPublicationHistory((await dependencies()).database, context, repairRunId); }
