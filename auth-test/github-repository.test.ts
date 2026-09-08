import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  executionProfile,
  githubInstallation,
  githubRepositoryAccessAttempt,
  repository,
} from '../db/schema.ts';
import {
  AccessDeniedError,
  resolveAuthenticatedWorkspace,
  type AuthenticatedWorkspace,
} from '../lib/auth/protected-context.ts';
import {
  beginRepositoryAuthorization,
  completeRepositoryAuthorization,
  getRepositoryOverview,
  hasRepositoryAccessAttempt,
  RepositoryAccessError,
} from '../lib/github-repositories/flow.ts';
import { createGitHubRepositoryHandlers } from '../lib/github-repositories/handlers.ts';
import type {
  GitHubRepository,
  GitHubRepositoryAccessGateway,
  GitHubUserInstallationRepository,
} from '../lib/github-repositories/types.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const CONFIGURATION = {
  appId: 991,
  appSlug: 'vigilo-dev-test',
  baseUrl: 'http://localhost:3000',
  clientId: 'Iv1.github-app-client',
} as const;
const STATE = 'state-token-0123456789abcdef';
const VERIFIER = 'pkce-verifier-0123456789abcdef';

const FIRST_REPOSITORY: GitHubRepository = {
  defaultBranch: 'main',
  fullName: 'octo-org/private-app',
  id: 8101,
  isPrivate: true,
  name: 'private-app',
  ownerId: 3001,
  ownerLogin: 'octo-org',
};

const SECOND_REPOSITORY: GitHubRepository = {
  defaultBranch: 'main',
  fullName: 'octo-org/read-only-app',
  id: 8102,
  isPrivate: false,
  name: 'read-only-app',
  ownerId: 3001,
  ownerLogin: 'octo-org',
};

function providerRepository(
  value: GitHubRepository,
  permissions: Partial<GitHubUserInstallationRepository['permissions']> = {},
): GitHubUserInstallationRepository {
  return {
    ...value,
    permissions: { admin: false, push: false, ...permissions },
  };
}

class FakeRepositoryGateway implements GitHubRepositoryAccessGateway {
  calls: string[] = [];
  installationIds: number[] = [9001];
  repositories: GitHubUserInstallationRepository[] = [
    providerRepository(FIRST_REPOSITORY, { push: true }),
    providerRepository(SECOND_REPOSITORY),
  ];
  revokeFails = false;
  userId = '2001';

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    repositoryId?: number;
  }): Promise<string> {
    assert.equal(input.code, 'one-time-code');
    assert.equal(input.codeVerifier, VERIFIER);
    assert.equal(
      input.redirectUri,
      'http://localhost:3000/api/github/installations/callback',
    );
    this.calls.push(`exchange:${input.repositoryId ?? 'all'}`);
    return 'github-app-user-token-sentinel';
  }

  async getAuthenticatedUserId(token: string): Promise<string> {
    assert.equal(token, 'github-app-user-token-sentinel');
    this.calls.push('user');
    return this.userId;
  }

  async listAccessibleInstallationIds(token: string): Promise<number[]> {
    assert.equal(token, 'github-app-user-token-sentinel');
    this.calls.push('installations');
    return this.installationIds;
  }

  async listUserInstallationRepositories(
    token: string,
    installationId: number,
  ): Promise<GitHubUserInstallationRepository[]> {
    assert.equal(token, 'github-app-user-token-sentinel');
    this.calls.push(`repositories:${installationId}`);
    return this.repositories;
  }

  async revokeUserAccessToken(token: string): Promise<void> {
    assert.equal(token, 'github-app-user-token-sentinel');
    this.calls.push('revoke-token');
    if (this.revokeFails) throw new Error('provider detail must remain hidden');
  }
}

async function authenticatedWorkspace(
  testContext: Awaited<ReturnType<typeof createTestContext>>,
  githubUserId = '2001',
  email = `${githubUserId}@example.test`,
) {
  const user = await saveGithubUser(testContext, githubUserId, email);
  const login = await testContext.testAuth.login({ userId: user.id });
  const context = await resolveAuthenticatedWorkspace(
    (headers) => testContext.auth.api.getSession({ headers }),
    testContext.database,
    login.headers,
  );
  const installationId = Number(githubUserId) + 7000;
  await testContext.database.insert(githubInstallation).values({
    accountLogin: 'octo-org',
    accountType: 'Organization',
    githubAccountId: 3001,
    installationId,
    status: 'active',
    workspaceId: context.workspace.id,
  });
  return { context, headers: login.headers, installationId };
}

