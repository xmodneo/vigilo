import { randomUUID } from 'node:crypto';

import { and, eq, lte } from 'drizzle-orm';
import type { JobResult } from 'pg-boss';

import { investigation, investigationContextEntry, investigationContextEvent, repairIntent, repairRun, repositoryBaseline } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { parseInvestigationJobPayload, type InvestigationQueueJob } from '../repair-runs/queue.ts';
import type { WorkerLogger } from '../repair-runs/worker.ts';
import { prepareTreeEntries, withScopedRepositoryToken } from './source.ts';
import type { InvestigationSourceGateway } from './types.ts';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const TRUSTWORTHY_OUTCOMES = new Set(['baseline_passed', 'baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed']);

type StoredInvestigation = typeof investigation.$inferSelect;

export interface InvestigationWorkerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: InvestigationSourceGateway;
  logger: WorkerLogger;
  shutdownSignal?: AbortSignal;
  clock?: () => Date;
  randomId?: () => string;
}

type Claim = { kind: 'owned'; investigation: StoredInvestigation } | { kind: 'busy' | 'terminal' | 'exhausted'; investigation: StoredInvestigation };

const leaseEnd = (now: Date) => new Date(now.getTime() + LEASE_MS);

async function claim(database: VigiloDatabase, investigationId: string, now: Date, randomId: () => string): Promise<Claim> {
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(investigation).where(eq(investigation.id, investigationId)).limit(1);
    if (!current) throw new Error('investigation_not_found');
    if (['ready', 'failed', 'cancelled'].includes(current.state)) return { kind: 'terminal', investigation: current };
    if (current.state === 'context_preparing' && current.leaseExpiresAt && current.leaseExpiresAt.getTime() > now.getTime()) return { kind: 'busy', investigation: current };
    if (current.attemptNumber >= MAX_ATTEMPTS) {
      const [failed] = await transaction.update(investigation).set({
        state: 'failed', ownershipToken: null, leaseExpiresAt: null, completedAt: now,
        failureCode: 'context_retry_exhausted', updatedAt: now,
      }).where(and(eq(investigation.id, current.id), eq(investigation.state, 'context_preparing'), lte(investigation.leaseExpiresAt, now))).returning();
      return { kind: failed ? 'exhausted' : 'busy', investigation: failed ?? current };
    }
    const ownershipToken = randomId();
    const attemptNumber = current.attemptNumber + 1;
    const predicate = current.state === 'created'
      ? and(eq(investigation.id, current.id), eq(investigation.state, 'created'))
      : and(eq(investigation.id, current.id), eq(investigation.state, 'context_preparing'), eq(investigation.ownershipToken, current.ownershipToken!), lte(investigation.leaseExpiresAt, now));
    const [owned] = await transaction.update(investigation).set({
      state: 'context_preparing', attemptNumber, ownershipToken, heartbeatAt: now,
      leaseExpiresAt: leaseEnd(now), preparationStartedAt: now, failureCode: null, updatedAt: now,
    }).where(predicate).returning();
    return { kind: owned ? 'owned' : 'busy', investigation: owned ?? current };
  });
}

async function renew(database: VigiloDatabase, owned: StoredInvestigation, now: Date): Promise<void> {
  const [updated] = await database.update(investigation).set({ heartbeatAt: now, leaseExpiresAt: leaseEnd(now), updatedAt: now }).where(and(
    eq(investigation.id, owned.id), eq(investigation.state, 'context_preparing'), eq(investigation.ownershipToken, owned.ownershipToken!),
  )).returning({ id: investigation.id });
  if (!updated) throw Object.assign(new Error('investigation_ownership_lost'), { code: 'investigation_ownership_lost' });
}

async function validateBinding(database: VigiloDatabase, owned: StoredInvestigation) {
  const [[run], [intent], [baseline]] = await Promise.all([
    database.select().from(repairRun).where(eq(repairRun.id, owned.repairRunId)).limit(1),
    database.select().from(repairIntent).where(eq(repairIntent.id, owned.repairIntentId)).limit(1),
    database.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, owned.baselineId)).limit(1),
  ]);
  if (!run || !intent || !baseline || intent.repairRunId !== run.id || intent.workspaceId !== run.workspaceId ||
    run.workspaceId !== owned.workspaceId || run.githubRepositoryId !== owned.githubRepositoryId || run.installationId !== owned.installationId ||
    run.baseCommitSha !== owned.baseCommitSha || run.profileIdentity !== owned.profileIdentity || run.baselineId !== owned.baselineId ||
    baseline.workspaceId !== owned.workspaceId || baseline.githubRepositoryId !== owned.githubRepositoryId || baseline.installationId !== owned.installationId ||
    baseline.baseCommitSha !== owned.baseCommitSha || baseline.profileIdentity !== owned.profileIdentity || !TRUSTWORTHY_OUTCOMES.has(baseline.overallOutcome)) {
    throw Object.assign(new Error('investigation_binding_mismatch'), { code: 'investigation_binding_mismatch' });
  }
  return { run, intent, baseline };
}

