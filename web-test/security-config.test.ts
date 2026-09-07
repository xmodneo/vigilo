import assert from 'node:assert/strict';
import test from 'node:test';

import nextConfig from '../next.config.js';

test('development logs omit OAuth callback URLs', () => {
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
  assert.equal(ignoredRequests.some((pattern) => pattern.test('/api/health')), false);
});
