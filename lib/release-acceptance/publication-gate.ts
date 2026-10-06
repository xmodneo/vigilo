import { and, eq, inArray } from 'drizzle-orm';

import {
  account,
  executionBudgetGrant,
  executionBudgetGrantRevocation,
  externalExecutionLease,
  externalExecutionReservation,
  humanReviewDecision,
  releaseAcceptance,
  user,
  workspace,
} from '../../db/schema.ts';
import { AI_MODEL_ID, AI_PROVIDER_ID } from '../ai-investigations/types.ts';
import { REPAIR_LOOP_AI_CANDIDATE_GENERATION_PROTOCOL_VERSION } from '../ai-candidate-generations/types.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { executionGrantIdentityMatches, executionReservationIdentityMatches } from '../external-execution/identity.ts';
import type { ApprovedHumanReviewAuthority } from '../human-reviews/types.ts';
import { canonicalRecord } from '../repair-loops/canonical.ts';
import { ReleaseAcceptanceError, resolveReleaseAcceptance, verifyAcceptanceExecutionAudit } from './resolver.ts';

export const PUBLICATION_ACCEPTANCE_BOUNDARIES = Object.freeze({
  repair_loop_live: Object.freeze({
    boundaryVersion: 'repair-loop-live-v1',
    protocolVersion: REPAIR_LOOP_AI_CANDIDATE_GENERATION_PROTOCOL_VERSION,
    providerId: AI_PROVIDER_ID,
    modelId: AI_MODEL_ID,
  }),
  human_review_live: Object.freeze({ boundaryVersion: 'human-review-v1' }),
  draft_publication_live: Object.freeze({ boundaryVersion: 'draft-publication-v1' }),
  security_cost_control: Object.freeze({ boundaryVersion: 'external-authority-v1' }),
});

const BOOTSTRAP_PROVIDER_ID = 'vigilo';
const BOOTSTRAP_OPERATION = 'create_draft_pull_request' as const;

export type PublicationReleaseAuthorization =
  | { mode: 'normal'; releasedCommitSha: string; acceptanceIds: readonly [string, string, string, string] }
  | {
      mode: 'acceptance_bootstrap';
      releasedCommitSha: string;
      acceptanceIds: readonly [string, string, string];
      purpose: string;
      oneShotGrantId: string;
      accountGrantId: string;
      reservationId: string | null;
    };

export interface ApprovedPublicationAuthority extends ApprovedHumanReviewAuthority {
  releaseAuthorization: PublicationReleaseAuthorization;
}

type AcceptanceRow = typeof releaseAcceptance.$inferSelect;

export function computePublicationBootstrapPurpose(
  authority: Pick<ApprovedHumanReviewAuthority,
    | 'workspaceId' | 'installationId' | 'githubRepositoryId' | 'baseCommitSha'
    | 'repairRunId' | 'repairLoopId' | 'repairLoopIterationId' | 'aiCandidateGenerationId'
    | 'repairCandidateId' | 'candidateIdentity' | 'candidateVerificationId'
    | 'verificationEvidenceId' | 'verificationEvidenceIdentity' | 'humanReviewDecisionId'
    | 'humanReviewDecisionIdentity' | 'reviewSubjectIdentity'>,
  releasedCommitSha: string,
): string {
  const identity = canonicalRecord({
    version: 1,
    operation: BOOTSTRAP_OPERATION,
    releasedCommitSha,
    workspaceId: authority.workspaceId,
    installationId: authority.installationId,
    githubRepositoryId: authority.githubRepositoryId,
    baseCommitSha: authority.baseCommitSha,
    repairRunId: authority.repairRunId,
    repairLoopId: authority.repairLoopId,
    repairLoopIterationId: authority.repairLoopIterationId,
    aiCandidateGenerationId: authority.aiCandidateGenerationId,
    repairCandidateId: authority.repairCandidateId,
    candidateIdentity: authority.candidateIdentity,
    candidateVerificationId: authority.candidateVerificationId,
    verificationEvidenceId: authority.verificationEvidenceId,
    verificationEvidenceIdentity: authority.verificationEvidenceIdentity,
    humanReviewDecisionId: authority.humanReviewDecisionId,
    humanReviewDecisionIdentity: authority.humanReviewDecisionIdentity,
    reviewSubjectIdentity: authority.reviewSubjectIdentity,
  }, 16 * 1024).hash;
  return `draft-pr-v1:${identity}`;
}

