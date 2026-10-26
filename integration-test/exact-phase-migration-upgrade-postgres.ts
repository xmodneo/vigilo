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
const name = `vigilo_exact_phase_upgrade_${randomUUID().replaceAll('-', '')}`;
const url = new URL(configured); url.pathname = `/${name}`;
const source = fileURLToPath(new URL('../drizzle', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'vigilo-exact-phase-migration-'));
let client: ReturnType<typeof postgres> | undefined;
try {
  await mkdir(join(temporary, 'meta'));
  for (const entry of MIGRATION_MANIFEST.slice(0, 27))
    await copyFile(join(source, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
  const journal = JSON.parse(await readFile(join(source, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, 27);
  await writeFile(join(temporary, 'meta/_journal.json'), JSON.stringify(journal));
  await admin.unsafe(`create database "${name}"`);
  client = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: temporary });
  const historicalHeartbeatId = randomUUID();
  await client`
    insert into operational_worker_heartbeat
      (id, service, release_sha, expected_schema_version, registered_queues, state, started_at, last_heartbeat_at)
    values (${historicalHeartbeatId}, 'vigilo-worker', ${'a'.repeat(40)}, '0026',
      ${JSON.stringify(canonicalRepairQueues)}::jsonb, 'starting', statement_timestamp(), statement_timestamp())
  `;
  const [before] = await client<{ id: string; service: string; releaseSha: string;
    version: string; queues: string[]; state: string }[]>`
    select id, service, release_sha as "releaseSha", expected_schema_version as version,
      registered_queues as queues, state from operational_worker_heartbeat where id = ${historicalHeartbeatId}
  `;
  await migrate(drizzle(client), { migrationsFolder: source });
  const [after] = await client<typeof before[]>`
    select id, service, release_sha as "releaseSha", expected_schema_version as version,
      registered_queues as queues, state from operational_worker_heartbeat where id = ${historicalHeartbeatId}
  `;
  assert.deepEqual(after, before);
  const ledger = await client<{ hash: string; createdAt: string }[]>`
    select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id
  `;
  assert.equal(ledger.length, 28);
  assert.equal(validateMigrationLedger(ledger), 'complete');
  assert.equal(ledger[27]?.hash, MIGRATION_MANIFEST[27]?.hash);
  const [catalog] = await client<{ targetQueue: string | null; guard: string | null;
    liveJob: string | null; liveRun: string | null }[]>`
    select
      (select column_name from information_schema.columns where table_name = 'operational_worker_heartbeat'
        and column_name = 'target_queue_name') as "targetQueue",
      (select pg_get_functiondef(oid) from pg_proc where proname = 'guard_operational_worker_heartbeat' limit 1) as guard,
      (select indexdef from pg_indexes where indexname = 'operational_exact_one_shot_live_job_unique') as "liveJob",
      (select indexdef from pg_indexes where indexname = 'operational_exact_one_shot_live_run_unique') as "liveRun"
  `;
  assert.equal(catalog?.targetQueue, 'target_queue_name');
  assert.match(catalog.guard ?? '', /target_queue_name/);
  assert.match(catalog.liveJob ?? '', /UNIQUE INDEX/);
  assert.match(catalog.liveRun ?? '', /UNIQUE INDEX/);
  await assert.rejects(client`
    insert into operational_worker_heartbeat
      (id, service, release_sha, expected_schema_version, registered_queues,
        target_repair_run_id, target_job_id, target_queue_name, state)
    values (${randomUUID()}, 'vigilo-exact-one-shot', ${'b'.repeat(40)}, '0027',
      '[null]'::jsonb, ${randomUUID()}, ${randomUUID()}, null, 'starting')
  `, /operational_worker_heartbeat_queues_check/);
  process.stdout.write(JSON.stringify({ upgrade: '0026-to-0027', preservedHeartbeats: 1,
    ledger: 28, constraints: 'passed', result: 'passed' }) + '\n');
} finally {
  if (client) await client.end({ timeout: 1 });
  await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
  await admin.unsafe(`drop database if exists "${name}"`);
  await admin.end({ timeout: 1 });
  await rm(temporary, { recursive: true, force: true });
}
