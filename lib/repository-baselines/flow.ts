import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { executionProfile, githubInstallation, repository, repositoryBaseline } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { validExecutionInstallation } from '../execution-profiles/flow.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { resolveBaselineAuthority } from './authority.ts';
import { runFrozenRepositoryBaseline } from './runner.ts';
import type { BaselineEvidence, GitHubBaselineGateway } from './types.ts';
import type { SandboxLifecycleObserver } from '../../src/sandbox-boundary.ts';

export class RepositoryBaselineError extends Error {
  constructor(public readonly code: 'authority_changed' | 'installation_unavailable' | 'repository_access_changed' | 'source_unavailable' | 'persistence_failed') {
    super(code);
    this.name = 'RepositoryBaselineError';
  }
}

function sameRepository(first: { id: number; ownerId: number; ownerLogin: string; name: string }, second: { id: number; ownerId: number; ownerLogin: string; name: string }) {
  return first.id === second.id && first.ownerId === second.ownerId && first.ownerLogin === second.ownerLogin && first.name === second.name;
}

function commandValues(command: BaselineEvidence['install']) {
  return { exitCode: command.exitCode, status: command.status, timedOut: command.timedOut };
}

async function persistBaseline(database: VigiloDatabase, report: BaselineEvidence) {
  const install = commandValues(report.install);
  const typecheck = report.typecheck ? commandValues(report.typecheck) : null;
  const build = report.build ? commandValues(report.build) : null;
  const tests = commandValues(report.test);
  const inserted = await database.insert(repositoryBaseline).values({
    archiveSha256: report.archiveSha256,
    baseCommitSha: report.baseCommitSha,
    buildExitCode: build?.exitCode ?? null,
    buildStatus: build?.status ?? null,
    buildTimedOut: build?.timedOut ?? null,
    cleanupDelete: report.cleanup.delete,
    cleanupLookup: report.cleanup.lookup,
    cleanupStop: report.cleanup.stop,
    completedAt: report.completedAt,
    credentialsExposure: report.credentialsExposure,
    durationMs: report.durationMs,
    errorCode: report.error?.code ?? null,
    errorPhase: report.error?.phase ?? null,
    evidenceVersion: report.evidenceVersion,
    executionOutcome: report.executionOutcome,
    githubRepositoryId: report.githubRepositoryId,
    id: report.runId,
    installExitCode: install.exitCode,
    installationId: report.installationId,
    installStatus: install.status,
    installTimedOut: install.timedOut,
    networkPolicy: report.networkPolicyBeforeRepositoryExecution,
    overallOutcome: report.overallOutcome,
    profileIdentity: report.profileIdentity,
    sandboxName: report.sandbox.name,
    sandboxSessionId: report.sandbox.sessionId,
    sourceIdentityAfter: report.source.identityAfterExecution,
    sourceIdentityBefore: report.source.identityBeforeExecution,
    sourceUnchanged: report.source.unchangedAfterExecution,
    startedAt: report.startedAt,
    testExitCode: tests.exitCode,
    testStatus: tests.status,
    testTimedOut: tests.timedOut,
    typecheckExitCode: typecheck?.exitCode ?? null,
    typecheckStatus: typecheck?.status ?? null,
    typecheckTimedOut: typecheck?.timedOut ?? null,
    workspaceId: report.workspaceId,
  }).returning({ id: repositoryBaseline.id });
  if (inserted.length !== 1) throw new RepositoryBaselineError('persistence_failed');
}

export async function executeSelectedRepositoryBaseline(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  gateway: GitHubBaselineGateway,
  configuration: GitHubAppConfiguration,
  options: {
    cancellation?: AbortSignal;
    clock?: () => Date;
    evidenceId?: string;
    expectedAuthority?: { workspaceId: string; githubRepositoryId: number; installationId: number; profileIdentity: string; baseCommitSha: string };
    authorizePersistence?: (evidence: BaselineEvidence) => Promise<void>;
    randomId?: () => string;
    runner?: typeof runFrozenRepositoryBaseline;
    sandboxObserver?: SandboxLifecycleObserver;
  } = {},
) {
  const authority = await resolveBaselineAuthority(database, context);
  if (options.expectedAuthority && (
    authority.profile.workspaceId !== options.expectedAuthority.workspaceId ||
    authority.profile.githubRepositoryId !== options.expectedAuthority.githubRepositoryId ||
    authority.profile.installationId !== options.expectedAuthority.installationId ||
    authority.profile.profileIdentity !== options.expectedAuthority.profileIdentity ||
    authority.profile.baseCommitSha !== options.expectedAuthority.baseCommitSha
  )) throw new RepositoryBaselineError('authority_changed');
  let token: string | undefined;
  let archive: Buffer | undefined;
  try {
    const installation = await gateway.getInstallation(authority.profile.installationId);
    if (!validExecutionInstallation(installation, authority.profile.installationId, configuration)) {
      throw new RepositoryBaselineError('installation_unavailable');
    }
    const scoped = await gateway.createInstallationAccessToken({
      installationId: authority.profile.installationId,
      repositoryId: authority.profile.githubRepositoryId,
    });
    token = scoped.accessToken;
    if (scoped.repository.id !== authority.profile.githubRepositoryId) throw new RepositoryBaselineError('repository_access_changed');
    const current = await gateway.getRepositoryMetadata(token, scoped.repository.ownerLogin, scoped.repository.name);
    if (!sameRepository(scoped.repository, current)) throw new RepositoryBaselineError('repository_access_changed');
    archive = await gateway.downloadRepositoryArchive({
      accessToken: token,
      owner: current.ownerLogin,
      ref: authority.profile.baseCommitSha,
      repository: current.name,
    });
  } finally {
    if (token) await gateway.revokeInstallationAccessToken(token);
  }
  if (!archive || archive.byteLength === 0) throw new RepositoryBaselineError('source_unavailable');
  const clock = options.clock ?? (() => new Date());
  const report = await (options.runner ?? runFrozenRepositoryBaseline)({
    ...authority,
    archive,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    runId: options.evidenceId ?? options.randomId?.() ?? randomUUID(),
    startedAt: clock(),
  }, options.cancellation, clock, options.sandboxObserver);
  await options.authorizePersistence?.(report);
  await persistBaseline(database, report);
  return report;
}

export async function getCurrentRepositoryBaseline(database: VigiloDatabase, context: AuthenticatedWorkspace) {
  const [value] = await database
    .select({ baseline: repositoryBaseline })
    .from(repositoryBaseline)
    .innerJoin(repository, and(
      eq(repository.githubRepositoryId, repositoryBaseline.githubRepositoryId),
      eq(repository.workspaceId, context.workspace.id),
    ))
    .innerJoin(executionProfile, and(
      eq(executionProfile.githubRepositoryId, repositoryBaseline.githubRepositoryId),
      eq(executionProfile.profileIdentity, repositoryBaseline.profileIdentity),
      eq(executionProfile.status, 'ready'),
    ))
    .innerJoin(githubInstallation, and(
      eq(githubInstallation.installationId, repositoryBaseline.installationId),
      eq(githubInstallation.workspaceId, context.workspace.id),
      eq(githubInstallation.status, 'active'),
    ))
    .where(eq(repositoryBaseline.workspaceId, context.workspace.id))
    .orderBy(desc(repositoryBaseline.completedAt))
    .limit(1);
  return value?.baseline ?? null;
}
