import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { consumeRateLimit } from '../lib/operations/http-rate-limit.ts';
import { canonicalRepairQueues } from '../lib/operations/queues.ts';
import { getReadinessResult } from '../lib/operations/readiness.ts';
import { collectOperationalSnapshot } from '../lib/operations/snapshot.ts';
import { PostgresWorkerHeartbeatStore, WorkerHeartbeatLifecycle } from '../lib/operations/worker-heartbeat.ts';
import { createRepairBoss } from '../lib/repair-runs/queue.ts';

const configured = process.env.DATABASE_URL;
if (!configured) throw new Error('missing_required_environment:DATABASE_URL');
const databaseName = `vigilo_operational_probe_${randomUUID().replaceAll('-', '')}`;
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const probeUrl = new URL(configured); probeUrl.pathname = `/${databaseName}`;
const releaseSha = 'a'.repeat(40);
const environment = { NODE_ENV: 'production', DATABASE_URL: probeUrl.toString(), VIGILO_RELEASE_SHA: releaseSha, VIGILO_RATE_LIMIT_HMAC_KEY: 'r'.repeat(32), VIGILO_TRUST_PROXY_HOPS: '1' };
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
let probe: ReturnType<typeof postgres> | undefined;
let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;

async function migratorExitCode(databaseUrl: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'db/migrate.ts'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore',
    });
    child.on('error', reject); child.on('close', resolve);
  });
}

try {
  await admin.unsafe(`create database "${databaseName}"`);
  probe = postgres(probeUrl.toString(), { max: 12, prepare: false });
  await migrate(drizzle(probe), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  boss = await createRepairBoss(probeUrl.toString(), 'publisher');
  const store = new PostgresWorkerHeartbeatStore(probe);
  const compatible = new WorkerHeartbeatLifecycle(store, { id: randomUUID(), releaseSha });
  await compatible.start(); await compatible.ready();
  assert.equal((await getReadinessResult(environment)).status, 200);
  const snapshot = await collectOperationalSnapshot(probe);
  assert.ok(snapshot.some((metric) => metric.metric === 'queue_backlog'));
  assert.deepEqual(snapshot.find((metric) => metric.metric === 'migration_startup_incompatibility'), { metric: 'migration_startup_incompatibility', labels: {}, value: 0 });

  await boss.createQueue('unexpected-operational-queue', { policy: 'standard' });
  const unexpected = await getReadinessResult(environment);
  assert.equal(unexpected.status, 503); assert.equal(unexpected.body.reason, 'queue_registration_incomplete');
  await boss.deleteQueue('unexpected-operational-queue');
  assert.equal((await getReadinessResult(environment)).status, 200);

  await compatible.draining(); await compatible.stopped();
  assert.equal((await getReadinessResult(environment)).body.reason, 'worker_missing');
  await probe`
    insert into operational_worker_heartbeat
      (id, service, release_sha, expected_schema_version, registered_queues, state, started_at, last_heartbeat_at)
    values (${randomUUID()}, 'vigilo-worker', ${'b'.repeat(40)}, '0023', ${JSON.stringify(canonicalRepairQueues)}::jsonb, 'ready', statement_timestamp(), statement_timestamp())
  `;
  await probe`update operational_worker_heartbeat set state = 'ready' where release_sha = ${'b'.repeat(40)}`;
  assert.equal((await getReadinessResult(environment)).body.reason, 'worker_release_mismatch');
  await probe`update operational_worker_heartbeat set state = 'stopped', stopped_at = statement_timestamp() where state = 'ready'`;
  const replacement = new WorkerHeartbeatLifecycle(store, { id: randomUUID(), releaseSha });
  await replacement.start(); await replacement.ready();
  assert.equal((await getReadinessResult(environment)).status, 200);
  await probe`drop trigger external_execution_semaphore_mutation_guard on external_execution_semaphore`;
  const missingAuthorityGuard = await getReadinessResult(environment);
  assert.equal(missingAuthorityGuard.status, 503);
  assert.equal(missingAuthorityGuard.body.reason, 'execution_authority_schema_mismatch');
  await probe`
    create trigger external_execution_semaphore_mutation_guard
    before insert or update or delete on external_execution_semaphore
    for each row execute function guard_external_execution_semaphore_mutation()
  `;
  assert.equal((await getReadinessResult(environment)).status, 200);
  const incompatibleWorkerId = randomUUID();
  await probe`
    insert into operational_worker_heartbeat
      (id, service, release_sha, expected_schema_version, registered_queues, state, started_at, last_heartbeat_at)
    values (${incompatibleWorkerId}, 'vigilo-worker', ${'c'.repeat(40)}, '0023', ${JSON.stringify(canonicalRepairQueues)}::jsonb, 'ready', statement_timestamp(), statement_timestamp())
  `;
  await probe`update operational_worker_heartbeat set state = 'ready' where id = ${incompatibleWorkerId}`;
  assert.equal((await getReadinessResult(environment)).status, 200);
  await probe`update operational_worker_heartbeat set state = 'stopped' where id = ${incompatibleWorkerId}`;

  const lockClient = postgres(probeUrl.toString(), { max: 1, prepare: false });
  await lockClient`select pg_advisory_lock(482933812341)`;
  try { assert.notEqual(await migratorExitCode(probeUrl.toString()), 0); }
  finally { await lockClient`select pg_advisory_unlock(482933812341)`; await lockClient.end({ timeout: 1 }); }

  const decisions = await Promise.all(Array.from({ length: 40 }, () => consumeRateLimit({ action: 'repair_start', subjectHash: 'f'.repeat(64), database: probe! })));
  assert.equal(decisions.filter((value) => value.allowed).length, 10);
  assert.equal(decisions.filter((value) => !value.allowed).length, 30);
  const [bucket] = await probe<{ count: number; plaintext: number }[]>`
    select request_count as count, count(*) filter (where subject_hash <> ${'f'.repeat(64)})::int as plaintext
    from http_rate_limit_bucket group by request_count
  `;
  assert.equal(bucket?.count, 10); assert.equal(bucket?.plaintext, 0);

  const unavailableUrl = new URL(probeUrl); unavailableUrl.port = '1';
  assert.equal((await getReadinessResult({ ...environment, DATABASE_URL: unavailableUrl.toString() })).status, 503);
  assert.equal((await getReadinessResult(environment)).status, 200);
  await replacement.draining(); await replacement.stopped();
  process.stdout.write(`${JSON.stringify({ readinessRecovery: 'passed', exactQueues: 'passed', executionAuthorityGuards: 'fail-closed', workerReplacement: 'passed', compatibleWorkerSelection: 'passed', migrationLockContention: 'failed-closed', concurrentRateLimit: '10/40', result: 'passed' })}\n`);
} finally {
  try { await boss?.stop({ graceful: false }); } catch { /* best effort */ }
  try { await probe?.end({ timeout: 1 }); } catch { /* best effort */ }
  try { await admin.unsafe(`drop database if exists "${databaseName}" with (force)`); } catch { /* report original error */ }
  await admin.end({ timeout: 1 });
}