function exactRepairAcceptance(row: AcceptanceRow, authority: ApprovedHumanReviewAuthority): boolean {
  return row.workspaceId === authority.workspaceId && row.repairRunId === authority.repairRunId &&
    row.repairLoopId === authority.repairLoopId && row.repairLoopIterationId === authority.repairLoopIterationId &&
    row.aiCandidateGenerationId === authority.aiCandidateGenerationId && row.repairCandidateId === authority.repairCandidateId &&
    row.candidateIdentity === authority.candidateIdentity && row.candidateVerificationId === authority.candidateVerificationId &&
    row.verificationEvidenceId === authority.verificationEvidenceId && row.verificationEvidenceIdentity === authority.verificationEvidenceIdentity &&
    row.objectiveContractHash === authority.objectiveContractHash && row.objectiveEvidenceHash === authority.objectiveEvidenceHash &&
    row.humanReviewDecisionId === null && row.repairPublicationId === null;
}

function exactHumanAcceptance(row: AcceptanceRow, authority: ApprovedHumanReviewAuthority): boolean {
  return row.workspaceId === authority.workspaceId && row.repairRunId === authority.repairRunId &&
    row.repairLoopId === authority.repairLoopId && row.repairLoopIterationId === authority.repairLoopIterationId &&
    row.aiCandidateGenerationId === authority.aiCandidateGenerationId && row.repairCandidateId === authority.repairCandidateId &&
    row.candidateIdentity === authority.candidateIdentity && row.candidateVerificationId === authority.candidateVerificationId &&
    row.verificationEvidenceId === authority.verificationEvidenceId && row.verificationEvidenceIdentity === authority.verificationEvidenceIdentity &&
    row.objectiveContractHash === authority.objectiveContractHash && row.objectiveEvidenceHash === authority.objectiveEvidenceHash &&
    row.humanReviewDecisionId === authority.humanReviewDecisionId && row.repairPublicationId === null &&
    row.sandboxExecutionIdentity === null && row.executionBudgetGrantId === null && row.executionReservationIds.length === 0;
}

function exactDraftAcceptance(row: AcceptanceRow, authority: ApprovedHumanReviewAuthority): boolean {
  return row.workspaceId === authority.workspaceId && row.repairRunId === authority.repairRunId &&
    row.repairLoopId === authority.repairLoopId && row.repairLoopIterationId === authority.repairLoopIterationId &&
    row.aiCandidateGenerationId === authority.aiCandidateGenerationId && row.repairCandidateId === authority.repairCandidateId &&
    row.candidateIdentity === authority.candidateIdentity && row.candidateVerificationId === authority.candidateVerificationId &&
    row.verificationEvidenceId === authority.verificationEvidenceId && row.verificationEvidenceIdentity === authority.verificationEvidenceIdentity &&
    row.objectiveContractHash === authority.objectiveContractHash && row.objectiveEvidenceHash === authority.objectiveEvidenceHash &&
    row.humanReviewDecisionId === authority.humanReviewDecisionId && row.repairPublicationId !== null &&
    row.sandboxExecutionIdentity === null && row.executionBudgetGrantId !== null && row.executionReservationIds.length === 1;
}

function exactSecurityAcceptance(row: AcceptanceRow): boolean {
  return row.repairRunId === null && row.repairLoopId === null && row.repairLoopIterationId === null &&
    row.aiCandidateGenerationId === null && row.repairCandidateId === null && row.candidateIdentity === null &&
    row.candidateVerificationId === null && row.verificationEvidenceId === null && row.verificationEvidenceIdentity === null &&
    row.objectiveContractHash === null && row.objectiveEvidenceHash === null && row.humanReviewDecisionId === null &&
    row.repairPublicationId === null && row.sandboxExecutionIdentity === null && row.executionBudgetGrantId !== null &&
    row.executionReservationIds.length > 0 && new Set(row.executionReservationIds).size === row.executionReservationIds.length;
}

