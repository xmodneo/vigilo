import { and, eq } from 'drizzle-orm';

import { repairRun, repairRunSourceCheckpoint } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { assertRunBusinessAllowed } from './business-fence.ts';
import { freshDatabaseTime } from './database-clock.ts';
import { assertReviewedPlanIntegrity } from './reviewed-plan-integrity.ts';
import { isReviewedStagingPlanIdentity } from './reviewed-plan.ts';

export type ReviewedHandoffAvailability = 'eligible' | 'ineligible' | 'not_reviewed';

/** Read-only UI hint for one reviewed run. Exact-job enqueue and execution recheck authority independently. */
export async function resolveReviewedHandoffAvailability(
  database: VigiloDatabase,
  subject: { workspaceId: string; ownerUserId: string; repairRunId: string; githubRepositoryId: number; runtimeReleaseSha: string },
): Promise<ReviewedHandoffAvailability> {
  try {
    if (!/^[0-9a-f]{40}$/.test(subject.runtimeReleaseSha)) return 'ineligible';
    const [run] = await database.select().from(repairRun).where(and(
      eq(repairRun.id, subject.repairRunId), eq(repairRun.workspaceId, subject.workspaceId),
    )).limit(1);
    if (!run || run.githubRepositoryId !== subject.githubRepositoryId) return 'ineligible';
    const [checkpoint] = await database.select().from(repairRunSourceCheckpoint)
      .where(eq(repairRunSourceCheckpoint.repairRunId, run.id)).limit(1);
    if (!checkpoint || !isReviewedStagingPlanIdentity(checkpoint.planIdentity)) return 'not_reviewed';
    if (run.state !== 'ready_for_investigation') return 'ineligible';
    const now = await freshDatabaseTime(database);
    if (!await assertReviewedPlanIntegrity(database, run.id, subject.runtimeReleaseSha, now)) return 'ineligible';
    if (checkpoint.reviewedBy !== subject.ownerUserId || checkpoint.state !== 'matched') return 'ineligible';
    await assertRunBusinessAllowed(database, { workspaceId: subject.workspaceId, repairRunId: run.id });
    return 'eligible';
  } catch {
    return 'ineligible';
  }
}
