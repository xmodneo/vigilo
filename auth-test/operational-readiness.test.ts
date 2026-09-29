import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXPECTED_SCHEMA_VERSION,
  MIGRATION_MANIFEST,
  validateMigrationFiles,
  validateMigrationLedger,
} from '../lib/operations/migrations.js';
import { readRuntimeRelease } from '../lib/operations/release.js';
import { redactLogValue, writeOperationalLog } from '../lib/operations/logging.js';
import { canonicalRepairQueues } from '../lib/operations/queues.js';
import { parseTrustedProxyHops, resolveRateLimitSubject } from '../lib/operations/rate-limit.js';
import { classifyRateLimitAction, rateLimitedResponse } from '../lib/operations/http-rate-limit.js';
import { assertPublicRepository } from '../lib/github-repositories/policy.js';
import { WorkerHeartbeatLifecycle, type WorkerHeartbeatStore } from '../lib/operations/worker-heartbeat.js';
import { readGitHubWorkerEnvironment } from '../lib/github-app/environment.js';
import { validateOperationalSnapshot } from '../lib/operations/snapshot.js';

test('checked migration manifest is complete, ordered, and matches repository bytes', async () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, '0023');
  assert.equal(MIGRATION_MANIFEST.length, 24);
  assert.deepEqual(MIGRATION_MANIFEST.map((entry) => entry.tag.slice(0, 4)),
    Array.from({ length: 24 }, (_, index) => String(index).padStart(4, '0')));
  await validateMigrationFiles(process.cwd());
});

test('migration ledger accepts only an exact ordered prefix or the full manifest', () => {
  const ledger = MIGRATION_MANIFEST.map(({ hash, createdAt }) => ({ hash, createdAt }));
  assert.equal(validateMigrationLedger(ledger), 'complete');
  assert.equal(validateMigrationLedger(ledger.slice(0, -1)), 'pending');
  assert.throws(() => validateMigrationLedger([...ledger, ledger[0]!]), /migration_ledger_unexpected/);
  assert.throws(() => validateMigrationLedger(ledger.map((value, index) => index === 4 ? { ...value, hash: '0'.repeat(64) } : value)), /migration_ledger_mismatch/);
  assert.throws(() => validateMigrationLedger([ledger[1]!, ledger[0]!]), /migration_ledger_mismatch/);
});

test('production release identity is exact and has no fallback', () => {
  const sha = 'a'.repeat(40);
  assert.equal(readRuntimeRelease({ NODE_ENV: 'production', VIGILO_RELEASE_SHA: sha }), sha);
  assert.throws(() => readRuntimeRelease({ NODE_ENV: 'production' }), /runtime_release_unavailable/);
  assert.throws(() => readRuntimeRelease({ NODE_ENV: 'production', VIGILO_RELEASE_SHA: 'main' }), /runtime_release_unavailable/);
  assert.equal(readRuntimeRelease({ NODE_ENV: 'test' }, { testReleaseSha: sha }), sha);
});

test('canonical worker queue set is exact and sorted', () => {
  assert.deepEqual(canonicalRepairQueues, [
    'ai-candidate-generation-v1',
    'ai-investigation-v1',
    'candidate-verification-v1',
    'investigation-context-v1',
    'repair-baseline-v1',
    'repair-loop-v1',
    'repair-publication-v1',
  ]);
});

test('public-only policy rejects private repositories with a stable code', () => {
  assert.doesNotThrow(() => assertPublicRepository({ isPrivate: false }));
  assert.throws(() => assertPublicRepository({ isPrivate: true }), /private_repository_not_supported/);
});

