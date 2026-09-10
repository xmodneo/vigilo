import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { PgBossCandidateVerificationQueue } from '../repair-runs/queue.ts';
import { getCandidateVerificationForCandidate } from './flow.ts';
import { createCandidateVerificationHandlers } from './handlers.ts';

async function dependencies() {
  const infrastructure = await getJobPublisherInfrastructure();
  return { ...infrastructure, queue: new PgBossCandidateVerificationQueue(infrastructure.boss), resolveContext: resolveRequestWorkspace };
}

export async function getCandidateVerificationHandlers() {
  return createCandidateVerificationHandlers(await dependencies());
}

export async function getCandidateVerificationForContext(context: AuthenticatedWorkspace, candidateId: string) {
  return getCandidateVerificationForCandidate((await dependencies()).database, context, candidateId);
}