async function exactApprovedHumanAuthority(
  database: VigiloDatabase,
  authority: ApprovedHumanReviewAuthority,
): Promise<boolean> {
  const [decision] = await database.select().from(humanReviewDecision)
    .where(eq(humanReviewDecision.id, authority.humanReviewDecisionId)).limit(1);
  return Boolean(decision && decision.decision === 'approved' &&
    decision.decisionIdentity === authority.humanReviewDecisionIdentity &&
    decision.reviewSubjectIdentity === authority.reviewSubjectIdentity &&
    decision.reviewerUserId === authority.reviewerUserId && decision.workspaceId === authority.workspaceId &&
    decision.repairRunId === authority.repairRunId && decision.repairLoopId === authority.repairLoopId &&
    decision.repairLoopIterationId === authority.repairLoopIterationId &&
    decision.aiCandidateGenerationId === authority.aiCandidateGenerationId &&
    decision.repairCandidateId === authority.repairCandidateId && decision.candidateIdentity === authority.candidateIdentity &&
    decision.candidateVerificationId === authority.candidateVerificationId &&
    decision.verificationEvidenceId === authority.verificationEvidenceId &&
    decision.verificationEvidenceIdentity === authority.verificationEvidenceIdentity &&
    decision.githubRepositoryId === authority.githubRepositoryId && decision.installationId === authority.installationId &&
    decision.baselineId === authority.baselineId && decision.baseCommitSha === authority.baseCommitSha &&
    decision.profileIdentity === authority.profileIdentity && decision.objectiveContractHash === authority.objectiveContractHash &&
    decision.objectiveEvidenceHash === authority.objectiveEvidenceHash);
}

async function exactOperatorProvenance(database: VigiloDatabase, authority: ApprovedHumanReviewAuthority, rows: AcceptanceRow[]): Promise<boolean> {
  const [principal] = await database.select({ id: user.id }).from(user)
    .innerJoin(workspace, eq(workspace.ownerUserId, user.id))
    .innerJoin(account, eq(account.userId, user.id))
    .where(and(eq(workspace.id, authority.workspaceId), eq(user.id, authority.reviewerUserId), eq(account.providerId, 'github'))).limit(1);
  if (!principal || rows.some((row) => row.reviewedBy !== principal.id)) return false;
  const grantIds = [...new Set(rows.flatMap((row) => row.executionBudgetGrantId ? [row.executionBudgetGrantId] : []))];
  const grants = await database.select().from(executionBudgetGrant).where(inArray(executionBudgetGrant.id, grantIds));
  return grants.length === grantIds.length && grants.every((grant) => grant.authorizedBy === principal.id);
}

function coherentAcceptedSubject(repair: AcceptanceRow, human: AcceptanceRow, draft?: AcceptanceRow): boolean {
  const common = (row: AcceptanceRow) => row.workspaceId === repair.workspaceId && row.repairRunId === repair.repairRunId &&
    row.repairLoopId === repair.repairLoopId && row.repairLoopIterationId === repair.repairLoopIterationId &&
    row.aiCandidateGenerationId === repair.aiCandidateGenerationId && row.repairCandidateId === repair.repairCandidateId &&
    row.candidateIdentity === repair.candidateIdentity && row.candidateVerificationId === repair.candidateVerificationId &&
    row.verificationEvidenceId === repair.verificationEvidenceId && row.verificationEvidenceIdentity === repair.verificationEvidenceIdentity &&
    row.objectiveContractHash === repair.objectiveContractHash && row.objectiveEvidenceHash === repair.objectiveEvidenceHash;
  return common(human) && human.humanReviewDecisionId !== null && human.repairPublicationId === null &&
    human.sandboxExecutionIdentity === null && human.executionBudgetGrantId === null && human.executionReservationIds.length === 0 &&
    (!draft || (common(draft) && draft.humanReviewDecisionId === human.humanReviewDecisionId && draft.repairPublicationId !== null &&
      draft.sandboxExecutionIdentity === null && draft.executionBudgetGrantId !== null && draft.executionReservationIds.length === 1));
}