function tokenSequence(...values: string[]) {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (!value) throw new Error('missing deterministic token');
    return value;
  };
}

async function authorize(
  database: Awaited<ReturnType<typeof createTestContext>>['database'],
  context: AuthenticatedWorkspace,
  input: { operation: 'list' } | { operation: 'select'; repositoryId: unknown },
  state = STATE,
) {
  return beginRepositoryAuthorization(database, context, CONFIGURATION, input, {
    now: NOW,
    randomToken: tokenSequence(state, VERIFIER),
  });
}

async function complete(
  database: Awaited<ReturnType<typeof createTestContext>>['database'],
  context: AuthenticatedWorkspace,
  gateway: GitHubRepositoryAccessGateway,
  state = STATE,
) {
  return completeRepositoryAuthorization(
    database,
    context,
    gateway,
    CONFIGURATION,
    { code: 'one-time-code', state },
    { now: NOW },
  );
}

test('repository authorization binds hashed state and PKCE to session, workspace, and installation', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);

  const result = await authorize(testContext.database, authenticated.context, {
    operation: 'list',
  });
  const url = new URL(result.redirectUrl);
  const [attempt] = await testContext.database.select().from(githubRepositoryAccessAttempt);

  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), CONFIGURATION.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/api/github/installations/callback');
  assert.equal(url.searchParams.get('state'), STATE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(VERIFIER).digest('base64url'),
  );
  assert.equal(url.searchParams.has('scope'), false);
  assert.equal(attempt?.workspaceId, authenticated.context.workspace.id);
  assert.equal(attempt?.sessionId, authenticated.context.sessionId);
  assert.equal(attempt?.installationId, authenticated.installationId);
  assert.equal(attempt?.stateHash, createHash('sha256').update(STATE).digest('hex'));
  assert.notEqual(attempt?.stateHash, STATE);
  assert.equal(attempt?.codeVerifier, VERIFIER);
  assert.doesNotMatch(JSON.stringify(attempt), /github-app-user-token-sentinel/);
});

test('GitHub App user-token result is filtered to explicit write access and stored without credentials', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  await authorize(testContext.database, authenticated.context, { operation: 'list' });

  assert.equal(await complete(testContext.database, authenticated.context, gateway), 'listed');
  const overview = await getRepositoryOverview(
    testContext.database,
    authenticated.context,
    NOW,
  );
  const [attempt] = await testContext.database.select().from(githubRepositoryAccessAttempt);

  assert.deepEqual(overview.repositories, [FIRST_REPOSITORY]);
  assert.deepEqual(gateway.calls, [
    'exchange:all',
    'user',
    'installations',
    'repositories:9001',
    'revoke-token',
  ]);
  assert.equal(attempt?.codeVerifier, null);
  assert.doesNotMatch(JSON.stringify(attempt), /github-app-user-token-sentinel/);
  assert.doesNotMatch(JSON.stringify(overview), /github-app-user-token-sentinel/);
});

test('provider intersection excludes installation-only, user-only, and read-only repositories', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  const userOnly = { ...FIRST_REPOSITORY, id: 8199, fullName: 'octo-org/user-only', name: 'user-only' };
  gateway.repositories = [
    providerRepository(FIRST_REPOSITORY, { push: true }),
    providerRepository(SECOND_REPOSITORY),
  ];
  await authorize(testContext.database, authenticated.context, { operation: 'list' });
  await complete(testContext.database, authenticated.context, gateway);
  const overview = await getRepositoryOverview(testContext.database, authenticated.context, NOW);

  assert.deepEqual(overview.repositories?.map((value) => value.id), [8101]);
  assert.equal(overview.repositories?.some((value) => value.id === userOnly.id), false);
  assert.equal(overview.repositories?.some((value) => value.id === SECOND_REPOSITORY.id), false);
});

