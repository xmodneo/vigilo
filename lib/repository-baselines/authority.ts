import { and, eq } from 'drizzle-orm';

import { executionProfile, githubInstallation, repository } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { computeExecutionProfileIdentity } from '../execution-profiles/detector.ts';
import type { FrozenBaselineProfile } from './types.ts';

export class BaselineAuthorityError extends Error {
  constructor(public readonly code:
    | 'repository_not_selected'
    | 'profile_not_ready'
    | 'profile_corrupt'
    | 'repository_profile_mismatch') {
    super(code);
    this.name = 'BaselineAuthorityError';
  }
}

export function frozenBaselineProfile(value: typeof executionProfile.$inferSelect): FrozenBaselineProfile {
  if (
    value.status !== 'ready' || value.profileVersion !== 2 ||
    !value.profileIdentity || !value.packageJsonBlobSha || !value.packageJsonContentSha256 ||
    !value.packageLockBlobSha || !value.packageLockContentSha256 ||
    value.runtimeFamily !== 'node' || value.nodeMajor !== 24 ||
    value.packageManager !== 'npm' || value.lockfileType !== 'package-lock' ||
    value.installOperation !== 'ci' || value.testScript !== 'test' ||
    !['node-test', 'vitest', 'jest'].includes(value.testRunner ?? '') ||
    ![null, 'typecheck'].includes(value.typecheckScript) ||
    ![null, 'build'].includes(value.buildScript)
  ) throw new BaselineAuthorityError('profile_not_ready');

  const profile: FrozenBaselineProfile = {
    baseCommitSha: value.baseCommitSha,
    buildScript: value.buildScript as 'build' | null,
    githubRepositoryId: value.githubRepositoryId,
    installationId: value.installationId,
    packageJsonBlobSha: value.packageJsonBlobSha,
    packageJsonContentSha256: value.packageJsonContentSha256,
    packageLockBlobSha: value.packageLockBlobSha,
    packageLockContentSha256: value.packageLockContentSha256,
    profileIdentity: value.profileIdentity,
    profileVersion: 2,
    testRunner: value.testRunner as FrozenBaselineProfile['testRunner'],
    testScript: 'test',
    typecheckScript: value.typecheckScript as 'typecheck' | null,
    workspaceId: value.workspaceId,
  };
  const recomputed = computeExecutionProfileIdentity({
    baseCommitSha: profile.baseCommitSha,
    build: profile.buildScript ? { script: 'build', tool: 'npm' } : null,
    githubRepositoryId: profile.githubRepositoryId,
    install: { operation: 'ci', tool: 'npm' },
    installationId: profile.installationId,
    lockfileType: 'package-lock',
    nodeMajor: 24,
    packageJsonBlobSha: profile.packageJsonBlobSha,
    packageJsonContentSha256: profile.packageJsonContentSha256,
    packageLockBlobSha: profile.packageLockBlobSha,
    packageLockContentSha256: profile.packageLockContentSha256,
    packageManager: 'npm',
    profileVersion: 2,
    runtimeFamily: 'node',
    test: { script: 'test', tool: 'npm' },
    testRunner: profile.testRunner,
    typecheck: profile.typecheckScript ? { script: 'typecheck', tool: 'npm' } : null,
    workspaceId: profile.workspaceId,
  });
  if (recomputed !== profile.profileIdentity) {
    throw new BaselineAuthorityError('profile_corrupt');
  }
  return profile;
}

export async function resolveBaselineAuthority(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
) {
  const [value] = await database
    .select({ installation: githubInstallation, profile: executionProfile, repository })
    .from(repository)
    .innerJoin(executionProfile, eq(executionProfile.githubRepositoryId, repository.githubRepositoryId))
    .innerJoin(githubInstallation, eq(githubInstallation.installationId, repository.installationId))
    .where(and(
      eq(repository.workspaceId, context.workspace.id),
      eq(executionProfile.workspaceId, context.workspace.id),
      eq(githubInstallation.workspaceId, context.workspace.id),
      eq(githubInstallation.status, 'active'),
    ))
    .limit(1);
  if (!value) throw new BaselineAuthorityError('repository_not_selected');
  const profile = frozenBaselineProfile(value.profile);
  if (
    profile.githubRepositoryId !== value.repository.githubRepositoryId ||
    profile.installationId !== value.repository.installationId ||
    profile.workspaceId !== value.repository.workspaceId
  ) throw new BaselineAuthorityError('repository_profile_mismatch');
  return {
    profile,
    repository: {
      defaultBranch: value.repository.defaultBranch ?? '',
      fullName: value.repository.fullName,
      id: value.repository.githubRepositoryId,
      isPrivate: value.repository.isPrivate,
      name: value.repository.name,
      ownerId: value.repository.ownerId,
      ownerLogin: value.repository.ownerLogin,
    },
  };
}
