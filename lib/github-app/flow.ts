import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';

import {
  githubInstallation,
  githubInstallationAttempt,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type {
  GitHubAppConfiguration,
  GitHubInstallationGateway,
  VerifiedGitHubInstallation,
} from './types.ts';

const ATTEMPT_LIFETIME_MS = 10 * 60_000;
const REQUIRED_PERMISSIONS = {
  contents: 'write',
  metadata: 'read',
  pull_requests: 'write',
} as const;

export type InstallationFlowErrorCode =
  | 'github_verification_failed'
  | 'installation_conflict'
  | 'invalid_callback'
  | 'invalid_state';

export class InstallationFlowError extends Error {
  constructor(public readonly code: InstallationFlowErrorCode) {
    super(code);
    this.name = 'InstallationFlowError';
  }
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

function isValidState(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function stateHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function parseInstallationId(value: string): number {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new InstallationFlowError('invalid_callback');
  }
  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId)) {
    throw new InstallationFlowError('invalid_callback');
  }
  return installationId;
}

function callbackUrl(configuration: GitHubAppConfiguration): string {
  return new URL('/api/github/installations/callback', configuration.baseUrl).toString();
}

function assertVerifiedInstallation(
  installation: VerifiedGitHubInstallation,
  expectedId: number,
  configuration: GitHubAppConfiguration,
): void {
  const permissionEntries = Object.entries(installation.permissions).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const expectedEntries = Object.entries(REQUIRED_PERMISSIONS).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const accountIsValid =
    Number.isSafeInteger(installation.account.id) &&
    installation.account.id > 0 &&
    installation.account.login.length > 0 &&
    installation.account.login.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(installation.account.login) &&
    (installation.account.type === 'Organization' || installation.account.type === 'User');

  if (
    installation.id !== expectedId ||
    installation.appId !== configuration.appId ||
    installation.appSlug !== configuration.appSlug ||
    installation.suspendedAt !== null ||
    !accountIsValid ||
    JSON.stringify(permissionEntries) !== JSON.stringify(expectedEntries)
  ) {
    throw new InstallationFlowError('github_verification_failed');
  }
}

export async function beginGitHubInstallation(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  configuration: GitHubAppConfiguration,
  options: FlowOptions = {},
): Promise<{ redirectUrl: string }> {
  const now = currentTime(options);
  const state = generateToken(options);
  if (!isValidState(state)) {
    throw new InstallationFlowError('invalid_state');
  }

  await database.insert(githubInstallationAttempt).values({
    expiresAt: new Date(now.getTime() + ATTEMPT_LIFETIME_MS),
    id: randomUUID(),
    phase: 'installation',
    sessionId: context.sessionId,
    stateHash: stateHash(state),
    workspaceId: context.workspace.id,
  });

  const redirectUrl = new URL(
    `/apps/${encodeURIComponent(configuration.appSlug)}/installations/new`,
    'https://github.com',
  );
  redirectUrl.searchParams.set('state', state);
  return { redirectUrl: redirectUrl.toString() };
}

export async function continueGitHubInstallation(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  configuration: GitHubAppConfiguration,
  input: {
    installationId: string;
    setupAction: string | null;
    state: string;
  },
  options: FlowOptions = {},
): Promise<{ redirectUrl: string }> {
  if (
    !isValidState(input.state) ||
    (input.setupAction !== null && input.setupAction !== 'install')
  ) {
    throw new InstallationFlowError('invalid_callback');
  }
  const installationId = parseInstallationId(input.installationId);
  const now = currentTime(options);
  const oauthState = generateToken(options);
  const codeVerifier = generateToken(options);
  if (!isValidState(oauthState) || !isValidState(codeVerifier)) {
    throw new InstallationFlowError('invalid_state');
  }

  const [attempt] = await database
    .update(githubInstallationAttempt)
    .set({
      codeVerifier,
      installationId,
      phase: 'authorization',
      stateHash: stateHash(oauthState),
      updatedAt: now,
    })
    .where(
      and(
        eq(githubInstallationAttempt.stateHash, stateHash(input.state)),
        eq(githubInstallationAttempt.workspaceId, context.workspace.id),
        eq(githubInstallationAttempt.sessionId, context.sessionId),
        eq(githubInstallationAttempt.phase, 'installation'),
        isNull(githubInstallationAttempt.consumedAt),
        gt(githubInstallationAttempt.expiresAt, now),
      ),
    )
    .returning({ id: githubInstallationAttempt.id });

  if (!attempt) {
    throw new InstallationFlowError('invalid_state');
  }

  const codeChallenge = createHash('sha256')
    .update(codeVerifier, 'utf8')
    .digest('base64url');
  const redirectUrl = new URL('https://github.com/login/oauth/authorize');
  redirectUrl.searchParams.set('client_id', configuration.clientId);
  redirectUrl.searchParams.set('redirect_uri', callbackUrl(configuration));
  redirectUrl.searchParams.set('state', oauthState);
  redirectUrl.searchParams.set('code_challenge', codeChallenge);
  redirectUrl.searchParams.set('code_challenge_method', 'S256');
  return { redirectUrl: redirectUrl.toString() };
}

