import { createRequire } from 'node:module';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  operationalWorkerHeartbeat, repairRun, repairRunAttempt, repairRunSourceCheckpoint,
  externalExecutionReservation, workspace,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { lockExternalExecution } from '../external-execution/business-fence.ts';
import { assertReviewedPlanIntegrity } from '../external-execution/reviewed-plan-integrity.ts';
import { assertPublicRepositoryAuthority } from '../github-repositories/policy.ts';
import { REVIEWED_BASELINE_QUEUE, parseRepairJobPayload } from './queue.ts';

// pg-boss 12.30.0 has no exact-id fetch. Keep its claim state transition in one
// small, version-pinned adapter rather than exposing a general queue executor.
const installedVersion = (createRequire(import.meta.url)('pg-boss/package.json') as { version?: string }).version;
export const EXACT_BASELINE_PG_BOSS_VERSION = '12.30.0';

export interface ExactBaselineRequest {
  repairRunId: string;
  jobId: string;
  planIdentity: string;
  repositoryId: number;
  revision: string;
  releaseSha: string;
}

export class ExactBaselineJobError extends Error {
  constructor(public readonly code: 'exact_job_invalid' | 'exact_job_unavailable' | 'exact_job_authority_changed') {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

export function parseExactBaselineArguments(args: readonly string[]): ExactBaselineRequest {
  const names = ['--repair-run', '--job', '--plan-identity', '--repository-id', '--revision', '--release'];
  if (args.length !== names.length * 2) throw new ExactBaselineJobError('exact_job_invalid');
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1]!;
    if (!names.includes(key) || values.has(key) || !value) throw new ExactBaselineJobError('exact_job_invalid');
    values.set(key, value);
  }
  const repairRunId = values.get('--repair-run')!;
  const jobId = values.get('--job')!;
  const planIdentity = values.get('--plan-identity')!;
  const repositoryIdText = values.get('--repository-id')!;
  const repositoryId = Number(repositoryIdText);
  const revision = values.get('--revision')!;
  const releaseSha = values.get('--release')!;
  if (!UUID.test(repairRunId) || jobId !== repairRunId || !HASH.test(planIdentity) ||
      !/^[1-9][0-9]*$/.test(repositoryIdText) || !Number.isSafeInteger(repositoryId) ||
      !SHA.test(revision) || !SHA.test(releaseSha)) throw new ExactBaselineJobError('exact_job_invalid');
  return { repairRunId, jobId, planIdentity, repositoryId, revision, releaseSha };
}

export function assertExactPgBossCompatibility(): void {
  if (installedVersion !== EXACT_BASELINE_PG_BOSS_VERSION) throw new ExactBaselineJobError('exact_job_unavailable');
}

type ClaimedJob = { id: string; data: unknown };

