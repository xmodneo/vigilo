import assert from 'node:assert/strict';
import test from 'node:test';

import { count, eq } from 'drizzle-orm';

import {
  githubInstallation,
  githubInstallationAttempt,
} from '../db/schema.ts';
import {
  AccessDeniedError,
  resolveAuthenticatedWorkspace,
  type AuthenticatedWorkspace,
} from '../lib/auth/protected-context.ts';
import {
  beginGitHubInstallation,
  completeGitHubInstallation,
  continueGitHubInstallation,
  InstallationFlowError,
} from '../lib/github-app/flow.ts';
import { createGitHubInstallationHandlers } from '../lib/github-app/handlers.ts';
import type {
  GitHubAppConfiguration,
  GitHubInstallationGateway,
  VerifiedGitHubInstallation,
} from '../lib/github-app/types.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const CONFIGURATION: GitHubAppConfiguration = {
  appId: 991,
  appSlug: 'vigilo-dev-test',
  baseUrl: 'http://localhost:3000',
  clientId: 'Iv1.test-client',
};

class FakeGitHubGateway implements GitHubInstallationGateway {
  readonly calls: string[] = [];
  accessToken = 'ghu_test-token-never-persist';
  authenticatedUserId = '2001';
  accessibleInstallationIds = [7001];
  installation: VerifiedGitHubInstallation = {
    account: { id: 3001, login: 'octo-org', type: 'Organization' },
    appId: CONFIGURATION.appId,
    appSlug: CONFIGURATION.appSlug,
    id: 7001,
    permissions: {
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    },
    suspendedAt: null,
  };
  verificationError: Error | undefined;

  async exchangeAuthorizationCode(): Promise<string> {
    this.calls.push('exchange');
    return this.accessToken;
  }

  async getAuthenticatedUserId(): Promise<string> {
    this.calls.push('user');
    return this.authenticatedUserId;
  }

  async listAccessibleInstallationIds(): Promise<number[]> {
    this.calls.push('accessible-installations');
    return this.accessibleInstallationIds;
  }

  async getInstallation(): Promise<VerifiedGitHubInstallation> {
    this.calls.push('app-installation');
    if (this.verificationError) {
      throw this.verificationError;
    }
    return this.installation;
  }

  async revokeUserAuthorization(): Promise<void> {
    this.calls.push('revoke');
  }
}

function tokens(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `unused-${index}`;
}

let attemptSequence = 0;

async function authenticatedWorkspace(
  testContext: Awaited<ReturnType<typeof createTestContext>>,
  githubUserId = '2001',
): Promise<{ context: AuthenticatedWorkspace; headers: Headers }> {
  const user = await saveGithubUser(testContext, githubUserId);
  const login = await testContext.testAuth.login({ userId: user.id });
  const context = await resolveAuthenticatedWorkspace(
    (headers) => testContext.auth.api.getSession({ headers }),
    testContext.database,
    login.headers,
  );

  return { context, headers: login.headers };
}

function stateFrom(url: string): string {
  const state = new URL(url).searchParams.get('state');
  assert.ok(state);
  return state;
}

async function readyAuthorization(
  testContext: Awaited<ReturnType<typeof createTestContext>>,
  context: AuthenticatedWorkspace,
) {
  const suffix = String(++attemptSequence).padStart(20, '0');
  const beginning = await beginGitHubInstallation(
    testContext.database,
    context,
    CONFIGURATION,
    { now: NOW, randomToken: tokens(`installation-${suffix}`) },
  );
  const authorization = await continueGitHubInstallation(
    testContext.database,
    context,
    CONFIGURATION,
    {
      installationId: '7001',
      setupAction: 'install',
      state: stateFrom(beginning.redirectUrl),
    },
    {
      now: new Date(NOW.getTime() + 1_000),
      randomToken: tokens(
        `authorization-${suffix}`,
        `code-verifier-${suffix}`,
      ),
    },
  );

  return stateFrom(authorization.redirectUrl);
}

