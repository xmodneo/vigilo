import postgres from 'postgres';

import { readDatabaseEnvironment } from '../auth/environment.ts';
import { canonicalRepairQueues } from './queues.ts';
import { parseTrustedProxyHops } from './rate-limit.ts';
import { readRuntimeRelease } from './release.ts';
import { EXPECTED_SCHEMA_VERSION, validateMigrationLedger } from './migrations.ts';

export interface ReadinessFacts {
  database: boolean;
  migrationLedger: boolean;
  queueSchema: boolean;
  queueSet: boolean;
  workerPresent: boolean;
  workerFresh: boolean;
  workerReleaseSha: string | null;
  workerSchemaVersion: string | null;
  executionAuthoritySchema: boolean;
  publicationSchema: boolean;
}

export interface ReadinessCheckResult {
  code: string;
  status: 'passed' | 'failed';
}

export interface ReadinessResult {
  status: 200 | 503;
  body: { service: 'vigilo-web'; status: 'ready' | 'not_ready'; reason?: string; checks: ReadinessCheckResult[] };
}

const checkDefinitions: Array<[keyof ReadinessFacts, string]> = [
  ['database', 'database_unavailable'],
  ['migrationLedger', 'migration_history_mismatch'],
  ['queueSchema', 'queue_schema_missing'],
  ['queueSet', 'queue_registration_incomplete'],
  ['workerPresent', 'worker_missing'],
  ['workerFresh', 'worker_stale'],
  ['executionAuthoritySchema', 'execution_authority_schema_mismatch'],
  ['publicationSchema', 'publication_schema_mismatch'],
];

export async function evaluateReadiness(input: {
  releaseSha: string;
  check: () => Promise<ReadinessFacts>;
}): Promise<ReadinessResult> {
  let facts: ReadinessFacts;
  try {
    facts = await input.check();
  } catch {
    facts = {
      database: false, migrationLedger: false, queueSchema: false, queueSet: false,
      workerPresent: false, workerFresh: false, workerReleaseSha: null, workerSchemaVersion: null,
      executionAuthoritySchema: false, publicationSchema: false,
    };
  }
  const checks = checkDefinitions.map(([key, code]) => ({ code, status: facts[key] === true ? 'passed' as const : 'failed' as const }));
  checks.push({ code: 'worker_release_mismatch', status: facts.workerReleaseSha === input.releaseSha ? 'passed' : 'failed' });
  checks.push({ code: 'worker_schema_mismatch', status: facts.workerSchemaVersion === EXPECTED_SCHEMA_VERSION ? 'passed' : 'failed' });
  const ready = checks.every((check) => check.status === 'passed');
  return {
    status: ready ? 200 : 503,
    body: { service: 'vigilo-web', status: ready ? 'ready' : 'not_ready', ...(ready ? {} : { reason: checks.find((check) => check.status === 'failed')!.code }), checks },
  };
}

