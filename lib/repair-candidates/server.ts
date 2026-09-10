import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { getLatestRepairCandidate } from './flow.ts';

export async function getLatestRepairCandidateForContext(context: AuthenticatedWorkspace, investigationId: string) {
  return getLatestRepairCandidate((await getJobPublisherInfrastructure()).database, context, investigationId);
}

export function publicRepairCandidate(value: Awaited<ReturnType<typeof getLatestRepairCandidate>> | null) {
  if (!value) return null;
  return {
    id: value.id,
    investigationId: value.investigationId,
    ordinal: value.ordinal,
    state: value.state,
    candidateIdentity: value.candidateIdentity,
    changedFileCount: value.changedFileCount,
    totalResultBytes: value.totalResultBytes,
    rejectionCode: value.rejectionCode,
    createdAt: value.createdAt.toISOString(),
    completedAt: value.completedAt?.toISOString() ?? null,
  };
}
