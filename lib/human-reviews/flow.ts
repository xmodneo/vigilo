import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import {
  aiCandidateGeneration,
  aiCandidateGenerationAttempt,
  candidateVerification,
  candidateVerificationAttempt,
  candidateVerificationEvidence,
  executionProfile,
  humanReviewDecision,
  repairCandidate,
  repairLoop,
  repairLoopIteration,
  repairRun,
  repositoryBaseline,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { selfCheckRepairCandidateForWorkspace } from '../repair-candidates/flow.ts';
import { frozenBaselineProfile } from '../repository-baselines/authority.ts';
import { canonicalRecord } from '../repair-loops/canonical.ts';
import {
  evaluateBaselineRecovery,
  deriveBaselineRecoveryContract,
  isTrustworthyBaselineRecoveryEvidence,
  validateStoredBaselineRecoveryContract,
} from '../repair-loops/objective-contract.ts';
import {
  HUMAN_REVIEW_VERSION,
  computeHumanReviewDecisionIdentity,
  computeHumanReviewSubjectIdentity,
  computeVerificationEvidenceIdentity,
  type HumanReviewDecision,
  type VerificationEvidenceIdentityInput,
} from './identity.ts';
import {
  TASK_4_3_LIVE_ACCEPTANCE_STATUS,
  type ApprovedHumanReviewAuthority,
  type HumanReviewDecisionResult,
  type HumanReviewHistoryItem,
  type HumanReviewIneligibleReason,
  type HumanReviewResult,
  type HumanReviewSubject,
} from './types.ts';

const ACTIVE_GENERATION_STATES = ['created', 'queued', 'generating'] as const;
const ACTIVE_VERIFICATION_STATES = ['created', 'queued', 'verifying'] as const;
const HISTORY_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export class HumanReviewError extends Error {
  constructor(public readonly code:
    | 'human_review_not_found'
    | 'human_review_ineligible'
    | 'review_subject_stale'
    | 'invalid_decision'
    | 'invalid_idempotency_key'
    | 'idempotency_conflict'
    | 'decision_conflict'
    | 'decision_not_approved'
    | 'live_acceptance_pending') {
    super(code);
    this.name = 'HumanReviewError';
  }
}

type ReviewDatabase = VigiloDatabase;
type DecisionRow = typeof humanReviewDecision.$inferSelect;

function publicDecision(row: DecisionRow): HumanReviewDecisionResult {
  return {
    id: row.id,
    decision: row.decision as HumanReviewDecision,
    reviewerUserId: row.reviewerUserId,
    decisionIdentity: row.decisionIdentity,
    createdAt: row.createdAt,
  };
}

function evidenceIdentityInput(
  row: typeof candidateVerificationEvidence.$inferSelect,
  attempt: typeof candidateVerificationAttempt.$inferSelect,
): VerificationEvidenceIdentityInput {
  return {
    evidenceVersion: row.evidenceVersion,
    verificationId: row.verificationId,
    attemptId: row.attemptId,
    attemptVerificationId: attempt.verificationId,
    attemptExpectedEvidenceId: attempt.expectedEvidenceId,
    attemptEvidenceId: attempt.evidenceId,
    attemptState: attempt.state,
    evidenceId: row.id,
    candidateId: row.candidateId,
    candidateIdentity: row.candidateIdentity,
    workspaceId: row.workspaceId,
    githubRepositoryId: row.githubRepositoryId,
    installationId: row.installationId,
    baseCommitSha: row.baseCommitSha,
    profileIdentity: row.profileIdentity,
    baselineId: row.baselineId,
    candidateArtifactIntegrity: row.candidateArtifactIntegrity,
    distinctSandboxConfirmed: row.distinctSandboxConfirmed,
    pristineSourceIdentity: row.pristineSourceIdentity,
    pristineBaseIntegrity: row.pristineBaseIntegrity,
    reconstructedSourceIdentity: row.reconstructedSourceIdentity,
    candidateReconstruction: row.candidateReconstruction,
    credentialsExposure: row.credentialsExposure,
    networkPolicy: row.networkPolicy,
    installStatus: row.installStatus,
    installExitCode: row.installExitCode,
    installTimedOut: row.installTimedOut,
    typecheckStatus: row.typecheckStatus,
    typecheckExitCode: row.typecheckExitCode,
    typecheckTimedOut: row.typecheckTimedOut,
    buildStatus: row.buildStatus,
    buildExitCode: row.buildExitCode,
    buildTimedOut: row.buildTimedOut,
    testStatus: row.testStatus,
    testExitCode: row.testExitCode,
    testTimedOut: row.testTimedOut,
    sourceIdentityAfter: row.sourceIdentityAfter,
    sourceIntegrityUnchanged: row.sourceIntegrityUnchanged,
    cleanupStop: row.cleanupStop,
    cleanupDelete: row.cleanupDelete,
    cleanupLookup: row.cleanupLookup,
    executionOutcome: row.executionOutcome,
    verificationContract: row.verificationContract,
    baselineComparison: row.baselineComparison,
    repairObjectiveEvidence: row.repairObjectiveEvidence,
    errorPhase: row.errorPhase,
    errorCode: row.errorCode,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    durationMs: row.durationMs,
  };
}

type LoadedSubject = {
  subject: HumanReviewSubject;
  subjectIdentity: string;
  verificationEvidenceIdentity: string;
  loop: typeof repairLoop.$inferSelect;
  iteration: typeof repairLoopIteration.$inferSelect;
  generation: typeof aiCandidateGeneration.$inferSelect;
  candidate: typeof repairCandidate.$inferSelect;
  verification: typeof candidateVerification.$inferSelect;
  evidence: typeof candidateVerificationEvidence.$inferSelect;
};

type SubjectLoad = { value: LoadedSubject | null; reason: HumanReviewIneligibleReason };

function ineligible(reason: HumanReviewIneligibleReason): SubjectLoad {
  return { value: null, reason };
}

async function loadEligibleSubject(database: ReviewDatabase, workspaceId: string, repairRunId: string): Promise<SubjectLoad> {
  const [run] = await database.select().from(repairRun).where(and(eq(repairRun.id, repairRunId), eq(repairRun.workspaceId, workspaceId))).limit(1);
  if (!run) return ineligible('authority_mismatch');
  if (!run.baselineId) return ineligible('authority_mismatch');
  const [loop] = await database.select().from(repairLoop).where(and(eq(repairLoop.repairRunId, run.id), eq(repairLoop.workspaceId, workspaceId))).limit(1);
  if (!loop) return ineligible('repair_loop_not_verified');
  if (loop.state === 'review_required') return ineligible('objective_not_measured');
  if (loop.state !== 'verified' || !loop.selectedCandidateId || !loop.selectedVerificationId || !loop.selectedEvidenceId) return ineligible('repair_loop_not_verified');

  const [iterations, [candidate], [verification], [evidence]] = await Promise.all([
    database.select().from(repairLoopIteration).where(and(eq(repairLoopIteration.repairLoopId, loop.id), eq(repairLoopIteration.candidateVerificationId, loop.selectedVerificationId))).limit(2),
    database.select().from(repairCandidate).where(eq(repairCandidate.id, loop.selectedCandidateId)).limit(1),
    database.select().from(candidateVerification).where(eq(candidateVerification.id, loop.selectedVerificationId)).limit(1),
    database.select().from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, loop.selectedEvidenceId)).limit(1),
  ]);
  const iteration = iterations.length === 1 ? iterations[0] : null;
  if (!iteration || !candidate || !verification || !evidence) return ineligible('authority_mismatch');
  const [generation] = await database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, iteration.aiCandidateGenerationId)).limit(1);
  if (!generation) return ineligible('authority_mismatch');
  const [[baseline], [profile]] = await Promise.all([
    database.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, run.baselineId)).limit(1),
    database.select().from(executionProfile).where(and(eq(executionProfile.workspaceId, workspaceId), eq(executionProfile.githubRepositoryId, run.githubRepositoryId), eq(executionProfile.profileIdentity, run.profileIdentity))).limit(1),
  ]);
  if (!baseline || !profile) return ineligible('authority_mismatch');

  const exactIds = iteration.decision === 'verified' && iteration.objectiveEvidence === 'satisfied' &&
    iteration.candidateVerificationId === verification.id && generation.repairCandidateId === candidate.id &&
    candidate.id === verification.candidateId && verification.evidenceId === evidence.id &&
    evidence.verificationId === verification.id && evidence.candidateId === candidate.id;
  const authorityRows = [baseline, profile, generation, candidate, verification, evidence];
  const exactAuthority = loop.workspaceId === run.workspaceId && authorityRows.every((row) => row.workspaceId === run.workspaceId &&
    row.githubRepositoryId === run.githubRepositoryId && row.installationId === run.installationId &&
    row.baseCommitSha === run.baseCommitSha && row.profileIdentity === run.profileIdentity) &&
    generation.repairRunId === run.id && candidate.repairRunId === run.id && verification.repairRunId === run.id &&
    generation.baselineId === run.baselineId && verification.baselineId === run.baselineId && evidence.baselineId === run.baselineId &&
    generation.protocolVersion === 4 && candidate.state === 'frozen' && candidate.candidateIdentity !== null &&
    candidate.candidateIdentity === verification.candidateIdentity && candidate.candidateIdentity === evidence.candidateIdentity;
  if (!exactIds || !exactAuthority || !run.baselineId) return ineligible('authority_mismatch');
  const candidateIdentity = candidate.candidateIdentity;
  if (!candidateIdentity) return ineligible('authority_mismatch');

  let files;
  try {
    files = (await selfCheckRepairCandidateForWorkspace(database, workspaceId, candidate.id)).files;
  } catch {
    return ineligible('candidate_invalid');
  }
  if (verification.state !== 'completed' || verification.candidateArtifactIntegrity !== 'valid' ||
      verification.verificationContract !== 'checks_passed' || verification.baselineComparison !== 'previous_baseline_failure_resolved') {
    return ineligible('verification_not_passed');
  }
  if (evidence.executionOutcome !== 'checks_passed' || evidence.verificationContract !== 'checks_passed' ||
      evidence.baselineComparison !== 'previous_baseline_failure_resolved') return ineligible('evidence_invalid');
  const [attempt] = await database.select().from(candidateVerificationAttempt).where(eq(candidateVerificationAttempt.id, evidence.attemptId)).limit(1);
  if (!attempt || attempt.verificationId !== verification.id || attempt.expectedEvidenceId !== evidence.id ||
      attempt.evidenceId !== evidence.id || attempt.state !== 'succeeded') return ineligible('evidence_invalid');
  let contract;
  try {
    frozenBaselineProfile(profile);
    contract = validateStoredBaselineRecoveryContract(iteration.objectiveContractSnapshot, iteration.objectiveContractHash, iteration.objectiveContractBytes, {
      repairRunId: run.id,
      workspaceId,
      githubRepositoryId: run.githubRepositoryId,
      installationId: run.installationId,
      baselineId: run.baselineId,
      profileIdentity: run.profileIdentity,
      baseCommitSha: run.baseCommitSha,
    });
    const derived = deriveBaselineRecoveryContract({ repairRunId: run.id, baseline, profile });
    if (derived.hash !== contract.hash || derived.canonicalSnapshot !== contract.canonicalSnapshot || derived.bytes !== contract.bytes) throw new Error('objective_contract_invalid');
  } catch {
    return ineligible('objective_not_measured');
  }
  if (!contract.measurable || !iteration.objectiveEvidenceSnapshot || !iteration.objectiveEvidenceHash || !iteration.objectiveEvidenceBytes) return ineligible('objective_not_measured');
  if (!isTrustworthyBaselineRecoveryEvidence(contract, evidence) || !evidence.pristineSourceIdentity || evidence.pristineSourceIdentity !== baseline.sourceIdentityBefore) return ineligible('evidence_invalid');
  const evaluated = evaluateBaselineRecovery(contract, evidence, {
    verificationId: verification.id,
    candidateId: candidate.id,
    candidateIdentity,
    evidenceId: evidence.id,
  });
  if (evaluated.result !== 'satisfied') return ineligible('objective_not_measured');
  const expectedObjective = canonicalRecord({
    version: 'baseline_recovery_evidence_v1',
    repairRunId: run.id,
    baselineId: run.baselineId,
    profileIdentity: run.profileIdentity,
    candidateId: candidate.id,
    candidateIdentity,
    verificationId: verification.id,
    evidenceId: evidence.id,
    objectiveContractVersion: iteration.objectiveContractVersion,
    objectiveContractHash: iteration.objectiveContractHash,
    result: 'satisfied',
    evaluatedChecks: evaluated.evaluatedChecks,
  }, 16 * 1024);
  const storedObjective = canonicalRecord(iteration.objectiveEvidenceSnapshot, 16 * 1024);
  if (storedObjective.hash !== iteration.objectiveEvidenceHash || storedObjective.bytes !== iteration.objectiveEvidenceBytes ||
      storedObjective.canonical !== expectedObjective.canonical) return ineligible('evidence_invalid');

  const [[activeGeneration], [activeCandidate], [activeVerification]] = await Promise.all([
    database.select({ id: aiCandidateGeneration.id }).from(aiCandidateGeneration).where(and(eq(aiCandidateGeneration.repairRunId, run.id), inArray(aiCandidateGeneration.state, ACTIVE_GENERATION_STATES))).limit(1),
    database.select({ id: repairCandidate.id }).from(repairCandidate).where(and(eq(repairCandidate.repairRunId, run.id), eq(repairCandidate.state, 'freezing'))).limit(1),
    database.select({ id: candidateVerification.id }).from(candidateVerification).where(and(eq(candidateVerification.repairRunId, run.id), ne(candidateVerification.id, verification.id), inArray(candidateVerification.state, ACTIVE_VERIFICATION_STATES))).limit(1),
  ]);
  if (activeGeneration || activeCandidate || activeVerification) return ineligible('active_conflict');

  const verificationEvidenceIdentity = computeVerificationEvidenceIdentity(evidenceIdentityInput(evidence, attempt));
  const subjectIdentity = computeHumanReviewSubjectIdentity({
    version: HUMAN_REVIEW_VERSION,
    workspaceId,
    repairRunId: run.id,
    repairLoopId: loop.id,
    repairLoopIterationId: iteration.id,
    aiCandidateGenerationId: generation.id,
    repairCandidateId: candidate.id,
    candidateIdentity,
    candidateVerificationId: verification.id,
    verificationEvidenceId: evidence.id,
    githubRepositoryId: run.githubRepositoryId,
    installationId: run.installationId,
    baselineId: run.baselineId,
    baseCommitSha: run.baseCommitSha,
    profileIdentity: run.profileIdentity,
    objectiveContractHash: iteration.objectiveContractHash,
    objectiveEvidenceHash: iteration.objectiveEvidenceHash!,
    verificationEvidenceIdentity,
  });
  return {
    reason: 'authority_mismatch',
    value: {
      subjectIdentity,
      verificationEvidenceIdentity,
      loop,
      iteration,
      generation,
      candidate,
      verification,
      evidence,
      subject: {
        authority: {
          workspaceId,
          repairRunId: run.id,
          repairLoopId: loop.id,
          repairLoopIterationId: iteration.id,
          aiCandidateGenerationId: generation.id,
          githubRepositoryId: run.githubRepositoryId,
          installationId: run.installationId,
          baselineId: run.baselineId,
          baseCommitSha: run.baseCommitSha,
          profileIdentity: run.profileIdentity,
        },
        candidate: { id: candidate.id, identity: candidateIdentity, files },
        verification: {
          id: verification.id,
          evidenceId: evidence.id,
          state: verification.state,
          verificationContract: verification.verificationContract,
          baselineComparison: verification.baselineComparison,
          executionOutcome: evidence.executionOutcome,
          networkIsolation: 'confirmed',
          cleanup: 'confirmed',
          phases: {
            install: { status: evidence.installStatus, exitCode: evidence.installExitCode, timedOut: evidence.installTimedOut },
            typecheck: { status: evidence.typecheckStatus, exitCode: evidence.typecheckExitCode, timedOut: evidence.typecheckTimedOut },
            build: { status: evidence.buildStatus, exitCode: evidence.buildExitCode, timedOut: evidence.buildTimedOut },
            test: { status: evidence.testStatus, exitCode: evidence.testExitCode, timedOut: evidence.testTimedOut },
          },
        },
        objective: {
          contractVersion: iteration.objectiveContractVersion,
          contractHash: iteration.objectiveContractHash,
          evidenceHash: iteration.objectiveEvidenceHash,
          measurable: true,
          result: 'satisfied',
          evaluatedChecks: evaluated.evaluatedChecks,
        },
      },
    },
  };
}