test('rate-limit subjects reject proxy spoofing without an explicit trust contract', () => {
  const spoofed = new Headers({ 'x-forwarded-for': '203.0.113.1' });
  assert.throws(() => resolveRateLimitSubject(spoofed, { production: true }), /proxy_attribution_unavailable/);
  assert.equal(resolveRateLimitSubject(new Headers(), { production: false, directAddress: '127.0.0.1' }), 'ip:127.0.0.1');
  assert.equal(resolveRateLimitSubject(spoofed, { production: true, trustedProxyHops: 1 }), 'ip:203.0.113.1');
  assert.equal(parseTrustedProxyHops(undefined), undefined);
  assert.equal(parseTrustedProxyHops('1'), 1);
  for (const malformed of ['', '0', '9', '01', ' 1', '1 ']) {
    assert.throws(() => parseTrustedProxyHops(malformed), /proxy_attribution_unavailable/);
  }
});

test('rate limiting classifies sensitive mutations and emits a stable bounded response', async () => {
  assert.equal(classifyRateLimitAction('/api/auth/callback/github', 'GET'), 'oauth_callback');
  assert.equal(classifyRateLimitAction('/api/repair-runs', 'POST'), 'repair_start');
  assert.equal(classifyRateLimitAction('/api/repair-runs/id/publications', 'POST'), 'publication');
  assert.equal(classifyRateLimitAction('/api/repair-runs/id', 'GET'), 'poll');
  const response = rateLimitedResponse(12);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '12');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
});

test('central redaction handles nested, mixed-case, patterns, bounds, and cycles', () => {
  const circular: Record<string, unknown> = {
    Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
    nested: { apiKey: 'AIza' + 'x'.repeat(35), safe: 'ok' },
    database: 'postgresql://user:password@example.test/vigilo',
    prompt: 'private model prompt',
    long: 'x'.repeat(5_000),
  };
  circular.circular = circular;
  const redacted = redactLogValue(circular) as Record<string, unknown>;
  assert.equal(redacted.Authorization, '[REDACTED]');
  assert.equal((redacted.nested as Record<string, unknown>).apiKey, '[REDACTED]');
  assert.equal((redacted.nested as Record<string, unknown>).safe, 'ok');
  assert.equal(redacted.database, '[REDACTED]');
  assert.equal(redacted.prompt, '[REDACTED]');
  assert.match(String(redacted.long), /\[TRUNCATED\]$/);
  assert.equal(redacted.circular, '[CIRCULAR]');
  assert.deepEqual(redactLogValue(new Error('postgresql://user:secret@example.test/vigilo')), { code: 'operation_failed' });
  assert.equal(redactLogValue('github_pat_' + 'x'.repeat(40)), '[REDACTED]');
});

test('central logging invokes no accessors and emits only the runtime allowlist', () => {
  let getterCalls = 0;
  const event = {
    level: 'info', event: 'worker.ready', service: 'vigilo-worker', durationMs: 12,
    authorization: 'Bearer must-not-appear',
    get source() { getterCalls += 1; throw new Error('getter_must_not_run'); },
    toJSON() { throw new Error('to_json_must_not_run'); },
  };
  const lines: string[] = [];
  writeOperationalLog(event as never, (line) => lines.push(line));
  assert.equal(getterCalls, 0);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(logged).sort(), ['durationMs', 'event', 'level', 'service', 'timestamp']);
  assert.equal(logged.event, 'worker.ready');
  assert.doesNotMatch(lines[0]!, /must-not-appear|authorization|source/i);
});

test('migration tooling uses the fixed nonblocking advisory lock and full ledger validation', async () => {
  const source = await readFile('db/migrate.ts', 'utf8');
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /validateMigrationLedger\(await readLedger\(client\)\)/);
  assert.match(source, /migration_ledger_incomplete/);
  assert.match(source, /pg_advisory_unlock/);
  assert.match(source, /finally\s*\{\s*await client\.end/);
});

test('every workflow and worker boundary enforces public-repository authority before transport', async () => {
  const files = [
    'lib/investigations/flow.ts', 'lib/ai-investigations/flow.ts', 'lib/ai-candidate-generations/flow.ts',
    'lib/candidate-verifications/flow.ts', 'lib/repair-loops/flow.ts', 'lib/repair-publications/flow.ts',
    'lib/investigations/worker.ts', 'lib/ai-investigations/worker.ts', 'lib/ai-candidate-generations/worker.ts',
    'lib/candidate-verifications/worker.ts', 'lib/repair-loops/worker.ts', 'lib/repair-runs/worker.ts',
    'lib/repair-publications/worker.ts',
  ];
  for (const file of files) assert.match(await readFile(file, 'utf8'), /assertPublicRepositoryAuthority/, file);
});

