import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { PgBossAiCandidateGenerationQueue, PgBossCandidateVerificationQueue, PgBossRepairLoopQueue } from '../repair-runs/queue.ts';
import { getRepairLoopForRun } from './flow.ts';
import { createRepairLoopHandlers } from './handlers.ts';

async function dependencies() {
  const infrastructure = await getJobPublisherInfrastructure();
  const loop = new PgBossRepairLoopQueue(infrastructure.boss);
  const generation = new PgBossAiCandidateGenerationQueue(infrastructure.boss);
  const verification = new PgBossCandidateVerificationQueue(infrastructure.boss);
  return { ...infrastructure, queues: {
    enqueueRepairLoop: loop.enqueueRepairLoop.bind(loop),
    enqueueAiCandidateGeneration: generation.enqueueAiCandidateGeneration.bind(generation),
    enqueueVerification: verification.enqueueVerification.bind(verification),
  }, resolveContext: resolveRequestWorkspace };
}

export async function getRepairLoopHandlers() { return createRepairLoopHandlers(await dependencies()); }
export async function getRepairLoopForContext(context: AuthenticatedWorkspace, repairRunId: string) { return getRepairLoopForRun((await dependencies()).database, context, repairRunId); }