async function safeHistory(database: ReviewDatabase, loopId: string): Promise<HumanReviewResult['history']> {
  const iterations = await database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loopId)).orderBy(desc(repairLoopIteration.createdAt)).limit(HISTORY_LIMIT + 1);
  const generationIds = iterations.map((row) => row.aiCandidateGenerationId);
  const verificationIds = iterations.flatMap((row) => row.candidateVerificationId ? [row.candidateVerificationId] : []);
  const generationAttempts = generationIds.length === 0 ? [] : await database.select().from(aiCandidateGenerationAttempt).where(inArray(aiCandidateGenerationAttempt.generationId, generationIds)).orderBy(desc(aiCandidateGenerationAttempt.claimedAt)).limit(HISTORY_LIMIT + 1);
  const verificationAttempts = verificationIds.length === 0 ? [] : await database.select().from(candidateVerificationAttempt).where(inArray(candidateVerificationAttempt.verificationId, verificationIds)).orderBy(desc(candidateVerificationAttempt.claimedAt)).limit(HISTORY_LIMIT + 1);
  const items: HumanReviewHistoryItem[] = [
    ...iterations.map((row) => ({ kind: 'repair_loop_iteration' as const, id: row.id, state: row.decision ?? 'pending', ordinal: row.ordinal, createdAt: row.createdAt, failureCode: row.failureCode })),
    ...generationAttempts.map((row) => ({ kind: 'ai_candidate_generation_attempt' as const, id: row.id, state: row.state, ordinal: row.attemptNumber, createdAt: row.claimedAt, failureCode: row.failureCode })),
    ...verificationAttempts.map((row) => ({ kind: 'candidate_verification_attempt' as const, id: row.id, state: row.state, ordinal: row.attemptNumber, createdAt: row.claimedAt, failureCode: row.failureCode })),
  ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  return { items: items.slice(0, HISTORY_LIMIT), truncated: items.length > HISTORY_LIMIT };
}

