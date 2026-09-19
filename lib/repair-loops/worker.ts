import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm';

import {
  aiCandidateGeneration,
  aiCandidateGenerationEvent,
  aiInvestigation,
  candidateVerification,
  candidateVerificationEvidence,
  candidateVerificationEvent,
  repairCandidate,
  repairCandidateFile,
  repairLoop,
  repairLoopEvent,
  repairLoopIteration,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { selfCheckRepairCandidate } from '../repair-candidates/flow.ts';
import { AI_MODEL_ID, AI_PROVIDER_ID } from '../ai-investigations/types.ts';
import { REPAIR_LOOP_AI_CANDIDATE_GENERATION_PROTOCOL_VERSION } from '../ai-candidate-generations/types.ts';
import {
  AI_CANDIDATE_GENERATION_JOB_VERSION,
  CANDIDATE_VERIFICATION_JOB_VERSION,
  parseRepairLoopJobPayload,
  REPAIR_LOOP_JOB_VERSION,
  type RepairQueueJob,
  type TransactionalAiCandidateGenerationQueue,
  type TransactionalCandidateVerificationQueue,
  type TransactionalRepairLoopQueue,
  type VigiloTransaction,
} from '../repair-runs/queue.ts';
import { canonicalRecord } from './canonical.ts';
import { decideRepairLoopOutcome, type RepairLoopIterationDecision, type RepairLoopState } from './decision.ts';
import { buildRepairLoopFeedback } from './feedback.ts';
import {
  evaluateBaselineRecovery,
  isTrustworthyBaselineRecoveryEvidence,
  validateStoredBaselineRecoveryContract,
  type BaselineRecoveryContract,
  type BaselineRecoveryEvidence,
  type RepairLoopObjectiveEvidence,
} from './objective-contract.ts';

type LoopRow = typeof repairLoop.$inferSelect;
type IterationRow = typeof repairLoopIteration.$inferSelect;
type GenerationRow = typeof aiCandidateGeneration.$inferSelect;
type VerificationRow = typeof candidateVerification.$inferSelect;
type EvidenceRow = typeof candidateVerificationEvidence.$inferSelect;
type CandidateRow = typeof repairCandidate.$inferSelect;
type JobResult = { id: string; status: 'completed' | 'failed' | 'deadletter'; output?: { code: string } };

export interface RepairLoopWorkerQueues extends TransactionalRepairLoopQueue, TransactionalAiCandidateGenerationQueue, TransactionalCandidateVerificationQueue {}
export interface RepairLoopWorkerDependencies {
  database: VigiloDatabase;
  queues: RepairLoopWorkerQueues;
  randomId?: () => string;
  clock?: () => Date;
  afterWakeValidated?: () => Promise<void>;
  afterVerificationCreated?: () => Promise<void>;
  afterEvidenceObserved?: () => Promise<void>;
}

const ACTIVE_LOOP_STATES = ['queued', 'running'] as const;
const INFRA_GENERATION_CODES = new Set(['provider_rate_limited', 'provider_quota_exhausted', 'provider_infrastructure_failed', 'provider_configuration_failed', 'context_source_unavailable', 'model_retry_exhausted', 'model_provider_failed', 'model_timeout']);
const INTEGRITY_GENERATION_CODES = new Set(['candidate_generation_authority_mismatch', 'model_provider_mismatch']);

function classifyGenerationFailure(code: string): 'generation_failure' | 'infrastructure_failure' | 'integrity_failure' | 'ownership_failure' {
  if (INFRA_GENERATION_CODES.has(code)) return 'infrastructure_failure';
  if (INTEGRITY_GENERATION_CODES.has(code)) return 'integrity_failure';
  if (code === 'candidate_generation_ownership_lost') return 'ownership_failure';
  return 'generation_failure';
}

class RepairLoopIntegrityError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'RepairLoopIntegrityError'; }
}

function contractFor(loop: LoopRow, iteration: IterationRow, generation: GenerationRow): BaselineRecoveryContract {
  if (iteration.objectiveContractVersion !== 'baseline_recovery_v1') throw new Error('objective_contract_invalid');
  return validateStoredBaselineRecoveryContract(iteration.objectiveContractSnapshot, iteration.objectiveContractHash, iteration.objectiveContractBytes, {
    repairRunId: loop.repairRunId, workspaceId: loop.workspaceId, githubRepositoryId: generation.githubRepositoryId,
    installationId: generation.installationId, baselineId: generation.baselineId,
    profileIdentity: generation.profileIdentity, baseCommitSha: generation.baseCommitSha,
  });
}

