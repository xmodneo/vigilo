import { and, eq, inArray } from 'drizzle-orm';

import {
  aiCandidateGeneration,
  candidateVerification,
  candidateVerificationAttempt,
  candidateVerificationEvidence,
  executionBudgetGrant,
  externalExecutionLease,
  externalExecutionReservation,
  humanReviewDecision,
  releaseAcceptance,
  releaseAcceptanceRevocation,
  repairCandidate,
  repairLoop,
  repairLoopIteration,
  repairPublication,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { evidenceIdentityInput } from '../human-reviews/flow.ts';
import { computeVerificationEvidenceIdentity } from '../human-reviews/identity.ts';
import { computeReleaseAcceptanceIdentity, executionGrantIdentityMatches, executionReservationIdentityMatches } from '../external-execution/identity.ts';

export type AcceptanceFailureCode = 'acceptance_missing' | 'acceptance_revoked' | 'acceptance_boundary_mismatch';
export type ReleaseAcceptanceKind = 'repair_loop_live' | 'human_review_live' | 'draft_publication_live' | 'security_cost_control';

export class ReleaseAcceptanceError extends Error {
  constructor(public readonly code: AcceptanceFailureCode) {
    super(code);
    this.name = 'ReleaseAcceptanceError';
  }
}

export interface ReleaseBoundary {
  kind: ReleaseAcceptanceKind;
  workspaceId: string;
  releasedCommitSha: string;
  boundaryVersion: string;
  protocolVersion?: number;
  providerId?: string;
  modelId?: string;
}

export function acceptanceIdentityPayload(row: typeof releaseAcceptance.$inferSelect): Record<string, unknown> {
  return {
    kind: row.kind,
    state: row.state,
    boundaryVersion: row.boundaryVersion,
    releasedCommitSha: row.releasedCommitSha,
    protocolVersion: row.protocolVersion,
    workspaceId: row.workspaceId,
    repairRunId: row.repairRunId,
    repairLoopId: row.repairLoopId,
    repairLoopIterationId: row.repairLoopIterationId,
    aiCandidateGenerationId: row.aiCandidateGenerationId,
    repairCandidateId: row.repairCandidateId,
    candidateIdentity: row.candidateIdentity,
    candidateVerificationId: row.candidateVerificationId,
    verificationEvidenceId: row.verificationEvidenceId,
    verificationEvidenceIdentity: row.verificationEvidenceIdentity,
    objectiveContractHash: row.objectiveContractHash,
    objectiveEvidenceHash: row.objectiveEvidenceHash,
    humanReviewDecisionId: row.humanReviewDecisionId,
    repairPublicationId: row.repairPublicationId,
    providerId: row.providerId,
    modelId: row.modelId,
    sandboxExecutionIdentity: row.sandboxExecutionIdentity,
    executionBudgetGrantId: row.executionBudgetGrantId,
    executionReservationIds: row.executionReservationIds,
    reviewedBy: row.reviewedBy,
    acceptedAt: row.acceptedAt.toISOString(),
  };
}

async function verifyRepairLoopEvidence(database: VigiloDatabase, row: typeof releaseAcceptance.$inferSelect): Promise<boolean> {
  if (!row.repairLoopId || !row.repairLoopIterationId || !row.aiCandidateGenerationId || !row.repairCandidateId ||
      !row.candidateVerificationId || !row.verificationEvidenceId || !row.candidateIdentity ||
      !row.verificationEvidenceIdentity || !row.objectiveContractHash || !row.objectiveEvidenceHash ||
      !row.executionBudgetGrantId || !row.providerId || !row.modelId || !row.sandboxExecutionIdentity) return false;
  const [[loop], [iteration], [generation], [candidate], [verification], [evidence], [grant]] = await Promise.all([
    database.select().from(repairLoop).where(eq(repairLoop.id, row.repairLoopId)).limit(1),
    database.select().from(repairLoopIteration).where(eq(repairLoopIteration.id, row.repairLoopIterationId)).limit(1),
    database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, row.aiCandidateGenerationId)).limit(1),
    database.select().from(repairCandidate).where(eq(repairCandidate.id, row.repairCandidateId)).limit(1),
    database.select().from(candidateVerification).where(eq(candidateVerification.id, row.candidateVerificationId)).limit(1),
    database.select().from(candidateVerificationEvidence).where(eq(candidateVerificationEvidence.id, row.verificationEvidenceId)).limit(1),
    database.select().from(executionBudgetGrant).where(eq(executionBudgetGrant.id, row.executionBudgetGrantId)).limit(1),
  ]);
  if (!loop || !iteration || !generation || !candidate || !verification || !evidence || !grant) return false;
  const [attempt] = await database.select().from(candidateVerificationAttempt).where(eq(candidateVerificationAttempt.id, evidence.attemptId)).limit(1);
  if (!attempt) return false;
  const reservationIds = Array.isArray(row.executionReservationIds) ? row.executionReservationIds : [];
  const boundReservations = reservationIds.length === 0 ? [] : await database.select().from(externalExecutionReservation)
    .where(inArray(externalExecutionReservation.id, reservationIds));
  const boundLeases = reservationIds.length === 0 ? [] : await database.select().from(externalExecutionLease)
    .where(inArray(externalExecutionLease.reservationId, reservationIds));
  const allRunReservations = await database.select({ id: externalExecutionReservation.id }).from(externalExecutionReservation)
    .where(and(eq(externalExecutionReservation.workspaceId, row.workspaceId), eq(externalExecutionReservation.repairRunId, row.repairRunId!)));
  const sandboxIdentity = computeReleaseAcceptanceIdentity({
    sandboxName: evidence.sandboxName,
    sandboxSessionId: evidence.sandboxSessionId,
    verificationId: verification.id,
    evidenceId: evidence.id,
  });
  return loop.state === 'verified' && loop.workspaceId === row.workspaceId && loop.id === iteration.repairLoopId &&
    loop.selectedCandidateId === candidate.id && loop.selectedVerificationId === verification.id && loop.selectedEvidenceId === evidence.id &&
    iteration.decision === 'verified' && iteration.aiCandidateGenerationId === generation.id && iteration.candidateVerificationId === verification.id &&
    iteration.objectiveContractHash === row.objectiveContractHash && iteration.objectiveEvidenceHash === row.objectiveEvidenceHash &&
    generation.repairCandidateId === candidate.id && generation.providerId === row.providerId && generation.modelId === row.modelId &&
    generation.protocolVersion === row.protocolVersion && candidate.candidateIdentity === row.candidateIdentity &&
    verification.candidateIdentity === row.candidateIdentity && verification.evidenceId === evidence.id &&
    computeVerificationEvidenceIdentity(evidenceIdentityInput(evidence, attempt)) === row.verificationEvidenceIdentity &&
    sandboxIdentity === row.sandboxExecutionIdentity && executionGrantIdentityMatches(grant) &&
    boundReservations.length === reservationIds.length && boundLeases.length === reservationIds.length &&
    new Set(reservationIds).size === reservationIds.length &&
    allRunReservations.length === reservationIds.length && allRunReservations.every(({ id }) => reservationIds.includes(id)) &&
    grant.scope === 'account' && boundReservations.every((reservation) => reservation.workspaceId === row.workspaceId &&
      reservation.repairRunId === row.repairRunId && reservation.githubRepositoryId === generation.githubRepositoryId &&
      reservation.baseCommitSha === generation.baseCommitSha && reservation.accountGrantId === grant.id && executionReservationIdentityMatches(reservation)) &&
    boundLeases.every((lease) => lease.state === 'succeeded');
}

