import assert from 'node:assert/strict';
import test from 'node:test';

import { count, eq } from 'drizzle-orm';

import { account, user, workspace } from '../db/schema.ts';
import {
  AccessDeniedError,
  resolveAuthenticatedWorkspace,
} from '../lib/auth/protected-context.ts';
import { createWorkspaceResponse } from '../lib/auth/workspace-response.ts';
import { ensureWorkspaceForUser } from '../lib/workspaces.ts';
import { createTestContext, saveGithubUser } from './support.ts';

test('first verified GitHub sign-in creates exactly one user and workspace', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1001');
  const createdRows = await context.database
    .select()
    .from(workspace)
    .where(eq(workspace.ownerUserId, signedInUser.id));

  const userCounts = await context.database.select({ userCount: count() }).from(user);
  const workspaceCounts = await context.database
    .select({ workspaceCount: count() })
    .from(workspace);

  assert.equal(userCounts[0]?.userCount, 1);
  assert.equal(workspaceCounts[0]?.workspaceCount, 1);
  assert.equal(createdRows[0]?.ownerUserId, signedInUser.id);
});

test('repeated sign-in reuses the same user and workspace', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1002');
  const firstLogin = await context.testAuth.login({ userId: signedInUser.id });
  const repeatedLogin = await context.testAuth.login({ userId: signedInUser.id });
  const first = await resolveAuthenticatedWorkspace(
    (headers) => context.auth.api.getSession({ headers }),
    context.database,
    firstLogin.headers,
  );
  const repeated = await resolveAuthenticatedWorkspace(
    (headers) => context.auth.api.getSession({ headers }),
    context.database,
    repeatedLogin.headers,
  );

  assert.equal(repeated.user.id, first.user.id);
  assert.equal(repeated.workspace.id, first.workspace.id);
  const rows = await context.database
    .select()
    .from(workspace)
    .where(eq(workspace.ownerUserId, signedInUser.id));
  assert.equal(rows.length, 1);

  const users = await context.database.select().from(user);
  assert.equal(users.length, 1);
});

test('duplicate callback retries cannot create duplicate workspace ownership', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1003');
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      ensureWorkspaceForUser(context.database, signedInUser.id),
    ),
  );

  assert.equal(new Set(attempts.map((entry) => entry.id)).size, 1);
  const workspaceCounts = await context.database
    .select({ workspaceCount: count() })
    .from(workspace);
  assert.equal(workspaceCounts[0]?.workspaceCount, 1);
});

test('database uniqueness constraints enforce identity and workspace invariants', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const firstUser = await saveGithubUser(context, '1004', 'first@example.test');
  const secondUser = await context.testAuth.saveUser(
    context.testAuth.createUser({ email: 'second@example.test' }),
  );
  const firstWorkspace = await ensureWorkspaceForUser(context.database, firstUser.id);

  await assert.rejects(
    context.database.insert(workspace).values({
      id: 'duplicate-owner-workspace',
      ownerUserId: firstUser.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  await assert.rejects(
    context.database.insert(account).values({
      id: 'duplicate-github-identity',
      accountId: '1004',
      issuer: 'local:oauth:github',
      providerId: 'github',
      userId: secondUser.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );

  assert.equal(firstWorkspace.ownerUserId, firstUser.id);
});

test('unauthorized and forged sessions are rejected', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1005');
  const login = await context.testAuth.login({ userId: signedInUser.id });
  const cookie = login.headers.get('cookie');
  assert.ok(cookie);

  await assert.rejects(
    resolveAuthenticatedWorkspace(
      (headers) => context.auth.api.getSession({ headers }),
      context.database,
      new Headers(),
    ),
    (error: unknown) => error instanceof AccessDeniedError && error.code === 'unauthorized',
  );

  const forgedHeaders = new Headers({
    cookie: cookie.replace(/=[^;]+/, '=forged-session-token'),
  });
  await assert.rejects(
    resolveAuthenticatedWorkspace(
      (headers) => context.auth.api.getSession({ headers }),
      context.database,
      forgedHeaders,
    ),
    (error: unknown) => error instanceof AccessDeniedError && error.code === 'unauthorized',
  );
});

test('logout invalidates the database session and protected access', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1006');
  const login = await context.testAuth.login({ userId: signedInUser.id });

  const before = await resolveAuthenticatedWorkspace(
    (headers) => context.auth.api.getSession({ headers }),
    context.database,
    login.headers,
  );
  assert.equal(before.githubUserId, '1006');

  await context.auth.api.signOut({ headers: login.headers });

  await assert.rejects(
    resolveAuthenticatedWorkspace(
      (headers) => context.auth.api.getSession({ headers }),
      context.database,
      login.headers,
    ),
    (error: unknown) => error instanceof AccessDeniedError && error.code === 'unauthorized',
  );
});

test('a user cannot access another user workspace', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const firstUser = await saveGithubUser(context, '1007', 'owner@example.test');
  const secondUser = await saveGithubUser(context, '1008', 'other@example.test');
  const firstWorkspace = await ensureWorkspaceForUser(context.database, firstUser.id);
  const secondLogin = await context.testAuth.login({ userId: secondUser.id });
  const secondContext = await resolveAuthenticatedWorkspace(
    (headers) => context.auth.api.getSession({ headers }),
    context.database,
    secondLogin.headers,
  );

  assert.notEqual(secondContext.workspace.id, firstWorkspace.id);
  assert.equal(secondContext.workspace.ownerUserId, secondUser.id);
});

test('protected workspace response is scoped and never includes OAuth tokens', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1009');
  const login = await context.testAuth.login({ userId: signedInUser.id });
  const response = await createWorkspaceResponse(() =>
    resolveAuthenticatedWorkspace(
      (headers) => context.auth.api.getSession({ headers }),
      context.database,
      login.headers,
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.deepEqual(body, {
    identity: { githubUserId: '1009' },
    workspace: { id: body.workspace.id },
  });
  assert.doesNotMatch(JSON.stringify(body), /token|secret|cookie/i);
});

test('protected workspace response returns 401 when session evidence is missing', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const response = await createWorkspaceResponse(() =>
    resolveAuthenticatedWorkspace(
      (headers) => context.auth.api.getSession({ headers }),
      context.database,
      new Headers(),
    ),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('browser-facing auth routes cannot return the stored GitHub access token', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const signedInUser = await saveGithubUser(context, '1010');
  const login = await context.testAuth.login({ userId: signedInUser.id });
  const [githubAccount] = await context.database
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, signedInUser.id));
  assert.ok(githubAccount);

  const headers = new Headers(login.headers);
  headers.set('content-type', 'application/json');
  headers.set('origin', 'http://localhost:3000');
  const response = await context.auth.handler(
    new Request('http://localhost:3000/api/auth/get-access-token', {
      body: JSON.stringify({ accountId: githubAccount.id }),
      headers,
      method: 'POST',
    }),
  );

  assert.equal(response.status, 404);
});