export async function getHumanReview(database: VigiloDatabase, context: AuthenticatedWorkspace, repairRunId: string): Promise<HumanReviewResult> {
  const [loop] = await database.select().from(repairLoop).where(and(eq(repairLoop.repairRunId, repairRunId), eq(repairLoop.workspaceId, context.workspace.id))).limit(1);
  if (!loop) return { repairRunId, status: 'ineligible', ineligibleReason: 'repair_loop_not_verified', reviewSubjectIdentity: null, liveAcceptanceStatus: TASK_4_3_LIVE_ACCEPTANCE_STATUS, subject: null, decision: null, history: { items: [], truncated: false } };
  const [decision] = await database.select().from(humanReviewDecision).where(and(eq(humanReviewDecision.repairLoopId, loop.id), eq(humanReviewDecision.workspaceId, context.workspace.id))).limit(1);
  const loaded = await loadEligibleSubject(database, context.workspace.id, repairRunId);
  const history = await safeHistory(database, loop.id);
  if (!loaded.value) return { repairRunId, status: 'ineligible', ineligibleReason: loaded.reason, reviewSubjectIdentity: null, liveAcceptanceStatus: TASK_4_3_LIVE_ACCEPTANCE_STATUS, subject: null, decision: decision ? publicDecision(decision) : null, history };
  return {
    repairRunId,
    status: decision ? 'decided' : 'awaiting_decision',
    ineligibleReason: null,
    reviewSubjectIdentity: loaded.value.subjectIdentity,
    liveAcceptanceStatus: TASK_4_3_LIVE_ACCEPTANCE_STATUS,
    subject: loaded.value.subject,
    decision: decision ? publicDecision(decision) : null,
    history,
  };
}

