import { eq } from 'drizzle-orm';

import { repairRun, repairRunSourceCheckpoint } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { ExternalExecutionAuthorityError } from './types.ts';

const HASH = /^[0-9a-f]{64}$/;

/** Operator-controlled staging only. There is intentionally no public route. */
export async function stageReviewedSourceCheckpoint(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  repairRunId: string,
  expectedSourceIdentity: string,
  planIdentity: string,
) {
  if (!HASH.test(expectedSourceIdentity) || !HASH.test(planIdentity)) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
  const [run] = await database.select({ workspaceId: repairRun.workspaceId }).from(repairRun)
    .where(eq(repairRun.id, repairRunId)).limit(1);
  if (!run || run.workspaceId !== context.workspace.id || context.user.id !== context.workspace.ownerUserId)
    throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
  const [row] = await database.insert(repairRunSourceCheckpoint).values({
    repairRunId, expectedSourceIdentity, planIdentity, reviewedBy: context.user.id,
  }).returning();
  if (!row) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
  return row;
}

/** PostgreSQL derives observed identity/state from immutable baseline evidence. */
export async function finalizeReviewedSourceCheckpoint(database: VigiloDatabase, repairRunId: string, baselineId: string) {
  const [row] = await database.update(repairRunSourceCheckpoint).set({ baselineId })
    .where(eq(repairRunSourceCheckpoint.repairRunId, repairRunId)).returning();
  if (!row) throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
  return row;
}

export async function finalizeSourceCheckpointIfStaged(database: VigiloDatabase, repairRunId: string, baselineId: string): Promise<void> {
  const [row] = await database.select({ state: repairRunSourceCheckpoint.state }).from(repairRunSourceCheckpoint)
    .where(eq(repairRunSourceCheckpoint.repairRunId, repairRunId)).limit(1);
  if (row?.state === 'pending') await finalizeReviewedSourceCheckpoint(database, repairRunId, baselineId);
}

export async function assertMatchedSourceCheckpoint(database: VigiloDatabase, repairRunId: string): Promise<void> {
  const [row] = await database.select({ state: repairRunSourceCheckpoint.state }).from(repairRunSourceCheckpoint)
    .where(eq(repairRunSourceCheckpoint.repairRunId, repairRunId)).limit(1);
  if (row && row.state !== 'matched') throw new ExternalExecutionAuthorityError('execution_authority_mismatch');
}