export async function claimExactReviewedBaselineJob(
  database: VigiloDatabase, request: ExactBaselineRequest, runtimeReleaseSha: string,
  options: { afterPostLockValidation?: () => Promise<void> } = {},
): Promise<ClaimedJob> {
  assertExactPgBossCompatibility();
  if (request.jobId !== request.repairRunId || request.releaseSha !== runtimeReleaseSha) throw new ExactBaselineJobError('exact_job_authority_changed');
  return database.transaction(async (transaction) => {
    await lockExternalExecution(transaction);
    const [subject] = await transaction.select().from(repairRun).where(eq(repairRun.id, request.repairRunId)).limit(1);
    if (!subject) throw new ExactBaselineJobError('exact_job_unavailable');
    const [owner] = await transaction.select({ id: workspace.id }).from(workspace)
      .where(eq(workspace.id, subject.workspaceId)).for('update').limit(1);
    if (!owner) throw new ExactBaselineJobError('exact_job_unavailable');
    const [run] = await transaction.select().from(repairRun).where(eq(repairRun.id, request.repairRunId)).for('update').limit(1);
    const [checkpoint] = await transaction.select().from(repairRunSourceCheckpoint)
      .where(eq(repairRunSourceCheckpoint.repairRunId, request.repairRunId)).limit(1);
    if (!run || run.state !== 'created' || run.baselineId !== null ||
        run.githubRepositoryId !== request.repositoryId || run.baseCommitSha !== request.revision ||
        checkpoint?.planIdentity !== request.planIdentity || checkpoint.state !== 'pending')
      throw new ExactBaselineJobError('exact_job_authority_changed');
    const [attempt] = await transaction.select({ id: repairRunAttempt.id }).from(repairRunAttempt)
      .where(eq(repairRunAttempt.repairRunId, run.id)).limit(1);
    const [reservation] = await transaction.select({ id: externalExecutionReservation.id }).from(externalExecutionReservation)
      .where(eq(externalExecutionReservation.repairRunId, run.id)).limit(1);
    if (attempt || reservation) throw new ExactBaselineJobError('exact_job_unavailable');
    await assertPublicRepositoryAuthority(transaction, run.workspaceId, run.githubRepositoryId);
    const queueResponse = await transaction.execute(sql`
      select policy from pgboss.queue where name = ${REVIEWED_BASELINE_QUEUE} for share
    `);
    const queueResult = queueResponse as unknown as { rows?: { policy: string }[] } | { policy: string }[];
    const queues = Array.isArray(queueResult) ? queueResult : queueResult.rows ?? [];
    if (queues.length !== 1 || queues[0]?.policy !== 'standard') throw new ExactBaselineJobError('exact_job_unavailable');
    const lockedJobResponse = await transaction.execute(sql`
      select id from pgboss.job where name = ${REVIEWED_BASELINE_QUEUE} and id = ${request.jobId}::uuid for update
    `);
    const lockedJobResult = lockedJobResponse as unknown as { rows?: { id: string }[] } | { id: string }[];
    const lockedJobs = Array.isArray(lockedJobResult) ? lockedJobResult : lockedJobResult.rows ?? [];
    if (lockedJobs.length !== 1) throw new ExactBaselineJobError('exact_job_unavailable');
    const timeResponse = await transaction.execute(sql`select clock_timestamp() as authority_time`);
    const timeResult = timeResponse as unknown as { rows?: { authority_time: Date | string }[] } | { authority_time: Date | string }[];
    const times = Array.isArray(timeResult) ? timeResult : timeResult.rows ?? [];
    const reportedTime = times[0]?.authority_time;
    const authorityTime = reportedTime instanceof Date ? reportedTime : typeof reportedTime === 'string' ? new Date(reportedTime) : null;
    if (!authorityTime || !Number.isFinite(authorityTime.getTime()))
      throw new ExactBaselineJobError('exact_job_unavailable');
    const [otherWorker] = await transaction.select({ id: operationalWorkerHeartbeat.id }).from(operationalWorkerHeartbeat)
      .where(and(eq(operationalWorkerHeartbeat.service, 'vigilo-worker'),
        inArray(operationalWorkerHeartbeat.state, ['starting', 'ready', 'draining']),
        sql`${operationalWorkerHeartbeat.lastHeartbeatAt} > clock_timestamp() - interval '45 seconds'`)).limit(1);
    if (otherWorker) throw new ExactBaselineJobError('exact_job_unavailable');
    if (await assertReviewedPlanIntegrity(transaction, run.id, runtimeReleaseSha, authorityTime) !== true)
      throw new ExactBaselineJobError('exact_job_authority_changed');
    await options.afterPostLockValidation?.();
    // Matches pg-boss 12.30.0 fetchNextJob's created->active fields, but adds
    // exact queue/id and forbids recovery or a second one-shot attempt. The
    // complete plan validated a common immutable grant expiry; re-read that
    // deadline under the same transaction at the atomic claim transition.
    const response = await transaction.execute(sql`
      update pgboss.job as j set state = 'active'::pgboss.job_state,
        started_on = clock_timestamp(), heartbeat_on = clock_timestamp(), retry_limit = 0
      where j.name = ${REVIEWED_BASELINE_QUEUE} and j.id = ${request.jobId}::uuid
        and j.state = 'created'::pgboss.job_state and j.started_on is null
        and j.retry_count = 0 and not j.blocked and not j.blocking
        and j.pending_dependencies = 0 and j.source_id is null
        and j.start_after <= clock_timestamp()
        and clock_timestamp() < (select min(g.expires_at) from execution_budget_grant as g
          where g.repair_run_id = ${run.id} and g.scope = 'operation')
      returning j.id::text as id, j.data as data
    `);
    const result = response as unknown as { rows?: ClaimedJob[] } | ClaimedJob[];
    const rows = Array.isArray(result) ? result : result.rows ?? [];
    if (rows.length !== 1 || rows[0]?.id !== request.jobId) throw new ExactBaselineJobError('exact_job_unavailable');
    const payload = parseRepairJobPayload(rows[0].data);
    if (payload.repairRunId !== request.repairRunId) throw new ExactBaselineJobError('exact_job_authority_changed');
    return rows[0];
  });
}