function evidenceValue(row: EvidenceRow): BaselineRecoveryEvidence {
  return row;
}

async function event(transaction: VigiloTransaction, randomId: () => string, values: {
  loop: LoopRow; iterationId?: string | null; fromState: string | null; toState: RepairLoopState;
  eventType: 'started' | 'iteration_created' | 'verification_created' | 'iteration_decided' | 'completed' | 'reconciled';
  decision?: RepairLoopIterationDecision | null; failureCode?: string | null; now: Date;
}) {
  await transaction.insert(repairLoopEvent).values({ id: randomId(), repairLoopId: values.loop.id, iterationId: values.iterationId ?? null, fromState: values.fromState, toState: values.toState, eventType: values.eventType, decision: values.decision ?? null, failureCode: values.failureCode ?? null, createdAt: values.now });
}

async function scheduleWake(transaction: VigiloTransaction, loop: LoopRow, expectedWakeJobId: string, queues: RepairLoopWorkerQueues, randomId: () => string, now: Date): Promise<void> {
  const wakeJobId = randomId();
  const [updated] = await transaction.update(repairLoop).set({ wakeJobId, updatedAt: now }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.wakeJobId, expectedWakeJobId), inArray(repairLoop.state, ACTIVE_LOOP_STATES))).returning();
  if (!updated) return;
  const queued = await queues.enqueueRepairLoop(transaction, { version: REPAIR_LOOP_JOB_VERSION, repairLoopId: loop.id }, wakeJobId, new Date(now.getTime() + 1_000));
  if (queued !== wakeJobId) throw new Error('repair_loop_handoff_failed');
  await event(transaction, randomId, { loop: updated, fromState: updated.state, toState: updated.state as RepairLoopState, eventType: 'reconciled', now });
}

async function terminalWithoutVerification(database: VigiloDatabase, loop: LoopRow, expectedWakeJobId: string, iteration: IterationRow, generation: GenerationRow, randomId: () => string, now: Date): Promise<void> {
  const abstained = generation.state === 'abstained';
  const decision: RepairLoopIterationDecision = abstained ? 'abstained' : 'generation_failed';
  const state: RepairLoopState = abstained ? 'abstained' : 'failed';
  const failureCode = abstained ? null : (generation.failureCode ?? 'candidate_generation_failed');
  await database.transaction(async (transaction) => {
    const [ownedLoop] = await transaction.select({ id: repairLoop.id }).from(repairLoop).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
    if (!ownedLoop) return;
    const [owned] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.id, iteration.id), eq(repairLoopIteration.aiCandidateGenerationId, generation.id), eq(repairLoopIteration.repairLoopId, loop.id))).for('update').limit(1);
    if (!owned || owned.decision !== null) return;
    await transaction.update(repairLoopIteration).set({ decision, failureCode, decidedAt: now }).where(and(eq(repairLoopIteration.id, iteration.id), isNull(repairLoopIteration.decision)));
    const classification = abstained ? null : classifyGenerationFailure(failureCode!);
    const [finished] = await transaction.update(repairLoop).set({ state, completedAt: now, updatedAt: now, failureClassification: classification, failureCode }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).returning();
    if (!finished) return;
    await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: 'running', toState: state, eventType: 'iteration_decided', decision, failureCode, now });
    await event(transaction, randomId, { loop: finished, iterationId: iteration.id, fromState: 'running', toState: state, eventType: 'completed', decision, failureCode, now });
  });
}

