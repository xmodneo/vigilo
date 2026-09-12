import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { PgBossAiInvestigationQueue } from '../repair-runs/queue.ts';
import { getAiInvestigationForInvestigation } from './flow.ts';
import { createAiInvestigationHandlers } from './handlers.ts';

async function dependencies() { const infrastructure = await getJobPublisherInfrastructure(); return { ...infrastructure, queue: new PgBossAiInvestigationQueue(infrastructure.boss), resolveContext: resolveRequestWorkspace }; }
export async function getAiInvestigationHandlers() { return createAiInvestigationHandlers(await dependencies()); }
export async function getAiInvestigationForContext(context: AuthenticatedWorkspace, investigationId: string) { return getAiInvestigationForInvestigation((await dependencies()).database, context, investigationId); }
