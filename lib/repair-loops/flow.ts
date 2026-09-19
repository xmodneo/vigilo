import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, max } from 'drizzle-orm';

import {
  aiCandidateGeneration,
  aiCandidateGenerationEvent,
  aiInvestigation,
  executionProfile,
  investigation,
  repairLoop,
  repairLoopEvent,
  repairLoopIteration,
  repairRun,
  repositoryBaseline,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { AI_MODEL_ID, AI_PROVIDER_ID } from '../ai-investigations/types.ts';
import { REPAIR_LOOP_AI_CANDIDATE_GENERATION_PROTOCOL_VERSION } from '../ai-candidate-generations/types.ts';
import {
  AI_CANDIDATE_GENERATION_JOB_VERSION,
  REPAIR_LOOP_JOB_VERSION,
  type TransactionalAiCandidateGenerationQueue,
  type TransactionalRepairLoopQueue,
} from '../repair-runs/queue.ts';
import { deriveBaselineRecoveryContract } from './objective-contract.ts';
import { REPAIR_LOOP_MAX_ITERATIONS, REPAIR_LOOP_PROTOCOL_VERSION, type RepairLoopIterationResult, type RepairLoopResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RepairLoopQueues extends TransactionalAiCandidateGenerationQueue, TransactionalRepairLoopQueue {}

export class RepairLoopFlowError extends Error {
  constructor(public readonly code: 'repair_loop_not_eligible' | 'repair_loop_not_found' | 'repair_loop_handoff_failed') {
    super(code);
    this.name = 'RepairLoopFlowError';
  }
}

function iterationResult(row: typeof repairLoopIteration.$inferSelect): RepairLoopIterationResult {
  const contract = row.objectiveContractSnapshot as { measurable?: unknown };
  return {
    id: row.id, ordinal: row.ordinal, aiCandidateGenerationId: row.aiCandidateGenerationId,
    candidateVerificationId: row.candidateVerificationId,
    objectiveContractVersion: 'baseline_recovery_v1', objectiveContractHash: row.objectiveContractHash,
    objectiveContractBytes: row.objectiveContractBytes, objectiveMeasurable: contract.measurable === true,
    feedbackHash: row.feedbackHash, feedbackBytes: row.feedbackBytes,
    objectiveEvidence: row.objectiveEvidence as RepairLoopIterationResult['objectiveEvidence'],
    decision: row.decision as RepairLoopIterationResult['decision'], failureCode: row.failureCode,
    createdAt: row.createdAt, decidedAt: row.decidedAt,
  };
}

async function result(database: VigiloDatabase, row: typeof repairLoop.$inferSelect): Promise<RepairLoopResult> {
  const iterations = await database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, row.id)).orderBy(repairLoopIteration.ordinal);
  return {
    id: row.id, repairRunId: row.repairRunId, investigationId: row.investigationId,
    aiInvestigationId: row.aiInvestigationId, workspaceId: row.workspaceId,
    protocolVersion: 1, maxIterations: 2, state: row.state as RepairLoopResult['state'],
    selectedCandidateId: row.selectedCandidateId, selectedVerificationId: row.selectedVerificationId,
    selectedEvidenceId: row.selectedEvidenceId, failureClassification: row.failureClassification,
    failureCode: row.failureCode, iterations: iterations.map(iterationResult), createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export async function startRepairLoop(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  repairRunId: string,
  queues: RepairLoopQueues,
  options: { idempotencyKey?: string; randomId?: () => string; clock?: () => Date } = {},
): Promise<RepairLoopResult> {
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const randomId = options.randomId ?? randomUUID;
  const now = (options.clock ?? (() => new Date()))();
  if (!UUID.test(repairRunId) || !UUID.test(idempotencyKey)) throw new RepairLoopFlowError('repair_loop_not_eligible');
  let created: typeof repairLoop.$inferSelect;
  try {
    created = await database.transaction(async (transaction) => {
      const [run] = await transaction.select().from(repairRun).where(and(eq(repairRun.id, repairRunId), eq(repairRun.workspaceId, context.workspace.id))).for('update').limit(1);
      if (!run) throw new RepairLoopFlowError('repair_loop_not_eligible');
      const [existing] = await transaction.select().from(repairLoop).where(eq(repairLoop.repairRunId, run.id)).limit(1);
      if (existing) return existing;
      if (run.state !== 'ready_for_investigation' || !run.baselineId) throw new RepairLoopFlowError('repair_loop_not_eligible');
      const [[parent], [baseline], [profile], [source]] = await Promise.all([
        transaction.select().from(investigation).where(and(eq(investigation.repairRunId, run.id), eq(investigation.workspaceId, run.workspaceId))).limit(1),
        transaction.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, run.baselineId)).limit(1),
        transaction.select().from(executionProfile).where(and(eq(executionProfile.githubRepositoryId, run.githubRepositoryId), eq(executionProfile.workspaceId, run.workspaceId))).limit(1),
        transaction.select().from(aiInvestigation).where(and(eq(aiInvestigation.repairRunId, run.id), eq(aiInvestigation.workspaceId, run.workspaceId), eq(aiInvestigation.state, 'completed'), eq(aiInvestigation.conclusionStatus, 'diagnosis_found'))).orderBy(desc(aiInvestigation.executionOrdinal)).limit(1),
      ]);
      if (!parent || parent.state !== 'ready' || !baseline || !profile || profile.status !== 'ready' || !source || source.investigationId !== parent.id) throw new RepairLoopFlowError('repair_loop_not_eligible');
      const authority = [parent, baseline, profile, source];
      if (authority.some((value) => value.workspaceId !== run.workspaceId || value.githubRepositoryId !== run.githubRepositoryId || value.installationId !== run.installationId || value.baseCommitSha !== run.baseCommitSha || value.profileIdentity !== run.profileIdentity)) throw new RepairLoopFlowError('repair_loop_not_eligible');
      const [activeGeneration] = await transaction.select({ id: aiCandidateGeneration.id }).from(aiCandidateGeneration).where(and(eq(aiCandidateGeneration.repairRunId, run.id), inArray(aiCandidateGeneration.state, ['created', 'queued', 'generating']))).limit(1);
      if (activeGeneration) throw new RepairLoopFlowError('repair_loop_not_eligible');
      const contract = deriveBaselineRecoveryContract({ repairRunId: run.id, baseline, profile });
      const [ordinalValue] = await transaction.select({ value: max(aiCandidateGeneration.executionOrdinal) }).from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, source.id));
      const loopId = randomId();
      const wakeJobId = randomId();
      const generationId = randomId();
      const iterationId = randomId();
      const [loop] = await transaction.insert(repairLoop).values({
        id: loopId, repairRunId: run.id, workspaceId: run.workspaceId, investigationId: parent.id,
        aiInvestigationId: source.id, protocolVersion: REPAIR_LOOP_PROTOCOL_VERSION,
        maxIterations: REPAIR_LOOP_MAX_ITERATIONS, idempotencyKey, state: 'queued', wakeJobId,
        createdAt: now, updatedAt: now,
      }).returning();
      if (!loop) throw new RepairLoopFlowError('repair_loop_handoff_failed');
      await transaction.insert(aiCandidateGeneration).values({
        id: generationId, aiInvestigationId: source.id, executionOrdinal: (ordinalValue?.value ?? 0) + 1,
        investigationId: parent.id, repairRunId: run.id, baselineId: baseline.id, workspaceId: run.workspaceId,
        githubRepositoryId: run.githubRepositoryId, installationId: run.installationId,
        baseCommitSha: run.baseCommitSha, profileIdentity: run.profileIdentity, providerId: AI_PROVIDER_ID,
        modelId: AI_MODEL_ID, protocolVersion: REPAIR_LOOP_AI_CANDIDATE_GENERATION_PROTOCOL_VERSION,
        idempotencyKey: randomId(), state: 'created', createdAt: now, updatedAt: now,
      });
      await transaction.insert(repairLoopIteration).values({
        id: iterationId, repairLoopId: loopId, ordinal: 1, aiCandidateGenerationId: generationId,
        objectiveContractVersion: contract.version, objectiveContractSnapshot: JSON.parse(contract.canonicalSnapshot),
        objectiveContractHash: contract.hash, objectiveContractBytes: contract.bytes, createdAt: now,
      });
      await transaction.insert(repairLoopEvent).values([
        { id: randomId(), repairLoopId: loopId, fromState: null, toState: 'queued', eventType: 'created', createdAt: now },
        { id: randomId(), repairLoopId: loopId, iterationId, fromState: 'queued', toState: 'queued', eventType: 'iteration_created', createdAt: now },
      ]);
      await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId, workspaceId: run.workspaceId, fromState: null, toState: 'created', createdAt: now });
      const generationJobId = await queues.enqueueAiCandidateGeneration(transaction, { version: AI_CANDIDATE_GENERATION_JOB_VERSION, proposalGenerationId: generationId });
      if (generationJobId !== generationId) throw new RepairLoopFlowError('repair_loop_handoff_failed');
      await transaction.update(aiCandidateGeneration).set({ state: 'queued', queuedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, generationId), eq(aiCandidateGeneration.state, 'created')));
      await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId, workspaceId: run.workspaceId, fromState: 'created', toState: 'queued', createdAt: now });
      const queuedWake = await queues.enqueueRepairLoop(transaction, { version: REPAIR_LOOP_JOB_VERSION, repairLoopId: loopId }, wakeJobId);
      if (queuedWake !== wakeJobId) throw new RepairLoopFlowError('repair_loop_handoff_failed');
      return loop;
    });
  } catch (error) {
    if (error instanceof RepairLoopFlowError) throw error;
    const [existing] = await database.select().from(repairLoop).where(and(eq(repairLoop.repairRunId, repairRunId), eq(repairLoop.workspaceId, context.workspace.id))).limit(1);
    if (existing) return result(database, existing);
    throw new RepairLoopFlowError('repair_loop_handoff_failed');
  }
  return result(database, created);
}

export async function getRepairLoop(database: VigiloDatabase, context: AuthenticatedWorkspace, id: string): Promise<RepairLoopResult | null> {
  if (!UUID.test(id)) return null;
  const [row] = await database.select().from(repairLoop).where(and(eq(repairLoop.id, id), eq(repairLoop.workspaceId, context.workspace.id))).limit(1);
  return row ? result(database, row) : null;
}

export async function getRepairLoopForRun(database: VigiloDatabase, context: AuthenticatedWorkspace, repairRunId: string): Promise<RepairLoopResult | null> {
  const [row] = await database.select().from(repairLoop).where(and(eq(repairLoop.repairRunId, repairRunId), eq(repairLoop.workspaceId, context.workspace.id))).limit(1);
  return row ? result(database, row) : null;
}