async function verifyHumanReviewEvidence(database: VigiloDatabase, row: typeof releaseAcceptance.$inferSelect): Promise<boolean> {
  if (!row.humanReviewDecisionId || !row.repairRunId || !row.repairCandidateId || !row.candidateVerificationId) return false;
  const [decision] = await database.select().from(humanReviewDecision)
    .where(eq(humanReviewDecision.id, row.humanReviewDecisionId)).limit(1);
  return Boolean(decision && decision.decision === 'approved' && decision.workspaceId === row.workspaceId && decision.repairRunId === row.repairRunId &&
    decision.repairCandidateId === row.repairCandidateId && decision.candidateVerificationId === row.candidateVerificationId &&
    (row.candidateIdentity === null || decision.candidateIdentity === row.candidateIdentity) &&
    (row.verificationEvidenceId === null || decision.verificationEvidenceId === row.verificationEvidenceId));
}

async function verifyDraftPublicationEvidence(database: VigiloDatabase, row: typeof releaseAcceptance.$inferSelect): Promise<boolean> {
  if (!row.repairPublicationId || !row.humanReviewDecisionId) return false;
  const [publication] = await database.select().from(repairPublication)
    .where(eq(repairPublication.id, row.repairPublicationId)).limit(1);
  return Boolean(publication && publication.state === 'published' && publication.workspaceId === row.workspaceId &&
    publication.humanReviewDecisionId === row.humanReviewDecisionId &&
    (row.repairRunId === null || publication.repairRunId === row.repairRunId) &&
    (row.repairCandidateId === null || publication.repairCandidateId === row.repairCandidateId) &&
    (row.candidateVerificationId === null || publication.candidateVerificationId === row.candidateVerificationId));
}

