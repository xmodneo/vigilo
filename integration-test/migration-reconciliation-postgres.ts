import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';

import * as schema from '../db/schema.ts';

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error('missing_required_environment:DATABASE_URL');
const databaseUrl: string = configuredUrl;

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const historicalHashes = new Map([
  ['0006_repair-run', '476a31593cd189ada853691ed50f1561b11382558fbcc447a4fb1dc3fac1255b'],
  ['0007_repair-worker', '0c3e8a5717d0b4ee4f14498a756e9aa1b0c3d9621cd051aa180728b479ac3f91'],
  ['0009_repair-candidate', '710e062fd6f8e509b4a67b4983d7f57589e7a822cd4bede5a24d552369c2af82'],
  ['0010_candidate-verification', 'ca19149548610d78b624f788a6d13f6337afac5deb5004b02354350bbcac4f28'],
  ['0011_ai-investigation', 'ddea7b4e42583afa8f625081d83f4e88b045b7ba2a6da3ddb485ef32edd7f3bd'],
  ['0017_ai-candidate-generation-protocol-v3', 'b1898fed050aa14e2556cd0022b8cb165849f25145c1c4d30c7ea2b0ea27dfc0'],
]);
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

const adminUrl = new URL(databaseUrl); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });

async function createHistoricalFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'vigilo-historical-migrations-'));
  const meta = join(folder, 'meta');
  await mkdir(meta);
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= 17);
  for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  await writeFile(join(meta, '_journal.json'), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`);
  return folder;
}

async function withDisposableDatabase<T>(label: string, operation: (sql: Sql) => Promise<T>) {
  const databaseName = `vigilo_reconcile_${label}_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseUrl); url.pathname = `/${databaseName}`;
  let sql: Sql | undefined;
  await admin.unsafe(`create database "${databaseName}"`);
  try {
    sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    return await operation(sql);
  } finally {
    if (sql) await sql.end();
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database if exists "${databaseName}"`);
  }
}

async function migrateFolder(sql: Sql, folder: string) {
  await migrate(drizzle(sql), { migrationsFolder: folder });
}

async function migrationRows(sql: Sql) {
  return sql<{ id: number; hash: string; createdAt: string }[]>`
    select id, hash, created_at::text as "createdAt"
    from drizzle.__drizzle_migrations
    order by id
  `;
}

async function assertHistoricalHashes(sql: Sql) {
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const rows = await migrationRows(sql);
  assert.equal(rows.length, 21);
  for (const [tag, expected] of historicalHashes) {
    const entry = journal.entries.find((candidate) => candidate.tag === tag);
    assert.ok(entry, tag);
    assert.equal(rows[entry.idx]?.hash, expected, tag);
  }
  for (const entry of journal.entries) {
    const content = await readFile(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    assert.equal(rows[entry.idx]?.hash, sha256(content), entry.tag);
  }
}

const NOW = new Date('2031-01-02T03:04:05.000Z');
const COMMIT = 'a'.repeat(40); const PROFILE = 'b'.repeat(64); const SOURCE = 'c'.repeat(64); const TREE = 'd'.repeat(40);
const REPOSITORY_ID = 91001; const INSTALLATION_ID = 92001;

async function seedRepresentativeRows(sql: Sql) {
  const database = drizzle(sql, { schema });
  const userId = randomUUID(); const workspaceId = randomUUID(); const baselineId = randomUUID(); const runId = randomUUID();
  const intentId = randomUUID(); const investigationId = randomUUID(); const aiId = randomUUID(); const candidateId = randomUUID();
  const verificationId = randomUUID(); const generationId = randomUUID();
  await database.insert(schema.user).values({ id: userId, name: 'Migration owner', email: `${userId}@test.invalid`, emailVerified: true });
  await database.insert(schema.workspace).values({ id: workspaceId, ownerUserId: userId });
  await database.insert(schema.githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId, githubAccountId: 93001, accountLogin: 'migration-owner', accountType: 'User', status: 'active' });
  await database.insert(schema.repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 93001, ownerLogin: 'migration-owner', name: 'migration-repo', fullName: 'migration-owner/migration-repo', defaultBranch: 'main', isPrivate: true });
  await database.insert(schema.executionProfile).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity: PROFILE, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'e'.repeat(40), packageJsonContentSha256: 'f'.repeat(64), packageLockBlobSha: '1'.repeat(40), packageLockContentSha256: '2'.repeat(64), status: 'ready' });
  await database.insert(schema.repositoryBaseline).values({ id: baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity: PROFILE, baseCommitSha: COMMIT, archiveSha256: '3'.repeat(64), sandboxName: 'migration-baseline', sourceIdentityBefore: SOURCE, sourceIdentityAfter: SOURCE, sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'completed', testExitCode: 0, testTimedOut: false, executionOutcome: 'baseline_passed', overallOutcome: 'baseline_passed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await database.insert(schema.repairRun).values({ id: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: PROFILE, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId, baselineOutcome: 'baseline_passed', baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  await database.insert(schema.repairIntent).values({ id: intentId, repairRunId: runId, workspaceId, objective: 'Preserve representative rows.', objectiveHash: sha256('Preserve representative rows.') });
  await database.insert(schema.investigation).values({ id: investigationId, repairRunId: runId, repairIntentId: intentId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: TREE, indexedPathCount: 1, attemptNumber: 1, completedAt: NOW, updatedAt: NOW });
  await database.insert(schema.aiInvestigation).values({ id: aiId, investigationId, executionOrdinal: 1, idempotencyKey: randomUUID(), repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 1, state: 'completed', queuedAt: NOW, investigationStartedAt: NOW, completedAt: NOW, completionReason: 'model_conclusion', conclusionStatus: 'insufficient_evidence', summary: 'Representative migration row.', suspectedFiles: [], evidenceReferences: [{ kind: 'baseline', reference: randomUUID() }], proposedApproach: 'Preserve this row.', confidence: 'low', updatedAt: NOW });
  await database.insert(schema.repairCandidate).values({ id: candidateId, investigationId, repairRunId: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, formatVersion: 1, ordinal: 1, proposalKey: generationId, proposalIdentity: '4'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: 1, freezingStartedAt: NOW, updatedAt: NOW });
  await database.insert(schema.repairCandidateFile).values({ candidateId, path: 'src/value.ts', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256('x'), resultByteLength: 1, resultingContent: 'x' });
  await database.update(schema.repairCandidate).set({ state: 'frozen', candidateIdentity: '5'.repeat(64), completedAt: NOW, updatedAt: NOW });
  await database.insert(schema.repairCandidateEvent).values({ id: randomUUID(), candidateId, workspaceId, eventType: 'frozen', candidateOrdinal: 1, changedFileCount: 1, totalResultBytes: 1, candidateIdentity: '5'.repeat(64), createdAt: NOW });
  await database.insert(schema.candidateVerification).values({ id: verificationId, candidateId, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, candidateIdentity: '5'.repeat(64), formatVersion: 1, state: 'queued', queuedAt: NOW, updatedAt: NOW });
  await database.insert(schema.aiCandidateGeneration).values({ id: generationId, aiInvestigationId: aiId, executionOrdinal: 1, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 3, idempotencyKey: randomUUID(), state: 'queued', queuedAt: NOW, updatedAt: NOW });
  return { userId, workspaceId, baselineId, runId, intentId, investigationId, aiId, candidateId, verificationId, generationId };
}

const preservedTables = [
  ['user', 'id'], ['workspace', 'id'], ['repository_baseline', 'id'], ['repair_run', 'id'], ['repair_intent', 'id'],
  ['investigation', 'id'], ['ai_investigation', 'id'], ['repair_candidate', 'id'], ['repair_candidate_file', 'candidate_id'],
  ['repair_candidate_event', 'id'], ['candidate_verification', 'id'], ['ai_candidate_generation', 'id'],
] as const;

async function dataFingerprint(sql: Sql) {
  const result: Record<string, { count: number; identity: string }> = {};
  for (const [table, key] of preservedTables) {
    const [row] = await sql.unsafe<{ count: number; identity: string }[]>(`select count(*)::int as count, coalesce(md5(string_agg(${key}::text, '|' order by ${key}::text)), '') as identity from "${table}"`);
    assert.ok(row);
    result[table] = row;
  }
  return result;
}

async function applyDocumentedManualCorrections(sql: Sql) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe('alter table repository_baseline drop constraint repository_baseline_github_repository_id_repository_github_repository_id_fk');
    await transaction.unsafe('alter table repository_baseline drop constraint repository_baseline_installation_id_github_installation_installation_id_fk');
    await transaction.unsafe("create unique index repair_run_active_identity_unique on repair_run (workspace_id,github_repository_id,installation_id,profile_identity,base_commit_sha) where state in ('created','baseline_running')");
    await transaction.unsafe('alter table repair_run_attempt drop constraint repair_run_attempt_cleanup_check');
    await transaction.unsafe("alter table repair_run_attempt add constraint repair_run_attempt_cleanup_check check ((cleanup_stop is null or cleanup_stop in ('confirmed','failed','not_needed')) and (cleanup_delete is null or cleanup_delete in ('confirmed','failed','not_needed')) and (cleanup_lookup is null or cleanup_lookup in ('absent','still_present','unconfirmed','unconfirmed_after_create_failure','not_run')))");
    await transaction.unsafe('alter table candidate_verification drop constraint candidate_verification_candidate_id_key');
  });
}

async function assertFinalCatalog(sql: Sql) {
  const foreignKeys = await sql<{ name: string; action: string }[]>`
    select conname::text as name, confdeltype::text as action
    from pg_constraint
    where conname::text in (
      'repair_candidate_investigation_id_investigation_id_fk',
      'repair_candidate_repair_run_id_repair_run_id_fk',
      'repair_candidate_workspace_id_workspace_id_fk',
      'repair_candidate_file_candidate_id_repair_candidate_id_fk',
      'repair_candidate_event_candidate_id_repair_candidate_id_fk',
      'repair_candidate_event_workspace_id_workspace_id_fk'
    ) order by name
  `;
  assert.equal(foreignKeys.length, 6);
  assert.ok(foreignKeys.every((foreignKey) => foreignKey.action === 'r'));
  const [facts] = await sql<{ usage: string; guard: string; repairLoop: string | null; repairLoopIteration: string | null; repairLoopEvent: string | null; repairLoopGuardCount: number; globalCandidateUnique: number }[]>`
    select
      (select pg_get_constraintdef(oid, true) from pg_constraint where conrelid = 'ai_investigation'::regclass and conname = 'ai_investigation_usage_check') as usage,
      (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'guard_ai_candidate_generation_update') as guard,
      to_regclass('public.repair_loop')::text as "repairLoop",
      to_regclass('public.repair_loop_iteration')::text as "repairLoopIteration",
      to_regclass('public.repair_loop_event')::text as "repairLoopEvent",
      (select count(*)::int from pg_trigger where tgname in ('repair_loop_update_guard','repair_loop_iteration_update_guard','repair_loop_event_mutation_guard','repair_loop_event_insert_guard') and not tgisinternal) as "repairLoopGuardCount",
      (select count(*)::int from pg_constraint where conrelid = 'candidate_verification'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (candidate_id)') as "globalCandidateUnique"
  `;
  assert.ok(facts?.usage.includes('tool_call_count <= 20'));
  assert.ok(facts?.guard.includes('OLD."execution_ordinal"'));
  assert.deepEqual([facts?.repairLoop, facts?.repairLoopIteration, facts?.repairLoopEvent], ['repair_loop', 'repair_loop_iteration', 'repair_loop_event']);
  assert.equal(facts?.repairLoopGuardCount, 4);
  assert.equal(facts?.globalCandidateUnique, 0);
  const [review] = await sql<{ table: string | null; insertGuard: string | null; mutationGuard: string | null; childGuards: number }[]>`
    select
      to_regclass('public.human_review_decision')::text as table,
      (select tgname from pg_trigger where tgname = 'human_review_decision_insert_guard' and not tgisinternal) as "insertGuard",
      (select tgname from pg_trigger where tgname = 'human_review_decision_mutation_guard' and not tgisinternal) as "mutationGuard",
      (select count(*)::int from pg_trigger where tgname in ('human_review_generation_write_guard','human_review_candidate_write_guard','human_review_verification_write_guard','human_review_candidate_file_insert_guard') and not tgisinternal) as "childGuards"
  `;
  assert.deepEqual(review, { table: 'human_review_decision', insertGuard: 'human_review_decision_insert_guard', mutationGuard: 'human_review_decision_mutation_guard', childGuards: 4 });
}

async function schemaSnapshot(sql: Sql) {
  const [snapshot] = await sql<{ value: unknown }[]>`
    select jsonb_build_object(
      'columns', (select jsonb_agg(to_jsonb(x) order by x.table_name, x.ordinal_position) from (
        select table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
        from information_schema.columns where table_schema = 'public'
      ) x),
      'constraints', (select jsonb_agg(to_jsonb(x) order by x.table_name, x.constraint_name) from (
        select c.relname::text as table_name, p.conname::text as constraint_name, p.contype::text as constraint_type, pg_get_constraintdef(p.oid, true) as definition
        from pg_constraint p join pg_class c on c.oid = p.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
      ) x),
      'indexes', (select jsonb_agg(to_jsonb(x) order by x.tablename, x.indexname) from (
        select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
      ) x),
      'triggers', (select jsonb_agg(to_jsonb(x) order by x.table_name, x.trigger_name) from (
        select c.relname::text as table_name, t.tgname::text as trigger_name, pg_get_triggerdef(t.oid, true) as definition
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal
      ) x),
      'functions', (select jsonb_agg(to_jsonb(x) order by x.function_name) from (
        select p.proname::text as function_name, pg_get_functiondef(p.oid) as definition
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      ) x)
    ) as value
  `;
  return snapshot?.value;
}

async function runUpgradePath(sql: Sql, historicalFolder: string, manuallyReconciled: boolean) {
  await migrateFolder(sql, historicalFolder);
  assert.equal((await migrationRows(sql)).length, 18);
  const identifiers = await seedRepresentativeRows(sql);
  if (manuallyReconciled) await applyDocumentedManualCorrections(sql);
  const before = await dataFingerprint(sql);
  await migrateFolder(sql, migrationsFolder);
  await assertHistoricalHashes(sql);
  await assertFinalCatalog(sql);
  assert.deepEqual(await dataFingerprint(sql), before);
  return { identifiers, schema: await schemaSnapshot(sql), data: before };
}

type FailureCase = { name: string; expected: string; corrupt: (sql: Sql) => Promise<unknown> };
const failureCases: FailureCase[] = [
  { name: '0006', expected: 'historical_reconciliation_unexpected_0006_state', corrupt: (sql) => sql.unsafe('alter table repository_baseline drop constraint repository_baseline_github_repository_id_repository_github_repository_id_fk') },
  { name: '0007', expected: 'historical_reconciliation_unexpected_0007_cleanup_check', corrupt: async (sql) => { await sql.unsafe('alter table repair_run_attempt drop constraint repair_run_attempt_cleanup_check'); await sql.unsafe("alter table repair_run_attempt add constraint repair_run_attempt_cleanup_check check (cleanup_lookup is null or cleanup_lookup in ('absent','unexpected'))"); } },
  { name: '0009', expected: 'historical_reconciliation_unexpected_0009_mixed_fk_state', corrupt: async (sql) => { await sql.unsafe('alter table repair_candidate drop constraint repair_candidate_investigation_id_investigation_id_fk'); await sql.unsafe('alter table repair_candidate add constraint repair_candidate_investigation_id_investigation_id_fk foreign key (investigation_id) references investigation(id) on delete restrict'); } },
  { name: '0010', expected: 'historical_reconciliation_unexpected_0010_candidate_unique', corrupt: (sql) => sql.unsafe('alter table candidate_verification rename constraint candidate_verification_candidate_id_key to unexpected_candidate_unique') },
  { name: '0011', expected: 'historical_reconciliation_unexpected_0011_usage_check', corrupt: async (sql) => { await sql.unsafe('alter table ai_investigation drop constraint ai_investigation_usage_check'); await sql.unsafe('alter table ai_investigation add constraint ai_investigation_usage_check check (input_tokens between 0 and 1000000 and output_tokens between 0 and 100000 and tool_call_count between 0 and 19 and model_turn_count between 0 and 8)'); } },
  { name: '0017', expected: 'historical_reconciliation_unexpected_0017_authority_guard', corrupt: (sql) => sql.unsafe("create or replace function guard_ai_candidate_generation_update() returns trigger as $$ begin return new; end; $$ language plpgsql") },
];

function errorChain(error: unknown) {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return messages.join(' | ');
}

const historicalFolder = await createHistoricalFolder();
try {
  const clean = await withDisposableDatabase('clean', (sql) => runUpgradePath(sql, historicalFolder, false));
  const historical = await withDisposableDatabase('historical', (sql) => runUpgradePath(sql, historicalFolder, true));
  assert.deepEqual(historical.schema, clean.schema);
  assert.deepEqual(Object.keys(historical.data), Object.keys(clean.data));

  const failures: string[] = [];
  for (const failureCase of failureCases) {
    await withDisposableDatabase(`fail_${failureCase.name}`, async (sql) => {
      await migrateFolder(sql, historicalFolder);
      await failureCase.corrupt(sql);
      const before = await schemaSnapshot(sql);
      const beforeHistory = await migrationRows(sql);
      await assert.rejects(migrateFolder(sql, migrationsFolder), (error: unknown) => errorChain(error).includes(failureCase.expected));
      assert.deepEqual(await schemaSnapshot(sql), before);
      assert.deepEqual(await migrationRows(sql), beforeHistory);
      const [repairLoop] = await sql<{ table: string | null }[]>`select to_regclass('public.repair_loop')::text as table`;
      assert.equal(repairLoop?.table, null);
      failures.push(failureCase.name);
    });
  }

  process.stdout.write(`${JSON.stringify({ cleanInstall: 'passed', historicalUpgrade: 'passed', finalSchemaComparison: 'equal', representativeRows: 'preserved', failClosedCases: failures, persistentDatabase: 'untouched' })}\n`);
} finally {
  await rm(historicalFolder, { recursive: true, force: true });
  await admin.end();
}