async function readDatabaseFacts(databaseUrl: string, releaseSha: string): Promise<ReadinessFacts> {
  const client = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 3, idle_timeout: 3, connection: { statement_timeout: 3000, lock_timeout: 1000 } });
  try {
    const ledger = await client<{ hash: string; createdAt: string }[]>`
      select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id
    `;
    let migrationLedger = false;
    try { migrationLedger = validateMigrationLedger(ledger) === 'complete'; } catch { /* fail closed */ }
    const [catalog] = await client<{
      queueTable: string | null; jobTable: string | null; heartbeatTable: string | null; grantTable: string | null;
      acceptanceTable: string | null; publicationTable: string | null; rateLimitTable: string | null;
      executionGuardCount: number; publicationGuardCount: number; heartbeatGuardCount: number;
    }[]>`
      select to_regclass('pgboss.queue')::text as "queueTable",
        to_regclass('pgboss.job')::text as "jobTable",
        to_regclass('public.operational_worker_heartbeat')::text as "heartbeatTable",
        to_regclass('public.execution_budget_grant')::text as "grantTable",
        to_regclass('public.release_acceptance')::text as "acceptanceTable",
        to_regclass('public.repair_publication')::text as "publicationTable",
        to_regclass('public.http_rate_limit_bucket')::text as "rateLimitTable",
        (select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid where (t.tgname,c.relname) in (
          ('external_execution_semaphore_mutation_guard','external_execution_semaphore'),
          ('execution_budget_grant_mutation_guard','execution_budget_grant'),
          ('execution_budget_grant_revocation_mutation_guard','execution_budget_grant_revocation'),
          ('external_execution_reservation_insert_guard','external_execution_reservation'),
          ('external_execution_reservation_mutation_guard','external_execution_reservation'),
          ('external_execution_lease_insert_guard','external_execution_lease'),
          ('external_execution_lease_mutation_guard','external_execution_lease'),
          ('external_execution_event_insert_guard','external_execution_event'),
          ('external_execution_event_mutation_guard','external_execution_event'),
          ('release_acceptance_insert_guard','release_acceptance'),
          ('release_acceptance_mutation_guard','release_acceptance'),
          ('release_acceptance_revocation_mutation_guard','release_acceptance_revocation')
        ) and not t.tgisinternal) as "executionGuardCount",
        (select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid where (t.tgname,c.relname) in (
          ('repair_publication_insert_guard','repair_publication'),
          ('repair_publication_update_guard','repair_publication'),
          ('repair_publication_delete_guard','repair_publication'),
          ('repair_publication_attempt_mutation_guard','repair_publication_attempt'),
          ('repair_publication_event_insert_guard','repair_publication_event'),
          ('repair_publication_event_mutation_guard','repair_publication_event'),
          ('repair_publication_intent_mutation_guard','repair_intent')
        ) and not t.tgisinternal) as "publicationGuardCount",
        (select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'operational_worker_heartbeat_guard' and c.relname = 'operational_worker_heartbeat' and not t.tgisinternal) as "heartbeatGuardCount"
    `;
    const queues = catalog?.queueTable ? await client<{ name: string }[]>`select name from pgboss.queue order by name` : [];
    const names = queues.map((row) => row.name);
    const queueSet = names.length === canonicalRepairQueues.length && names.every((name, index) => name === canonicalRepairQueues[index]);
    const [worker] = catalog?.heartbeatTable ? await client<{ present: boolean; fresh: boolean; releaseSha: string | null; expectedSchemaVersion: string | null }[]>`
      with workers as (
        select release_sha, expected_schema_version, last_heartbeat_at,
          (state = 'ready' and last_heartbeat_at >= statement_timestamp() - interval '45 seconds') as fresh
        from operational_worker_heartbeat
        where service = 'vigilo-worker' and state <> 'stopped'
      ), reported as (
        select release_sha, expected_schema_version from workers
        order by case when fresh and release_sha = ${releaseSha} and expected_schema_version = ${EXPECTED_SCHEMA_VERSION} then 0 when fresh then 1 else 2 end,
          last_heartbeat_at desc
        limit 1
      )
      select exists(select 1 from workers) as present,
        exists(select 1 from workers where fresh) as fresh,
        (select release_sha from reported) as "releaseSha",
        (select expected_schema_version from reported) as "expectedSchemaVersion"
    ` : [];
    return {
      database: true,
      migrationLedger,
      queueSchema: Boolean(catalog?.queueTable && catalog.jobTable),
      queueSet,
      workerPresent: worker?.present === true,
      workerFresh: worker?.fresh === true,
      workerReleaseSha: worker?.releaseSha ?? null,
      workerSchemaVersion: worker?.expectedSchemaVersion ?? null,
      executionAuthoritySchema: Boolean(catalog?.grantTable && catalog.acceptanceTable && catalog.executionGuardCount === 12),
      publicationSchema: Boolean(catalog?.publicationTable && catalog.rateLimitTable && catalog.heartbeatTable && catalog.publicationGuardCount === 7 && catalog.heartbeatGuardCount === 1),
    };
  } finally {
    await client.end({ timeout: 1 });
  }
}

export async function getReadinessResult(environment: NodeJS.ProcessEnv = process.env): Promise<ReadinessResult> {
  try {
    const { databaseUrl } = readDatabaseEnvironment(environment);
    const releaseSha = readRuntimeRelease(environment);
    if (environment.NODE_ENV === 'production') {
      if (!environment.VIGILO_RATE_LIMIT_HMAC_KEY || Buffer.byteLength(environment.VIGILO_RATE_LIMIT_HMAC_KEY) < 32 || parseTrustedProxyHops(environment.VIGILO_TRUST_PROXY_HOPS) === undefined) {
        throw new Error('readiness_configuration_invalid');
      }
    }
    return evaluateReadiness({ releaseSha, check: () => readDatabaseFacts(databaseUrl, releaseSha) });
  } catch {
    return { status: 503, body: { service: 'vigilo-web', status: 'not_ready', reason: 'readiness_configuration_invalid', checks: [{ code: 'readiness_configuration_invalid', status: 'failed' }] } };
  }
}