function boundary(kind: keyof typeof PUBLICATION_ACCEPTANCE_BOUNDARIES, workspaceId: string, releasedCommitSha: string) {
  return { kind, workspaceId, releasedCommitSha, ...PUBLICATION_ACCEPTANCE_BOUNDARIES[kind] };
}

function bootstrapGrantShape(grant: typeof executionBudgetGrant.$inferSelect, authority: ApprovedHumanReviewAuthority, purpose: string): boolean {
  return grant.scope === 'one_shot' && grant.workspaceId === authority.workspaceId && grant.repairRunId === authority.repairRunId &&
    grant.githubRepositoryId === authority.githubRepositoryId && grant.baseCommitSha === authority.baseCommitSha &&
    grant.operationCategory === 'release_acceptance_one_shot' && grant.providerId === BOOTSTRAP_PROVIDER_ID &&
    grant.modelId === null && grant.acceptancePurpose === purpose && grant.sandboxResourceClass === null &&
    grant.maxLogicalRequests === 1 && grant.maxProviderAttempts === 0 && grant.maxInputTokens === 0 && grant.maxOutputTokens === 0 &&
    grant.maxSandboxIdentities === 0 && grant.maxSandboxRuntimeMs === 0 && grant.maxVerificationAttempts === 0 &&
    grant.maxRepairLoopIterations === 0 && grant.maxConcurrentExternalOperations === 0 && executionGrantIdentityMatches(grant);
}

async function exactBootstrapAuthority(
  database: VigiloDatabase,
  authority: ApprovedHumanReviewAuthority,
  releasedCommitSha: string,
  security: AcceptanceRow,
  options: { clock?: () => Date; operationKey?: string } = {},
) {
  if (!security.executionBudgetGrantId) throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  const now = (options.clock ?? (() => new Date()))();
  const purpose = computePublicationBootstrapPurpose(authority, releasedCommitSha);
  const grants = await database.select().from(executionBudgetGrant);
  const account = grants.find((grant) => grant.id === security.executionBudgetGrantId);
  const candidates = grants.filter((grant) => bootstrapGrantShape(grant, authority, purpose));
  if (!account || account.scope !== 'account' || account.authorizedBy !== authority.reviewerUserId ||
      account.expiresAt <= now || !executionGrantIdentityMatches(account) || candidates.length !== 1) {
    throw new ReleaseAcceptanceError('acceptance_missing');
  }
  const grant = candidates[0]!;
  if (grant.authorizedBy !== authority.reviewerUserId) throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  if (grant.expiresAt <= now) throw new ReleaseAcceptanceError('acceptance_missing');
  const revocations = await database.select({ grantId: executionBudgetGrantRevocation.grantId }).from(executionBudgetGrantRevocation)
    .where(inArray(executionBudgetGrantRevocation.grantId, [account.id, grant.id]));
  if (revocations.length > 0) throw new ReleaseAcceptanceError('acceptance_revoked');
  const reservations = await database.select().from(externalExecutionReservation).where(eq(externalExecutionReservation.grantId, grant.id));
  if (reservations.length === 0) return { purpose, oneShotGrantId: grant.id, accountGrantId: account.id, reservationId: null };
  if (!options.operationKey || reservations.length !== 1) throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  const reservation = reservations[0]!;
  const [lease] = await database.select().from(externalExecutionLease).where(eq(externalExecutionLease.reservationId, reservation.id)).limit(1);
  if (reservation.operationKey !== options.operationKey || reservation.accountGrantId !== account.id ||
      reservation.workspaceId !== authority.workspaceId || reservation.repairRunId !== authority.repairRunId ||
      reservation.githubRepositoryId !== authority.githubRepositoryId || reservation.baseCommitSha !== authority.baseCommitSha ||
      reservation.operationCategory !== 'release_acceptance_one_shot' || reservation.providerId !== BOOTSTRAP_PROVIDER_ID ||
      reservation.modelId !== null || reservation.acceptancePurpose !== purpose || reservation.reservedLogicalRequests !== 1 ||
      reservation.reservedProviderAttempts !== 0 || reservation.reservedInputTokens !== 0 || reservation.reservedOutputTokens !== 0 ||
      reservation.reservedSandboxIdentities !== 0 || reservation.reservedSandboxRuntimeMs !== 0 ||
      reservation.reservedVerificationAttempts !== 0 || reservation.reservedRepairLoopIterations !== 0 ||
      reservation.sandboxResourceClass !== null || !executionReservationIdentityMatches(reservation) || !lease ||
      lease.state !== 'active' || lease.leaseExpiresAt <= now) throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  return { purpose, oneShotGrantId: grant.id, accountGrantId: account.id, reservationId: reservation.id };
}

