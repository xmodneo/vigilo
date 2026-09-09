import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';

import { repairRun, repairRunEvent, repositoryBaseline } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { resolveBaselineAuthority } from '../repository-baselines/authority.ts';
import { REPAIR_JOB_VERSION, type TransactionalRepairQueue } from './queue.ts';
import { validateTransition } from './state-machine.ts';
import type { RepairRunIdentity, RepairRunResult, RepairRunState } from './types.ts';

export class RepairRunError extends Error {
  constructor(public readonly code:
    | 'invalid_idempotency_key'
    | 'run_not_found'
    | 'run_already_claimed'
    | 'baseline_evidence_missing'
    | 'baseline_evidence_mismatch'
    | 'handoff_failed'
    | 'state_persistence_failed') {
    super(code);
    this.name = 'RepairRunError';
  }
}

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type StoredRun = typeof repairRun.$inferSelect;

function result(value: StoredRun): RepairRunResult {
  return {
    id: value.id,
    state: value.state as RepairRunState,
    identity: {
      workspaceId: value.workspaceId,
      githubRepositoryId: value.githubRepositoryId,
      installationId: value.installationId,
      baseCommitSha: value.baseCommitSha,
      profileIdentity: value.profileIdentity,
    },
    baselineId: value.baselineId,
    baselineOutcome: value.baselineOutcome as RepairRunResult['baselineOutcome'],
    failureClassification: value.failureClassification,
    failureCode: value.failureCode,
    createdAt: value.createdAt,
    baselineStartedAt: value.baselineStartedAt,
    completedAt: value.completedAt,
    stateChangedAt: value.stateChangedAt,
    updatedAt: value.updatedAt,
  };
}

export function matchesRepairRunEvidence(run: StoredRun, evidence: typeof repositoryBaseline.$inferSelect): boolean {
  return evidence.workspaceId === run.workspaceId &&
    evidence.githubRepositoryId === run.githubRepositoryId &&
    evidence.installationId === run.installationId &&
    evidence.profileIdentity === run.profileIdentity &&
    evidence.baseCommitSha === run.baseCommitSha;
}

function transitionFacts(target: RepairRunState, baseline: typeof repositoryBaseline.$inferSelect | null, now: Date, failureCode?: string) {
  const baselineOutcome = baseline?.overallOutcome ?? null;
  if (target === 'ready_for_investigation') {
    if (!baseline || baselineOutcome !== 'baseline_passed') throw new RepairRunError('baseline_evidence_missing');
    return { baselineId: baseline.id, baselineOutcome, completedAt: now, failureClassification: null, failureCode: null };
  }
  if (target === 'baseline_failed') {
    if (!baseline || !['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed'].includes(baselineOutcome ?? '')) {
      throw new RepairRunError('baseline_evidence_missing');
    }
    return { baselineId: baseline.id, baselineOutcome, completedAt: now, failureClassification: 'customer_baseline_failure', failureCode: baselineOutcome };
  }
  if (target === 'infrastructure_failed') {
    return { baselineId: baseline?.id ?? null, baselineOutcome, completedAt: now, failureClassification: 'infrastructure_failure', failureCode: failureCode ?? baselineOutcome ?? 'baseline_execution_failed' };
  }
  if (target === 'cancelled') {
    return { baselineId: baseline?.id ?? null, baselineOutcome, completedAt: now, failureClassification: 'cancelled', failureCode: failureCode ?? 'cancelled' };
  }
  if (target === 'baseline_running') {
    return { baselineStartedAt: now, baselineId: null, baselineOutcome: null, completedAt: null, failureClassification: null, failureCode: null };
  }
  return {};
}

export async function transitionRepairRun(
  database: VigiloDatabase,
  workspaceId: string,
  runId: string,
  expected: RepairRunState,
  target: RepairRunState,
  now: Date,
  options: { baselineId?: string; failureCode?: string; eventId: string },
): Promise<RepairRunResult> {
  validateTransition(expected, target);
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(repairRun).where(and(eq(repairRun.id, runId), eq(repairRun.workspaceId, workspaceId))).limit(1);
    if (!current) throw new RepairRunError('run_not_found');
    if (current.state !== expected) throw new RepairRunError('run_already_claimed');

    let baseline: typeof repositoryBaseline.$inferSelect | null = null;
    if (options.baselineId) {
      const [foundBaseline] = await transaction.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, options.baselineId)).limit(1);
      if (!foundBaseline) throw new RepairRunError('baseline_evidence_missing');
      baseline = foundBaseline;
      if (!matchesRepairRunEvidence(current, baseline)) throw new RepairRunError('baseline_evidence_mismatch');
    }
    const facts = transitionFacts(target, baseline, now, options.failureCode);
    const [updated] = await transaction.update(repairRun).set({ ...facts, state: target, stateChangedAt: now, updatedAt: now }).where(and(eq(repairRun.id, runId), eq(repairRun.workspaceId, workspaceId), eq(repairRun.state, expected))).returning();
    if (!updated) throw new RepairRunError('run_already_claimed');
    await transaction.insert(repairRunEvent).values({
      id: options.eventId,
      repairRunId: runId,
      fromState: expected,
      toState: target,
      baselineOutcome: baseline?.overallOutcome ?? null,
      failureClassification: updated.failureClassification,
      failureCode: updated.failureCode,
      createdAt: now,
    });
    return result(updated);
  });
}