test('worker heartbeat lifecycle starts, becomes ready, drains, and stops in order', async () => {
  const states: string[] = [];
  const store: WorkerHeartbeatStore = {
    create: async (value) => { states.push(value.state); },
    transition: async (_id, state) => { states.push(state); },
    cleanup: async () => 0,
  };
  const lifecycle = new WorkerHeartbeatLifecycle(store, {
    id: '11111111-1111-4111-8111-111111111111',
    releaseSha: 'a'.repeat(40),
  });
  await lifecycle.start();
  await lifecycle.ready();
  await lifecycle.draining();
  await lifecycle.stopped();
  assert.deepEqual(states, ['starting', 'ready', 'draining', 'stopped']);
});

test('terminal worker heartbeat cannot be restarted by the lifecycle', async () => {
  const store: WorkerHeartbeatStore = { create: async () => {}, transition: async () => {}, cleanup: async () => 0 };
  const lifecycle = new WorkerHeartbeatLifecycle(store, { id: '11111111-1111-4111-8111-111111111111', releaseSha: 'a'.repeat(40) });
  await lifecycle.start();
  await lifecycle.stopped();
  await assert.rejects(lifecycle.ready(), /worker_heartbeat_transition_invalid/);
});

test('slow worker heartbeat refreshes never overlap', async () => {
  const states: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let releasePulse: (() => void) | undefined;
  let blockReady = false;
  const store: WorkerHeartbeatStore = {
    create: async () => {},
    transition: async (_id, state) => {
      states.push(state);
      if (state !== 'ready' || !blockReady) return;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => { releasePulse = resolve; });
      active -= 1;
    },
    cleanup: async () => 0,
  };
  const lifecycle = new WorkerHeartbeatLifecycle(store, {
    id: '11111111-1111-4111-8111-111111111111', releaseSha: 'a'.repeat(40),
  }, { heartbeatIntervalMs: 2 });
  await lifecycle.start();
  await lifecycle.ready();
  blockReady = true;
  lifecycle.begin();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(maximumActive, 1);
  let drained = false;
  const draining = lifecycle.draining().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(drained, false);
  blockReady = false;
  releasePulse?.();
  await draining;
  assert.equal(states.at(-1), 'draining');
  await lifecycle.stopped();
});

test('worker environment does not require web auth or OAuth secrets', () => {
  const value = readGitHubWorkerEnvironment({
    GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'vigilo-test', GITHUB_APP_CLIENT_ID: 'Iv1.test',
    GITHUB_APP_PRIVATE_KEY_PATH: '.secrets/test.pem',
  });
  assert.equal(value.clientSecret, '');
  assert.equal(value.baseUrl, 'https://worker.invalid');
});

test('operational snapshot rejects high-cardinality identity labels', () => {
  assert.doesNotThrow(() => validateOperationalSnapshot([{ metric: 'queue_backlog', labels: { queue: 'repair-loop-v1' }, value: 0 }]));
  assert.throws(() => validateOperationalSnapshot([{ metric: 'queue_backlog', labels: { workspaceId: 'workspace-1' }, value: 1 }]), /operational_snapshot_label_invalid/);
  assert.throws(() => validateOperationalSnapshot(Array.from({ length: 201 }, () => ({ metric: 'safe_metric', labels: {}, value: 0 }))), /operational_snapshot_cardinality_exceeded/);
});

test('operational snapshot command applies bounded database timeouts', async () => {
  const source = await readFile('operations/snapshot.ts', 'utf8');
  assert.match(source, /connect_timeout:\s*5/);
  assert.match(source, /statement_timeout:\s*5_000/);
  assert.match(source, /lock_timeout:\s*1_000/);
});
