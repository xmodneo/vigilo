import assert from 'node:assert/strict';
import test from 'node:test';

import nextConfig from '../next.config.js';

test('development logs omit identity and GitHub App callback URLs', () => {
  const logging = nextConfig.logging;

  assert.equal(typeof logging, 'object');
  assert.notEqual(logging, null);

  if (typeof logging !== 'object' || logging === null) {
    return;
  }

  const incomingRequests = logging.incomingRequests;

  assert.equal(typeof incomingRequests, 'object');
  assert.notEqual(incomingRequests, null);

  if (typeof incomingRequests !== 'object' || incomingRequests === null) {
    return;
  }

  const ignoredRequests = incomingRequests.ignore ?? [];

  assert.equal(
    ignoredRequests.some((pattern) =>
      pattern.test('/api/auth/callback/github?code=temporary&state=temporary'),
    ),
    true,
  );
  for (const callbackPath of [
    '/api/github/installations/setup?installation_id=7001&state=temporary',
    '/api/github/installations/callback?code=temporary&state=temporary',
  ]) {
    assert.equal(
      ignoredRequests.some((pattern) => pattern.test(callbackPath)),
      true,
    );
  }
  assert.equal(ignoredRequests.some((pattern) => pattern.test('/api/health')), false);
});
