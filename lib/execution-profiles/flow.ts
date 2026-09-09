import { and, eq } from 'drizzle-orm';

import {
  executionProfile,
  githubInstallation,
  repository,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { detectExecutionProfile } from './detector.ts';
import type {
  ExecutionProfileDraft,
  GitHubExecutionProfileGateway,
  InstallationRepositoryMetadata,
} from './types.ts';

export type ExecutionProfileErrorCode =
  | 'installation_unavailable'
  | 'profile_unavailable'
  | 'repository_access_changed'
  | 'repository_not_selected'
  | 'repository_state_changed';

export class ExecutionProfileError extends Error {
  constructor(public readonly code: ExecutionProfileErrorCode) {
    super(code);
    this.name = 'ExecutionProfileError';
  }
}

function sameRepository(
  first: InstallationRepositoryMetadata,
  second: InstallationRepositoryMetadata,
): boolean {
  return (
    first.id === second.id &&
    first.ownerId === second.ownerId &&
    first.ownerLogin === second.ownerLogin &&
    first.name === second.name &&
    first.fullName === second.fullName &&
    first.defaultBranch === second.defaultBranch &&
    first.isPrivate === second.isPrivate
  );
}

export function validExecutionInstallation(
  value: Awaited<ReturnType<GitHubExecutionProfileGateway['getInstallation']>>,
  installationId: number,
  configuration: GitHubAppConfiguration,
): boolean {
  return (
    value.id === installationId &&
    value.appId === configuration.appId &&
    value.appSlug === configuration.appSlug &&
    value.suspendedAt === null &&
    ['read', 'write'].includes(value.permissions.contents ?? '') &&
    ['read', 'write'].includes(value.permissions.metadata ?? '')
  );
}

async function selectedRepository(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
) {
  const [selected] = await database
    .select({
      defaultBranch: repository.defaultBranch,
      githubRepositoryId: repository.githubRepositoryId,
      installationId: repository.installationId,
    })
    .from(repository)
    .innerJoin(
      githubInstallation,
      and(
        eq(githubInstallation.installationId, repository.installationId),
        eq(githubInstallation.workspaceId, context.workspace.id),
        eq(githubInstallation.status, 'active'),
      ),
    )
    .where(eq(repository.workspaceId, context.workspace.id))
    .limit(1);
  if (!selected) throw new ExecutionProfileError('repository_not_selected');
  return selected;
}

function profileValues(draft: ExecutionProfileDraft, updatedAt: Date) {
  if (draft.status === 'unsupported') {
    return {
      baseCommitSha: draft.baseCommitSha,
      buildScript: null,
      githubRepositoryId: draft.githubRepositoryId,
      installOperation: null,
      installationId: draft.installationId,
      lockfileType: null,
      nodeMajor: null,
      packageJsonBlobSha: null,
      packageJsonContentSha256: null,
      packageLockBlobSha: null,
      packageLockContentSha256: null,
      packageManager: null,
      profileIdentity: null,
      profileVersion: draft.profileVersion,
      runtimeFamily: null,
      status: draft.status,
      testRunner: null,
      testScript: null,
      typecheckScript: null,
      unsupportedReason: draft.reason,
      updatedAt,
      workspaceId: draft.workspaceId,
    } as const;
  }
  return {
    baseCommitSha: draft.baseCommitSha,
    buildScript: draft.build?.script ?? null,
    githubRepositoryId: draft.githubRepositoryId,
    installOperation: draft.install.operation,
    installationId: draft.installationId,
    lockfileType: draft.lockfileType,
    nodeMajor: draft.nodeMajor,
    packageJsonBlobSha: draft.packageJsonBlobSha,
    packageJsonContentSha256: draft.packageJsonContentSha256,
    packageLockBlobSha: draft.packageLockBlobSha,
    packageLockContentSha256: draft.packageLockContentSha256,
    packageManager: draft.packageManager,
    profileIdentity: draft.profileIdentity,
    profileVersion: draft.profileVersion,
    runtimeFamily: draft.runtimeFamily,
    status: draft.status,
    testRunner: draft.testRunner,
    testScript: draft.test.script,
    typecheckScript: draft.typecheck?.script ?? null,
    unsupportedReason: null,
    updatedAt,
    workspaceId: draft.workspaceId,
  } as const;
}

async function persistProfile(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  metadata: InstallationRepositoryMetadata,
  draft: ExecutionProfileDraft,
  now: Date,
) {
  const updatedRepositories = await database
    .update(repository)
    .set({
      defaultBranch: metadata.defaultBranch,
      fullName: metadata.fullName,
      isPrivate: metadata.isPrivate,
      name: metadata.name,
      ownerId: metadata.ownerId,
      ownerLogin: metadata.ownerLogin,
      updatedAt: now,
    })
    .where(
      and(
        eq(repository.githubRepositoryId, draft.githubRepositoryId),
        eq(repository.workspaceId, context.workspace.id),
        eq(repository.installationId, draft.installationId),
      ),
    )
    .returning({ id: repository.githubRepositoryId });
  if (updatedRepositories.length !== 1) {
    throw new ExecutionProfileError('repository_access_changed');
  }

  const values = profileValues(draft, now);
  await database
    .insert(executionProfile)
    .values(values)
    .onConflictDoUpdate({
      set: values,
      target: executionProfile.githubRepositoryId,
    });
  const [saved] = await database
    .select()
    .from(executionProfile)
    .where(
      and(
        eq(executionProfile.githubRepositoryId, draft.githubRepositoryId),
        eq(executionProfile.workspaceId, context.workspace.id),
      ),
    )
    .limit(1);
  if (!saved) throw new ExecutionProfileError('profile_unavailable');
  return saved;
}

export async function detectSelectedRepositoryExecutionProfile(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  gateway: GitHubExecutionProfileGateway,
  configuration: GitHubAppConfiguration,
  now = new Date(),
) {
  const selected = await selectedRepository(database, context);
  let accessToken: string | undefined;
  let draft: ExecutionProfileDraft | undefined;
  let metadata: InstallationRepositoryMetadata | undefined;

  try {
    const installation = await gateway.getInstallation(selected.installationId);
    if (!validExecutionInstallation(installation, selected.installationId, configuration)) {
      throw new ExecutionProfileError('installation_unavailable');
    }
    const scoped = await gateway.createInstallationAccessToken({
      installationId: selected.installationId,
      repositoryId: selected.githubRepositoryId,
    });
    accessToken = scoped.accessToken;
    if (scoped.repository.id !== selected.githubRepositoryId) {
      throw new ExecutionProfileError('repository_access_changed');
    }

    const currentMetadata = await gateway.getRepositoryMetadata(
      accessToken,
      scoped.repository.ownerLogin,
      scoped.repository.name,
    );
    if (
      currentMetadata.id !== selected.githubRepositoryId ||
      !sameRepository(scoped.repository, currentMetadata)
    ) {
      throw new ExecutionProfileError('repository_access_changed');
    }
    metadata = currentMetadata;

    const baseCommitSha = await gateway.resolveBranchCommit({
      accessToken,
      branch: metadata.defaultBranch,
      owner: metadata.ownerLogin,
      repository: metadata.name,
    });
    const [rootEntries, packageJson, packageLock] = await Promise.all([
      gateway.getRepositoryRoot({
        accessToken,
        owner: metadata.ownerLogin,
        ref: baseCommitSha,
        repository: metadata.name,
      }),
      gateway.getRepositoryFile({
        accessToken,
        owner: metadata.ownerLogin,
        path: 'package.json',
        ref: baseCommitSha,
        repository: metadata.name,
      }),
      gateway.getRepositoryFile({
        accessToken,
        owner: metadata.ownerLogin,
        path: 'package-lock.json',
        ref: baseCommitSha,
        repository: metadata.name,
      }),
    ]);

    const [confirmedCommitSha, confirmedMetadata, confirmedInstallation] = await Promise.all([
      gateway.resolveBranchCommit({
        accessToken,
        branch: metadata.defaultBranch,
        owner: metadata.ownerLogin,
        repository: metadata.name,
      }),
      gateway.getRepositoryMetadata(accessToken, metadata.ownerLogin, metadata.name),
      gateway.getInstallation(selected.installationId),
    ]);
    if (confirmedCommitSha !== baseCommitSha || !sameRepository(metadata, confirmedMetadata)) {
      throw new ExecutionProfileError('repository_state_changed');
    }
    if (!validExecutionInstallation(confirmedInstallation, selected.installationId, configuration)) {
      throw new ExecutionProfileError('installation_unavailable');
    }

    draft = detectExecutionProfile({
      baseCommitSha,
      githubRepositoryId: selected.githubRepositoryId,
      installationId: selected.installationId,
      packageJson,
      packageLock,
      rootEntries,
      workspaceId: context.workspace.id,
    });
  } finally {
    if (accessToken) await gateway.revokeInstallationAccessToken(accessToken);
  }

  if (!draft || !metadata) throw new ExecutionProfileError('profile_unavailable');
  return persistProfile(database, context, metadata, draft, now);
}

export async function getCurrentExecutionProfile(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
) {
  const [current] = await database
    .select({ profile: executionProfile })
    .from(executionProfile)
    .innerJoin(
      repository,
      and(
        eq(repository.githubRepositoryId, executionProfile.githubRepositoryId),
        eq(repository.workspaceId, context.workspace.id),
      ),
    )
    .innerJoin(
      githubInstallation,
      and(
        eq(githubInstallation.installationId, executionProfile.installationId),
        eq(githubInstallation.workspaceId, context.workspace.id),
        eq(githubInstallation.status, 'active'),
      ),
    )
    .where(eq(executionProfile.workspaceId, context.workspace.id))
    .limit(1);
  return current?.profile ?? null;
}
