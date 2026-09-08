import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSync } from 'node:crypto';

import {
  readGitHubAppEnvironment,
  readGitHubAppPrivateKey,
} from '../lib/github-app/environment.ts';

const BASE_ENVIRONMENT = {
  BETTER_AUTH_URL: 'http://localhost:3000',
  GITHUB_APP_CLIENT_ID: 'Iv1.application-client',
  GITHUB_APP_CLIENT_SECRET: 'secret-value',
  GITHUB_APP_ID: '991',
  GITHUB_APP_PRIVATE_KEY_PATH: '.secrets/vigilo-dev.pem',
  GITHUB_APP_SLUG: 'vigilo-dev-test',
} as NodeJS.ProcessEnv;

test('GitHub App environment accepts only complete, valid server configuration', () => {
  assert.deepEqual(readGitHubAppEnvironment(BASE_ENVIRONMENT), {
    appId: 991,
    appSlug: 'vigilo-dev-test',
    baseUrl: 'http://localhost:3000',
    clientId: 'Iv1.application-client',
    clientSecret: 'secret-value',
    privateKeyPath: '.secrets/vigilo-dev.pem',
  });

  for (const [name, value] of [
    ['GITHUB_APP_ID', 'unsafe'],
    ['GITHUB_APP_ID', '0'],
    ['GITHUB_APP_SLUG', '../bad'],
    ['BETTER_AUTH_URL', 'http://example.com'],
    ['GITHUB_APP_CLIENT_SECRET', ''],
  ] satisfies Array<[string, string]>) {
    assert.throws(
      () => readGitHubAppEnvironment({ ...BASE_ENVIRONMENT, [name]: value }),
      /^Error: invalid_github_app_configuration$/,
    );
  }
});

test('private key loader accepts a private regular file and rejects unsafe files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vigilo-github-app-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const privateKeyPath = join(directory, 'app.pem');
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  }).privateKey;
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });

  assert.equal(await readGitHubAppPrivateKey(privateKeyPath), privateKey);

  await chmod(privateKeyPath, 0o644);
  await assert.rejects(
    readGitHubAppPrivateKey(privateKeyPath),
    /^Error: invalid_github_app_private_key$/,
  );

  await writeFile(privateKeyPath, 'not a private key', { mode: 0o600 });
  await assert.rejects(
    readGitHubAppPrivateKey(privateKeyPath),
    /^Error: invalid_github_app_private_key$/,
  );
});