async function verifySecurityCostEvidence(database: VigiloDatabase, row: typeof releaseAcceptance.$inferSelect): Promise<boolean> {
  if (!row.executionBudgetGrantId) return false;
  const [grant] = await database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.id, row.executionBudgetGrantId)).limit(1);
  if (!grant || (grant.workspaceId !== null && grant.workspaceId !== row.workspaceId)) return false;
  if (!executionGrantIdentityMatches(grant)) return false;
  const reservationIds = Array.isArray(row.executionReservationIds) ? row.executionReservationIds : [];
  const reservations = reservationIds.length === 0 ? [] : await database.select().from(externalExecutionReservation)
    .where(inArray(externalExecutionReservation.id, reservationIds));
  const leases = reservationIds.length === 0 ? [] : await database.select().from(externalExecutionLease)
    .where(inArray(externalExecutionLease.reservationId, reservationIds));
  return reservations.length === reservationIds.length &&
    leases.length === reservationIds.length && leases.every((lease) => lease.state !== 'active') &&
    reservations.every((reservation) => (grant.scope === 'account' ? reservation.accountGrantId : reservation.grantId) === grant.id && reservation.workspaceId === row.workspaceId && executionReservationIdentityMatches(reservation));
}

export async function resolveReleaseAcceptance(database: VigiloDatabase, boundary: ReleaseBoundary) {
  const rows = await database.select().from(releaseAcceptance).where(and(
    eq(releaseAcceptance.kind, boundary.kind),
    eq(releaseAcceptance.workspaceId, boundary.workspaceId),
  ));
  const matching = rows.filter((row) => row.releasedCommitSha === boundary.releasedCommitSha &&
    row.boundaryVersion === boundary.boundaryVersion && row.protocolVersion === (boundary.protocolVersion ?? null) &&
    row.providerId === (boundary.providerId ?? null) && row.modelId === (boundary.modelId ?? null));
  const passed = matching.filter((row) => row.state === 'passed');
  if (passed.length === 0) throw new ReleaseAcceptanceError('acceptance_missing');
  if (passed.length !== 1) throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  const row = passed[0]!;
  const [revocation] = await database.select({ id: releaseAcceptanceRevocation.id }).from(releaseAcceptanceRevocation)
    .where(eq(releaseAcceptanceRevocation.acceptanceId, row.id)).limit(1);
  if (revocation) throw new ReleaseAcceptanceError('acceptance_revoked');
  if (row.acceptanceIdentity !== computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(row))) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }
  if (row.kind === 'repair_loop_live' && !(await verifyRepairLoopEvidence(database, row))) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }
  if (row.kind === 'human_review_live' && !(await verifyHumanReviewEvidence(database, row))) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }
  if (row.kind === 'draft_publication_live' && !(await verifyDraftPublicationEvidence(database, row))) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }
  if (row.kind === 'security_cost_control' && !(await verifySecurityCostEvidence(database, row))) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }
  return row;
}