async function bindOrCreateVerification(dependencies: RepairLoopWorkerDependencies, loop: LoopRow, expectedWakeJobId: string, iteration: IterationRow, generation: GenerationRow, candidate: CandidateRow, randomId: () => string, now: Date): Promise<void> {
  try { await selfCheckRepairCandidate(dependencies.database, { workspace: { id: loop.workspaceId } } as never, candidate.id); }
  catch { throw new RepairLoopIntegrityError('candidate_artifact_invalid'); }
  await dependencies.database.transaction(async (transaction) => {
    const [ownedLoop] = await transaction.select({ id: repairLoop.id }).from(repairLoop).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
    if (!ownedLoop) return;
    const [owned] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.id, iteration.id), eq(repairLoopIteration.repairLoopId, loop.id), eq(repairLoopIteration.aiCandidateGenerationId, generation.id))).for('update').limit(1);
    if (!owned || owned.decision !== null || owned.candidateVerificationId !== null) return;
    const current = await transaction.select().from(candidateVerification).where(eq(candidateVerification.candidateId, candidate.id)).orderBy(asc(candidateVerification.createdAt), asc(candidateVerification.id));
    if (current.length > 0) throw new RepairLoopIntegrityError('verification_provenance_ambiguous');
    const id = randomId();
    const [verification] = await transaction.insert(candidateVerification).values({
      id, candidateId: candidate.id, investigationId: candidate.investigationId, repairRunId: candidate.repairRunId,
      baselineId: generation.baselineId, workspaceId: candidate.workspaceId, githubRepositoryId: candidate.githubRepositoryId,
      installationId: candidate.installationId, baseCommitSha: candidate.baseCommitSha,
      profileIdentity: candidate.profileIdentity, candidateIdentity: candidate.candidateIdentity!, formatVersion: 1,
      state: 'queued', createdAt: now, queuedAt: now, updatedAt: now,
    }).returning();
    if (!verification) throw new Error('verification_handoff_failed');
    await transaction.insert(candidateVerificationEvent).values([
      { id: randomId(), verificationId: id, workspaceId: loop.workspaceId, fromState: null, toState: 'created', createdAt: now },
      { id: randomId(), verificationId: id, workspaceId: loop.workspaceId, fromState: 'created', toState: 'queued', createdAt: now },
    ]);
    const jobId = await dependencies.queues.enqueueVerification(transaction, { version: CANDIDATE_VERIFICATION_JOB_VERSION, verificationId: id });
    if (jobId !== id) throw new Error('verification_handoff_failed');
    if (verification.candidateId !== candidate.id || verification.investigationId !== loop.investigationId || verification.repairRunId !== loop.repairRunId || verification.workspaceId !== loop.workspaceId || verification.baselineId !== generation.baselineId || verification.candidateIdentity !== candidate.candidateIdentity) throw new RepairLoopIntegrityError('verification_authority_mismatch');
    await transaction.update(repairLoopIteration).set({ candidateVerificationId: verification.id }).where(and(eq(repairLoopIteration.id, iteration.id), isNull(repairLoopIteration.candidateVerificationId)));
    await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: 'running', toState: 'running', eventType: 'verification_created', now });
    await scheduleWake(transaction, loop, expectedWakeJobId, dependencies.queues, randomId, now);
  });
  await dependencies.afterVerificationCreated?.();
}

function objectiveSnapshot(loop: LoopRow, iteration: IterationRow, verification: VerificationRow, evidence: EvidenceRow | null, result: RepairLoopObjectiveEvidence, evaluatedChecks: string[]) {
  return canonicalRecord({
    version: 'baseline_recovery_evidence_v1', repairRunId: loop.repairRunId,
    baselineId: verification.baselineId, profileIdentity: verification.profileIdentity,
    candidateId: verification.candidateId, candidateIdentity: verification.candidateIdentity,
    verificationId: verification.id, evidenceId: evidence?.id ?? null,
    objectiveContractVersion: iteration.objectiveContractVersion,
    objectiveContractHash: iteration.objectiveContractHash, result, evaluatedChecks,
  }, 16 * 1024);
}

