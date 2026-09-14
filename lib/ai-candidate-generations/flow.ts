import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { aiCandidateGeneration, aiCandidateGenerationEvent, aiInvestigation, executionProfile, investigation, repairRun, repositoryBaseline } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { AI_MODEL_ID, AI_PROVIDER_ID } from '../ai-investigations/types.ts';
import type { TransactionalAiCandidateGenerationQueue } from '../repair-runs/queue.ts';
import { AI_CANDIDATE_GENERATION_PROTOCOL_VERSION, type AiCandidateGenerationResult } from './types.ts';

export class AiCandidateGenerationFlowError extends Error {
  constructor(public readonly code: 'candidate_generation_active' | 'candidate_generation_not_eligible' | 'candidate_generation_not_found' | 'candidate_generation_handoff_failed') { super(code); this.name = 'AiCandidateGenerationFlowError'; }
}

function result(row: typeof aiCandidateGeneration.$inferSelect): AiCandidateGenerationResult {
  return { id: row.id, aiInvestigationId: row.aiInvestigationId, executionOrdinal: row.executionOrdinal, investigationId: row.investigationId, repairRunId: row.repairRunId, state: row.state as AiCandidateGenerationResult['state'], revision: row.baseCommitSha, providerId: row.providerId, modelId: row.modelId, protocolVersion: row.protocolVersion, repairCandidateId: row.repairCandidateId, completionReason: row.completionReason as AiCandidateGenerationResult['completionReason'], usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens, toolCallCount: row.toolCallCount, modelTurnCount: row.modelTurnCount }, failureCode: row.failureCode, createdAt: row.createdAt, completedAt: row.completedAt };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function startAiCandidateGeneration(database: VigiloDatabase, context: AuthenticatedWorkspace, aiInvestigationId: string, queue: TransactionalAiCandidateGenerationQueue, options: { idempotencyKey?: string; randomId?: () => string; clock?: () => Date } = {}): Promise<AiCandidateGenerationResult> {
  const randomId = options.randomId ?? randomUUID; const now = (options.clock ?? (() => new Date()))(); const idempotencyKey = options.idempotencyKey ?? randomUUID();
  if (!UUID.test(aiInvestigationId) || !UUID.test(idempotencyKey)) throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
  const created = await database.transaction(async (transaction) => {
    const [source] = await transaction.select({ source: aiInvestigation, parent: investigation, run: repairRun, baseline: repositoryBaseline, profile: executionProfile })
      .from(aiInvestigation).innerJoin(investigation, eq(investigation.id, aiInvestigation.investigationId)).innerJoin(repairRun, eq(repairRun.id, aiInvestigation.repairRunId)).innerJoin(repositoryBaseline, eq(repositoryBaseline.id, aiInvestigation.baselineId)).innerJoin(executionProfile, and(eq(executionProfile.githubRepositoryId, aiInvestigation.githubRepositoryId), eq(executionProfile.workspaceId, aiInvestigation.workspaceId)))
      .where(and(eq(aiInvestigation.id, aiInvestigationId), eq(aiInvestigation.workspaceId, context.workspace.id))).for('update').limit(1);
    if (!source || source.source.state !== 'completed' || source.source.conclusionStatus !== 'diagnosis_found' || source.parent.state !== 'ready' || source.run.state !== 'ready_for_investigation' || source.profile.status !== 'ready') throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
    const bound = [source.parent, source.run, source.baseline, source.profile];
    if (bound.some((value) => value.workspaceId !== source.source.workspaceId || value.githubRepositoryId !== source.source.githubRepositoryId || value.installationId !== source.source.installationId || value.baseCommitSha !== source.source.baseCommitSha || value.profileIdentity !== source.source.profileIdentity)) throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
    const [sameIntent] = await transaction.select().from(aiCandidateGeneration).where(and(eq(aiCandidateGeneration.aiInvestigationId, source.source.id), eq(aiCandidateGeneration.idempotencyKey, idempotencyKey))).limit(1);
    if (sameIntent) return sameIntent;
    const existing = await transaction.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, source.source.id)).orderBy(aiCandidateGeneration.executionOrdinal);
    if (existing.some((row) => ['created', 'queued', 'generating'].includes(row.state))) throw new AiCandidateGenerationFlowError('candidate_generation_active');
    const latest = existing.at(-1);
    if (latest?.state === 'frozen' || latest?.state === 'abstained') throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
    const id = randomId();
    const executionOrdinal = (latest?.executionOrdinal ?? 0) + 1;
    const [row] = await transaction.insert(aiCandidateGeneration).values({ id, aiInvestigationId: source.source.id, executionOrdinal, investigationId: source.source.investigationId, repairRunId: source.source.repairRunId, baselineId: source.source.baselineId, workspaceId: source.source.workspaceId, githubRepositoryId: source.source.githubRepositoryId, installationId: source.source.installationId, baseCommitSha: source.source.baseCommitSha, profileIdentity: source.source.profileIdentity, providerId: AI_PROVIDER_ID, modelId: AI_MODEL_ID, protocolVersion: AI_CANDIDATE_GENERATION_PROTOCOL_VERSION, idempotencyKey, state: 'created', createdAt: now, updatedAt: now }).returning();
    if (!row) throw new AiCandidateGenerationFlowError('candidate_generation_handoff_failed');
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: row.workspaceId, fromState: null, toState: 'created', createdAt: now });
    const queuedId = await queue.enqueueAiCandidateGeneration(transaction, { version: 1, proposalGenerationId: id });
    if (queuedId !== id) throw new AiCandidateGenerationFlowError('candidate_generation_handoff_failed');
    const [queued] = await transaction.update(aiCandidateGeneration).set({ state: 'queued', queuedAt: now, updatedAt: now }).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.state, 'created'))).returning();
    if (!queued) throw new AiCandidateGenerationFlowError('candidate_generation_handoff_failed');
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId: id, workspaceId: row.workspaceId, fromState: 'created', toState: 'queued', createdAt: now });
    return queued;
  });
  return result(created);
}

export async function getAiCandidateGeneration(database: VigiloDatabase, context: AuthenticatedWorkspace, id: string): Promise<AiCandidateGenerationResult | null> {
  const [row] = await database.select().from(aiCandidateGeneration).where(and(eq(aiCandidateGeneration.id, id), eq(aiCandidateGeneration.workspaceId, context.workspace.id))).limit(1);
  return row ? result(row) : null;
}

export async function getAiCandidateGenerationForAiInvestigation(database: VigiloDatabase, context: AuthenticatedWorkspace, aiInvestigationId: string): Promise<AiCandidateGenerationResult | null> {
  const [row] = await database.select().from(aiCandidateGeneration).where(and(eq(aiCandidateGeneration.aiInvestigationId, aiInvestigationId), eq(aiCandidateGeneration.workspaceId, context.workspace.id))).orderBy(desc(aiCandidateGeneration.executionOrdinal)).limit(1);
  return row ? result(row) : null;
}
