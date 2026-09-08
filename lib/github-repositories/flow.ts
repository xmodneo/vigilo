import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';

import {
  githubInstallation,
  githubRepositoryAccessAttempt,
  repository,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type {
  GitHubRepository,
  GitHubRepositoryAccessGateway,
  GitHubUserInstallationRepository,
} from './types.ts';

const ATTEMPT_LIFETIME_MS = 10 * 60_000;
const MAX_SNAPSHOT_BYTES = 1_000_000;

export type RepositoryAccessErrorCode =
  | 'installation_required'
  | 'invalid_callback'
  | 'invalid_repository'
  | 'invalid_state'
  | 'provider_failure'
  | 'repository_conflict'
  | 'repository_not_eligible';

export class RepositoryAccessError extends Error {
  constructor(public readonly code: RepositoryAccessErrorCode) {
    super(code);
    this.name = 'RepositoryAccessError';
  }
}

export interface RepositoryOverview {
  repositories: GitHubRepository[] | null;
  selected: typeof repository.$inferSelect | null;
}

interface FlowOptions {
  now?: Date;
  randomToken?: () => string;
}

function currentTime(options: FlowOptions): Date {
  return options.now ?? new Date();
}

function generateToken(options: FlowOptions): string {
  return options.randomToken?.() ?? randomBytes(32).toString('base64url');
}

function validState(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function stateHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function callbackUrl(configuration: GitHubAppConfiguration): string {
  return new URL('/api/github/installations/callback', configuration.baseUrl).toString();
}

function parseRepositoryId(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,15}$/.test(text)) {
    throw new RepositoryAccessError('invalid_repository');
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw new RepositoryAccessError('invalid_repository');
  }
  return id;
}

function validRepository(value: GitHubRepository): boolean {
  return (
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    Number.isSafeInteger(value.ownerId) &&
    value.ownerId > 0 &&
    value.name.length > 0 &&
    value.name.length <= 255 &&
    value.ownerLogin.length > 0 &&
    value.ownerLogin.length <= 255 &&
    value.fullName === `${value.ownerLogin}/${value.name}` &&
    value.fullName.length <= 512 &&
    (value.defaultBranch === null ||
      (value.defaultBranch.length > 0 && value.defaultBranch.length <= 255)) &&
    !/[\u0000-\u001f\u007f]/.test(
      `${value.ownerLogin}${value.name}${value.fullName}${value.defaultBranch ?? ''}`,
    )
  );
}

function eligibleRepositories(
  values: GitHubUserInstallationRepository[],
): GitHubRepository[] {
  const result = new Map<number, GitHubRepository>();
  for (const value of values) {
    if (
      !validRepository(value) ||
      typeof value.permissions.admin !== 'boolean' ||
      typeof value.permissions.push !== 'boolean' ||
      result.has(value.id)
    ) {
      throw new RepositoryAccessError('provider_failure');
    }
    if (value.permissions.admin || value.permissions.push) {
      const { permissions: _permissions, ...metadata } = value;
      result.set(value.id, metadata);
    }
  }
  return [...result.values()].sort(
    (first, second) => first.fullName.localeCompare(second.fullName) || first.id - second.id,
  );
}

function serializeRepositories(values: GitHubRepository[]): string {
  const serialized = JSON.stringify(values);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new RepositoryAccessError('provider_failure');
  }
  return serialized;
}

