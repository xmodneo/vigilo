import type postgres from 'postgres';

import { canonicalRepairQueues } from './queues.ts';
import { validateMigrationLedger } from './migrations.ts';

export interface OperationalMetric {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

const SAFE_LABELS = new Set(['queue', 'state', 'provider', 'category', 'outcome', 'action', 'freshness']);
const SAFE_VALUE = /^[a-z0-9_-]{1,80}$/;

export function validateOperationalSnapshot(metrics: readonly OperationalMetric[]): void {
  if (metrics.length > 200) throw new Error('operational_snapshot_cardinality_exceeded');
  for (const metric of metrics) {
    if (!/^[a-z][a-z0-9_]{1,80}$/.test(metric.metric) || !Number.isFinite(metric.value) || metric.value < 0) throw new Error('operational_snapshot_invalid');
    for (const [key, value] of Object.entries(metric.labels)) {
      if (!SAFE_LABELS.has(key) || !SAFE_VALUE.test(value)) throw new Error('operational_snapshot_label_invalid');
    }
  }
}

export async function collectOperationalSnapshot(client: ReturnType<typeof postgres>): Promise<OperationalMetric[]> {
  const metrics: OperationalMetric[] = [];
  let migrationIncompatible = 0;
  try {
    const ledger = await client<{ hash: string; createdAt: string }[]>`select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id`;
    if (validateMigrationLedger(ledger) !== 'complete') migrationIncompatible = 1;
  } catch { migrationIncompatible = 1; }
  const queueRows = await client<{ queue: string; backlog: number; oldestSeconds: number }[]>`
    select q.name as queue,
      count(j.id) filter (where j.state in ('created','retry'))::int as backlog,
      coalesce(max(extract(epoch from (statement_timestamp() - j.created_on))) filter (where j.state in ('created','retry')),0)::int as "oldestSeconds"
    from pgboss.queue q left join pgboss.job j on j.name = q.name
    where q.name = any(${canonicalRepairQueues as string[]}) group by q.name order by q.name
  `;
  for (const row of queueRows) {
    metrics.push({ metric: 'queue_backlog', labels: { queue: row.queue }, value: row.backlog });
    metrics.push({ metric: 'queue_oldest_pending_seconds', labels: { queue: row.queue }, value: row.oldestSeconds });
  }
  const workerRows = await client<{ freshness: string; count: number; maximumAge: number }[]>`
    select case when state = 'ready' and last_heartbeat_at >= statement_timestamp() - interval '45 seconds' then 'fresh' else 'stale' end as freshness,
      count(*)::int as count, coalesce(max(extract(epoch from (statement_timestamp() - last_heartbeat_at))),0)::int as "maximumAge"
    from operational_worker_heartbeat where state <> 'stopped' group by freshness
  `;
  for (const row of workerRows) {
    metrics.push({ metric: 'worker_count', labels: { freshness: row.freshness }, value: row.count });
    metrics.push({ metric: 'worker_heartbeat_age_seconds', labels: { freshness: row.freshness }, value: Math.max(0, row.maximumAge) });
  }
  const runRows = await client<{ state: string; count: number }[]>`
    select state, count(*)::int as count from repair_run
    where state in ('created','baseline_running','ready_for_investigation','investigating') group by state
  `;
  for (const row of runRows) metrics.push({ metric: 'active_repair_runs', labels: { state: row.state }, value: row.count });
  const [leases] = await client<{ domain: number; external: number }[]>`
    select
      (select count(*)::int from repair_run_attempt where state = 'active' and lease_expires_at <= statement_timestamp()) as domain,
      (select count(*)::int from external_execution_lease where state = 'active' and lease_expires_at <= statement_timestamp()) as external
  `;
  metrics.push({ metric: 'stale_domain_leases', labels: {}, value: leases?.domain ?? 0 });
  metrics.push({ metric: 'stale_external_execution_leases', labels: {}, value: leases?.external ?? 0 });
  const providerRows = await client<{ provider: string; category: string; outcome: string; count: number }[]>`
    select case when r.provider_id in ('google','vercel-sandbox') then r.provider_id else 'other' end as provider,
      r.operation_category as category,
      replace(e.event_type, 'attempt_', '') as outcome, count(*)::int as count
    from external_execution_event e join external_execution_reservation r on r.id = e.reservation_id
    where e.event_type in ('attempt_succeeded','attempt_failed','attempt_ambiguous')
    group by 1, r.operation_category, e.event_type
  `;
  for (const row of providerRows) metrics.push({ metric: 'provider_attempts', labels: { provider: row.provider, category: row.category, outcome: row.outcome }, value: row.count });
  const [security] = await client<{ exhausted: number; denied: number; cleanup: number; revocation: number; publication: number }[]>`
    select
      (select count(*)::int from external_execution_event where failure_code = 'execution_budget_exhausted') as exhausted,
      (select count(*)::int from external_execution_event where failure_code like 'execution_authority_%') as denied,
      ((select count(*) from repair_run_attempt where cleanup_lookup in ('still_present','unconfirmed','unconfirmed_after_create_failure','not_run')) +
       (select count(*) from candidate_verification_attempt where cleanup_lookup in ('still_present','unconfirmed','unconfirmed_after_create_failure','not_run')))::int as cleanup,
      (select count(*)::int from repair_publication_event where failure_code = 'token_revocation_unconfirmed') as revocation,
      (select count(*)::int from repair_publication where state = 'review_required') as publication
  `;
  metrics.push({ metric: 'execution_budget_exhausted', labels: {}, value: security?.exhausted ?? 0 });
  metrics.push({ metric: 'execution_authority_denials', labels: {}, value: security?.denied ?? 0 });
  metrics.push({ metric: 'unresolved_sandbox_cleanup', labels: {}, value: security?.cleanup ?? 0 });
  metrics.push({ metric: 'token_revocation_failures', labels: {}, value: security?.revocation ?? 0 });
  metrics.push({ metric: 'publication_review_required', labels: {}, value: security?.publication ?? 0 });
  const rateRows = await client<{ action: string; count: number }[]>`
    select action, sum(request_count)::int as count from http_rate_limit_bucket
    where expires_at > statement_timestamp() group by action order by action
  `;
  for (const row of rateRows) metrics.push({ metric: 'rate_limit_requests', labels: { action: row.action }, value: row.count });
  metrics.push({ metric: 'migration_startup_incompatibility', labels: {}, value: migrationIncompatible });
  validateOperationalSnapshot(metrics);
  return metrics;
}