test('authenticated initiation is session-bound and unauthenticated initiation is rejected', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeGitHubGateway();
  const handlers = createGitHubInstallationHandlers({
    configuration: CONFIGURATION,
    database: testContext.database,
    gateway,
    now: () => NOW,
    randomToken: tokens('handler-state-0123456789'),
    resolveContext: async (headers) => {
      if (!headers.has('cookie')) {
        throw new AccessDeniedError('unauthorized');
      }
      return authenticated.context;
    },
  });

  const response = await handlers.start(
    new Request('http://localhost:3000/api/github/installations', {
      headers: { cookie: 'session=valid', origin: 'http://localhost:3000' },
      method: 'POST',
    }),
  );
  const unauthorized = await handlers.start(
    new Request('http://localhost:3000/api/github/installations', {
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location') ?? '').hostname, 'github.com');
  assert.equal(unauthorized.status, 401);
  const [attempt] = await testContext.database.select().from(githubInstallationAttempt);
  assert.equal(attempt?.sessionId, authenticated.context.sessionId);
  assert.equal(attempt?.workspaceId, authenticated.context.workspace.id);
  assert.notEqual(attempt?.stateHash, 'handler-state-0123456789');
});

test('valid callback verifies and associates one installation without persisting a token', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const gateway = new FakeGitHubGateway();
  const state = await readyAuthorization(testContext, authenticated.context);

  const result = await completeGitHubInstallation(
    testContext.database,
    authenticated.context,
    gateway,
    CONFIGURATION,
    { code: 'one-time-code', state },
    { now: new Date(NOW.getTime() + 2_000) },
  );

  assert.equal(result.installationId, 7001);
  assert.deepEqual(gateway.calls, [
    'exchange',
    'user',
    'accessible-installations',
    'app-installation',
    'revoke',
  ]);
  const rows = await testContext.database.select().from(githubInstallation);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /ghu_/);
});

test('replayed, expired, forged, suspended, and wrong-app callbacks fail closed', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);

  const acceptedState = await readyAuthorization(testContext, authenticated.context);
  await completeGitHubInstallation(
    testContext.database,
    authenticated.context,
    new FakeGitHubGateway(),
    CONFIGURATION,
    { code: 'code', state: acceptedState },
    { now: new Date(NOW.getTime() + 2_000) },
  );
  await assert.rejects(
    completeGitHubInstallation(
      testContext.database,
      authenticated.context,
      new FakeGitHubGateway(),
      CONFIGURATION,
      { code: 'code', state: acceptedState },
      { now: new Date(NOW.getTime() + 3_000) },
    ),
    (error: unknown) => error instanceof InstallationFlowError && error.code === 'invalid_state',
  );

  const expiredState = await readyAuthorization(testContext, authenticated.context);
  await assert.rejects(
    completeGitHubInstallation(
      testContext.database,
      authenticated.context,
      new FakeGitHubGateway(),
      CONFIGURATION,
      { code: 'code', state: expiredState },
      { now: new Date(NOW.getTime() + 11 * 60_000) },
    ),
    (error: unknown) => error instanceof InstallationFlowError && error.code === 'invalid_state',
  );

  for (const mutate of [
    (gateway: FakeGitHubGateway) => { gateway.verificationError = new Error('not found'); },
    (gateway: FakeGitHubGateway) => { gateway.installation = { ...gateway.installation, suspendedAt: NOW.toISOString() }; },
    (gateway: FakeGitHubGateway) => { gateway.installation = { ...gateway.installation, appId: 992 }; },
    (gateway: FakeGitHubGateway) => { gateway.installation = { ...gateway.installation, appSlug: 'another-app' }; },
    (gateway: FakeGitHubGateway) => { gateway.installation = { ...gateway.installation, id: 7002 }; },
    (gateway: FakeGitHubGateway) => {
      gateway.installation = {
        ...gateway.installation,
        permissions: { ...gateway.installation.permissions, issues: 'read' },
      };
    },
  ]) {
    const state = await readyAuthorization(testContext, authenticated.context);
    const gateway = new FakeGitHubGateway();
    mutate(gateway);
    await assert.rejects(
      completeGitHubInstallation(
        testContext.database,
        authenticated.context,
        gateway,
        CONFIGURATION,
        { code: 'code', state },
        { now: new Date(NOW.getTime() + 2_000) },
      ),
      InstallationFlowError,
    );
    assert.equal(gateway.calls.at(-1), 'revoke');
  }
});

test('callback identity and user-accessible installation proof are both required', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);

  for (const mutate of [
    (gateway: FakeGitHubGateway) => { gateway.authenticatedUserId = 'different-user'; },
    (gateway: FakeGitHubGateway) => { gateway.accessibleInstallationIds = []; },
  ]) {
    const state = await readyAuthorization(testContext, authenticated.context);
    const gateway = new FakeGitHubGateway();
    mutate(gateway);
    await assert.rejects(
      completeGitHubInstallation(
        testContext.database,
        authenticated.context,
        gateway,
        CONFIGURATION,
        { code: 'code', state },
        { now: new Date(NOW.getTime() + 2_000) },
      ),
      InstallationFlowError,
    );
  }

  const totals = await testContext.database.select({ total: count() }).from(githubInstallation);
  assert.equal(totals[0]?.total, 0);
});

