import { and, eq } from 'drizzle-orm';

import { repairRun } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { freshDatabaseTime } from './database-clock.ts';
import { assertReviewedPlanIntegrity } from './reviewed-plan-integrity.ts';
import { ExternalExecutionAuthorityError } from './types.ts';

/** Called inside an owner handoff transaction after the global execution lock. */
export async function assertReviewedHandoffAuthority(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  repairRunId: string,
  runtimeReleaseSha = process.env.VIGILO_RELEASE_SHA ?? '',
): Promise<void> {
  const [run] = await database.select({ workspaceId: repairRun.workspaceId }).from(repairRun)
    .where(and(eq(repairRun.id, repairRunId), eq(repairRun.workspaceId, context.workspace.id)))
    .for('update').limit(1);
  if (!run || !context.user?.id || context.user.id !== context.workspace.ownerUserId)
    throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
  const now = await freshDatabaseTime(database);
  // These owner handoffs create new work only for a complete current reviewed
  // plan. A missing checkpoint is never evidence of legacy enqueue authority.
  if (!await assertReviewedPlanIntegrity(database, repairRunId, runtimeReleaseSha, now))
    throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
}
