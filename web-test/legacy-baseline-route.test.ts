import assert from 'node:assert/strict';
import test from 'node:test';

import { POST } from '../app/api/github/repositories/baseline/route.js';

test('POST /api/github/repositories/baseline is unavailable even for an authenticated-looking request', async () => {
  const response = POST(new Request('http://localhost:3000/api/github/repositories/baseline', {
    method: 'POST',
    headers: {
      cookie: 'vigilo.session_token=authenticated-sentinel',
      origin: 'http://localhost:3000',
    },
  }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { error: 'legacy_baseline_execution_unavailable' });
});