export async function createHumanReviewDecision(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  repairRunId: string,
  input: { decision: HumanReviewDecision; reviewSubjectIdentity: string; idempotencyKey: string },
  options: { randomId?: () => string; clock?: () => Date } = {},
): Promise<HumanReviewDecisionResult> {
  if (!['approved', 'rejected'].includes(input.decision)) throw new HumanReviewError('invalid_decision');
  if (!UUID.test(input.idempotencyKey)) throw new HumanReviewError('invalid_idempotency_key');
  if (!UUID.test(repairRunId)) throw new HumanReviewError('human_review_not_found');
  if (!HASH.test(input.reviewSubjectIdentity)) throw new HumanReviewError('review_subject_stale');
  const randomId = options.randomId ?? randomUUID;
  const now = (options.clock ?? (() => new Date()))();
  try {
    const created = await database.transaction(async (transaction) => {
      const [run] = await transaction.select({ id: repairRun.id }).from(repairRun).where(and(eq(repairRun.id, repairRunId), eq(repairRun.workspaceId, context.workspace.id))).for('update').limit(1);
      if (!run) throw new HumanReviewError('human_review_not_found');
      const [byKey] = await transaction.select().from(humanReviewDecision).where(and(eq(humanReviewDecision.workspaceId, context.workspace.id), eq(humanReviewDecision.idempotencyKey, input.idempotencyKey))).limit(1);
      if (byKey) {
        if (byKey.reviewerUserId === context.user.id && byKey.repairRunId === repairRunId && byKey.reviewSubjectIdentity === input.reviewSubjectIdentity && byKey.decision === input.decision) return byKey;
        throw new HumanReviewError('idempotency_conflict');
      }
      const loaded = await loadEligibleSubject(transaction as unknown as VigiloDatabase, context.workspace.id, repairRunId);
      if (!loaded.value) throw new HumanReviewError('human_review_ineligible');
      if (loaded.value.subjectIdentity !== input.reviewSubjectIdentity) throw new HumanReviewError('review_subject_stale');
      const [[lockedLoop], [lockedIteration]] = await Promise.all([
        transaction.select({ id: repairLoop.id }).from(repairLoop).where(eq(repairLoop.id, loaded.value.loop.id)).for('update').limit(1),
        transaction.select({ id: repairLoopIteration.id }).from(repairLoopIteration).where(eq(repairLoopIteration.id, loaded.value.iteration.id)).for('update').limit(1),
      ]);
      if (!lockedLoop || !lockedIteration) throw new HumanReviewError('human_review_ineligible');
      const [existing] = await transaction.select().from(humanReviewDecision).where(eq(humanReviewDecision.repairLoopId, loaded.value.loop.id)).limit(1);
      if (existing) throw new HumanReviewError('decision_conflict');
      const decisionIdentity = computeHumanReviewDecisionIdentity({ subjectIdentity: loaded.value.subjectIdentity, reviewerUserId: context.user.id, decision: input.decision });
      const [decision] = await transaction.insert(humanReviewDecision).values({
        id: randomId(),
        version: HUMAN_REVIEW_VERSION,
        workspaceId: context.workspace.id,
        reviewerUserId: context.user.id,
        repairRunId,
        repairLoopId: loaded.value.loop.id,
        repairLoopIterationId: loaded.value.iteration.id,
        aiCandidateGenerationId: loaded.value.generation.id,
        repairCandidateId: loaded.value.candidate.id,
        candidateIdentity: loaded.value.candidate.candidateIdentity!,
        candidateVerificationId: loaded.value.verification.id,
        verificationEvidenceId: loaded.value.evidence.id,
        githubRepositoryId: loaded.value.candidate.githubRepositoryId,
        installationId: loaded.value.candidate.installationId,
        baselineId: loaded.value.verification.baselineId,
        baseCommitSha: loaded.value.candidate.baseCommitSha,
        profileIdentity: loaded.value.candidate.profileIdentity,
        objectiveContractHash: loaded.value.iteration.objectiveContractHash,
        objectiveEvidenceHash: loaded.value.iteration.objectiveEvidenceHash!,
        verificationEvidenceIdentity: loaded.value.verificationEvidenceIdentity,
        reviewSubjectIdentity: loaded.value.subjectIdentity,
        decision: input.decision,
        decisionIdentity,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      }).returning();
      if (!decision) throw new HumanReviewError('decision_conflict');
      return decision;
    });
    return publicDecision(created);
  } catch (error) {
    if (error instanceof HumanReviewError) throw error;
    const [byKey] = await database.select().from(humanReviewDecision).where(and(eq(humanReviewDecision.workspaceId, context.workspace.id), eq(humanReviewDecision.idempotencyKey, input.idempotencyKey))).limit(1);
    if (byKey && byKey.reviewerUserId === context.user.id && byKey.repairRunId === repairRunId && byKey.reviewSubjectIdentity === input.reviewSubjectIdentity && byKey.decision === input.decision) return publicDecision(byKey);
    if (byKey) throw new HumanReviewError('idempotency_conflict');
    const [existing] = await database.select().from(humanReviewDecision).innerJoin(repairLoop, eq(repairLoop.id, humanReviewDecision.repairLoopId)).where(and(eq(repairLoop.repairRunId, repairRunId), eq(humanReviewDecision.workspaceId, context.workspace.id))).limit(1);
    if (existing) throw new HumanReviewError('decision_conflict');
    throw error;
  }
}