async function stopAfterVerification(dependencies: RepairLoopWorkerDependencies, loop: LoopRow, expectedWakeJobId: string, iteration: IterationRow, verification: VerificationRow, evidence: EvidenceRow | null, disposition: 'integrity_failure' | 'infrastructure_failure', code: string, randomId: () => string, now: Date) {
  const objective = objectiveSnapshot(loop, iteration, verification, evidence, 'not_measured', []);
  const decision = disposition === 'integrity_failure' ? 'evidence_invalid' : 'infrastructure_failed';
  await dependencies.database.transaction(async (transaction) => {
    const [ownedLoop] = await transaction.select({ id: repairLoop.id }).from(repairLoop).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
    if (!ownedLoop) return;
    const [owned] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.id, iteration.id), eq(repairLoopIteration.candidateVerificationId, verification.id))).for('update').limit(1);
    if (!owned || owned.decision !== null) return;
    await transaction.update(repairLoopIteration).set({ objectiveEvidence: 'not_measured', objectiveEvidenceSnapshot: objective.snapshot, objectiveEvidenceHash: objective.hash, objectiveEvidenceBytes: objective.bytes, decision, failureCode: code, decidedAt: now }).where(eq(repairLoopIteration.id, iteration.id));
    const [finished] = await transaction.update(repairLoop).set({ state: 'failed', failureClassification: disposition === 'integrity_failure' ? 'integrity_failure' : 'infrastructure_failure', failureCode: code, completedAt: now, updatedAt: now }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).returning();
    if (!finished) return;
    await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: 'running', toState: 'failed', eventType: 'iteration_decided', decision, failureCode: code, now });
    await event(transaction, randomId, { loop: finished, iterationId: iteration.id, fromState: 'running', toState: 'failed', eventType: 'completed', decision, failureCode: code, now });
  });
}

