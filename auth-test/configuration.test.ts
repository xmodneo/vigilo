import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthOptions } from '../lib/auth/factory.ts';
import { readServerEnvironment } from '../lib/auth/environment.ts';
import { verification } from '../db/schema.ts';
import { createTestContext } from './support.ts';

test('production auth configuration enables database OAuth state and token encryption', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const options = createAuthOptions(context.database, {
    baseUrl: 'https://vigilo.example',
    githubClientId: 'client-id',
    githubClientSecret: 'client-secret',
    secret: 'a-secure-test-secret-that-is-at-least-32-characters',
  });

  assert.equal(options.account?.encryptOAuthTokens, true);
  assert.equal(options.account?.storeStateStrategy, 'database');
  assert.equal(options.account?.accountLinking?.enabled, false);
  assert.equal(options.session?.cookieCache?.enabled, false);
  assert.equal(options.advanced?.useSecureCookies, true);
  assert.deepEqual(options.disabledPaths, [
    '/account-info',
    '/get-access-token',
    '/refresh-token',
  ]);
  assert.deepEqual(options.trustedOrigins, ['https://vigilo.example']);
  assert.equal(options.logger?.disabled, true);
});

test('server environment accepts local HTTP and requires PostgreSQL and a strong auth secret', () => {
  const valid = {
    BETTER_AUTH_SECRET: 'a-secure-test-secret-that-is-at-least-32-characters',
    BETTER_AUTH_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://vigilo:test@localhost:5432/vigilo',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
  };

  assert.equal(readServerEnvironment(valid).baseUrl, 'http://localhost:3000');
  assert.throws(
    () => readServerEnvironment({ ...valid, BETTER_AUTH_SECRET: 'short' }),
    /invalid_environment:BETTER_AUTH_SECRET/,
  );
  assert.throws(
    () => readServerEnvironment({ ...valid, DATABASE_URL: 'sqlite://local' }),
    /invalid_environment:DATABASE_URL/,
  );
  assert.throws(
    () => readServerEnvironment({ ...valid, BETTER_AUTH_URL: 'http://vigilo.example' }),
    /invalid_environment:BETTER_AUTH_URL/,
  );
});

test('GitHub authorization starts with state, PKCE, and the configured callback', async (t) => {
  const context = await createTestContext();
  t.after(() => context.client.close());

  const response = await context.auth.api.signInSocial({
    asResponse: true,
    body: {
      callbackURL: '/app',
      provider: 'github',
    },
    headers: new Headers({ origin: 'http://localhost:3000' }),
  });
  const authorizationUrl = new URL(response.headers.get('location') ?? '');
  const storedState = await context.database.select().from(verification);

  assert.equal(response.status, 200);
  assert.equal(authorizationUrl.origin, 'https://github.com');
  assert.equal(authorizationUrl.pathname, '/login/oauth/authorize');
  assert.ok(authorizationUrl.searchParams.get('state'));
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizationUrl.searchParams.get('code_challenge'));
  assert.equal(
    authorizationUrl.searchParams.get('redirect_uri'),
    'http://localhost:3000/api/auth/callback/github',
  );
  assert.match(authorizationUrl.searchParams.get('scope') ?? '', /user:email/);
  assert.ok(response.headers.get('set-cookie'));
  assert.equal(storedState.length, 1);
});
