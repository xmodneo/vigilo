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
  const [facts] = await probe<{ attemptTable: string | null; investigationTable: string | null; candidateTable: string | null; verificationTable: string | null; aiInvestigationTable: string | null; aiAttemptTable: string | null; aiEventTable: string | null; cleanupConstraint: string | null; investigationConstraint: string | null; candidateConstraint: string | null; verificationConstraint: string | null; aiStateConstraint: string | null; aiEvidenceConstraint: string | null; aiExecutionConstraint: string | null; candidateGuard: string | null; fileGuard: string | null; eventGuard: string | null; verificationGuard: string | null; verificationEvidenceGuard: string | null; verificationEventGuard: string | null; aiGuard: string | null; aiEventGuard: string | null; candidateRunFk: string | null; candidateFileFk: string | null; verificationCandidateFk: string | null; verificationEvidenceFk: string | null; contextAiFk: string | null; activeVerificationIndex: string | null; activeAiIndex: string | null; activeAiAttemptIndex: string | null; aiOrdinalIndex: string | null; aiIdempotencyIndex: string | null; candidateWideUniqueCount: number; aiWideUniqueCount: number }[]>`
    select
      to_regclass('public.repair_run_attempt')::text as "attemptTable",
      to_regclass('public.investigation')::text as "investigationTable",
      to_regclass('public.repair_candidate')::text as "candidateTable",
      to_regclass('public.candidate_verification')::text as "verificationTable",
      to_regclass('public.ai_investigation')::text as "aiInvestigationTable",
      to_regclass('public.ai_investigation_attempt')::text as "aiAttemptTable",
      to_regclass('public.ai_investigation_event')::text as "aiEventTable",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_run_attempt_cleanup_check') as "cleanupConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'investigation_state_facts_check') as "investigationConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_candidate_state_facts_check') as "candidateConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'candidate_verification_state_facts_check') as "verificationConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_investigation_state_facts_check') as "aiStateConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_investigation_evidence_check') as "aiEvidenceConstraint",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_investigation_execution_check') as "aiExecutionConstraint",
      (select tgname from pg_trigger where tgname = 'repair_candidate_update_guard' and not tgisinternal) as "candidateGuard",
      (select tgname from pg_trigger where tgname = 'repair_candidate_file_mutation_guard' and not tgisinternal) as "fileGuard",
      (select tgname from pg_trigger where tgname = 'repair_candidate_event_mutation_guard' and not tgisinternal) as "eventGuard",
      (select tgname from pg_trigger where tgname = 'candidate_verification_update_guard' and not tgisinternal) as "verificationGuard",
      (select tgname from pg_trigger where tgname = 'candidate_verification_evidence_mutation_guard' and not tgisinternal) as "verificationEvidenceGuard",
      (select tgname from pg_trigger where tgname = 'candidate_verification_event_mutation_guard' and not tgisinternal) as "verificationEventGuard",
      (select tgname from pg_trigger where tgname = 'ai_investigation_update_guard' and not tgisinternal) as "aiGuard",
      (select tgname from pg_trigger where tgname = 'ai_investigation_event_mutation_guard' and not tgisinternal) as "aiEventGuard",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_candidate_repair_run_id_repair_run_id_fk') as "candidateRunFk",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'repair_candidate_file_candidate_id_repair_candidate_id_fk') as "candidateFileFk",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'candidate_verification_candidate_id_repair_candidate_id_fk') as "verificationCandidateFk",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'candidate_verification_evidence_id_candidate_verification_evidence_id_fk') as "verificationEvidenceFk",
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'investigation_context_event_ai_id_fk') as "contextAiFk",
      (select indexdef from pg_indexes where indexname = 'candidate_verification_active_candidate_unique') as "activeVerificationIndex",
      (select indexdef from pg_indexes where indexname = 'ai_investigation_active_unique') as "activeAiIndex",
      (select indexdef from pg_indexes where indexname = 'ai_investigation_attempt_active_unique') as "activeAiAttemptIndex",
      (select indexdef from pg_indexes where indexname = 'ai_investigation_ordinal_unique') as "aiOrdinalIndex",
      (select indexdef from pg_indexes where indexname = 'ai_investigation_idempotency_unique') as "aiIdempotencyIndex",
      (select count(*)::int from pg_constraint where conrelid = 'candidate_verification'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (candidate_id)') as "candidateWideUniqueCount",
      (select count(*)::int from pg_constraint where conrelid = 'ai_investigation'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (investigation_id)') as "aiWideUniqueCount"
  `;
  const passed = facts?.attemptTable === 'repair_run_attempt' && facts.investigationTable === 'investigation' && facts.candidateTable === 'repair_candidate' && facts.verificationTable === 'candidate_verification' && facts.aiInvestigationTable === 'ai_investigation' && facts.aiAttemptTable === 'ai_investigation_attempt' && facts.aiEventTable === 'ai_investigation_event' &&
    facts.cleanupConstraint?.includes('unconfirmed_after_create_failure') === true && facts.investigationConstraint?.includes('context_preparing') === true && facts.candidateConstraint?.includes('frozen') === true && facts.verificationConstraint?.includes('checks_passed') === true &&
    facts.aiStateConstraint?.includes('investigating') === true && facts.aiEvidenceConstraint?.includes('model_conclusion') === true && facts.aiExecutionConstraint?.includes('execution_ordinal') === true &&
    facts.candidateGuard === 'repair_candidate_update_guard' && facts.fileGuard === 'repair_candidate_file_mutation_guard' && facts.eventGuard === 'repair_candidate_event_mutation_guard' &&
    facts.verificationGuard === 'candidate_verification_update_guard' && facts.verificationEvidenceGuard === 'candidate_verification_evidence_mutation_guard' && facts.verificationEventGuard === 'candidate_verification_event_mutation_guard' && facts.aiGuard === 'ai_investigation_update_guard' && facts.aiEventGuard === 'ai_investigation_event_mutation_guard' &&
    facts.candidateRunFk?.includes('ON DELETE RESTRICT') === true && facts.candidateFileFk?.includes('ON DELETE RESTRICT') === true &&
    facts.verificationCandidateFk?.includes('ON DELETE RESTRICT') === true && facts.verificationEvidenceFk?.includes('ON DELETE RESTRICT') === true && facts.contextAiFk?.includes('ON DELETE RESTRICT') === true &&
    facts.activeVerificationIndex?.includes("WHERE (state = ANY (ARRAY['created'::text, 'queued'::text, 'verifying'::text]))") === true && facts.activeAiIndex?.includes("WHERE (state = ANY (ARRAY['created'::text, 'queued'::text, 'investigating'::text]))") === true && facts.activeAiAttemptIndex?.includes("WHERE (state = 'active'::text)") === true && facts.aiOrdinalIndex?.includes('investigation_id, execution_ordinal') === true && facts.aiIdempotencyIndex?.includes('investigation_id, idempotency_key') === true && facts.candidateWideUniqueCount === 0 && facts.aiWideUniqueCount === 0;
  if (!passed) throw new Error('clean_migration_probe_failed');
  process.stdout.write(`${JSON.stringify({ migrations: '0000-0012', repairRunAttempt: 'present', investigation: 'present', repairCandidate: 'present', candidateVerification: 'present', aiInvestigation: 'present', constraints: 'current', result: 'passed' })}\n`);
} finally {
  if (probe) await probe.end();
  await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
}
