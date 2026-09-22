import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { ApprovedHumanReviewAuthority } from '../human-reviews/types.ts';
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
export function processRepairPublicationJobForTest(job: RepairQueueJob, dependencies: RepairPublicationWorkerDependencies, resolver: PublicationAuthorityResolver) {
  return processRepairPublicationJobWithResolverInternal(job, dependencies, resolver);
}
