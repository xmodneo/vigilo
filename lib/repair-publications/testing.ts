import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { ApprovedHumanReviewAuthority } from '../human-reviews/types.ts';
import type { ApprovedPublicationAuthority } from '../release-acceptance/publication-gate.ts';
import type { TransactionalRepairPublicationQueue } from '../repair-runs/queue.ts';
import { reserveRepairPublicationWithAuthority } from './flow.ts';
import { processRepairPublicationJobWithResolverInternal, type PublicationAuthorityResolver, type RepairPublicationWorkerDependencies } from './worker.ts';
import type { RepairQueueJob } from '../repair-runs/queue.ts';

/** Test-local release-gate boundary. Production server and worker modules never import this file. */
export function reserveApprovedPublicationForTest(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  queues: TransactionalRepairPublicationQueue,
  authority: ApprovedHumanReviewAuthority,
  input: { decisionIdentity: string; idempotencyKey: string },
  options?: { clock?: () => Date; randomId?: () => string },
) {
  return reserveRepairPublicationWithAuthority(database, context, queues, authority, input, options);
}

/** Test-local worker boundary. Production modules never import this file. */
export function processRepairPublicationJobForTest(
  job: RepairQueueJob,
  dependencies: RepairPublicationWorkerDependencies,
  resolver: (database: VigiloDatabase, workspaceId: string, decisionId: string, publicationId: string) => Promise<ApprovedHumanReviewAuthority | ApprovedPublicationAuthority>,
) {
  const wrapped: PublicationAuthorityResolver = async (database, workspaceId, decisionId, publicationId) => {
    const authority = await resolver(database, workspaceId, decisionId, publicationId);
    return 'releaseAuthorization' in authority ? authority : approvedPublicationAuthorityForTest(authority);
  };
  return processRepairPublicationJobWithResolverInternal(job, dependencies, wrapped);
}

/** Test-only adapter for publication artifact tests that intentionally bypass the production release gate. */
export function approvedPublicationAuthorityForTest(authority: ApprovedHumanReviewAuthority): ApprovedPublicationAuthority {
  return {
    ...authority,
    releaseAuthorization: {
      mode: 'normal',
      releasedCommitSha: '0'.repeat(40),
      // Empty only inside this test-local adapter. Production resolvers always
      // return the exact three- or four-row immutable acceptance set.
      acceptanceIds: [] as unknown as readonly [string, string, string, string],
    },
  };
}