async function decideCompletedVerification(dependencies: RepairLoopWorkerDependencies, loop: LoopRow, expectedWakeJobId: string, iteration: IterationRow, generation: GenerationRow, verification: VerificationRow, evidence: EvidenceRow, candidate: CandidateRow, randomId: () => string, now: Date): Promise<void> {
  let contract: BaselineRecoveryContract;
  try { contract = contractFor(loop, iteration, generation); }
  catch { await stopAfterVerification(dependencies, loop, expectedWakeJobId, iteration, verification, evidence, 'integrity_failure', 'objective_contract_invalid', randomId, now); return; }
  const exact = verification.evidenceId === evidence.id && evidence.verificationId === verification.id && evidence.candidateId === candidate.id &&
    evidence.candidateIdentity === candidate.candidateIdentity && generation.repairCandidateId === candidate.id &&
    evidence.candidateArtifactIntegrity === verification.candidateArtifactIntegrity &&
    evidence.verificationContract === verification.verificationContract && evidence.baselineComparison === verification.baselineComparison;
  if (!exact || !isTrustworthyBaselineRecoveryEvidence(contract, evidenceValue(evidence))) {
    await stopAfterVerification(dependencies, loop, expectedWakeJobId, iteration, verification, evidence, 'integrity_failure', 'verification_evidence_invalid', randomId, now); return;
  }
  const evaluated = evaluateBaselineRecovery(contract, evidenceValue(evidence), { verificationId: verification.id, candidateId: candidate.id, candidateIdentity: candidate.candidateIdentity!, evidenceId: evidence.id });
  const objective = objectiveSnapshot(loop, iteration, verification, evidence, evaluated.result, evaluated.evaluatedChecks);
  const regression = verification.baselineComparison === 'regression_detected';
  const decision = decideRepairLoopOutcome({ iterationOrdinal: iteration.ordinal, maxIterations: loop.maxIterations, verificationDisposition: 'trustworthy', objectiveEvidence: evaluated.result, regression });
  await dependencies.afterEvidenceObserved?.();
  if (!decision.scheduleNext) {
    await dependencies.database.transaction(async (transaction) => {
      const [ownedLoop] = await transaction.select({ id: repairLoop.id }).from(repairLoop).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
      if (!ownedLoop) return;
      const [owned] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.id, iteration.id), eq(repairLoopIteration.candidateVerificationId, verification.id))).for('update').limit(1);
      if (!owned || owned.decision !== null) return;
      await transaction.update(repairLoopIteration).set({ objectiveEvidence: evaluated.result, objectiveEvidenceSnapshot: objective.snapshot, objectiveEvidenceHash: objective.hash, objectiveEvidenceBytes: objective.bytes, decision: decision.iterationDecision, decidedAt: now }).where(eq(repairLoopIteration.id, iteration.id));
      const [finished] = await transaction.update(repairLoop).set({ state: decision.loopState, completedAt: now, updatedAt: now, ...(decision.loopState === 'verified' ? { selectedCandidateId: candidate.id, selectedVerificationId: verification.id, selectedEvidenceId: evidence.id } : {}) }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).returning();
      if (!finished) return;
      await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: 'running', toState: decision.loopState, eventType: 'iteration_decided', decision: decision.iterationDecision, now });
      await event(transaction, randomId, { loop: finished, iterationId: iteration.id, fromState: 'running', toState: decision.loopState, eventType: 'completed', decision: decision.iterationDecision, now });
    });
    return;
  }
  const files = await dependencies.database.select({ path: repairCandidateFile.path, operation: repairCandidateFile.operation }).from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, candidate.id));
  const [diagnosis] = await dependencies.database.select().from(aiInvestigation).where(eq(aiInvestigation.id, loop.aiInvestigationId)).limit(1);
  if (!diagnosis || diagnosis.state !== 'completed' || diagnosis.conclusionStatus !== 'diagnosis_found') {
    await stopAfterVerification(dependencies, loop, expectedWakeJobId, iteration, verification, evidence, 'integrity_failure', 'diagnosis_binding_invalid', randomId, now); return;
  }
  let feedback;
  try { feedback = buildRepairLoopFeedback({
    version: 1,
    provenance: { previousIterationId: iteration.id, generationId: generation.id, candidateId: candidate.id, candidateIdentity: candidate.candidateIdentity!, verificationId: verification.id, evidenceId: evidence.id },
    previousCandidate: { files: files.map((file) => ({ path: file.path, operation: file.operation as 'add' | 'modify' | 'delete' })) },
    verification: {
      contract: verification.verificationContract!, baselineComparison: verification.baselineComparison!, objectiveEvidence: evaluated.result,
      phases: {
        install: { status: evidence.installStatus, exitCode: evidence.installExitCode, timedOut: evidence.installTimedOut },
        typecheck: { status: evidence.typecheckStatus, exitCode: evidence.typecheckExitCode, timedOut: evidence.typecheckTimedOut },
        build: { status: evidence.buildStatus, exitCode: evidence.buildExitCode, timedOut: evidence.buildTimedOut },
        test: { status: evidence.testStatus, exitCode: evidence.testExitCode, timedOut: evidence.testTimedOut },
      },
      safeFailure: { phase: evidence.errorPhase, code: evidence.errorCode },
    },
    priorDiagnosis: { summary: diagnosis.summary!, proposedApproach: diagnosis.proposedApproach!, confidence: diagnosis.confidence! },
    boundaries: { repositoryValues: 'UNTRUSTED_REPOSITORY_DATA', modelValues: 'UNTRUSTED_MODEL_DATA', completeReplacementAgainstOriginalBase: true },
  }); } catch { throw new RepairLoopIntegrityError('repair_loop_feedback_invalid'); }
  await dependencies.database.transaction(async (transaction) => {
    const [ownedLoop] = await transaction.select({ id: repairLoop.id }).from(repairLoop).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
    if (!ownedLoop) return;
    const [owned] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.id, iteration.id), eq(repairLoopIteration.candidateVerificationId, verification.id))).for('update').limit(1);
    if (!owned || owned.decision !== null || owned.ordinal !== 1) return;
    const [other] = await transaction.select({ id: repairLoopIteration.id }).from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(desc(repairLoopIteration.ordinal)).limit(1);
    if (!other || other.id !== owned.id) return;
    const [ordinalValue] = await transaction.select({ value: max(aiCandidateGeneration.executionOrdinal) }).from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, loop.aiInvestigationId));
    const generationId = randomId(); const nextIterationId = randomId(); const wakeJobId = randomId();
    await transaction.update(repairLoopIteration).set({ objectiveEvidence: evaluated.result, objectiveEvidenceSnapshot: objective.snapshot, objectiveEvidenceHash: objective.hash, objectiveEvidenceBytes: objective.bytes, decision: 'repairable_failure', decidedAt: now }).where(eq(repairLoopIteration.id, iteration.id));
    await transaction.insert(aiCandidateGeneration).values({
      id: generationId, aiInvestigationId: loop.aiInvestigationId, executionOrdinal: (ordinalValue?.value ?? 0) + 1,
      investigationId: loop.investigationId, repairRunId: loop.repairRunId, baselineId: verification.baselineId,
      workspaceId: loop.workspaceId, githubRepositoryId: verification.githubRepositoryId, installationId: verification.installationId,
      baseCommitSha: verification.baseCommitSha, profileIdentity: verification.profileIdentity,
      providerId: AI_PROVIDER_ID, modelId: AI_MODEL_ID, protocolVersion: REPAIR_LOOP_AI_CANDIDATE_GENERATION_PROTOCOL_VERSION,
      idempotencyKey: randomId(), state: 'created', createdAt: now, updatedAt: now,
    });
    await transaction.insert(repairLoopIteration).values({
      id: nextIterationId, repairLoopId: loop.id, ordinal: 2, aiCandidateGenerationId: generationId,
      previousIterationId: iteration.id, objectiveContractVersion: iteration.objectiveContractVersion,
      objectiveContractSnapshot: iteration.objectiveContractSnapshot, objectiveContractHash: iteration.objectiveContractHash,
      objectiveContractBytes: iteration.objectiveContractBytes, feedbackVersion: 1, feedbackSnapshot: feedback.snapshot,
      feedbackHash: feedback.hash, feedbackBytes: feedback.bytes, feedbackVerificationId: verification.id,
      feedbackEvidenceId: evidence.id, createdAt: now,
    });
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId, workspaceId: loop.workspaceId, fromState: null, toState: 'created', createdAt: now });
    const generationJob = await dependencies.queues.enqueueAiCandidateGeneration(transaction, { version: AI_CANDIDATE_GENERATION_JOB_VERSION, proposalGenerationId: generationId });
    if (generationJob !== generationId) throw new Error('repair_loop_handoff_failed');
    await transaction.update(aiCandidateGeneration).set({ state: 'queued', queuedAt: now, updatedAt: now }).where(eq(aiCandidateGeneration.id, generationId));
    await transaction.insert(aiCandidateGenerationEvent).values({ id: randomId(), generationId, workspaceId: loop.workspaceId, fromState: 'created', toState: 'queued', createdAt: now });
    const [updatedLoop] = await transaction.update(repairLoop).set({ wakeJobId, updatedAt: now }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'running'), eq(repairLoop.wakeJobId, expectedWakeJobId))).returning();
    if (!updatedLoop) throw new Error('repair_loop_handoff_failed');
    const wakeJob = await dependencies.queues.enqueueRepairLoop(transaction, { version: REPAIR_LOOP_JOB_VERSION, repairLoopId: loop.id }, wakeJobId, new Date(now.getTime() + 1_000));
    if (wakeJob !== wakeJobId) throw new Error('repair_loop_handoff_failed');
    await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: 'running', toState: 'running', eventType: 'iteration_decided', decision: 'repairable_failure', now });
    await event(transaction, randomId, { loop, iterationId: nextIterationId, fromState: 'running', toState: 'running', eventType: 'iteration_created', now });
  });
}