test('selection uses a repository-scoped fresh authorization and rejects forged IDs', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  await authorize(
    testContext.database,
    authenticated.context,
    { operation: 'select', repositoryId: '8101' },
  );
  assert.equal(await complete(testContext.database, authenticated.context, gateway), 'selected');
  assert.equal((await testContext.database.select().from(repository))[0]?.githubRepositoryId, 8101);
  assert.equal(gateway.calls[0], 'exchange:8101');

  const forgedState = 'forged-state-0123456789abcd';
  await authorize(
    testContext.database,
    authenticated.context,
    { operation: 'select', repositoryId: '9999' },
    forgedState,
  );
  await assert.rejects(
    complete(testContext.database, authenticated.context, gateway, forgedState),
    (error: unknown) =>
      error instanceof RepositoryAccessError && error.code === 'repository_not_eligible',
  );
  assert.equal(gateway.calls.at(-1), 'revoke-token');
  assert.equal((await testContext.database.select().from(repository)).length, 1);
});

test('write access lost after listing is rejected by fresh selection authorization', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  await authorize(testContext.database, authenticated.context, { operation: 'list' });
  await complete(testContext.database, authenticated.context, gateway);
  assert.deepEqual(
    (await getRepositoryOverview(testContext.database, authenticated.context, NOW))
      .repositories?.map((value) => value.id),
    [8101],
  );

  gateway.repositories = [providerRepository(FIRST_REPOSITORY)];
  const selectionState = 'lost-write-state-0123456789abcd';
  await authorize(
    testContext.database,
    authenticated.context,
    { operation: 'select', repositoryId: 8101 },
    selectionState,
  );
  await assert.rejects(
    complete(testContext.database, authenticated.context, gateway, selectionState),
    (error: unknown) =>
      error instanceof RepositoryAccessError && error.code === 'repository_not_eligible',
  );
  assert.equal((await testContext.database.select().from(repository)).length, 0);
});

test('selecting a different stable repository invalidates the previous execution profile', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  gateway.repositories = [
    providerRepository(FIRST_REPOSITORY, { push: true }),
    providerRepository(SECOND_REPOSITORY, { push: true }),
  ];
  await authorize(
    testContext.database,
    authenticated.context,
    { operation: 'select', repositoryId: FIRST_REPOSITORY.id },
  );
  await complete(testContext.database, authenticated.context, gateway);
  await testContext.database.insert(executionProfile).values({
    baseCommitSha: 'a'.repeat(40),
    buildScript: 'build',
    githubRepositoryId: FIRST_REPOSITORY.id,
    installOperation: 'ci',
    installationId: authenticated.installationId,
    lockfileType: 'package-lock',
    nodeMajor: 24,
    packageJsonBlobSha: 'b'.repeat(40),
    packageJsonContentSha256: 'c'.repeat(64),
    packageLockBlobSha: 'd'.repeat(40),
    packageLockContentSha256: 'e'.repeat(64),
    packageManager: 'npm',
    profileIdentity: 'f'.repeat(64),
    profileVersion: 2,
    runtimeFamily: 'node',
    status: 'ready',
    testRunner: 'node-test',
    testScript: 'test',
    typecheckScript: 'typecheck',
    workspaceId: authenticated.context.workspace.id,
  });

  const secondState = 'second-selection-state-0123456789';
  await authorize(
    testContext.database,
    authenticated.context,
    { operation: 'select', repositoryId: SECOND_REPOSITORY.id },
    secondState,
  );
  await complete(
    testContext.database,
    authenticated.context,
    gateway,
    secondState,
  );

  assert.equal((await testContext.database.select().from(repository))[0]?.githubRepositoryId, SECOND_REPOSITORY.id);
  assert.equal((await testContext.database.select().from(executionProfile)).length, 0);
});