export async function resolveApprovedHumanReviewAuthority(
  database: VigiloDatabase,
  workspaceId: string,
  decisionId: string,
): Promise<ApprovedHumanReviewAuthority> {
  const [decision] = await database.select().from(humanReviewDecision).where(and(eq(humanReviewDecision.id, decisionId), eq(humanReviewDecision.workspaceId, workspaceId))).limit(1);
  if (!decision) throw new HumanReviewError('human_review_not_found');
  if (decision.decision !== 'approved') throw new HumanReviewError('decision_not_approved');
  const loaded = await loadEligibleSubject(database, workspaceId, decision.repairRunId);
  if (!loaded.value) throw new HumanReviewError('human_review_ineligible');
  const expectedDecisionIdentity = computeHumanReviewDecisionIdentity({ subjectIdentity: loaded.value.subjectIdentity, reviewerUserId: decision.reviewerUserId, decision: 'approved' });
  const exact = decision.repairLoopId === loaded.value.loop.id && decision.repairLoopIterationId === loaded.value.iteration.id &&
    decision.aiCandidateGenerationId === loaded.value.generation.id && decision.repairCandidateId === loaded.value.candidate.id &&
    decision.candidateIdentity === loaded.value.candidate.candidateIdentity && decision.candidateVerificationId === loaded.value.verification.id &&
    decision.verificationEvidenceId === loaded.value.evidence.id && decision.reviewSubjectIdentity === loaded.value.subjectIdentity &&
    decision.verificationEvidenceIdentity === loaded.value.verificationEvidenceIdentity && decision.objectiveContractHash === loaded.value.iteration.objectiveContractHash &&
    decision.objectiveEvidenceHash === loaded.value.iteration.objectiveEvidenceHash &&
    decision.workspaceId === loaded.value.subject.authority.workspaceId && decision.repairRunId === loaded.value.subject.authority.repairRunId &&
    decision.githubRepositoryId === loaded.value.subject.authority.githubRepositoryId && decision.installationId === loaded.value.subject.authority.installationId &&
    decision.baselineId === loaded.value.subject.authority.baselineId && decision.baseCommitSha === loaded.value.subject.authority.baseCommitSha &&
    decision.profileIdentity === loaded.value.subject.authority.profileIdentity && decision.decisionIdentity === expectedDecisionIdentity;
  if (!exact) throw new HumanReviewError('human_review_ineligible');
  return {
    humanReviewDecisionId: decision.id,
    humanReviewDecisionIdentity: decision.decisionIdentity,
    repairRunId: decision.repairRunId,
    repairLoopId: decision.repairLoopId,
    repairLoopIterationId: decision.repairLoopIterationId,
    aiCandidateGenerationId: decision.aiCandidateGenerationId,
    repairCandidateId: decision.repairCandidateId,
    candidateIdentity: decision.candidateIdentity,
    candidateVerificationId: decision.candidateVerificationId,
    verificationEvidenceId: decision.verificationEvidenceId,
    verificationEvidenceIdentity: decision.verificationEvidenceIdentity,
    reviewSubjectIdentity: decision.reviewSubjectIdentity,
    workspaceId: decision.workspaceId,
    reviewerUserId: decision.reviewerUserId,
    githubRepositoryId: decision.githubRepositoryId,
    installationId: decision.installationId,
    baselineId: decision.baselineId,
    baseCommitSha: decision.baseCommitSha,
    profileIdentity: decision.profileIdentity,
    objectiveContractHash: decision.objectiveContractHash,
    objectiveEvidenceHash: decision.objectiveEvidenceHash,
  };
}

function assertTask43LiveAcceptanceReleaseGate(): never {
  throw new HumanReviewError('live_acceptance_pending');
}

export async function resolveApprovedPublicationAuthority(
  database: VigiloDatabase,
  workspaceId: string,
  decisionId: string,
): Promise<ApprovedHumanReviewAuthority> {
  const authority = await resolveApprovedHumanReviewAuthority(database, workspaceId, decisionId);
  assertTask43LiveAcceptanceReleaseGate();
  return authority;
}