async function reconcile(dependencies: RepairLoopWorkerDependencies, loop: LoopRow, expectedWakeJobId: string, randomId: () => string, now: Date): Promise<void> {
  if (loop.state === 'queued') {
    await dependencies.database.transaction(async (transaction) => {
      const [started] = await transaction.update(repairLoop).set({ state: 'running', startedAt: now, updatedAt: now }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.state, 'queued'), eq(repairLoop.wakeJobId, expectedWakeJobId))).returning();
      if (started) await event(transaction, randomId, { loop, fromState: 'queued', toState: 'running', eventType: 'started', now });
    });
  }
  const [currentLoop] = await dependencies.database.select().from(repairLoop).where(eq(repairLoop.id, loop.id)).limit(1);
  if (!currentLoop || currentLoop.state !== 'running' || currentLoop.wakeJobId !== expectedWakeJobId) return;
  const [iteration] = await dependencies.database.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.repairLoopId, loop.id), isNull(repairLoopIteration.decision))).limit(1);
  if (!iteration) throw new RepairLoopIntegrityError('repair_loop_iteration_missing');
  const [generation] = await dependencies.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, iteration.aiCandidateGenerationId)).limit(1);
  if (!generation || generation.aiInvestigationId !== loop.aiInvestigationId || generation.investigationId !== loop.investigationId || generation.repairRunId !== loop.repairRunId || generation.workspaceId !== loop.workspaceId || generation.protocolVersion !== 4) throw new RepairLoopIntegrityError('repair_loop_generation_invalid');
  if (['created', 'queued', 'generating'].includes(generation.state)) {
    await dependencies.database.transaction((transaction) => scheduleWake(transaction, currentLoop, expectedWakeJobId, dependencies.queues, randomId, now)); return;
  }
  if (generation.state === 'abstained' || generation.state === 'failed' || generation.state === 'cancelled') {
    await terminalWithoutVerification(dependencies.database, currentLoop, expectedWakeJobId, iteration, generation, randomId, now); return;
  }
  if (generation.state !== 'frozen' || !generation.repairCandidateId) throw new RepairLoopIntegrityError('repair_loop_generation_invalid');
  const [candidate] = await dependencies.database.select().from(repairCandidate).where(eq(repairCandidate.id, generation.repairCandidateId)).limit(1);
  if (!candidate || candidate.state !== 'frozen' || !candidate.candidateIdentity || candidate.proposalKey !== generation.id || candidate.investigationId !== loop.investigationId || candidate.repairRunId !== loop.repairRunId || candidate.workspaceId !== loop.workspaceId) throw new RepairLoopIntegrityError('repair_loop_candidate_invalid');
  if (!iteration.candidateVerificationId) {
    await bindOrCreateVerification(dependencies, currentLoop, expectedWakeJobId, iteration, generation, candidate, randomId, now); return;
  }
  const [verification] = await dependencies.database.select().from(candidateVerification).where(eq(candidateVerification.id, iteration.candidateVerificationId)).limit(1);
  if (!verification || verification.candidateId !== candidate.id || verification.candidateIdentity !== candidate.candidateIdentity) throw new RepairLoopIntegrityError('repair_loop_verification_invalid');
  if (['created', 'queued', 'verifying'].includes(verification.state)) {
    await dependencies.database.transaction((transaction) => scheduleWake(transaction, currentLoop, expectedWakeJobId, dependencies.queues, randomId, now)); return;
  }
  if (verification.state === 'infrastructure_failed' || verification.state === 'cancelled') {
    await stopAfterVerification(dependencies, currentLoop, expectedWakeJobId, iteration, verification, null, 'infrastructure_failure', verification.failureCode ?? 'verification_infrastructure_failed', randomId, now); return;
  }
  if (verification.state !== 'completed' || !verification.evidenceId) {
    await stopAfterVerification(dependencies, currentLoop, expectedWakeJobId, iteration, verification, null, 'integrity_failure', 'verification_evidence_missing', randomId, now); return;
  }
  const [evidence] = await dependencies.database.select().from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, verification.evidenceId)).limit(1);
  if (!evidence) { await stopAfterVerification(dependencies, currentLoop, expectedWakeJobId, iteration, verification, null, 'integrity_failure', 'verification_evidence_missing', randomId, now); return; }
  await decideCompletedVerification(dependencies, currentLoop, expectedWakeJobId, iteration, generation, verification, evidence, candidate, randomId, now);
}

