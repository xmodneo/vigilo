import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import {
  executionProfile,
  githubInstallation,
  repository,
} from '../db/schema.ts';
import {
  detectSelectedRepositoryExecutionProfile,
  ExecutionProfileError,
  getCurrentExecutionProfile,
} from '../lib/execution-profiles/flow.ts';
import { createExecutionProfileHandlers } from '../lib/execution-profiles/handlers.ts';
import { gitBlobSha } from '../lib/execution-profiles/detector.ts';
import type {
  GitHubExecutionProfileGateway,
  InspectedRepositoryFile,
  InstallationRepositoryMetadata,
  RepositoryRootEntry,
} from '../lib/execution-profiles/types.ts';
import type { VerifiedGitHubInstallation } from '../lib/github-app/types.ts';
import {
  resolveAuthenticatedWorkspace,
  type AuthenticatedWorkspace,
} from '../lib/auth/protected-context.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-08T15:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const SECOND_COMMIT = 'b'.repeat(40);
const CONFIGURATION = {
  appId: 991,
  appSlug: 'vigilo-dev-test',
  baseUrl: 'http://localhost:3000',
  clientId: 'Iv1.github-app-client',
} as const;
const REPOSITORY: InstallationRepositoryMetadata = {
  defaultBranch: 'main',
  fullName: 'octo-org/private-app',
  id: 8101,
  isPrivate: true,
  name: 'private-app',
  ownerId: 3001,
  ownerLogin: 'octo-org',
};

function file(value: unknown): InspectedRepositoryFile {
  const content = JSON.stringify(value);
  return { content, sha: gitBlobSha(content) };
}

const PACKAGE_JSON = file({
  engines: { node: '24.x' },
  name: 'private-app',
  packageManager: 'npm@11.6.2',
  scripts: { build: 'tsc', test: 'node --test', typecheck: 'tsc --noEmit' },
  version: '1.0.0',
});
const PACKAGE_LOCK = file({
  lockfileVersion: 3,
  name: 'private-app',
  packages: { '': { name: 'private-app', version: '1.0.0' } },
  version: '1.0.0',
});
const ROOT: RepositoryRootEntry[] = [
  { name: 'package-lock.json', path: 'package-lock.json', sha: PACKAGE_LOCK.sha, size: PACKAGE_LOCK.content.length, type: 'file' },
  { name: 'package.json', path: 'package.json', sha: PACKAGE_JSON.sha, size: PACKAGE_JSON.content.length, type: 'file' },
];

class FakeProfileGateway implements GitHubExecutionProfileGateway {
  calls: string[] = [];
  commits = [COMMIT, COMMIT];
  installation: VerifiedGitHubInstallation = {
    account: { id: 3001, login: 'octo-org', type: 'Organization' as const },
    appId: CONFIGURATION.appId,
    appSlug: CONFIGURATION.appSlug,
    id: 9001,
    permissions: { contents: 'read', metadata: 'read' },
    suspendedAt: null,
  };
  metadata = { ...REPOSITORY };
  packageJson: InspectedRepositoryFile | null = PACKAGE_JSON;
  packageLock: InspectedRepositoryFile | null = PACKAGE_LOCK;
  root = ROOT;
  revokeFails = false;
  token = 'installation-token-sentinel';

  async getInstallation() {
    this.calls.push('installation');
    return this.installation;
  }

  async createInstallationAccessToken(input: { installationId: number; repositoryId: number }) {
    assert.deepEqual(input, { installationId: 9001, repositoryId: 8101 });
    this.calls.push('mint:8101:contents-read:metadata-read');
    return { accessToken: this.token, repository: { ...this.metadata } };
  }

  async getRepositoryMetadata(token: string) {
    assert.equal(token, this.token);
    this.calls.push('metadata');
    return { ...this.metadata };
  }

  async resolveBranchCommit(input: { accessToken: string; branch: string }) {
    assert.equal(input.accessToken, this.token);
    assert.equal(input.branch, 'main');
    this.calls.push('resolve');
    return this.commits.shift() ?? COMMIT;
  }