async function persistPrepared(
  dependencies: InvestigationWorkerDependencies,
  owned: StoredInvestigation,
  treeSha: string,
  prepared: ReturnType<typeof prepareTreeEntries>,
): Promise<boolean> {
  const now = (dependencies.clock ?? (() => new Date()))();
  const randomId = dependencies.randomId ?? randomUUID;
  return dependencies.database.transaction(async (transaction) => {
    const [updated] = await transaction.update(investigation).set({
      state: 'ready', treeSha, indexedPathCount: prepared.entries.length, excludedPathCount: prepared.excludedPathCount,
      treeTruncated: prepared.truncated, ownershipToken: null, leaseExpiresAt: null, completedAt: now, failureCode: null, updatedAt: now,
    }).where(and(eq(investigation.id, owned.id), eq(investigation.state, 'context_preparing'), eq(investigation.ownershipToken, owned.ownershipToken!))).returning({ id: investigation.id });
    if (!updated) return false;
    if (prepared.entries.length) await transaction.insert(investigationContextEntry).values(prepared.entries.map((entry) => ({ investigationId: owned.id, ...entry })));
    await transaction.insert(investigationContextEvent).values({
      id: randomId(), investigationId: owned.id, workspaceId: owned.workspaceId, operation: 'prepare', status: 'completed',
      resultCount: prepared.entries.length, resultBytes: 0, budgetBytes: 0, truncated: prepared.truncated,
      budgetExhausted: prepared.truncated, createdAt: now, completedAt: now,
    });
    return true;
  });
}

async function recordFailure(dependencies: InvestigationWorkerDependencies, owned: StoredInvestigation, code: string): Promise<'retry' | 'failed' | 'lost'> {
  const now = (dependencies.clock ?? (() => new Date()))();
  const terminal = owned.attemptNumber >= MAX_ATTEMPTS;
  const [updated] = await dependencies.database.update(investigation).set(terminal ? {
    state: 'failed', ownershipToken: null, leaseExpiresAt: null, completedAt: now, failureCode: code, updatedAt: now,
  } : {
    state: 'created', ownershipToken: null, heartbeatAt: null, leaseExpiresAt: null, failureCode: code, updatedAt: now,
  }).where(and(eq(investigation.id, owned.id), eq(investigation.state, 'context_preparing'), eq(investigation.ownershipToken, owned.ownershipToken!))).returning({ id: investigation.id });
  return !updated ? 'lost' : terminal ? 'failed' : 'retry';
}

function safeCode(error: unknown, aborted: boolean): string {
  if (aborted) return 'worker_interrupted';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code)) return error.code;
  return 'context_preparation_failed';
}

export async function processInvestigationJob(job: InvestigationQueueJob, dependencies: InvestigationWorkerDependencies): Promise<JobResult> {
  let payload;
  try {
    payload = parseInvestigationJobPayload(job.data);
    if (payload.investigationId !== job.id) throw new Error();
  } catch {
    return { id: job.id, status: 'deadletter', output: { code: 'invalid_investigation_job_payload' } };
  }
  let claimed: Claim;
  try {
    claimed = await claim(dependencies.database, payload.investigationId, (dependencies.clock ?? (() => new Date()))(), dependencies.randomId ?? randomUUID);
  } catch {
    return { id: job.id, status: 'deadletter', output: { code: 'investigation_not_found' } };
  }
  if (claimed.kind === 'terminal' || claimed.kind === 'exhausted') return { id: job.id, status: 'completed' };
  if (claimed.kind === 'busy') return { id: job.id, status: 'failed', output: { code: 'investigation_active' } };
  const owned = claimed.investigation;
  dependencies.logger.write({ event: 'investigation_claimed', investigationId: owned.id });
  const controller = new AbortController();
  const abort = () => controller.abort();
  job.signal.addEventListener('abort', abort, { once: true });
  dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  if (job.signal.aborted || dependencies.shutdownSignal?.aborted) controller.abort();
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    renew(dependencies.database, owned, (dependencies.clock ?? (() => new Date()))()).catch(() => controller.abort()).finally(() => { heartbeatRunning = false; });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    controller.signal.throwIfAborted();
    await validateBinding(dependencies.database, owned);
    const context = await withScopedRepositoryToken(dependencies.gateway, dependencies.configuration, owned, async ({ accessToken, owner, repository }) => {
      controller.signal.throwIfAborted();
      const commit = await dependencies.gateway.getCommitTree({ accessToken, owner, repository, commitSha: owned.baseCommitSha });
      if (commit.commitSha !== owned.baseCommitSha) throw Object.assign(new Error('investigation_binding_mismatch'), { code: 'investigation_binding_mismatch' });
      const tree = await dependencies.gateway.getTree({ accessToken, owner, repository, treeSha: commit.treeSha });
      return { treeSha: commit.treeSha, prepared: prepareTreeEntries(tree.entries, tree.truncated) };
    });
    controller.signal.throwIfAborted();
    await renew(dependencies.database, owned, (dependencies.clock ?? (() => new Date()))());
    if (!await persistPrepared(dependencies, owned, context.treeSha, context.prepared)) return { id: job.id, status: 'failed', output: { code: 'investigation_ownership_lost' } };
    dependencies.logger.write({ event: 'investigation_ready', investigationId: owned.id, outcome: 'ready' });
    return { id: job.id, status: 'completed' };
  } catch (error) {
    const code = safeCode(error, controller.signal.aborted);
    const outcome = await recordFailure(dependencies, owned, code);
    if (outcome === 'lost') return { id: job.id, status: 'failed', output: { code: 'investigation_ownership_lost' } };
    dependencies.logger.write({ event: 'investigation_retry', investigationId: owned.id, code });
    return outcome === 'retry' ? { id: job.id, status: 'failed', output: { code } } : { id: job.id, status: 'completed' };
  } finally {
    clearInterval(heartbeat);
    job.signal.removeEventListener('abort', abort);
    dependencies.shutdownSignal?.removeEventListener('abort', abort);
  }
}
