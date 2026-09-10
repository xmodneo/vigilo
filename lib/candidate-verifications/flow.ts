import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  candidateVerification,
  candidateVerificationEvidence,
  candidateVerificationEvent,
  executionProfile,
  investigation,
  repairCandidate,
  repairRun,
  repositoryBaseline,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { selfCheckRepairCandidate } from '../repair-candidates/flow.ts';
import { frozenBaselineProfile } from '../repository-baselines/authority.ts';
import {
  CANDIDATE_VERIFICATION_JOB_VERSION,
  type TransactionalCandidateVerificationQueue,
} from '../repair-runs/queue.ts';
import type { CandidateVerificationResult } from './types.ts';
import { trustworthyComparableBaseline } from './classification.ts';

export class CandidateVerificationError extends Error {
  constructor(public readonly code:
    | 'candidate_not_found'
    | 'candidate_not_frozen'
    | 'candidate_artifact_invalid'
    | 'verification_authority_mismatch'
    | 'verification_handoff_failed'
    | 'verification_not_found') {
    super(code);
    this.name = 'CandidateVerificationError';
  }
}

type VerificationRow = typeof candidateVerification.$inferSelect;
type EvidenceRow = typeof candidateVerificationEvidence.$inferSelect;
const ACTIVE_STATES = ['created', 'queued', 'verifying'] as const;

function failingPhase(evidence?: EvidenceRow): CandidateVerificationResult['failingPhase'] {
  return evidence?.errorPhase === 'typecheck' || evidence?.errorPhase === 'build' || evidence?.errorPhase === 'test'
    ? evidence.errorPhase
    : null;
}