async function verifyPublishedBootstrap(
  database: VigiloDatabase,
  releasedCommitSha: string,
  repair: AcceptanceRow,
  human: AcceptanceRow,
  draft: AcceptanceRow,
  security: AcceptanceRow,
): Promise<boolean> {
  if (!draft.executionBudgetGrantId || !draft.repairPublicationId || !security.executionBudgetGrantId || draft.executionReservationIds.length !== 1) return false;
  if (!human.humanReviewDecisionId) return false;
  const [decision] = await database.select().from(humanReviewDecision).where(eq(humanReviewDecision.id, human.humanReviewDecisionId)).limit(1);
  if (!decision || decision.decision !== 'approved' || decision.workspaceId !== repair.workspaceId ||
      decision.repairRunId !== repair.repairRunId || decision.repairLoopId !== repair.repairLoopId ||
      decision.repairLoopIterationId !== repair.repairLoopIterationId || decision.aiCandidateGenerationId !== repair.aiCandidateGenerationId ||
      decision.repairCandidateId !== repair.repairCandidateId || decision.candidateIdentity !== repair.candidateIdentity ||
      decision.candidateVerificationId !== repair.candidateVerificationId || decision.verificationEvidenceId !== repair.verificationEvidenceId ||
      decision.verificationEvidenceIdentity !== repair.verificationEvidenceIdentity || decision.objectiveContractHash !== repair.objectiveContractHash ||
      decision.objectiveEvidenceHash !== repair.objectiveEvidenceHash) return false;
  const [grant] = await database.select().from(executionBudgetGrant).where(eq(executionBudgetGrant.id, draft.executionBudgetGrantId)).limit(1);
  const [reservation] = await database.select().from(externalExecutionReservation).where(eq(externalExecutionReservation.id, draft.executionReservationIds[0]!)).limit(1);
  const [lease] = reservation ? await database.select().from(externalExecutionLease).where(eq(externalExecutionLease.reservationId, reservation.id)).limit(1) : [];
  const acceptedAuthority: ApprovedHumanReviewAuthority = {
    humanReviewDecisionId: decision.id, humanReviewDecisionIdentity: decision.decisionIdentity,
    repairRunId: decision.repairRunId, repairLoopId: decision.repairLoopId,
    repairLoopIterationId: decision.repairLoopIterationId, aiCandidateGenerationId: decision.aiCandidateGenerationId,
    repairCandidateId: decision.repairCandidateId, candidateIdentity: decision.candidateIdentity,
    candidateVerificationId: decision.candidateVerificationId, verificationEvidenceId: decision.verificationEvidenceId,
    verificationEvidenceIdentity: decision.verificationEvidenceIdentity, reviewSubjectIdentity: decision.reviewSubjectIdentity,
    workspaceId: decision.workspaceId, reviewerUserId: decision.reviewerUserId, githubRepositoryId: decision.githubRepositoryId,
    installationId: decision.installationId, baselineId: decision.baselineId, baseCommitSha: decision.baseCommitSha,
    profileIdentity: decision.profileIdentity, objectiveContractHash: decision.objectiveContractHash,
    objectiveEvidenceHash: decision.objectiveEvidenceHash,
  };
  const purpose = computePublicationBootstrapPurpose(acceptedAuthority, releasedCommitSha);
  return Boolean(grant && bootstrapGrantShape(grant, acceptedAuthority, purpose) && reservation && lease && lease.state === 'succeeded' &&
    reservation.grantId === grant.id && reservation.accountGrantId === security.executionBudgetGrantId &&
    reservation.operationKey === draft.repairPublicationId && reservation.acceptancePurpose === purpose &&
    executionReservationIdentityMatches(reservation));
}

