import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../app/api/health/route.js';

test('GET /api/health returns the current Vigilo milestone status', async () => {
  const response = GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), {
    service: 'vigilo-web',
    status: 'ok',
    milestone: '4.1',
  });
});