test('database uniqueness prevents cross-workspace installation claims', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const first = await authenticatedWorkspace(testContext, '2001');
  const second = await authenticatedWorkspace(testContext, '2002');

  await testContext.database.insert(githubInstallation).values({
    accountLogin: 'first-owner',
    accountType: 'User',
    githubAccountId: 2001,
    installationId: 7001,
    status: 'active',
    workspaceId: first.context.workspace.id,
  });

  await assert.rejects(
    testContext.database.insert(githubInstallation).values({
      accountLogin: 'second-owner',
      accountType: 'User',
      githubAccountId: 2002,
      installationId: 7001,
      status: 'active',
      workspaceId: second.context.workspace.id,
    }),
  );
  await assert.rejects(
    testContext.database.insert(githubInstallation).values({
      accountLogin: 'replacement',
      accountType: 'Organization',
      githubAccountId: 3002,
      installationId: 7002,
      status: 'active',
      workspaceId: first.context.workspace.id,
    }),
  );
});

test('installation state cannot cross sessions or workspaces', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const first = await authenticatedWorkspace(testContext, '2001');
  const second = await authenticatedWorkspace(testContext, '2002');
  const start = await beginGitHubInstallation(
    testContext.database,
    first.context,
    CONFIGURATION,
    { now: NOW, randomToken: tokens('cross-workspace-state-0001') },
  );

  await assert.rejects(
    continueGitHubInstallation(
      testContext.database,
      second.context,
      CONFIGURATION,
      {
        installationId: '7001',
        setupAction: 'install',
        state: stateFrom(start.redirectUrl),
      },
      {
        now: new Date(NOW.getTime() + 1_000),
        randomToken: tokens(
          'cross-workspace-oauth-0001',
          'cross-workspace-verifier-0001',
        ),
      },
    ),
    (error: unknown) =>
      error instanceof InstallationFlowError && error.code === 'invalid_state',
  );

  const callback = await continueGitHubInstallation(
    testContext.database,
    first.context,
    CONFIGURATION,
    {
      installationId: '7001',
      setupAction: 'install',
      state: stateFrom(start.redirectUrl),
    },
    {
      now: new Date(NOW.getTime() + 1_000),
      randomToken: tokens(
        'cross-session-oauth-state-0001',
        'cross-session-code-verifier-0001',
      ),
    },
  );
  await assert.rejects(
    completeGitHubInstallation(
      testContext.database,
      { ...first.context, sessionId: second.context.sessionId },
      new FakeGitHubGateway(),
      CONFIGURATION,
      { code: 'code', state: stateFrom(callback.redirectUrl) },
      { now: new Date(NOW.getTime() + 2_000) },
    ),
    (error: unknown) =>
      error instanceof InstallationFlowError && error.code === 'invalid_state',
  );
});

test('failed transient grant revocation prevents installation association', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const state = await readyAuthorization(testContext, authenticated.context);
  const gateway = new FakeGitHubGateway();
  gateway.revokeUserAuthorization = async () => {
    gateway.calls.push('revoke');
    throw new Error('provider detail');
  };

  await assert.rejects(
    completeGitHubInstallation(
      testContext.database,
      authenticated.context,
      gateway,
      CONFIGURATION,
      { code: 'code', state },
      { now: new Date(NOW.getTime() + 2_000) },
    ),
    (error: unknown) =>
      error instanceof InstallationFlowError &&
      error.code === 'github_verification_failed',
  );
  const rows = await testContext.database.select().from(githubInstallation);
  assert.equal(rows.length, 0);
});

test('responses never expose provider errors, tokens, or private-key text', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const authenticated = await authenticatedWorkspace(testContext);
  const state = await readyAuthorization(testContext, authenticated.context);
  const gateway = new FakeGitHubGateway();
  gateway.verificationError = new Error(
    'PRIVATE-KEY-SENTINEL ghu_secret-token-sentinel',
  );
  const handlers = createGitHubInstallationHandlers({
    configuration: CONFIGURATION,
    database: testContext.database,
    gateway,
    now: () => new Date(NOW.getTime() + 2_000),
    randomToken: tokens('unused'),
    resolveContext: async () => authenticated.context,
  });

  const response = await handlers.callback(
    new Request(
      `http://localhost:3000/api/github/installations/callback?code=code&state=${state}`,
      { headers: authenticated.headers },
    ),
  );
  const serialized = `${response.status} ${response.headers.get('location') ?? ''}`;

  assert.equal(response.status, 303);
  assert.doesNotMatch(serialized, /PRIVATE-KEY-SENTINEL|ghu_|secret/i);
  const attempts = await testContext.database
    .select()
    .from(githubInstallationAttempt)
    .where(eq(githubInstallationAttempt.workspaceId, authenticated.context.workspace.id));
  assert.equal(attempts.at(-1)?.consumedAt instanceof Date, true);
});
