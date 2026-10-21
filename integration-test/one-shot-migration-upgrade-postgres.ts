import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { MIGRATION_MANIFEST, validateMigrationLedger } from '../lib/operations/migrations.ts';
import { canonicalRepairQueues } from '../lib/operations/queues.ts';

const configuredText = process.env.DATABASE_URL;
if (!configuredText) throw new Error('missing_required_environment:DATABASE_URL');
const configured = new URL(configuredText);
if (configured.hostname !== '127.0.0.1' || configured.pathname !== '/vigilo' ||
    !(configured.port === '55432' ||
      (configured.port === '55433' && process.env.VIGILO_DISPOSABLE_NATIVE_POSTGRES === 'true')))
  throw new Error('disposable_test_requires_local_vigilo_postgres');
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
const name = `vigilo_one_shot_upgrade_${randomUUID().replaceAll('-', '')}`;
const url = new URL(configured); url.pathname = `/${name}`;
const source = fileURLToPath(new URL('../drizzle', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'vigilo-one-shot-migration-'));
let client: ReturnType<typeof postgres> | undefined;
try {
  await mkdir(join(temporary, 'meta'));
  for (const entry of MIGRATION_MANIFEST.slice(0, 26))
    await copyFile(join(source, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
  const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, 26);
  await writeFile(join(temporary, 'meta/_journal.json'), JSON.stringify(journal));
  await admin.unsafe(`create database "${name}"`);
  client = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: temporary });
  const heartbeatId = randomUUID();
  await client`
    insert into operational_worker_heartbeat
      (id, service, release_sha, expected_schema_version, registered_queues, state, started_at, last_heartbeat_at)
    values (${heartbeatId}, 'vigilo-worker', ${'a'.repeat(40)}, '0023', ${JSON.stringify(canonicalRepairQueues)}::jsonb,
      'starting', statement_timestamp(), statement_timestamp())
  `;
  const [before] = await client<{ id: string; service: string; releaseSha: string;
    version: string; queues: string[]; state: string }[]>`
    select id, service, release_sha as "releaseSha", expected_schema_version as version,
      registered_queues as queues, state from operational_worker_heartbeat where id = ${heartbeatId}
  `;
  await migrate(drizzle(client), { migrationsFolder: source });
  const [after] = await client<typeof before[]>`
    select id, service, release_sha as "releaseSha", expected_schema_version as version,
      registered_queues as queues, state from operational_worker_heartbeat where id = ${heartbeatId}
  `;
  assert.deepEqual(after, before);
  const ledger = await client<{ hash: string; createdAt: string }[]>`
    select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id
  `;
  assert.equal(ledger.length, 27);
  assert.equal(validateMigrationLedger(ledger), 'complete');
  assert.equal(ledger[26]?.hash, MIGRATION_MANIFEST[26]?.hash);
  const [catalog] = await client<{ targetRun: string | null; targetJob: string | null;
    targetFk: string | null; uniqueIndex: string | null; guard: string | null }[]>`
    select
      (select column_name from information_schema.columns where table_name = 'operational_worker_heartbeat' and column_name = 'target_repair_run_id') as "targetRun",
      (select column_name from information_schema.columns where table_name = 'operational_worker_heartbeat' and column_name = 'target_job_id') as "targetJob",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'operational_worker_heartbeat_target_run_fk') as "targetFk",
      (select indexdef from pg_indexes where indexname = 'operational_one_shot_live_target_unique') as "uniqueIndex",
      (select pg_get_functiondef(oid) from pg_proc where proname = 'guard_operational_worker_heartbeat' limit 1) as guard
  `;
  assert.equal(catalog?.targetRun, 'target_repair_run_id');
  assert.equal(catalog.targetJob, 'target_job_id');
  assert.match(catalog.targetFk ?? '', /ON DELETE RESTRICT/);
  assert.match(catalog.uniqueIndex ?? '', /UNIQUE INDEX/);
  assert.match(catalog.guard ?? '', /target_repair_run_id/);
  await assert.rejects(client`update operational_worker_heartbeat set service = 'vigilo-baseline-one-shot' where id = ${heartbeatId}`);
  process.stdout.write(JSON.stringify({ upgrade: '0025-to-0026', preservedHeartbeats: 1,
    ledger: 27, constraints: 'passed', result: 'passed' }) + '\n');
} finally {
  if (client) await client.end({ timeout: 1 });
  await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
  await admin.unsafe(`drop database if exists "${name}"`);
  await admin.end({ timeout: 1 });
  await rm(temporary, { recursive: true, force: true });
}