export function candidateVerificationResult(row: VerificationRow, evidence?: EvidenceRow): CandidateVerificationResult {
  return {
    id: row.id,
    candidateId: row.candidateId,
    investigationId: row.investigationId,
    repairRunId: row.repairRunId,
    baselineId: row.baselineId,
    workspaceId: row.workspaceId,
    githubRepositoryId: row.githubRepositoryId,
    installationId: row.installationId,
    baseCommitSha: row.baseCommitSha,
    profileIdentity: row.profileIdentity,
    candidateIdentity: row.candidateIdentity,
    formatVersion: 1,
    state: row.state as CandidateVerificationResult['state'],
    candidateArtifactIntegrity: row.candidateArtifactIntegrity as CandidateVerificationResult['candidateArtifactIntegrity'],
    verificationContract: row.verificationContract as CandidateVerificationResult['verificationContract'],
    baselineComparison: row.baselineComparison as CandidateVerificationResult['baselineComparison'],
    repairObjectiveEvidence: 'not_measured',
    evidenceId: row.evidenceId,
    executionOutcome: evidence?.executionOutcome as CandidateVerificationResult['executionOutcome'] ?? null,
    failingPhase: failingPhase(evidence),
    networkIsolation: evidence?.networkPolicy === 'deny-all' ? 'confirmed' : 'unconfirmed',
    cleanup: evidence?.cleanupStop === 'confirmed' && evidence.cleanupDelete === 'confirmed' && evidence.cleanupLookup === 'absent'
      ? 'confirmed'
      : 'unconfirmed',
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
    verificationStartedAt: row.verificationStartedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

function sameAuthority(
  candidate: typeof repairCandidate.$inferSelect,
  current: typeof investigation.$inferSelect,
  run: typeof repairRun.$inferSelect,
  baseline: typeof repositoryBaseline.$inferSelect,
): boolean {
  const values = [candidate, current, run, baseline];
  return candidate.investigationId === current.id && candidate.repairRunId === run.id && current.repairRunId === run.id &&
    current.baselineId === baseline.id && run.baselineId === baseline.id &&
    values.every((value) => value.workspaceId === candidate.workspaceId &&
      value.githubRepositoryId === candidate.githubRepositoryId && value.installationId === candidate.installationId &&
      value.baseCommitSha === candidate.baseCommitSha && value.profileIdentity === candidate.profileIdentity) &&
    trustworthyComparableBaseline(baseline);
}

export async function startCandidateVerification(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  candidateId: string,
  queue: TransactionalCandidateVerificationQueue,
  options: { clock?: () => Date; randomId?: () => string; reverify?: boolean } = {},
): Promise<CandidateVerificationResult> {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const [candidate] = await database.select().from(repairCandidate).where(and(
    eq(repairCandidate.id, candidateId), eq(repairCandidate.workspaceId, context.workspace.id),
  )).limit(1);
  if (!candidate) throw new CandidateVerificationError('candidate_not_found');
  if (candidate.state !== 'frozen' || !candidate.candidateIdentity) throw new CandidateVerificationError('candidate_not_frozen');
  const candidateIdentity = candidate.candidateIdentity;
  try { await selfCheckRepairCandidate(database, context, candidate.id); }
  catch { throw new CandidateVerificationError('candidate_artifact_invalid'); }

  const [[current], [run], [baseline], [profile]] = await Promise.all([
    database.select().from(investigation).where(eq(investigation.id, candidate.investigationId)).limit(1),
    database.select().from(repairRun).where(eq(repairRun.id, candidate.repairRunId)).limit(1),
    database.select().from(repositoryBaseline).innerJoin(repairRun, eq(repairRun.baselineId, repositoryBaseline.id)).where(eq(repairRun.id, candidate.repairRunId)).limit(1).then((rows) => rows.map((row) => row.repository_baseline)),
    database.select().from(executionProfile).where(and(eq(executionProfile.githubRepositoryId, candidate.githubRepositoryId), eq(executionProfile.profileIdentity, candidate.profileIdentity))).limit(1),
  ]);
  if (!current || !run || !baseline || !profile || !sameAuthority(candidate, current, run, baseline)) throw new CandidateVerificationError('verification_authority_mismatch');
  try {
    const frozen = frozenBaselineProfile(profile);
    if (frozen.baseCommitSha !== candidate.baseCommitSha || frozen.installationId !== candidate.installationId || frozen.workspaceId !== candidate.workspaceId) throw new Error('mismatch');
  } catch { throw new CandidateVerificationError('verification_authority_mismatch'); }

  const now = clock();
  try {
    return await database.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(candidateVerification).where(
        options.reverify
          ? and(eq(candidateVerification.candidateId, candidate.id), inArray(candidateVerification.state, ACTIVE_STATES))
          : eq(candidateVerification.candidateId, candidate.id),
      ).orderBy(desc(candidateVerification.createdAt), desc(candidateVerification.id)).limit(1);
      if (existing) return candidateVerificationResult(existing);
      const id = randomId();
      const [created] = await transaction.insert(candidateVerification).values({
        id, candidateId: candidate.id, investigationId: candidate.investigationId, repairRunId: candidate.repairRunId,
        baselineId: baseline.id, workspaceId: candidate.workspaceId, githubRepositoryId: candidate.githubRepositoryId,
        installationId: candidate.installationId, baseCommitSha: candidate.baseCommitSha,
        profileIdentity: candidate.profileIdentity, candidateIdentity,
        formatVersion: 1, state: 'queued', createdAt: now, queuedAt: now, updatedAt: now,
      }).returning();
      if (!created) throw new CandidateVerificationError('verification_handoff_failed');
      await transaction.insert(candidateVerificationEvent).values([
        { id: randomId(), verificationId: id, workspaceId: candidate.workspaceId, fromState: null, toState: 'created', createdAt: now },
        { id: randomId(), verificationId: id, workspaceId: candidate.workspaceId, fromState: 'created', toState: 'queued', createdAt: now },
      ]);
      const jobId = await queue.enqueueVerification(transaction, { version: CANDIDATE_VERIFICATION_JOB_VERSION, verificationId: id });
      if (jobId !== id) throw new CandidateVerificationError('verification_handoff_failed');
      return candidateVerificationResult(created);
    });
  } catch (error) {
    if (error instanceof CandidateVerificationError) throw error;
    const [existing] = await database.select().from(candidateVerification).where(eq(candidateVerification.candidateId, candidate.id)).orderBy(desc(candidateVerification.createdAt), desc(candidateVerification.id)).limit(1);
    if (existing) return candidateVerificationResult(existing);
    throw new CandidateVerificationError('verification_handoff_failed');
  }
}

export async function getCandidateVerification(database: VigiloDatabase, context: AuthenticatedWorkspace, verificationId: string): Promise<CandidateVerificationResult | null> {
  const [row] = await database.select().from(candidateVerification).where(and(eq(candidateVerification.id, verificationId), eq(candidateVerification.workspaceId, context.workspace.id))).limit(1);
  if (!row) return null;
  const [evidence] = row.evidenceId
    ? await database.select().from(candidateVerificationEvidence).where(and(eq(candidateVerificationEvidence.id, row.evidenceId), eq(candidateVerificationEvidence.workspaceId, context.workspace.id))).limit(1)
    : [];
  return candidateVerificationResult(row, evidence);
}

export async function getCandidateVerificationForCandidate(database: VigiloDatabase, context: AuthenticatedWorkspace, candidateId: string): Promise<CandidateVerificationResult | null> {
  const [row] = await database.select().from(candidateVerification).where(and(eq(candidateVerification.candidateId, candidateId), eq(candidateVerification.workspaceId, context.workspace.id))).orderBy(desc(candidateVerification.createdAt), desc(candidateVerification.id)).limit(1);
  if (!row) return null;
  const [evidence] = row.evidenceId
    ? await database.select().from(candidateVerificationEvidence).where(and(eq(candidateVerificationEvidence.id, row.evidenceId), eq(candidateVerificationEvidence.workspaceId, context.workspace.id))).limit(1)
    : [];
  return candidateVerificationResult(row, evidence);
}