test('wrong user, inaccessible installation, replay, and cross-session state fail closed', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  gateway.userId = 'different-user';
  await authorize(testContext.database, authenticated.context, { operation: 'list' });
  await assert.rejects(
    complete(testContext.database, authenticated.context, gateway),
    (error: unknown) =>
      error instanceof RepositoryAccessError && error.code === 'repository_not_eligible',
  );
  assert.equal(gateway.calls.at(-1), 'revoke-token');
  await assert.rejects(
    complete(testContext.database, authenticated.context, gateway),
    (error: unknown) => error instanceof RepositoryAccessError && error.code === 'invalid_state',
  );

  const inaccessibleState = 'inaccessible-0123456789abcdef';
  gateway.userId = '2001';
  gateway.installationIds = [];
  await authorize(
    testContext.database,
    authenticated.context,
    { operation: 'list' },
    inaccessibleState,
  );
  await assert.rejects(
    complete(testContext.database, authenticated.context, gateway, inaccessibleState),
    (error: unknown) =>
      error instanceof RepositoryAccessError && error.code === 'repository_not_eligible',
  );
  assert.equal(gateway.calls.at(-1), 'revoke-token');

  const secondLogin = await testContext.testAuth.login({ userId: authenticated.context.user.id });
  const secondContext = await resolveAuthenticatedWorkspace(
    (headers) => testContext.auth.api.getSession({ headers }),
    testContext.database,
    secondLogin.headers,
  );
  const crossState = 'cross-session-0123456789abcd';
  await authorize(testContext.database, authenticated.context, { operation: 'list' }, crossState);
  await assert.rejects(
    complete(testContext.database, secondContext, new FakeRepositoryGateway(), crossState),
    (error: unknown) => error instanceof RepositoryAccessError && error.code === 'invalid_state',
  );
});

test('revocation failure prevents both repository snapshots and selected records', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  gateway.revokeFails = true;
  await authorize(testContext.database, authenticated.context, { operation: 'list' });
  await assert.rejects(
    complete(testContext.database, authenticated.context, gateway),
    (error: unknown) => error instanceof RepositoryAccessError && error.code === 'provider_failure',
  );
  const [attempt] = await testContext.database.select().from(githubRepositoryAccessAttempt);
  assert.equal(attempt?.codeVerifier, null);
  assert.equal(attempt?.repositoriesJson, null);
  assert.equal((await testContext.database.select().from(repository)).length, 0);
});

test('fresh listing reconciles renamed and removed selected repositories by stable ID', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  await authorize(testContext.database, authenticated.context, { operation: 'select', repositoryId: 8101 });
  await complete(testContext.database, authenticated.context, gateway);

  const renamedState = 'renamed-state-0123456789abcdef';
  gateway.repositories = [providerRepository({
    ...FIRST_REPOSITORY,
    fullName: 'octo-org/renamed-app',
    name: 'renamed-app',
  }, { push: true })];
  await authorize(testContext.database, authenticated.context, { operation: 'list' }, renamedState);
  await complete(testContext.database, authenticated.context, gateway, renamedState);
  assert.equal((await testContext.database.select().from(repository))[0]?.fullName, 'octo-org/renamed-app');

  const removedState = 'removed-state-0123456789abcdef';
  gateway.repositories = [];
  await authorize(testContext.database, authenticated.context, { operation: 'list' }, removedState);
  await complete(testContext.database, authenticated.context, gateway, removedState);
  assert.equal((await testContext.database.select().from(repository)).length, 0);
  assert.deepEqual(
    (await getRepositoryOverview(testContext.database, authenticated.context, NOW)).repositories,
    [],
  );
});

test('database uniqueness prevents one repository from being selected by two workspaces', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const first = await authenticatedWorkspace(testContext, '2001', 'first@example.test');
  const second = await authenticatedWorkspace(testContext, '2002', 'second@example.test');
  const firstGateway = new FakeRepositoryGateway();
  const secondGateway = new FakeRepositoryGateway();
  secondGateway.userId = '2002';
  secondGateway.installationIds = [9002];
  await authorize(testContext.database, first.context, { operation: 'select', repositoryId: 8101 });
  await complete(testContext.database, first.context, firstGateway);
  const secondState = 'second-state-0123456789abcdef';
  await authorize(testContext.database, second.context, { operation: 'select', repositoryId: 8101 }, secondState);
  await assert.rejects(
    complete(testContext.database, second.context, secondGateway, secondState),
    (error: unknown) => error instanceof RepositoryAccessError && error.code === 'repository_conflict',
  );
});

