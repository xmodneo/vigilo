import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { PgBossAiCandidateGenerationQueue } from '../repair-runs/queue.ts';
import { getAiCandidateGenerationForAiInvestigation } from './flow.ts';
import { createAiCandidateGenerationHandlers } from './handlers.ts';

async function dependencies() { const infrastructure = await getJobPublisherInfrastructure(); return { ...infrastructure, queue: new PgBossAiCandidateGenerationQueue(infrastructure.boss), resolveContext: resolveRequestWorkspace }; }
export async function getAiCandidateGenerationHandlers() { return createAiCandidateGenerationHandlers(await dependencies()); }
export async function getAiCandidateGenerationForContext(context: AuthenticatedWorkspace, aiInvestigationId: string) { return getAiCandidateGenerationForAiInvestigation((await dependencies()).database, context, aiInvestigationId); }