/**
 * Resolves the exact immutable release evidence for one approved publication subject.
 * The production wrapper supplies VIGILO_RELEASE_SHA; callers cannot substitute a browser value.
 */
export async function resolvePublicationReleaseAuthority(
  database: VigiloDatabase,
  authority: ApprovedHumanReviewAuthority,
  releasedCommitSha: string,
  options: { clock?: () => Date; operationKey?: string } = {},
): Promise<ApprovedPublicationAuthority> {
  const [repair, human, security] = await Promise.all([
    resolveReleaseAcceptance(database, boundary('repair_loop_live', authority.workspaceId, releasedCommitSha)),
    resolveReleaseAcceptance(database, boundary('human_review_live', authority.workspaceId, releasedCommitSha)),
    resolveReleaseAcceptance(database, boundary('security_cost_control', authority.workspaceId, releasedCommitSha)),
  ]);
  if (!(await exactApprovedHumanAuthority(database, authority)) || !(await exactOperatorProvenance(database, authority, [repair, human, security])) ||
      security.executionBudgetGrantId !== repair.executionBudgetGrantId ||
      repair.executionReservationIds.some((id) => !security.executionReservationIds.includes(id)) ||
      !coherentAcceptedSubject(repair, human) || !exactSecurityAcceptance(security)) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }

  try {
    const draft = await resolveReleaseAcceptance(database, boundary('draft_publication_live', authority.workspaceId, releasedCommitSha));
    if (!(await exactOperatorProvenance(database, authority, [draft])) ||
        !(await verifyAcceptanceExecutionAudit(database, draft.executionReservationIds)) ||
        !exactRepairAcceptance(repair, authority) || !exactHumanAcceptance(human, authority) ||
        !exactDraftAcceptance(draft, authority) || !coherentAcceptedSubject(repair, human, draft) ||
        !(await verifyPublishedBootstrap(database, releasedCommitSha, repair, human, draft, security))) {
      throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
    }
    return { ...authority, releaseAuthorization: { mode: 'normal', releasedCommitSha, acceptanceIds: [repair.id, human.id, draft.id, security.id] } };
  } catch (error) {
    if (!(error instanceof ReleaseAcceptanceError) || error.code !== 'acceptance_missing') throw error;
  }

  const existingDraftBoundary = await database.select({ id: releaseAcceptance.id }).from(releaseAcceptance).where(and(
    eq(releaseAcceptance.kind, 'draft_publication_live'), eq(releaseAcceptance.workspaceId, authority.workspaceId),
    eq(releaseAcceptance.releasedCommitSha, releasedCommitSha),
    eq(releaseAcceptance.boundaryVersion, PUBLICATION_ACCEPTANCE_BOUNDARIES.draft_publication_live.boundaryVersion),
  ));
  if (existingDraftBoundary.length !== 0) throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  if (!exactRepairAcceptance(repair, authority) || !exactHumanAcceptance(human, authority)) {
    throw new ReleaseAcceptanceError('acceptance_boundary_mismatch');
  }
  const bootstrap = await exactBootstrapAuthority(database, authority, releasedCommitSha, security, options);
  return {
    ...authority,
    releaseAuthorization: {
      mode: 'acceptance_bootstrap', releasedCommitSha, acceptanceIds: [repair.id, human.id, security.id], ...bootstrap,
    },
  };
}
