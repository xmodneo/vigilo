import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { humanReviewDecision, repairCandidateFile, repairIntent, repairPublication, repairPublicationEvent, repairRun } from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { resolveApprovedPublicationAuthority } from '../human-reviews/flow.ts';
import type { ApprovedHumanReviewAuthority } from '../human-reviews/types.ts';
import { normalizeRepairObjective } from '../repair-runs/intent.ts';
import { selfCheckRepairCandidateForWorkspace } from '../repair-candidates/flow.ts';
import { REPAIR_PUBLICATION_JOB_VERSION, type TransactionalRepairPublicationQueue } from '../repair-runs/queue.ts';
import { buildPullRequestMetadata, computePublicationIntentIdentity, publicationBranch } from './identity.ts';
import { PUBLICATION_VERSION, type RepairPublicationResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export class RepairPublicationError extends Error {
  constructor(public readonly code:
    | 'publication_not_found'
    | 'publication_authority_mismatch'
    | 'publication_idempotency_conflict'
    | 'publication_invalid_request'
    | 'publication_queue_failed') {
    super(code);
    this.name = 'RepairPublicationError';
  }
}

type PublicationRow = typeof repairPublication.$inferSelect;

export function publicRepairPublication(row: PublicationRow): RepairPublicationResult {
  const hasPullRequest = row.githubPullRequestId !== null && row.githubPullRequestNumber !== null && row.githubPullRequestNodeId !== null && row.githubPullRequestUrl !== null;
  return {
    id: row.id, repairRunId: row.repairRunId, state: row.state as RepairPublicationResult['state'], checkpoint: row.checkpoint as RepairPublicationResult['checkpoint'],
    targetBranch: row.targetBranch, targetBaseBranch: row.targetBaseBranch, expectedCommitSha: row.expectedCommitSha,
    remoteBranchCommitSha: row.remoteBranchCommitSha,
    pullRequest: hasPullRequest ? { id: row.githubPullRequestId!, number: row.githubPullRequestNumber!, nodeId: row.githubPullRequestNodeId!, url: row.githubPullRequestUrl! } : null,
    failureCode: row.failureCode, createdAt: row.createdAt, completedAt: row.completedAt,
  };
}

export async function getRepairPublication(database: VigiloDatabase, context: AuthenticatedWorkspace, repairRunId: string): Promise<RepairPublicationResult | null> {
  const [row] = await database.select().from(repairPublication).where(and(eq(repairPublication.repairRunId, repairRunId), eq(repairPublication.workspaceId, context.workspace.id))).limit(1);
  return row ? publicRepairPublication(row) : null;
}

export async function getRepairPublicationHistory(database: VigiloDatabase, context: AuthenticatedWorkspace, repairRunId: string) {
  const [publication] = await database.select().from(repairPublication).where(and(eq(repairPublication.repairRunId, repairRunId), eq(repairPublication.workspaceId, context.workspace.id))).limit(1);
  if (!publication) return { publication: null, events: [] };
  const events = await database.select().from(repairPublicationEvent).where(eq(repairPublicationEvent.publicationId, publication.id)).orderBy(asc(repairPublicationEvent.createdAt), asc(repairPublicationEvent.id));
  return { publication: publicRepairPublication(publication), events: events.map((event) => ({ id: event.id, fromState: event.fromState, toState: event.toState, checkpoint: event.checkpoint, eventType: event.eventType, failureCode: event.failureCode, createdAt: event.createdAt })) };
}

export async function reserveRepairPublicationWithAuthority(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  queues: TransactionalRepairPublicationQueue,
  authority: ApprovedHumanReviewAuthority,
  input: { decisionIdentity: string; idempotencyKey: string },
  options: { clock?: () => Date; randomId?: () => string } = {},
): Promise<RepairPublicationResult> {
  if (!UUID.test(input.idempotencyKey) || !HASH.test(input.decisionIdentity) || input.decisionIdentity !== authority.humanReviewDecisionIdentity || authority.workspaceId !== context.workspace.id) throw new RepairPublicationError('publication_invalid_request');
  const clock = options.clock ?? (() => new Date()); const randomId = options.randomId ?? randomUUID;
  const [intent] = await database.select().from(repairIntent).where(and(eq(repairIntent.repairRunId, authority.repairRunId), eq(repairIntent.workspaceId, context.workspace.id))).limit(1);
  if (!intent) throw new RepairPublicationError('publication_authority_mismatch');
  const normalized = normalizeRepairObjective(intent.objective);
  if (normalized.objective !== intent.objective || normalized.objectiveHash !== intent.objectiveHash) throw new RepairPublicationError('publication_authority_mismatch');
  const checked = await selfCheckRepairCandidateForWorkspace(database, context.workspace.id, authority.repairCandidateId);
  if (checked.candidateIdentity !== authority.candidateIdentity) throw new RepairPublicationError('publication_authority_mismatch');
  const storedFiles = await database.select({ path: repairCandidateFile.path, operation: repairCandidateFile.operation }).from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, authority.repairCandidateId));
  if (storedFiles.length !== checked.files.length) throw new RepairPublicationError('publication_authority_mismatch');
  const id = randomId();
  const clockValue = clock();
  if (!Number.isFinite(clockValue.getTime())) throw new RepairPublicationError('publication_invalid_request');
  const now = new Date(Math.floor(clockValue.getTime() / 1_000) * 1_000);
  const targetBranch = publicationBranch(authority.humanReviewDecisionIdentity);
  const metadata = buildPullRequestMetadata({
    publicationId: id, objective: intent.objective, objectiveHash: intent.objectiveHash, candidateIdentity: authority.candidateIdentity,
    decisionIdentity: authority.humanReviewDecisionIdentity, verificationId: authority.candidateVerificationId,
    evidenceId: authority.verificationEvidenceId, evidenceIdentity: authority.verificationEvidenceIdentity,
    changedFiles: storedFiles.map((file) => ({ path: file.path, operation: file.operation as 'add' | 'modify' | 'delete' })),
  });
  const publicationIntentIdentity = computePublicationIntentIdentity({ publicationId: id, authority, repairIntentId: intent.id, repairObjectiveHash: intent.objectiveHash, requestedByUserId: context.user.id, targetBranch, pullRequestTitle: metadata.title, pullRequestBodyHash: metadata.bodyHash });
  try {
    return await database.transaction(async (transaction) => {
      const [run] = await transaction.select({ id: repairRun.id }).from(repairRun).where(and(eq(repairRun.id, authority.repairRunId), eq(repairRun.workspaceId, context.workspace.id))).for('update').limit(1);
      if (!run) throw new RepairPublicationError('publication_authority_mismatch');
      const [byDecision] = await transaction.select().from(repairPublication).where(eq(repairPublication.humanReviewDecisionId, authority.humanReviewDecisionId)).limit(1);
      if (byDecision) return publicRepairPublication(byDecision);
      const [byKey] = await transaction.select().from(repairPublication).where(and(eq(repairPublication.workspaceId, context.workspace.id), eq(repairPublication.idempotencyKey, input.idempotencyKey))).limit(1);
      if (byKey) {
        if (byKey.humanReviewDecisionIdentity !== input.decisionIdentity) throw new RepairPublicationError('publication_idempotency_conflict');
        return publicRepairPublication(byKey);
      }
      const [created] = await transaction.insert(repairPublication).values({
        id, version: PUBLICATION_VERSION, workspaceId: context.workspace.id, requestedByUserId: context.user.id,
        repairRunId: authority.repairRunId, repairLoopId: authority.repairLoopId, humanReviewDecisionId: authority.humanReviewDecisionId,
        humanReviewDecisionIdentity: authority.humanReviewDecisionIdentity, repairCandidateId: authority.repairCandidateId,
        candidateIdentity: authority.candidateIdentity, candidateVerificationId: authority.candidateVerificationId,
        verificationEvidenceId: authority.verificationEvidenceId, verificationEvidenceIdentity: authority.verificationEvidenceIdentity,
        githubRepositoryId: authority.githubRepositoryId, installationId: authority.installationId, baselineId: authority.baselineId,
        baseCommitSha: authority.baseCommitSha, profileIdentity: authority.profileIdentity, objectiveContractHash: authority.objectiveContractHash,
        objectiveEvidenceHash: authority.objectiveEvidenceHash, repairIntentId: intent.id, repairObjective: intent.objective,
        repairObjectiveHash: intent.objectiveHash, targetBranch, pullRequestTitle: metadata.title, pullRequestBody: metadata.body,
        pullRequestBodyHash: metadata.bodyHash, publicationIntentIdentity, state: 'queued', checkpoint: 'reserved',
        idempotencyKey: input.idempotencyKey, createdAt: now, updatedAt: now,
      }).returning();
      if (!created) throw new RepairPublicationError('publication_queue_failed');
      await transaction.insert(repairPublicationEvent).values({ id: randomId(), publicationId: id, workspaceId: context.workspace.id, fromState: null, toState: 'queued', checkpoint: 'reserved', eventType: 'reserved', createdAt: now });
      const jobId = await queues.enqueuePublication(transaction, { version: REPAIR_PUBLICATION_JOB_VERSION, publicationId: id });
      if (jobId !== id) throw new RepairPublicationError('publication_queue_failed');
      return publicRepairPublication(created);
    });
  } catch (error) {
    if (error instanceof RepairPublicationError) throw error;
    const [byDecision] = await database.select().from(repairPublication).where(eq(repairPublication.humanReviewDecisionId, authority.humanReviewDecisionId)).limit(1);
    if (byDecision) return publicRepairPublication(byDecision);
    throw new RepairPublicationError('publication_queue_failed');
  }
}

export async function createRepairPublication(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  queues: TransactionalRepairPublicationQueue,
  repairRunId: string,
  input: { decisionIdentity: string; idempotencyKey: string },
): Promise<RepairPublicationResult> {
  if (!UUID.test(repairRunId)) throw new RepairPublicationError('publication_not_found');
  const [decision] = await database.select().from(humanReviewDecision).where(and(eq(humanReviewDecision.repairRunId, repairRunId), eq(humanReviewDecision.workspaceId, context.workspace.id))).limit(1);
  if (!decision) throw new RepairPublicationError('publication_not_found');
  if (decision.decisionIdentity !== input.decisionIdentity) throw new RepairPublicationError('publication_authority_mismatch');
  const authority = await resolveApprovedPublicationAuthority(database, context.workspace.id, decision.id);
  return reserveRepairPublicationWithAuthority(database, context, queues, authority, input);
}