  async getRepositoryRoot(input: { accessToken: string; ref: string }) {
    assert.equal(input.accessToken, this.token);
    assert.equal(input.ref, COMMIT);
    this.calls.push('root');
    return this.root;
  }

  async getRepositoryFile(input: { accessToken: string; path: 'package-lock.json' | 'package.json'; ref: string }) {
    assert.equal(input.accessToken, this.token);
    assert.equal(input.ref, COMMIT);
    this.calls.push(`file:${input.path}`);
    return input.path === 'package.json' ? this.packageJson : this.packageLock;
  }

  async revokeInstallationAccessToken(token: string) {
    assert.equal(token, this.token);
    this.calls.push('revoke');
    if (this.revokeFails) throw new Error('provider detail');
  }
}

async function authenticatedWorkspace(
  testContext: Awaited<ReturnType<typeof createTestContext>>,
  githubUserId = '2001',
): Promise<AuthenticatedWorkspace> {
  const user = await saveGithubUser(testContext, githubUserId);
  const login = await testContext.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace(
    (headers) => testContext.auth.api.getSession({ headers }),
    testContext.database,
    login.headers,
  );
}

async function selectRepository(
  testContext: Awaited<ReturnType<typeof createTestContext>>,
  context: AuthenticatedWorkspace,
) {
  await testContext.database.insert(githubInstallation).values({
    accountLogin: 'octo-org',
    accountType: 'Organization',
    githubAccountId: 3001,
    installationId: 9001,
    status: 'active',
    workspaceId: context.workspace.id,
  });
  await testContext.database.insert(repository).values({
    defaultBranch: REPOSITORY.defaultBranch,
    fullName: REPOSITORY.fullName,
    githubRepositoryId: REPOSITORY.id,
    installationId: 9001,
    isPrivate: REPOSITORY.isPrivate,
    name: REPOSITORY.name,
    ownerId: REPOSITORY.ownerId,
    ownerLogin: REPOSITORY.ownerLogin,
    workspaceId: context.workspace.id,
  });
}

test('exact commit profile is persisted only after scoped token revocation', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const gateway = new FakeProfileGateway();

  const result = await detectSelectedRepositoryExecutionProfile(
    testContext.database,
    context,
    gateway,
    CONFIGURATION,
    NOW,
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.baseCommitSha, COMMIT);
  assert.equal(result.testRunner, 'node-test');
  assert.equal(result.installOperation, 'ci');
  assert.equal(result.typecheckScript, 'typecheck');
  assert.equal(result.buildScript, 'build');
  assert.equal(result.testScript, 'test');
  assert.equal(gateway.calls.at(-1), 'revoke');
  assert.doesNotMatch(JSON.stringify(result), /installation-token-sentinel|node --test|tsc --noEmit/);

  const stored = await testContext.database.select().from(executionProfile);
  assert.equal(stored.length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /installation-token-sentinel|node --test|private-app.*scripts/);
});

test('same repository evidence produces the same persisted identity', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const first = await detectSelectedRepositoryExecutionProfile(
    testContext.database, context, new FakeProfileGateway(), CONFIGURATION, NOW,
  );
  const second = await detectSelectedRepositoryExecutionProfile(
    testContext.database, context, new FakeProfileGateway(), CONFIGURATION, new Date(NOW.getTime() + 1_000),
  );
  assert.equal(first.profileIdentity, second.profileIdentity);
  assert.equal((await testContext.database.select().from(executionProfile)).length, 1);
});

