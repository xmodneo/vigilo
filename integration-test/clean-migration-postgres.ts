import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error('missing_required_environment:DATABASE_URL');

const databaseName = `vigilo_migration_probe_${randomUUID().replaceAll('-', '')}`;
const adminUrl = new URL(configuredUrl); adminUrl.pathname = '/postgres';
const probeUrl = new URL(configuredUrl); probeUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
let probe: ReturnType<typeof postgres> | undefined;

try {
  await admin.unsafe(`create database "${databaseName}"`);
  probe = postgres(probeUrl.toString(), { max: 1, prepare: false });
  await migrate(drizzle(probe), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const [facts] = await probe<{ attemptTable: string | null; cleanupConstraint: string | null }[]>`
    select
      to_regclass('public.repair_run_attempt')::text as "attemptTable",
      pg_get_constraintdef(oid) as "cleanupConstraint"
    from pg_constraint
    where conname = 'repair_run_attempt_cleanup_check'
  `;
  const passed = facts?.attemptTable === 'repair_run_attempt' && facts.cleanupConstraint?.includes('unconfirmed_after_create_failure') === true;
  if (!passed) throw new Error('clean_migration_probe_failed');
  process.stdout.write(`${JSON.stringify({ migrations: '0000-0007', repairRunAttempt: 'present', cleanupConstraint: 'current', result: 'passed' })}\n`);
} finally {
  if (probe) await probe.end();
  await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
}