async function createRepairRun(
  database: VigiloDatabase,
  identity: RepairRunIdentity,
  idempotencyKey: string,
  now: Date,
  randomId: () => string,
  queue: TransactionalRepairQueue,
) {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new RepairRunError('invalid_idempotency_key');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claimed = await database.transaction(async (transaction) => {
      const [inserted] = await transaction.insert(repairRun).values({
        id: randomId(),
        ...identity,
        idempotencyKey,
        state: 'created',
        createdAt: now,
        stateChangedAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning();
      if (inserted) {
        await transaction.insert(repairRunEvent).values({ id: randomId(), repairRunId: inserted.id, fromState: null, toState: 'created', createdAt: now });
        const jobId = await queue.enqueue(transaction, { version: REPAIR_JOB_VERSION, repairRunId: inserted.id });
        if (jobId !== inserted.id) throw new RepairRunError('handoff_failed');
        return { run: result(inserted), ownsExecution: true };
      }
      const [idempotent] = await transaction.select().from(repairRun).where(and(
        eq(repairRun.workspaceId, identity.workspaceId),
        eq(repairRun.idempotencyKey, idempotencyKey),
      )).limit(1);
      if (idempotent) return { run: result(idempotent), ownsExecution: false };
      const [active] = await transaction.select().from(repairRun).where(and(
        eq(repairRun.workspaceId, identity.workspaceId),
        eq(repairRun.githubRepositoryId, identity.githubRepositoryId),
        eq(repairRun.installationId, identity.installationId),
        eq(repairRun.profileIdentity, identity.profileIdentity),
        eq(repairRun.baseCommitSha, identity.baseCommitSha),
        inArray(repairRun.state, ['created', 'baseline_running']),
      )).limit(1);
      return active ? { run: result(active), ownsExecution: false } : null;
    });
    if (claimed) return claimed;
  }
  throw new RepairRunError('state_persistence_failed');
}

export async function startRepairRun(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  idempotencyKey: string,
  queue: TransactionalRepairQueue,
  options: { clock?: () => Date; randomId?: () => string } = {},
): Promise<RepairRunResult> {
  const authority = await resolveBaselineAuthority(database, context);
  const identity: RepairRunIdentity = {
    workspaceId: authority.profile.workspaceId,
    githubRepositoryId: authority.profile.githubRepositoryId,
    installationId: authority.profile.installationId,
    baseCommitSha: authority.profile.baseCommitSha,
    profileIdentity: authority.profile.profileIdentity,
  };
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  try {
    return (await createRepairRun(database, identity, idempotencyKey, clock(), randomId, queue)).run;
  } catch (error) {
    if (error instanceof RepairRunError) throw error;
    throw new RepairRunError('handoff_failed');
  }
}

export async function getRepairRun(database: VigiloDatabase, context: AuthenticatedWorkspace, runId: string): Promise<RepairRunResult | null> {
  const [value] = await database.select().from(repairRun).where(and(eq(repairRun.id, runId), eq(repairRun.workspaceId, context.workspace.id))).limit(1);
  return value ? result(value) : null;
}

export async function getLatestRepairRun(database: VigiloDatabase, context: AuthenticatedWorkspace, githubRepositoryId: number): Promise<RepairRunResult | null> {
  const [value] = await database.select().from(repairRun).where(and(eq(repairRun.workspaceId, context.workspace.id), eq(repairRun.githubRepositoryId, githubRepositoryId))).orderBy(desc(repairRun.createdAt)).limit(1);
  return value ? result(value) : null;
}

export async function cancelCreatedRepairRun(database: VigiloDatabase, context: AuthenticatedWorkspace, runId: string, now = new Date()): Promise<RepairRunResult> {
  return transitionRepairRun(database, context.workspace.id, runId, 'created', 'cancelled', now, { eventId: randomUUID(), failureCode: 'cancelled_before_execution' });
}