test('stale profile is replaced by a profile bound to the newly detected commit', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const first = await detectSelectedRepositoryExecutionProfile(
    testContext.database, context, new FakeProfileGateway(), CONFIGURATION, NOW,
  );
  const gateway = new FakeProfileGateway();
  gateway.commits = [SECOND_COMMIT, SECOND_COMMIT];
  const originalGetRoot = gateway.getRepositoryRoot.bind(gateway);
  gateway.getRepositoryRoot = async (input) => originalGetRoot({ ...input, ref: COMMIT });
  const originalGetFile = gateway.getRepositoryFile.bind(gateway);
  gateway.getRepositoryFile = async (input) => originalGetFile({ ...input, ref: COMMIT });
  // The fake's content does not depend on the ref; accept the new exact revision in assertions.
  gateway.getRepositoryRoot = async (input) => {
    assert.equal(input.ref, SECOND_COMMIT);
    gateway.calls.push('root');
    return gateway.root;
  };
  gateway.getRepositoryFile = async (input) => {
    assert.equal(input.ref, SECOND_COMMIT);
    gateway.calls.push(`file:${input.path}`);
    return input.path === 'package.json' ? gateway.packageJson : gateway.packageLock;
  };
  const second = await detectSelectedRepositoryExecutionProfile(
    testContext.database, context, gateway, CONFIGURATION, new Date(NOW.getTime() + 2_000),
  );
  assert.notEqual(first.profileIdentity, second.profileIdentity);
  assert.equal(second.baseCommitSha, SECOND_COMMIT);
  assert.equal((await getCurrentExecutionProfile(testContext.database, context))?.baseCommitSha, SECOND_COMMIT);
});

test('branch movement during inspection fails closed and still revokes the token', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const gateway = new FakeProfileGateway();
  gateway.commits = [COMMIT, SECOND_COMMIT];

  await assert.rejects(
    detectSelectedRepositoryExecutionProfile(testContext.database, context, gateway, CONFIGURATION, NOW),
    (error: unknown) => error instanceof ExecutionProfileError && error.code === 'repository_state_changed',
  );
  assert.equal(gateway.calls.at(-1), 'revoke');
  assert.equal((await testContext.database.select().from(executionProfile)).length, 0);
});

test('suspended and wrong-app installations fail before token minting', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  for (const mutate of [
    (gateway: FakeProfileGateway) => { gateway.installation = { ...gateway.installation, suspendedAt: NOW.toISOString() }; },
    (gateway: FakeProfileGateway) => { gateway.installation = { ...gateway.installation, appId: 992 }; },
    (gateway: FakeProfileGateway) => { gateway.installation = { ...gateway.installation, permissions: { metadata: 'read' } }; },
  ]) {
    const gateway = new FakeProfileGateway();
    mutate(gateway);
    await assert.rejects(
      detectSelectedRepositoryExecutionProfile(testContext.database, context, gateway, CONFIGURATION, NOW),
      (error: unknown) => error instanceof ExecutionProfileError && error.code === 'installation_unavailable',
    );
    assert.deepEqual(gateway.calls, ['installation']);
  }
});

test('repository removed from installation fails without persisting a profile', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const gateway = new FakeProfileGateway();
  gateway.createInstallationAccessToken = async () => {
    gateway.calls.push('mint-rejected');
    throw new Error('repository unavailable');
  };
  await assert.rejects(
    detectSelectedRepositoryExecutionProfile(testContext.database, context, gateway, CONFIGURATION, NOW),
  );
  assert.equal((await testContext.database.select().from(executionProfile)).length, 0);
});

test('token revocation failure prevents Ready and Unsupported profile persistence', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  for (const unsupported of [false, true]) {
    const gateway = new FakeProfileGateway();
    gateway.revokeFails = true;
    if (unsupported) gateway.packageLock = null;
    await assert.rejects(
      detectSelectedRepositoryExecutionProfile(testContext.database, context, gateway, CONFIGURATION, NOW),
    );
    assert.equal((await testContext.database.select().from(executionProfile)).length, 0);
  }
});

test('unsupported repository persists a safe reason without raw metadata', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const gateway = new FakeProfileGateway();
  gateway.packageLock = null;
  const result = await detectSelectedRepositoryExecutionProfile(
    testContext.database, context, gateway, CONFIGURATION, NOW,
  );
  assert.equal(result.status, 'unsupported');
  assert.equal(result.unsupportedReason, 'missing_package_lock');
  assert.equal(result.profileIdentity, null);
  assert.equal(result.baseCommitSha, COMMIT);
});

