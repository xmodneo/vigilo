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
  const [facts] = await probe<{ attemptTable: string | null; investigationTable: string | null; candidateTable: string | null; cleanupConstraint: string | null; investigationConstraint: string | null; candidateConstraint: string | null; candidateGuard: string | null; fileGuard: string | null; eventGuard: string | null; candidateRunFk: string | null; candidateFileFk: string | null }[]>`
    select
      to_regclass('public.repair_run_attempt')::text as "attemptTable",
      to_regclass('public.investigation')::text as "investigationTable",
      to_regclass('public.repair_candidate')::text as "candidateTable",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_run_attempt_cleanup_check') as "cleanupConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'investigation_state_facts_check') as "investigationConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_candidate_state_facts_check') as "candidateConstraint",
      (select tgname from pg_trigger where tgname = 'repair_candidate_update_guard' and not tgisinternal) as "candidateGuard",
      (select tgname from pg_trigger where tgname = 'repair_candidate_file_mutation_guard' and not tgisinternal) as "fileGuard",
      (select tgname from pg_trigger where tgname = 'repair_candidate_event_mutation_guard' and not tgisinternal) as "eventGuard",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_candidate_repair_run_id_repair_run_id_fk') as "candidateRunFk",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_candidate_file_candidate_id_repair_candidate_id_fk') as "candidateFileFk"
  `;
  const passed = facts?.attemptTable === 'repair_run_attempt' && facts.investigationTable === 'investigation' && facts.candidateTable === 'repair_candidate' &&
    facts.cleanupConstraint?.includes('unconfirmed_after_create_failure') === true && facts.investigationConstraint?.includes('context_preparing') === true && facts.candidateConstraint?.includes('frozen') === true &&
    facts.candidateGuard === 'repair_candidate_update_guard' && facts.fileGuard === 'repair_candidate_file_mutation_guard' && facts.eventGuard === 'repair_candidate_event_mutation_guard' &&
    facts.candidateRunFk?.includes('ON DELETE RESTRICT') === true && facts.candidateFileFk?.includes('ON DELETE RESTRICT') === true;
  if (!passed) throw new Error('clean_migration_probe_failed');
  process.stdout.write(`${JSON.stringify({ migrations: '0000-0009', repairRunAttempt: 'present', investigation: 'present', repairCandidate: 'present', constraints: 'current', result: 'passed' })}\n`);
} finally {
  if (probe) await probe.end();
  await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
}
