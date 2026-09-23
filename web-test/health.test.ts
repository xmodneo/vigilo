import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../app/api/health/route.js';
import { GET as GET_READINESS } from '../app/api/health/readiness/route.js';

test('GET /api/health reports process liveness without claiming dependency readiness', async () => {
  const response = GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    service: 'vigilo-web',
    status: 'alive',
    scope: 'process',
    readiness: '/api/health/readiness',
  });
});

test('GET /api/health/readiness fails closed until local dependency checks exist', async () => {
  const response = GET_READINESS();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    service: 'vigilo-web',
    status: 'not_ready',
    reason: 'readiness_checks_not_implemented',
    checks: {
      database: 'not_checked',
      migrations: 'not_checked',
      worker: 'not_checked',
      externalProviders: 'not_checked',
    },
  });
});
