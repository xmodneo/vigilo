import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';

import {
  createGitHubAppJwt,
  GitHubApiClient,
} from '../lib/github-app/client.ts';
import type { GitHubApiConfiguration } from '../lib/github-app/types.ts';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const CONFIGURATION: GitHubApiConfiguration = {
  appId: 991,
  appSlug: 'vigilo-dev-test',
  baseUrl: 'http://localhost:3000',
  clientId: 'Iv1.test-client',
  clientSecret: 'client-secret-sentinel',
};

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
}

function decodePart(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

test('App JWT uses RS256, the client ID issuer, and a bounded lifetime', () => {
  const keys = keyPair();
  const jwt = createGitHubAppJwt(CONFIGURATION.clientId, keys.privateKey, NOW);
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  assert.ok(encodedHeader && encodedPayload && encodedSignature);

  assert.deepEqual(decodePart(encodedHeader), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodePart(encodedPayload), {
    exp: Math.floor(NOW.getTime() / 1_000) + 540,
    iat: Math.floor(NOW.getTime() / 1_000) - 60,
    iss: CONFIGURATION.clientId,
  });
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      keys.publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    ),
    true,
  );
});

test('GitHub client verifies user and installation without minting an installation token', async () => {
  const keys = keyPair();
  const requests: Array<{ body: string; headers: Headers; method: string; url: string }> = [];
  const responses = [
    Response.json({ access_token: 'ghu_transient-proof', token_type: 'bearer' }),
    Response.json({ id: 2001 }),
    Response.json({ installations: [{ id: 7001 }], total_count: 1 }),
    Response.json({
      account: { id: 3001, login: 'octo-org', type: 'Organization' },
      app_id: 991,
      app_slug: 'vigilo-dev-test',
      id: 7001,
      permissions: {
        contents: 'write',
        metadata: 'read',
        pull_requests: 'write',
      },
      suspended_at: null,
    }),
    new Response(null, { status: 204 }),
  ];
  const fetchStub: typeof fetch = async (input, init) => {
    requests.push({
      body: typeof init?.body === 'string' ? init.body : '',
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url: String(input),
    });
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  const client = new GitHubApiClient(
    CONFIGURATION,
    keys.privateKey,
    fetchStub,
    () => NOW,
  );

  const accessToken = await client.exchangeAuthorizationCode({
    code: 'one-time-code',
    codeVerifier: 'valid-code-verifier-0123456789',
    redirectUri: 'http://localhost:3000/api/github/installations/callback',
  });
  const userId = await client.getAuthenticatedUserId(accessToken);
  const installationIds = await client.listAccessibleInstallationIds(accessToken);
  const installation = await client.getInstallation(7001);
  await client.revokeUserAuthorization(accessToken);

  assert.equal(userId, '2001');
  assert.deepEqual(installationIds, [7001]);
  assert.equal(installation.id, 7001);
  assert.equal(requests[0]?.url, 'https://github.com/login/oauth/access_token');
  assert.equal(requests[1]?.url, 'https://api.github.com/user');
  assert.equal(requests[2]?.url, 'https://api.github.com/user/installations?per_page=100');
  assert.equal(requests[3]?.url, 'https://api.github.com/app/installations/7001');
  assert.equal(
    requests[4]?.url,
    `https://api.github.com/applications/${CONFIGURATION.clientId}/grant`,
  );
  assert.equal(requests.some((request) => request.url.includes('/access_tokens')), false);
  assert.equal(requests[3]?.headers.get('x-github-api-version'), '2026-03-10');
  assert.match(requests[3]?.headers.get('authorization') ?? '', /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.match(requests[4]?.headers.get('authorization') ?? '', /^Basic /);
});

function repositoryResponse(input: {
  id: number;
  permissions?: { admin: boolean; push: boolean };
}) {
  return {
    default_branch: 'main',
    full_name: 'xmodneo/vigilo',
    id: input.id,
    name: 'vigilo',
    owner: { id: 62422139, login: 'xmodneo' },
    permissions: input.permissions,
    private: false,
  };
}

test('repository access uses the GitHub App user-token intersection and revokes the token', async () => {
  const keys = keyPair();
  const requests: Array<{ body: string; headers: Headers; method: string; url: string }> = [];
  const responses = [
    Response.json({ access_token: 'ghu_transient-repository-token' }),
    Response.json({
      repositories: [repositoryResponse({
        id: 8101,
        permissions: { admin: false, push: true },
      })],
      total_count: 1,
    }),
    new Response(null, { status: 204 }),
  ];
  const fetchStub: typeof fetch = async (input, init) => {
    requests.push({
      body: typeof init?.body === 'string' ? init.body : '',
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url: String(input),
    });
    const response = responses.shift();
    assert.ok(response);
    return response;
  };
  const client = new GitHubApiClient(CONFIGURATION, keys.privateKey, fetchStub, () => NOW);

  const token = await client.exchangeAuthorizationCode({
    code: 'one-time-code',
    codeVerifier: 'valid-code-verifier-0123456789',
    redirectUri: 'http://localhost:3000/api/github/installations/callback',
    repositoryId: 8101,
  });
  const repositories = await client.listUserInstallationRepositories(token, 7001);
  await client.revokeUserAccessToken(token);

  const exchangeBody = new URLSearchParams(requests[0]?.body);
  assert.equal(exchangeBody.get('repository_id'), '8101');
  assert.equal(requests[0]?.url, 'https://github.com/login/oauth/access_token');
  assert.equal(requests[0]?.method, 'POST');
  assert.match(requests[1]?.url ?? '', /\/user\/installations\/7001\/repositories\?/);
  assert.equal(requests[1]?.headers.get('authorization'), 'Bearer ghu_transient-repository-token');
  assert.equal(
    requests[2]?.url,
    `https://api.github.com/applications/${CONFIGURATION.clientId}/token`,
  );
  assert.equal(requests[2]?.method, 'DELETE');
  assert.deepEqual(repositories.map((repository) => repository.id), [8101]);
  assert.equal(repositories[0]?.permissions.push, true);
  assert.equal(requests.some((request) => request.url.includes('/user/repos')), false);
  assert.equal(requests.some((request) => request.url.includes('/access_tokens')), false);
});

test('repository discovery rejects malformed provider metadata', async () => {
  const keys = keyPair();
  const client = new GitHubApiClient(
    CONFIGURATION,
    keys.privateKey,
    async () => Response.json([repositoryResponse({ id: 8101 })]),
    () => NOW,
  );

  await assert.rejects(
    client.listUserInstallationRepositories('ghu_user-sentinel', 7001),
    (error: unknown) => error instanceof Error && error.message === 'github_api_error',
  );
});

test('GitHub client rejects malformed, unavailable, and oversized provider responses generically', async () => {
  const keys = keyPair();

  for (const response of [
    new Response('provider private error', { status: 404 }),
    Response.json({ id: 'not-a-number' }),
    new Response('x'.repeat(1_100_000), { status: 200 }),
  ]) {
    const client = new GitHubApiClient(
      CONFIGURATION,
      keys.privateKey,
      async () => response,
      () => NOW,
    );
    await assert.rejects(
      client.getAuthenticatedUserId('ghu_test'),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'github_api_error' &&
        !error.message.includes('provider private error'),
    );
  }
});