test('selected private repository metadata remains scoped to its owning workspace', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const first = await authenticatedWorkspace(testContext, '2001', 'owner@example.test');
  const second = await authenticatedWorkspace(testContext, '2002', 'other@example.test');
  const gateway = new FakeRepositoryGateway();
  await authorize(testContext.database, first.context, { operation: 'select', repositoryId: 8101 });
  await complete(testContext.database, first.context, gateway);

  const handlers = createGitHubRepositoryHandlers({
    configuration: CONFIGURATION,
    database: testContext.database,
    gateway,
    now: () => NOW,
    resolveContext: async () => second.context,
  });
  const response = await handlers.current(new Request(
    'http://localhost:3000/api/github/repositories/selected',
    { headers: { cookie: 'other-session' } },
  ));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { repository: null });
});

test('attempt constraints and expiry enforce operation invariants and bounded lifetime', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  await assert.rejects(
    testContext.database.insert(githubRepositoryAccessAttempt).values({
      codeVerifier: VERIFIER,
      expiresAt: new Date(NOW.getTime() + 60_000),
      id: 'invalid-attempt',
      installationId: 9001,
      operation: 'list',
      repositoryId: 8101,
      sessionId: authenticated.context.sessionId,
      stateHash: 'invalid-state-hash',
      workspaceId: authenticated.context.workspace.id,
    }),
  );
  await authorize(testContext.database, authenticated.context, { operation: 'list' });
  assert.equal(await hasRepositoryAccessAttempt(testContext.database, STATE, NOW), true);
  assert.equal(
    await hasRepositoryAccessAttempt(
      testContext.database,
      STATE,
      new Date(NOW.getTime() + 11 * 60_000),
    ),
    false,
  );
});

test('protected handlers keep temporary tokens out of browser responses and enforce origin', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeRepositoryGateway();
  const handlers = createGitHubRepositoryHandlers({
    configuration: CONFIGURATION,
    database: testContext.database,
    gateway,
    now: () => NOW,
    randomToken: tokenSequence(STATE, VERIFIER),
    resolveContext: async (headers) => {
      if (!headers.has('cookie')) throw new AccessDeniedError('unauthorized');
      return authenticated.context;
    },
  });

  const unauthorized = await handlers.list(new Request('http://localhost:3000/api/github/repositories'));
  const crossOrigin = await handlers.authorize(new Request('http://localhost:3000/api/github/repositories/authorize', {
    headers: { cookie: 'session=valid', origin: 'https://attacker.example' },
    method: 'POST',
  }));
  const started = await handlers.authorize(new Request('http://localhost:3000/api/github/repositories/authorize', {
    headers: { cookie: 'session=valid', origin: 'http://localhost:3000' },
    method: 'POST',
  }));
  assert.equal(unauthorized.status, 401);
  assert.equal(crossOrigin.status, 403);
  assert.equal(started.status, 303);
  assert.doesNotMatch(started.headers.get('location') ?? '', /token-sentinel/);
  assert.equal(await handlers.matchesCallback(new Request(`http://localhost:3000/api/github/installations/callback?state=${STATE}`)), true);

  const callback = await handlers.callback(new Request(`http://localhost:3000/api/github/installations/callback?state=${STATE}&code=one-time-code`, {
    headers: { cookie: 'session=valid' },
  }));
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get('location') ?? '', /repositories=loaded/);
  const listed = await handlers.list(new Request('http://localhost:3000/api/github/repositories', {
    headers: { cookie: 'session=valid' },
  }));
  const body = JSON.stringify(await listed.json());
  assert.equal(listed.status, 200);
  assert.doesNotMatch(body, /token-sentinel|codeVerifier|stateHash/i);
});

test('repository flow has no dependency on the traditional OAuth access token', async () => {
  const serverSource = await readFile('lib/github-repositories/server.ts', 'utf8');
  assert.doesNotMatch(serverSource, /getAccessToken|BetterAuthGitHubUserTokenProvider/);
  assert.doesNotMatch(serverSource, /\bgetAuth\(/);
});
