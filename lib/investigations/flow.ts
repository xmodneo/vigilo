import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { investigation, repairIntent, repairRun, repositoryBaseline } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { matchesRepairRunEvidence } from '../repair-runs/flow.ts';
import { INVESTIGATION_JOB_VERSION, type TransactionalInvestigationQueue } from '../repair-runs/queue.ts';
import { CONTEXT_BUDGET } from './policy.ts';
import type { InvestigationResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRUSTWORTHY_OUTCOMES = new Set(['baseline_passed', 'baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed']);

export class InvestigationError extends Error {
  constructor(public readonly code:
    | 'invalid_investigation_request'
    | 'repair_run_not_found'
    | 'repair_run_not_eligible'
    | 'repair_intent_missing'
    | 'baseline_evidence_mismatch'
    | 'investigation_conflict'
    | 'investigation_handoff_failed') {
    super(code);
    this.name = 'InvestigationError';
  }
}

type StoredInvestigation = typeof investigation.$inferSelect;

function result(value: StoredInvestigation, objective: string): InvestigationResult {
  return {
    id: value.id,
    repairRunId: value.repairRunId,
    repairObjective: objective,
    state: value.state as InvestigationResult['state'],
    workspaceId: value.workspaceId,
    githubRepositoryId: value.githubRepositoryId,
    installationId: value.installationId,
    baseCommitSha: value.baseCommitSha,
    profileIdentity: value.profileIdentity,
    baselineId: value.baselineId,
    treeSha: value.treeSha,
    indexedPathCount: value.indexedPathCount,
    excludedPathCount: value.excludedPathCount,
    treeTruncated: value.treeTruncated,
    contextBudget: {
      version: 1,
      maxTreeEntries: 2000,
      maxFileBytes: 65536,
      maxCumulativeBytes: 1048576,
      maxOperations: 50,
    },
    failureCode: value.failureCode,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    updatedAt: value.updatedAt,
  };
}

async function loadResult(database: VigiloDatabase, workspaceId: string, where: ReturnType<typeof eq>): Promise<InvestigationResult | null> {
  const [row] = await database.select({ investigation, objective: repairIntent.objective })
    .from(investigation)
    .innerJoin(repairIntent, eq(repairIntent.id, investigation.repairIntentId))
    .where(and(eq(investigation.workspaceId, workspaceId), where))
    .limit(1);
  return row ? result(row.investigation, row.objective) : null;
}

export async function createInvestigation(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  repairRunId: string,
  idempotencyKey: string,
  queue: TransactionalInvestigationQueue,
  options: { clock?: () => Date; randomId?: () => string } = {},
): Promise<InvestigationResult> {
  if (!UUID.test(repairRunId) || !UUID.test(idempotencyKey)) throw new InvestigationError('invalid_investigation_request');
  const now = (options.clock ?? (() => new Date()))();
  const randomId = options.randomId ?? randomUUID;
  try {
    return await database.transaction(async (transaction) => {
      const [run] = await transaction.select().from(repairRun).where(and(eq(repairRun.id, repairRunId), eq(repairRun.workspaceId, context.workspace.id))).limit(1);
      if (!run) throw new InvestigationError('repair_run_not_found');
      if (!['ready_for_investigation', 'baseline_failed'].includes(run.state) || !run.baselineId || !TRUSTWORTHY_OUTCOMES.has(run.baselineOutcome ?? '')) throw new InvestigationError('repair_run_not_eligible');
      const [[intent], [baseline]] = await Promise.all([
        transaction.select().from(repairIntent).where(and(eq(repairIntent.repairRunId, run.id), eq(repairIntent.workspaceId, context.workspace.id))).limit(1),
        transaction.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, run.baselineId)).limit(1),
      ]);
      if (!intent) throw new InvestigationError('repair_intent_missing');
      if (!baseline || !matchesRepairRunEvidence(run, baseline) || !TRUSTWORTHY_OUTCOMES.has(baseline.overallOutcome)) throw new InvestigationError('baseline_evidence_mismatch');

      const [created] = await transaction.insert(investigation).values({
        id: randomId(), repairRunId: run.id, repairIntentId: intent.id, workspaceId: run.workspaceId,
        githubRepositoryId: run.githubRepositoryId, installationId: run.installationId,
        baseCommitSha: run.baseCommitSha, profileIdentity: run.profileIdentity, baselineId: baseline.id,
        idempotencyKey, state: 'created', contextBudgetVersion: CONTEXT_BUDGET.version,
        maxTreeEntries: CONTEXT_BUDGET.maxTreeEntries, maxFileBytes: CONTEXT_BUDGET.maxFileBytes,
        maxCumulativeBytes: CONTEXT_BUDGET.maxCumulativeBytes, maxOperations: CONTEXT_BUDGET.maxOperations,
        createdAt: now, updatedAt: now,
      }).onConflictDoNothing().returning();
      if (created) {
        const jobId = await queue.enqueueInvestigation(transaction, { version: INVESTIGATION_JOB_VERSION, investigationId: created.id });
        if (jobId !== created.id) throw new InvestigationError('investigation_handoff_failed');
        return result(created, intent.objective);
      }
      const [existing] = await transaction.select().from(investigation).where(eq(investigation.repairRunId, run.id)).limit(1);
      if (existing) return result(existing, intent.objective);
      const [idempotent] = await transaction.select().from(investigation).where(and(eq(investigation.workspaceId, context.workspace.id), eq(investigation.idempotencyKey, idempotencyKey))).limit(1);
      if (!idempotent || idempotent.repairRunId !== run.id) throw new InvestigationError('investigation_conflict');
      return result(idempotent, intent.objective);
    });
  } catch (error) {
    if (error instanceof InvestigationError) throw error;
    throw new InvestigationError('investigation_handoff_failed');
  }
}

export function getInvestigation(database: VigiloDatabase, context: AuthenticatedWorkspace, investigationId: string) {
  if (!UUID.test(investigationId)) return Promise.resolve(null);
  return loadResult(database, context.workspace.id, eq(investigation.id, investigationId));
}

export function getInvestigationForRun(database: VigiloDatabase, context: AuthenticatedWorkspace, repairRunId: string) {
  if (!UUID.test(repairRunId)) return Promise.resolve(null);
  return loadResult(database, context.workspace.id, eq(investigation.repairRunId, repairRunId));
}