export async function completeGitHubInstallation(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  gateway: GitHubInstallationGateway,
  configuration: GitHubAppConfiguration,
  input: { code: string; state: string },
  options: Pick<FlowOptions, 'now'> = {},
): Promise<typeof githubInstallation.$inferSelect> {
  if (
    !isValidState(input.state) ||
    input.code.length === 0 ||
    input.code.length > 1_024
  ) {
    throw new InstallationFlowError('invalid_callback');
  }
  const now = currentTime(options);
  const [attempt] = await database
    .update(githubInstallationAttempt)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(githubInstallationAttempt.stateHash, stateHash(input.state)),
        eq(githubInstallationAttempt.workspaceId, context.workspace.id),
        eq(githubInstallationAttempt.sessionId, context.sessionId),
        eq(githubInstallationAttempt.phase, 'authorization'),
        isNull(githubInstallationAttempt.consumedAt),
        gt(githubInstallationAttempt.expiresAt, now),
      ),
    )
    .returning({
      codeVerifier: githubInstallationAttempt.codeVerifier,
      id: githubInstallationAttempt.id,
      installationId: githubInstallationAttempt.installationId,
    });

  if (!attempt?.codeVerifier || !attempt.installationId) {
    throw new InstallationFlowError('invalid_state');
  }

  let accessToken: string | undefined;
  let verifiedInstallation: VerifiedGitHubInstallation | undefined;
  let verificationFailed = false;
  try {
    accessToken = await gateway.exchangeAuthorizationCode({
      code: input.code,
      codeVerifier: attempt.codeVerifier,
      redirectUri: callbackUrl(configuration),
    });
    const authenticatedUserId = await gateway.getAuthenticatedUserId(accessToken);
    const accessibleInstallationIds =
      await gateway.listAccessibleInstallationIds(accessToken);
    const installation = await gateway.getInstallation(attempt.installationId);
    if (
      authenticatedUserId !== context.githubUserId ||
      !accessibleInstallationIds.includes(attempt.installationId)
    ) {
      throw new InstallationFlowError('github_verification_failed');
    }
    assertVerifiedInstallation(installation, attempt.installationId, configuration);
    verifiedInstallation = installation;
  } catch {
    verificationFailed = true;
  }

  if (accessToken) {
    try {
      await gateway.revokeUserAuthorization(accessToken);
    } catch {
      verificationFailed = true;
    }
  }
  await database
    .update(githubInstallationAttempt)
    .set({ codeVerifier: null, updatedAt: now })
    .where(eq(githubInstallationAttempt.id, attempt.id));

  if (verificationFailed || !verifiedInstallation) {
    throw new InstallationFlowError('github_verification_failed');
  }

  await database
    .insert(githubInstallation)
    .values({
      accountLogin: verifiedInstallation.account.login,
      accountType: verifiedInstallation.account.type,
      githubAccountId: verifiedInstallation.account.id,
      installationId: verifiedInstallation.id,
      status: 'active',
      updatedAt: now,
      workspaceId: context.workspace.id,
    })
    .onConflictDoNothing();

  const [associated] = await database
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.installationId, verifiedInstallation.id))
    .limit(1);
  if (!associated || associated.workspaceId !== context.workspace.id) {
    throw new InstallationFlowError('installation_conflict');
  }

  return associated;
}

export async function findGitHubInstallation(
  database: VigiloDatabase,
  workspaceId: string,
): Promise<typeof githubInstallation.$inferSelect | null> {
  const [installation] = await database
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.workspaceId, workspaceId))
    .limit(1);
  return installation ?? null;
}