function parseRepositories(value: string): GitHubRepository[] {
  if (Buffer.byteLength(value, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new RepositoryAccessError('provider_failure');
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    const repositories = parsed as GitHubRepository[];
    const ids = new Set<number>();
    for (const candidate of repositories) {
      if (!validRepository(candidate) || ids.has(candidate.id)) throw new Error();
      ids.add(candidate.id);
    }
    return repositories;
  } catch {
    throw new RepositoryAccessError('provider_failure');
  }
}

function mutableRepositoryValues(
  value: GitHubRepository,
  installationId: number,
  workspaceId: string,
  now: Date,
) {
  return {
    defaultBranch: value.defaultBranch,
    fullName: value.fullName,
    githubRepositoryId: value.id,
    installationId,
    isPrivate: value.isPrivate,
    name: value.name,
    ownerId: value.ownerId,
    ownerLogin: value.ownerLogin,
    updatedAt: now,
    workspaceId,
  };
}

async function requireInstallation(
  database: VigiloDatabase,
  workspaceId: string,
): Promise<number> {
  const [installation] = await database
    .select({ installationId: githubInstallation.installationId })
    .from(githubInstallation)
    .where(eq(githubInstallation.workspaceId, workspaceId))
    .limit(1);
  if (!installation) throw new RepositoryAccessError('installation_required');
  return installation.installationId;
}

export async function beginRepositoryAuthorization(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  configuration: GitHubAppConfiguration,
  input: { operation: 'list' } | { operation: 'select'; repositoryId: unknown },
  options: FlowOptions = {},
): Promise<{ redirectUrl: string }> {
  const now = currentTime(options);
  const installationId = await requireInstallation(database, context.workspace.id);
  const repositoryId =
    input.operation === 'select' ? parseRepositoryId(input.repositoryId) : null;
  const state = generateToken(options);
  const codeVerifier = generateToken(options);
  if (!validState(state) || !validState(codeVerifier)) {
    throw new RepositoryAccessError('invalid_state');
  }

  await database.insert(githubRepositoryAccessAttempt).values({
    codeVerifier,
    expiresAt: new Date(now.getTime() + ATTEMPT_LIFETIME_MS),
    id: randomUUID(),
    installationId,
    operation: input.operation,
    repositoryId,
    sessionId: context.sessionId,
    stateHash: stateHash(state),
    workspaceId: context.workspace.id,
  });

  const challenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  const redirectUrl = new URL('https://github.com/login/oauth/authorize');
  redirectUrl.searchParams.set('client_id', configuration.clientId);
  redirectUrl.searchParams.set('redirect_uri', callbackUrl(configuration));
  redirectUrl.searchParams.set('state', state);
  redirectUrl.searchParams.set('code_challenge', challenge);
  redirectUrl.searchParams.set('code_challenge_method', 'S256');
  return { redirectUrl: redirectUrl.toString() };
}

export async function hasRepositoryAccessAttempt(
  database: VigiloDatabase,
  state: string,
  now = new Date(),
): Promise<boolean> {
  if (!validState(state)) return false;
  const [attempt] = await database
    .select({ id: githubRepositoryAccessAttempt.id })
    .from(githubRepositoryAccessAttempt)
    .where(
      and(
        eq(githubRepositoryAccessAttempt.stateHash, stateHash(state)),
        isNull(githubRepositoryAccessAttempt.consumedAt),
        gt(githubRepositoryAccessAttempt.expiresAt, now),
      ),
    )
    .limit(1);
  return Boolean(attempt);
}

async function reconcileSelectedRepository(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  installationId: number,
  repositories: GitHubRepository[],
  now: Date,
): Promise<typeof repository.$inferSelect | null> {
  const [stored] = await database
    .select()
    .from(repository)
    .where(eq(repository.workspaceId, context.workspace.id))
    .limit(1);
  if (!stored) return null;
  const current = repositories.find((value) => value.id === stored.githubRepositoryId);
  if (!current) {
    await database.delete(repository).where(eq(repository.workspaceId, context.workspace.id));
    return null;
  }
  const [updated] = await database
    .update(repository)
    .set(mutableRepositoryValues(current, installationId, context.workspace.id, now))
    .where(eq(repository.workspaceId, context.workspace.id))
    .returning();
  if (!updated) throw new RepositoryAccessError('provider_failure');
  return updated;
}

async function persistSelectedRepository(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  installationId: number,
  selected: GitHubRepository,
  now: Date,
): Promise<void> {
  const values = mutableRepositoryValues(selected, installationId, context.workspace.id, now);
  try {
    const [existing] = await database
      .select({ githubRepositoryId: repository.githubRepositoryId })
      .from(repository)
      .where(eq(repository.workspaceId, context.workspace.id))
      .limit(1);
    if (existing) {
      await database
        .update(repository)
        .set(values)
        .where(eq(repository.workspaceId, context.workspace.id));
    } else {
      await database.insert(repository).values(values);
    }
  } catch {
    throw new RepositoryAccessError('repository_conflict');
  }
}

export async function completeRepositoryAuthorization(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  gateway: GitHubRepositoryAccessGateway,
  configuration: GitHubAppConfiguration,
  input: { code: string; state: string },
  options: Pick<FlowOptions, 'now'> = {},
): Promise<'listed' | 'selected'> {
  if (!validState(input.state) || input.code.length === 0 || input.code.length > 1_024) {
    throw new RepositoryAccessError('invalid_callback');
  }
  const now = currentTime(options);
  const [attempt] = await database
    .update(githubRepositoryAccessAttempt)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(githubRepositoryAccessAttempt.stateHash, stateHash(input.state)),
        eq(githubRepositoryAccessAttempt.workspaceId, context.workspace.id),
        eq(githubRepositoryAccessAttempt.sessionId, context.sessionId),
        isNull(githubRepositoryAccessAttempt.consumedAt),
        gt(githubRepositoryAccessAttempt.expiresAt, now),
      ),
    )
    .returning();
  if (!attempt?.codeVerifier) throw new RepositoryAccessError('invalid_state');

  let accessToken: string | undefined;
  let repositories: GitHubRepository[] | undefined;
  let failure: RepositoryAccessError | undefined;
  try {
    accessToken = await gateway.exchangeAuthorizationCode({
      code: input.code,
      codeVerifier: attempt.codeVerifier,
      redirectUri: callbackUrl(configuration),
      ...(attempt.repositoryId === null ? {} : { repositoryId: attempt.repositoryId }),
    });
    const authenticatedUserId = await gateway.getAuthenticatedUserId(accessToken);
    const installationIds = await gateway.listAccessibleInstallationIds(accessToken);
    if (
      authenticatedUserId !== context.githubUserId ||
      !installationIds.includes(attempt.installationId)
    ) {
      throw new RepositoryAccessError('repository_not_eligible');
    }
    repositories = eligibleRepositories(
      await gateway.listUserInstallationRepositories(accessToken, attempt.installationId),
    );
    if (
      attempt.operation === 'select' &&
      !repositories.some((value) => value.id === attempt.repositoryId)
    ) {
      throw new RepositoryAccessError('repository_not_eligible');
    }
  } catch (error) {
    failure = error instanceof RepositoryAccessError
      ? error
      : new RepositoryAccessError('provider_failure');
  }

  if (accessToken) {
    try {
      await gateway.revokeUserAccessToken(accessToken);
    } catch {
      failure = new RepositoryAccessError('provider_failure');
    }
  }
  try {
    await database
      .update(githubRepositoryAccessAttempt)
      .set({ codeVerifier: null, updatedAt: now })
      .where(eq(githubRepositoryAccessAttempt.id, attempt.id));
  } catch {
    failure = new RepositoryAccessError('provider_failure');
  }
  if (failure) throw failure;
  if (!repositories) throw new RepositoryAccessError('provider_failure');

  if (attempt.operation === 'list') {
    const repositoriesJson = serializeRepositories(repositories);
    await reconcileSelectedRepository(
      database,
      context,
      attempt.installationId,
      repositories,
      now,
    );
    await database
      .update(githubRepositoryAccessAttempt)
      .set({ repositoriesJson: null, updatedAt: now })
      .where(
        and(
          eq(githubRepositoryAccessAttempt.workspaceId, context.workspace.id),
          eq(githubRepositoryAccessAttempt.sessionId, context.sessionId),
          eq(githubRepositoryAccessAttempt.operation, 'list'),
          ne(githubRepositoryAccessAttempt.id, attempt.id),
          isNotNull(githubRepositoryAccessAttempt.repositoriesJson),
        ),
      );
    await database
      .update(githubRepositoryAccessAttempt)
      .set({ repositoriesJson, updatedAt: now })
      .where(eq(githubRepositoryAccessAttempt.id, attempt.id));
    return 'listed';
  }

  const selected = repositories.find((value) => value.id === attempt.repositoryId);
  if (!selected) throw new RepositoryAccessError('repository_not_eligible');
  await persistSelectedRepository(
    database,
    context,
    attempt.installationId,
    selected,
    now,
  );
  return 'selected';
}