test('another workspace cannot inspect or read the selected repository profile', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const owner = await authenticatedWorkspace(testContext, '2001');
  const other = await authenticatedWorkspace(testContext, '2002');
  await selectRepository(testContext, owner);
  await detectSelectedRepositoryExecutionProfile(
    testContext.database, owner, new FakeProfileGateway(), CONFIGURATION, NOW,
  );
  await assert.rejects(
    detectSelectedRepositoryExecutionProfile(testContext.database, other, new FakeProfileGateway(), CONFIGURATION, NOW),
    (error: unknown) => error instanceof ExecutionProfileError && error.code === 'repository_not_selected',
  );
  assert.equal(await getCurrentExecutionProfile(testContext.database, other), null);
});

test('database constraints reject fabricated Ready profile fields', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  await assert.rejects(
    testContext.database.insert(executionProfile).values({
      baseCommitSha: COMMIT,
      githubRepositoryId: REPOSITORY.id,
      installationId: 9001,
      profileVersion: 2,
      status: 'ready',
      unsupportedReason: 'missing_package_lock',
      workspaceId: context.workspace.id,
    }),
  );
});

test('repository rename is reconciled by stable ID without changing identity ownership', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const gateway = new FakeProfileGateway();
  gateway.metadata = { ...REPOSITORY, fullName: 'octo-org/renamed-app', name: 'renamed-app' };
  await detectSelectedRepositoryExecutionProfile(
    testContext.database, context, gateway, CONFIGURATION, NOW,
  );
  const [saved] = await testContext.database
    .select()
    .from(repository)
    .where(eq(repository.githubRepositoryId, REPOSITORY.id));
  assert.equal(saved?.name, 'renamed-app');
  assert.equal(saved?.githubRepositoryId, REPOSITORY.id);
});

test('protected handlers ignore forged repository and commit input and expose no token or raw manifests', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  await selectRepository(testContext, context);
  const gateway = new FakeProfileGateway();
  const handlers = createExecutionProfileHandlers({
    configuration: CONFIGURATION,
    database: testContext.database,
    gateway,
    now: () => NOW,
    resolveContext: async () => context,
  });
  const response = await handlers.detect(new Request(
    'http://localhost:3000/api/github/repositories/profile',
    {
      body: JSON.stringify({ commitSha: SECOND_COMMIT, repositoryId: 9999 }),
      headers: {
        'content-type': 'application/json',
        origin: CONFIGURATION.baseUrl,
      },
      method: 'POST',
    },
  ));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'http://localhost:3000/app/github?profile=ready');
  assert.equal(gateway.calls.includes('mint:8101:contents-read:metadata-read'), true);
  assert.doesNotMatch(await response.text(), /installation-token-sentinel|scripts|package-lock/);

  const current = await handlers.current(new Request(
    'http://localhost:3000/api/github/repositories/profile',
  ));
  const body = JSON.stringify(await current.json());
  assert.equal(current.status, 200);
  assert.match(body, new RegExp(COMMIT));
  assert.doesNotMatch(body, /installation-token-sentinel|node --test|tsc --noEmit|private-app.*scripts/);
});

test('profile mutation requires same-origin and authenticated workspace resolution', async (t) => {
  const testContext = await createTestContext();
  t.after(() => testContext.client.close());
  const context = await authenticatedWorkspace(testContext);
  const handlers = createExecutionProfileHandlers({
    configuration: CONFIGURATION,
    database: testContext.database,
    gateway: new FakeProfileGateway(),
    resolveContext: async () => context,
  });
  const forbidden = await handlers.detect(new Request(
    'http://localhost:3000/api/github/repositories/profile',
    { headers: { origin: 'https://attacker.example' }, method: 'POST' },
  ));
  assert.equal(forbidden.status, 403);
});
