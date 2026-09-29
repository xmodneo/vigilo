import { and, eq } from 'drizzle-orm';

import { repository } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';

export class RepositoryPolicyError extends Error {
  readonly code = 'private_repository_not_supported';
  constructor() { super('private_repository_not_supported'); }
}

export function assertPublicRepository(repository: { isPrivate: boolean }): void {
  if (repository.isPrivate) throw new RepositoryPolicyError();
}

export async function assertPublicRepositoryAuthority(database: VigiloDatabase, workspaceId: string, githubRepositoryId: number): Promise<void> {
  const [selected] = await database.select({ isPrivate: repository.isPrivate }).from(repository).where(and(
    eq(repository.workspaceId, workspaceId), eq(repository.githubRepositoryId, githubRepositoryId),
  )).limit(1);
  if (!selected) throw new RepositoryPolicyError();
  assertPublicRepository(selected);
}