export async function getRepositoryOverview(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  now = new Date(),
): Promise<RepositoryOverview> {
  const installationId = await requireInstallation(database, context.workspace.id);
  const [stored] = await database
    .select()
    .from(repository)
    .where(eq(repository.workspaceId, context.workspace.id))
    .limit(1);
  const [snapshot] = await database
    .select({ repositoriesJson: githubRepositoryAccessAttempt.repositoriesJson })
    .from(githubRepositoryAccessAttempt)
    .where(
      and(
        eq(githubRepositoryAccessAttempt.workspaceId, context.workspace.id),
        eq(githubRepositoryAccessAttempt.sessionId, context.sessionId),
        eq(githubRepositoryAccessAttempt.installationId, installationId),
        eq(githubRepositoryAccessAttempt.operation, 'list'),
        isNotNull(githubRepositoryAccessAttempt.consumedAt),
        isNotNull(githubRepositoryAccessAttempt.repositoriesJson),
        gt(githubRepositoryAccessAttempt.expiresAt, now),
      ),
    )
    .orderBy(desc(githubRepositoryAccessAttempt.updatedAt))
    .limit(1);

  return {
    repositories: snapshot?.repositoriesJson
      ? parseRepositories(snapshot.repositoriesJson)
      : null,
    selected: stored ?? null,
  };
}