async function failIntegrity(database: VigiloDatabase, loopId: string, expectedWakeJobId: string, code: string, randomId: () => string, now: Date): Promise<void> {
  const snapshot = canonicalRecord({ version: 'baseline_recovery_evidence_v1', result: 'not_measured', evaluatedChecks: [], failureCode: code }, 16 * 1024);
  await database.transaction(async (transaction) => {
    const [loop] = await transaction.select().from(repairLoop).where(and(eq(repairLoop.id, loopId), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
    if (!loop || !ACTIVE_LOOP_STATES.includes(loop.state as typeof ACTIVE_LOOP_STATES[number])) return;
    const [iteration] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.repairLoopId, loop.id), isNull(repairLoopIteration.decision))).for('update').limit(1);
    if (!iteration) return;
    await transaction.update(repairLoopIteration).set({ objectiveEvidence: 'not_measured', objectiveEvidenceSnapshot: snapshot.snapshot, objectiveEvidenceHash: snapshot.hash, objectiveEvidenceBytes: snapshot.bytes, decision: 'evidence_invalid', failureCode: code, decidedAt: now }).where(eq(repairLoopIteration.id, iteration.id));
    const [finished] = await transaction.update(repairLoop).set({ state: 'failed', failureClassification: 'integrity_failure', failureCode: code, completedAt: now, updatedAt: now }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.wakeJobId, expectedWakeJobId), inArray(repairLoop.state, ACTIVE_LOOP_STATES))).returning();
    if (!finished) return;
    await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: loop.state, toState: 'failed', eventType: 'iteration_decided', decision: 'evidence_invalid', failureCode: code, now });
    await event(transaction, randomId, { loop: finished, iterationId: iteration.id, fromState: loop.state, toState: 'failed', eventType: 'completed', decision: 'evidence_invalid', failureCode: code, now });
  });
}

