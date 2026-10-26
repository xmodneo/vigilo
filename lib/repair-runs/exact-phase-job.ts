import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import {
  aiCandidateGeneration, aiInvestigation, candidateVerification, executionBudgetGrant,
  investigation, operationalWorkerHeartbeat, repairCandidate,
  repairLoop, repairRun, repairRunSourceCheckpoint, workspace,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { assertRunBusinessAllowed, lockExternalExecution } from '../external-execution/business-fence.ts';
import { assertReviewedPlanIntegrity } from '../external-execution/reviewed-plan-integrity.ts';
import { assertMatchedSourceCheckpoint } from '../external-execution/source-checkpoint.ts';
import { assertPublicRepositoryAuthority } from '../github-repositories/policy.ts';
import { assertExactPgBossCompatibility } from './exact-baseline-job.ts';
import {
  AI_CANDIDATE_GENERATION_QUEUE, AI_INVESTIGATION_QUEUE, CANDIDATE_VERIFICATION_QUEUE,
  INVESTIGATION_CONTEXT_QUEUE, REPAIR_LOOP_QUEUE, parseAiCandidateGenerationJobPayload,
  parseAiInvestigationJobPayload, parseCandidateVerificationJobPayload,
  parseInvestigationJobPayload, parseRepairLoopJobPayload,
} from './queue.ts';

export const exactPhaseQueues = {
  context: INVESTIGATION_CONTEXT_QUEUE,
  investigation: AI_INVESTIGATION_QUEUE,
  loop: REPAIR_LOOP_QUEUE,
  generation: AI_CANDIDATE_GENERATION_QUEUE,
  verification: CANDIDATE_VERIFICATION_QUEUE,
} as const;
export type ExactPhase = keyof typeof exactPhaseQueues;

export interface ExactPhaseRequest {
  phase: ExactPhase;
  repairRunId: string;
  jobId: string;
  planIdentity: string;
  repositoryId: number;
  revision: string;
  releaseSha: string;
}

export class ExactPhaseJobError extends Error {
  constructor(public readonly code: 'exact_job_invalid' | 'exact_job_unavailable' | 'exact_job_authority_changed') { super(code); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

export function parseExactPhaseArguments(args: readonly string[]): ExactPhaseRequest {
  const keys = ['--phase', '--repair-run', '--job', '--plan-identity', '--repository-id', '--revision', '--release'];
  if (args.length !== keys.length * 2) throw new ExactPhaseJobError('exact_job_invalid');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1]!;
    if (!keys.includes(key) || values.has(key) || !value) throw new ExactPhaseJobError('exact_job_invalid');
    values.set(key, value);
  }
  const phase = values.get('--phase');
  const repositoryIdText = values.get('--repository-id')!;
  const repositoryId = Number(repositoryIdText);
  const repairRunId = values.get('--repair-run')!;
  const jobId = values.get('--job')!;
  const planIdentity = values.get('--plan-identity')!;
  const revision = values.get('--revision')!;
  const releaseSha = values.get('--release')!;
  if (!phase || !Object.hasOwn(exactPhaseQueues, phase) || !UUID.test(repairRunId) || !UUID.test(jobId) ||
      !HASH.test(planIdentity) || !/^[1-9][0-9]*$/.test(repositoryIdText) ||
      !Number.isSafeInteger(repositoryId) || !SHA.test(revision) || !SHA.test(releaseSha))
    throw new ExactPhaseJobError('exact_job_invalid');
  return { phase: phase as ExactPhase, repairRunId, jobId, planIdentity, repositoryId, revision, releaseSha };
}

function deny(): never { throw new ExactPhaseJobError('exact_job_authority_changed'); }

type Run = typeof repairRun.$inferSelect;
function matchesRun(value: { repairRunId: string; workspaceId: string; githubRepositoryId: number;
  installationId: number; baseCommitSha: string; profileIdentity: string; baselineId: string }, run: Run): boolean {
  return value.repairRunId === run.id && value.workspaceId === run.workspaceId &&
    value.githubRepositoryId === run.githubRepositoryId && value.installationId === run.installationId &&
    value.baseCommitSha === run.baseCommitSha && value.profileIdentity === run.profileIdentity &&
    value.baselineId === run.baselineId;
}
function matchesCandidate(value: typeof repairCandidate.$inferSelect, run: Run): boolean {
  return value.repairRunId === run.id && value.workspaceId === run.workspaceId &&
    value.githubRepositoryId === run.githubRepositoryId && value.installationId === run.installationId &&
    value.baseCommitSha === run.baseCommitSha && value.profileIdentity === run.profileIdentity;
}

async function assertSubject(database: VigiloDatabase, request: ExactPhaseRequest, run: Run): Promise<void> {
  const jobId = request.jobId;
  if (request.phase === 'context') {
    const [row] = await database.select().from(investigation).where(eq(investigation.id, jobId)).limit(1);
    if (!row || row.state !== 'created' || !matchesRun(row, run)) deny();
    return;
  }
  if (request.phase === 'investigation') {
    const [row] = await database.select().from(aiInvestigation).where(eq(aiInvestigation.id, jobId)).limit(1);
    if (!row || row.state !== 'queued' || !matchesRun(row, run) || row.providerId !== 'google' || row.modelId !== 'gemini-3.1-flash-lite') deny();
    const [parent] = await database.select().from(investigation).where(eq(investigation.id, row.investigationId)).limit(1);
    if (!parent || parent.state !== 'ready' || !matchesRun(parent, run)) deny();
    return;
  }
  if (request.phase === 'generation') {
    const [row] = await database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, jobId)).limit(1);
    if (!row || row.state !== 'queued' || !matchesRun(row, run) || row.providerId !== 'google' || row.modelId !== 'gemini-3.1-flash-lite') deny();
    const [parent] = await database.select().from(aiInvestigation).where(eq(aiInvestigation.id, row.aiInvestigationId)).limit(1);
    const [context] = await database.select().from(investigation).where(eq(investigation.id, row.investigationId)).limit(1);
    if (!parent || parent.state !== 'completed' || parent.conclusionStatus !== 'diagnosis_found' ||
        !matchesRun(parent, run) || !context || context.state !== 'ready' ||
        !matchesRun(context, run) || parent.investigationId !== context.id) deny();
    return;
  }
  if (request.phase === 'verification') {
    const [row] = await database.select().from(candidateVerification).where(eq(candidateVerification.id, jobId)).limit(1);
    if (!row || row.state !== 'queued' || !matchesRun(row, run)) deny();
    const [candidate] = await database.select().from(repairCandidate).where(eq(repairCandidate.id, row.candidateId)).limit(1);
    const [context] = await database.select().from(investigation).where(eq(investigation.id, row.investigationId)).limit(1);
    if (!candidate || candidate.state !== 'frozen' || candidate.candidateIdentity !== row.candidateIdentity ||
        candidate.investigationId !== row.investigationId || !matchesCandidate(candidate, run) ||
        !context || context.state !== 'ready' || !matchesRun(context, run)) deny();
    return;
  }
  const [loop] = await database.select().from(repairLoop).where(eq(repairLoop.wakeJobId, jobId)).limit(1);
  if (!loop || loop.repairRunId !== run.id || loop.workspaceId !== run.workspaceId ||
      !['queued', 'running'].includes(loop.state)) deny();
  const [parent] = await database.select().from(aiInvestigation).where(eq(aiInvestigation.id, loop.aiInvestigationId)).limit(1);
  const [context] = await database.select().from(investigation).where(eq(investigation.id, loop.investigationId)).limit(1);
  if (!parent || !matchesRun(parent, run) || !context || !matchesRun(context, run) ||
      parent.investigationId !== context.id || parent.state !== 'completed' ||
      parent.conclusionStatus !== 'diagnosis_found') deny();
}

