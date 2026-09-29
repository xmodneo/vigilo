import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../app/api/health/route.js';
import { GET as GET_READINESS } from '../app/api/health/readiness/route.js';
import { evaluateReadiness } from '../lib/operations/readiness.js';

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

test('GET /api/health/readiness fails closed without configured operational dependencies', async () => {
  const response = await GET_READINESS();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), {
    service: 'vigilo-web',
    status: 'not_ready',
    reason: 'readiness_configuration_invalid',
    checks: [{ code: 'readiness_configuration_invalid', status: 'failed' }],
  });
});

test('readiness returns ready only for exact schema, queues, worker release, and operational schemas', async () => {
  const releaseSha = 'a'.repeat(40);
  const ready = await evaluateReadiness({
    releaseSha,
    check: async () => ({
      database: true,
      migrationLedger: true,
      queueSchema: true,
      queueSet: true,
      workerPresent: true,
      workerFresh: true,
      workerReleaseSha: releaseSha,
      workerSchemaVersion: '0023',
      executionAuthoritySchema: true,
      publicationSchema: true,
    }),
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.checks.every((check) => check.status === 'passed'), true);
});

test('readiness fails closed with stable codes for mismatched or stale dependencies', async () => {
  const releaseSha = 'a'.repeat(40);
  const result = await evaluateReadiness({
    releaseSha,
    check: async () => ({
      database: true,
      migrationLedger: false,
      queueSchema: true,
      queueSet: false,
      workerPresent: true,
      workerFresh: false,
      workerReleaseSha: 'b'.repeat(40),
      workerSchemaVersion: '0022',
      executionAuthoritySchema: true,
      publicationSchema: true,
    }),
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body.checks.filter((check) => check.status === 'failed').map((check) => check.code), [
    'migration_history_mismatch',
    'queue_registration_incomplete',
    'worker_stale',
    'worker_release_mismatch',
    'worker_schema_mismatch',
  ]);
});
