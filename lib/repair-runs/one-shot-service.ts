import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { repairRun } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { REVIEWED_BASELINE_QUEUE, type RepairQueueJob } from './queue.ts';
import { claimExactReviewedBaselineJob, ExactBaselineJobError, type ExactBaselineRequest } from './exact-baseline-job.ts';
import { processRepairJob, type RepairWorkerDependencies } from './worker.ts';

export interface ExactBaselineReceipt {
  kind: 'baseline_one_shot';
  repairRunId: string;
  jobId: string;
  planIdentity: string;
  releaseSha: string;
  result: 'completed' | 'failed';
  repairRunState: string;
}

/** One claim, one handler call, one settlement. No queue-wide work() registration. */
export async function executeExactBaselineOnce(
  database: VigiloDatabase,
  boss: Pick<PgBoss, 'complete' | 'fail' | 'touch'>,
  request: ExactBaselineRequest,
  runtimeReleaseSha: string,
  dependencies: RepairWorkerDependencies,
  shutdownSignal: AbortSignal,
  options: { afterClaim?: () => void } = {},
): Promise<ExactBaselineReceipt> {
  if (shutdownSignal.aborted) throw new ExactBaselineJobError('exact_job_unavailable');
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  shutdownSignal.addEventListener('abort', abort, { once: true });
  if (shutdownSignal.aborted) cancellation.abort();
  let claimed;
  try {
    if (cancellation.signal.aborted) throw new ExactBaselineJobError('exact_job_unavailable');
    claimed = await claimExactReviewedBaselineJob(database, request, runtimeReleaseSha);
    options.afterClaim?.();
    // The atomic claim may have committed while the signal arrived. Leave its
    // durable active ownership for reconciliation; never enter transport.
    if (cancellation.signal.aborted) throw new ExactBaselineJobError('exact_job_unavailable');
  } catch (error) {
    shutdownSignal.removeEventListener('abort', abort);
    throw error;
  }
  let touching = false;
  const timer = setInterval(() => {
    if (touching) return;
    touching = true;
    void boss.touch(REVIEWED_BASELINE_QUEUE, claimed.id).then((result) => {
      if ((result as { affected?: number }).affected !== 1) cancellation.abort();
    }).catch(() => cancellation.abort()).finally(() => { touching = false; });
  }, 25_000);
  timer.unref();
  try {
    if (cancellation.signal.aborted) throw new ExactBaselineJobError('exact_job_unavailable');
    const job = { id: claimed.id, name: REVIEWED_BASELINE_QUEUE, data: claimed.data, signal: cancellation.signal } as RepairQueueJob;
    let result: Awaited<ReturnType<typeof processRepairJob>>;
    try {
      result = await processRepairJob(job, { ...dependencies, shutdownSignal: cancellation.signal,
        runtimeReleaseSha, reviewedOneShot: { repairRunId: request.repairRunId, planIdentity: request.planIdentity } });
    } catch {
      result = { id: claimed.id, status: 'failed', output: { code: 'worker_operation_failed' } };
    }
    if (result.id !== claimed.id) throw new ExactBaselineJobError('exact_job_unavailable');
    const [run] = await database.select({ state: repairRun.state }).from(repairRun)
      .where(eq(repairRun.id, request.repairRunId)).limit(1);
    const succeeded = result.status === 'completed' &&
      (run?.state === 'ready_for_investigation' || run?.state === 'baseline_failed');
    const settled = succeeded
      ? await boss.complete(REVIEWED_BASELINE_QUEUE, claimed.id)
      : await boss.fail(REVIEWED_BASELINE_QUEUE, claimed.id, { code: 'baseline_one_shot_failed' });
    if ((settled as { affected?: number }).affected !== 1) throw new ExactBaselineJobError('exact_job_unavailable');
    return { kind: 'baseline_one_shot', repairRunId: request.repairRunId, jobId: claimed.id,
      planIdentity: request.planIdentity, releaseSha: runtimeReleaseSha,
      result: succeeded ? 'completed' : 'failed', repairRunState: run?.state ?? 'missing' };
  } finally {
    clearInterval(timer);
    shutdownSignal.removeEventListener('abort', abort);
  }
}