export interface ClaimedExactPhaseJob { id: string; data: unknown }

export async function claimExactPhaseJob(database: VigiloDatabase, request: ExactPhaseRequest,
  runtimeReleaseSha: string, workerHeartbeatId: string): Promise<ClaimedExactPhaseJob> {
  assertExactPgBossCompatibility();
  if (request.releaseSha !== runtimeReleaseSha || !UUID.test(workerHeartbeatId)) deny();
  const queue = exactPhaseQueues[request.phase];
  return database.transaction(async (transaction) => {
    await lockExternalExecution(transaction);
    const [subject] = await transaction.select().from(repairRun).where(eq(repairRun.id, request.repairRunId)).limit(1);
    if (!subject) throw new ExactPhaseJobError('exact_job_unavailable');
    const [owner] = await transaction.select({ id: workspace.id }).from(workspace)
      .where(eq(workspace.id, subject.workspaceId)).for('update').limit(1);
    if (!owner) throw new ExactPhaseJobError('exact_job_unavailable');
    const [run] = await transaction.select().from(repairRun).where(eq(repairRun.id, request.repairRunId)).for('update').limit(1);
    const [checkpoint] = await transaction.select().from(repairRunSourceCheckpoint)
      .where(eq(repairRunSourceCheckpoint.repairRunId, request.repairRunId)).limit(1);
    if (!run || run.state !== 'ready_for_investigation' || run.baselineId === null ||
        run.githubRepositoryId !== request.repositoryId || run.baseCommitSha !== request.revision ||
        checkpoint?.planIdentity !== request.planIdentity || checkpoint.state !== 'matched' ||
        checkpoint.baselineId !== run.baselineId) deny();
    await assertPublicRepositoryAuthority(transaction, run.workspaceId, run.githubRepositoryId);
    await assertMatchedSourceCheckpoint(transaction, run.id);
    await assertRunBusinessAllowed(transaction, { workspaceId: run.workspaceId, repairRunId: run.id });
    await assertSubject(transaction, request, run);
    const queueRows = await transaction.execute(sql`select policy from pgboss.queue where name = ${queue} for share`);
    const queues = Array.isArray(queueRows) ? queueRows : (queueRows as { rows?: Array<{ policy: string }> }).rows ?? [];
    if (queues.length !== 1 || queues[0]?.policy !== 'standard') throw new ExactPhaseJobError('exact_job_unavailable');
    const jobRows = await transaction.execute(sql`select id from pgboss.job where name = ${queue} and id = ${request.jobId}::uuid for update`);
    const locked = Array.isArray(jobRows) ? jobRows : (jobRows as { rows?: Array<{ id: string }> }).rows ?? [];
    if (locked.length !== 1) throw new ExactPhaseJobError('exact_job_unavailable');
    const timeRows = await transaction.execute(sql`select clock_timestamp() as authority_time`);
    const times = Array.isArray(timeRows) ? timeRows : (timeRows as { rows?: Array<{ authority_time: Date | string }> }).rows ?? [];
    const rawTime = times[0]?.authority_time;
    const now = rawTime instanceof Date ? rawTime : typeof rawTime === 'string' ? new Date(rawTime) : null;
    if (!now || !Number.isFinite(now.getTime())) throw new ExactPhaseJobError('exact_job_unavailable');
    const [otherWorker] = await transaction.select({ id: operationalWorkerHeartbeat.id }).from(operationalWorkerHeartbeat)
      .where(and(inArray(operationalWorkerHeartbeat.service, ['vigilo-worker', 'vigilo-exact-one-shot']),
        inArray(operationalWorkerHeartbeat.state, ['starting', 'ready', 'draining']),
        sql`${operationalWorkerHeartbeat.lastHeartbeatAt} > clock_timestamp() - interval '45 seconds'`,
        ne(operationalWorkerHeartbeat.id, workerHeartbeatId))).limit(1);
    if (otherWorker) throw new ExactPhaseJobError('exact_job_unavailable');
    if (await assertReviewedPlanIntegrity(transaction, run.id, runtimeReleaseSha, now) !== true) deny();
    const response = await transaction.execute(sql`
      update pgboss.job as j set state = 'active'::pgboss.job_state,
        started_on = clock_timestamp(), heartbeat_on = clock_timestamp(), retry_limit = 0
      where j.name = ${queue} and j.id = ${request.jobId}::uuid
        and j.state = 'created'::pgboss.job_state and j.started_on is null
        and j.retry_count = 0 and not j.blocked and not j.blocking
        and j.pending_dependencies = 0 and j.source_id is null
        and j.start_after <= clock_timestamp()
        and clock_timestamp() < (select min(g.expires_at) from execution_budget_grant as g
          where g.repair_run_id = ${run.id} and g.scope = 'operation')
      returning j.id::text as id, j.data as data
    `);
    const rows = Array.isArray(response) ? response : (response as { rows?: ClaimedExactPhaseJob[] }).rows ?? [];
    if (rows.length !== 1 || rows[0]?.id !== request.jobId) throw new ExactPhaseJobError('exact_job_unavailable');
    const data = rows[0].data;
    const payloadId = request.phase === 'context' ? parseInvestigationJobPayload(data).investigationId
      : request.phase === 'investigation' ? parseAiInvestigationJobPayload(data).aiInvestigationId
      : request.phase === 'generation' ? parseAiCandidateGenerationJobPayload(data).proposalGenerationId
      : request.phase === 'verification' ? parseCandidateVerificationJobPayload(data).verificationId
      : parseRepairLoopJobPayload(data).repairLoopId;
    if (request.phase === 'loop') {
      const [loop] = await transaction.select({ id: repairLoop.id }).from(repairLoop).where(eq(repairLoop.wakeJobId, request.jobId)).limit(1);
      if (loop?.id !== payloadId) deny();
    } else if (payloadId !== request.jobId) deny();
    return rows[0];
  });
}