async function failInfrastructure(database: VigiloDatabase, loopId: string, expectedWakeJobId: string, code: string, randomId: () => string, now: Date): Promise<void> {
  const snapshot = canonicalRecord({ version: 'baseline_recovery_evidence_v1', result: 'not_measured', evaluatedChecks: [], failureCode: code }, 16 * 1024);
  await database.transaction(async (transaction) => {
    const [loop] = await transaction.select().from(repairLoop).where(and(eq(repairLoop.id, loopId), eq(repairLoop.wakeJobId, expectedWakeJobId))).for('update').limit(1);
    if (!loop || !ACTIVE_LOOP_STATES.includes(loop.state as typeof ACTIVE_LOOP_STATES[number])) return;
    const [iteration] = await transaction.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.repairLoopId, loop.id), isNull(repairLoopIteration.decision))).for('update').limit(1);
    if (!iteration) return;
    await transaction.update(repairLoopIteration).set({ objectiveEvidence: 'not_measured', objectiveEvidenceSnapshot: snapshot.snapshot, objectiveEvidenceHash: snapshot.hash, objectiveEvidenceBytes: snapshot.bytes, decision: 'infrastructure_failed', failureCode: code, decidedAt: now }).where(eq(repairLoopIteration.id, iteration.id));
    const [finished] = await transaction.update(repairLoop).set({ state: 'failed', failureClassification: 'infrastructure_failure', failureCode: code, completedAt: now, updatedAt: now }).where(and(eq(repairLoop.id, loop.id), eq(repairLoop.wakeJobId, expectedWakeJobId), inArray(repairLoop.state, ACTIVE_LOOP_STATES))).returning();
    if (!finished) return;
    await event(transaction, randomId, { loop, iterationId: iteration.id, fromState: loop.state, toState: 'failed', eventType: 'iteration_decided', decision: 'infrastructure_failed', failureCode: code, now });
    await event(transaction, randomId, { loop: finished, iterationId: iteration.id, fromState: loop.state, toState: 'failed', eventType: 'completed', decision: 'infrastructure_failed', failureCode: code, now });
  });
}

export async function processRepairLoopJob(job: RepairQueueJob, dependencies: RepairLoopWorkerDependencies): Promise<JobResult> {
  let payload;
  try { payload = parseRepairLoopJobPayload(job.data); }
  catch { return { id: job.id, status: 'deadletter', output: { code: 'invalid_repair_loop_job_payload' } }; }
  const randomId = dependencies.randomId ?? randomUUID; const now = (dependencies.clock ?? (() => new Date()))();
  const [loop] = await dependencies.database.select().from(repairLoop).where(eq(repairLoop.id, payload.repairLoopId)).limit(1);
  if (!loop) return { id: job.id, status: 'deadletter', output: { code: 'repair_loop_not_found' } };
  if (!ACTIVE_LOOP_STATES.includes(loop.state as typeof ACTIVE_LOOP_STATES[number]) || loop.wakeJobId !== job.id) return { id: job.id, status: 'completed' };
  try { await dependencies.afterWakeValidated?.(); await reconcile(dependencies, loop, job.id, randomId, now); return { id: job.id, status: 'completed' }; }
  catch (error) {
    if (error instanceof RepairLoopIntegrityError) {
      await failIntegrity(dependencies.database, loop.id, job.id, error.code, randomId, now);
      return { id: job.id, status: 'completed' };
    }
    if ('retryCount' in job && 'retryLimit' in job && job.retryCount >= job.retryLimit) {
      await failInfrastructure(dependencies.database, loop.id, job.id, 'repair_loop_reconciliation_exhausted', randomId, now);
      return { id: job.id, status: 'completed' };
    }
    return { id: job.id, status: 'failed', output: { code: 'repair_loop_reconciliation_failed' } };
  }
}
