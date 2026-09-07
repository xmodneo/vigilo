import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { workspace } from '../db/schema.ts';
import type { VigiloDatabase } from './db/types.ts';

export type Workspace = typeof workspace.$inferSelect;

export async function ensureWorkspaceForUser(
  database: VigiloDatabase,
  userId: string,
): Promise<Workspace> {
  await database
    .insert(workspace)
    .values({
      id: randomUUID(),
      ownerUserId: userId,
    })
    .onConflictDoNothing({ target: workspace.ownerUserId });

  const [ownedWorkspace] = await database
    .select()
    .from(workspace)
    .where(eq(workspace.ownerUserId, userId))
    .limit(1);

  if (!ownedWorkspace) {
    throw new Error('workspace_provisioning_failed');
  }

  return ownedWorkspace;
}
