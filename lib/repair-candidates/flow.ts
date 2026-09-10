import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, max } from 'drizzle-orm';

import {
  investigation,
  repairCandidate,
  repairCandidateEvent,
  repairCandidateFile,
  repairRun,
  repositoryBaseline,
} from '../../db/schema.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { candidatePathKey, CandidatePolicyError, normalizeCandidateProposal } from './policy.ts';
import { CandidateArtifactError, computeCandidateIdentity, sha256 } from './identity.ts';
import { InvestigationSourceError, withScopedRepositoryToken } from '../investigations/source.ts';
import type {
  CandidateRejectionCode,
  CandidateSourceGateway,
  FrozenCandidateFile,
  NormalizedCandidateProposal,
  RepairCandidateResult,
} from './types.ts';

const TRUSTWORTHY_OUTCOMES = new Set(['baseline_passed', 'baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed']);

export class RepairCandidateError extends Error {
  constructor(public readonly code:
    | 'candidate_artifact_invalid'
    | 'candidate_conflict'
    | 'candidate_not_found'
    | 'investigation_not_eligible'
    | 'proposal_conflict') {
    super(code);
    this.name = 'RepairCandidateError';
  }
}

type CandidateRow = typeof repairCandidate.$inferSelect;

function result(row: CandidateRow): RepairCandidateResult {
  return {
    id: row.id,
    investigationId: row.investigationId,
    repairRunId: row.repairRunId,
    ordinal: row.ordinal,
    state: row.state as RepairCandidateResult['state'],
    formatVersion: 1,
    githubRepositoryId: row.githubRepositoryId,
    installationId: row.installationId,
    baseCommitSha: row.baseCommitSha,
    profileIdentity: row.profileIdentity,
    candidateIdentity: row.candidateIdentity,
    changedFileCount: row.changedFileCount,
    totalResultBytes: row.totalResultBytes,
    rejectionCode: row.rejectionCode,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function bindingMatches(
  current: typeof investigation.$inferSelect,
  run: typeof repairRun.$inferSelect,
  baseline: typeof repositoryBaseline.$inferSelect,
): boolean {
  return current.repairRunId === run.id && current.workspaceId === run.workspaceId &&
    current.githubRepositoryId === run.githubRepositoryId && current.installationId === run.installationId &&
    current.baseCommitSha === run.baseCommitSha && current.profileIdentity === run.profileIdentity &&
    current.baselineId === run.baselineId && baseline.id === current.baselineId &&
    baseline.workspaceId === current.workspaceId && baseline.githubRepositoryId === current.githubRepositoryId &&
    baseline.installationId === current.installationId && baseline.baseCommitSha === current.baseCommitSha &&
    baseline.profileIdentity === current.profileIdentity && TRUSTWORTHY_OUTCOMES.has(baseline.overallOutcome);
}

async function reserveCandidate(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  proposal: NormalizedCandidateProposal,
  now: Date,
  randomId: () => string,
): Promise<{ candidate: CandidateRow; ownsFreeze: boolean }> {
  return database.transaction(async (transaction) => {
    const [current] = await transaction.select().from(investigation).where(and(
      eq(investigation.id, proposal.investigationId),
      eq(investigation.workspaceId, context.workspace.id),
    )).for('update').limit(1);
    if (!current || current.state !== 'ready') throw new RepairCandidateError('investigation_not_eligible');

    const [existing] = await transaction.select().from(repairCandidate).where(and(
      eq(repairCandidate.investigationId, current.id),
      eq(repairCandidate.proposalKey, proposal.proposalKey),
    )).limit(1);
    if (existing) {
      if (existing.proposalIdentity !== proposal.proposalIdentity) throw new RepairCandidateError('proposal_conflict');
      return { candidate: existing, ownsFreeze: false };
    }

    const [[run], [baseline], [active]] = await Promise.all([
      transaction.select().from(repairRun).where(eq(repairRun.id, current.repairRunId)).limit(1),
      transaction.select().from(repositoryBaseline).where(eq(repositoryBaseline.id, current.baselineId)).limit(1),
      transaction.select().from(repairCandidate).where(and(eq(repairCandidate.investigationId, current.id), eq(repairCandidate.state, 'freezing'))).limit(1),
    ]);
    if (!run || !baseline || !['ready_for_investigation', 'baseline_failed'].includes(run.state) || !bindingMatches(current, run, baseline)) throw new RepairCandidateError('investigation_not_eligible');
    if (active) throw new RepairCandidateError('candidate_conflict');
    const [ordinalResult] = await transaction.select({ value: max(repairCandidate.ordinal) }).from(repairCandidate).where(eq(repairCandidate.investigationId, current.id));
    const ordinal = (ordinalResult?.value ?? 0) + 1;
    const id = randomId();
    const [created] = await transaction.insert(repairCandidate).values({
      id,
      investigationId: current.id,
      repairRunId: run.id,
      workspaceId: current.workspaceId,
      githubRepositoryId: current.githubRepositoryId,
      installationId: current.installationId,
      baseCommitSha: current.baseCommitSha,
      profileIdentity: current.profileIdentity,
      formatVersion: 1,
      ordinal,
      proposalKey: proposal.proposalKey,
      proposalIdentity: proposal.proposalIdentity,
      state: 'freezing',
      changedFileCount: proposal.files.length,
      totalResultBytes: proposal.totalResultBytes,
      createdAt: now,
      freezingStartedAt: now,
      updatedAt: now,
    }).returning();
    await transaction.insert(repairCandidateEvent).values([
      { id: randomId(), candidateId: id, workspaceId: current.workspaceId, eventType: 'created', candidateOrdinal: ordinal, changedFileCount: proposal.files.length, totalResultBytes: proposal.totalResultBytes, createdAt: now },
      { id: randomId(), candidateId: id, workspaceId: current.workspaceId, eventType: 'freeze_started', candidateOrdinal: ordinal, changedFileCount: proposal.files.length, totalResultBytes: proposal.totalResultBytes, createdAt: now },
    ]);
    return { candidate: created!, ownsFreeze: true };
  });
}

async function validateBase(
  gateway: CandidateSourceGateway,
  configuration: GitHubAppConfiguration,
  candidate: CandidateRow,
  proposal: NormalizedCandidateProposal,
): Promise<FrozenCandidateFile[]> {
  return withScopedRepositoryToken(gateway, configuration, candidate, async ({ accessToken, owner, repository }) => {
    const commit = await gateway.getCommitTree({ accessToken, owner, repository, commitSha: candidate.baseCommitSha });
    if (commit.commitSha !== candidate.baseCommitSha) throw new CandidatePolicyError('source_evidence_incomplete');
    const tree = await gateway.getTree({ accessToken, owner, repository, treeSha: commit.treeSha });
    if (tree.truncated) throw new CandidatePolicyError('source_evidence_incomplete');
    const exact = new Map(tree.entries.map((entry) => [entry.path, entry]));
    const folded = new Map<string, number>();
    for (const entry of tree.entries) folded.set(candidatePathKey(entry.path), (folded.get(candidatePathKey(entry.path)) ?? 0) + 1);

    const files: FrozenCandidateFile[] = [];
    for (const proposed of proposal.files) {
      const entry = exact.get(proposed.path);
      const foldedCount = folded.get(candidatePathKey(proposed.path)) ?? 0;
      if (proposed.operation === 'add') {
        if (entry || foldedCount > 0) throw new CandidatePolicyError('add_path_already_exists');
        const segments = proposed.path.split('/');
        for (let index = 1; index < segments.length; index += 1) {
          const ancestor = exact.get(segments.slice(0, index).join('/'));
          if (ancestor && (ancestor.type !== 'tree' || ancestor.mode !== '040000')) throw new CandidatePolicyError('unsupported_file_type');
        }
        files.push({ path: proposed.path, operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: proposed.resultContentSha256, resultByteLength: proposed.resultByteLength, resultingContent: proposed.resultingText });
        continue;
      }
      if (!entry) throw new CandidatePolicyError('base_file_missing');
      if (foldedCount !== 1) throw new CandidatePolicyError('invalid_path');
      if (entry.type !== 'blob' || entry.mode !== '100644' || entry.size === null) throw new CandidatePolicyError('unsupported_file_type');
      if (entry.sha !== proposed.expectedBaseIdentity) throw new CandidatePolicyError('base_identity_mismatch');
      const blob = await gateway.getBlob({ accessToken, owner, repository, blobSha: entry.sha, maxBytes: 131_072 });
      const actualGitSha = createHash('sha1').update(`blob ${blob.bytes.byteLength}\0`).update(blob.bytes).digest('hex');
      if (blob.sha !== entry.sha || actualGitSha !== entry.sha || blob.bytes.byteLength !== entry.size) throw new CandidatePolicyError('source_evidence_incomplete');
      if (proposed.operation === 'modify' && proposed.resultingBytes!.equals(blob.bytes)) throw new CandidatePolicyError('no_effective_change');
      files.push({
        path: proposed.path,
        operation: proposed.operation,
        baseBlobSha: entry.sha,
        baseContentSha256: sha256(blob.bytes),
        resultContentSha256: proposed.resultContentSha256,
        resultByteLength: proposed.resultByteLength,
        resultingContent: proposed.resultingText,
      });
    }
    return files;
  });
}

function rejectionCode(error: unknown): CandidateRejectionCode {
  if (error instanceof CandidatePolicyError && !['candidate_conflict', 'proposal_conflict'].includes(error.code)) return error.code as CandidateRejectionCode;
  if (error instanceof InvestigationSourceError) return error.code === 'installation_unavailable' ? 'installation_unavailable' : 'infrastructure_failed';
  return 'source_evidence_incomplete';
}

async function rejectCandidate(database: VigiloDatabase, candidate: CandidateRow, code: CandidateRejectionCode, now: Date, randomId: () => string): Promise<RepairCandidateResult> {
  return database.transaction(async (transaction) => {
    const [updated] = await transaction.update(repairCandidate).set({ state: 'rejected', rejectionCode: code, completedAt: now, updatedAt: now }).where(and(eq(repairCandidate.id, candidate.id), eq(repairCandidate.state, 'freezing'))).returning();
    if (!updated) throw new RepairCandidateError('candidate_conflict');
    await transaction.insert(repairCandidateEvent).values({ id: randomId(), candidateId: updated.id, workspaceId: updated.workspaceId, eventType: 'rejected', candidateOrdinal: updated.ordinal, changedFileCount: updated.changedFileCount, totalResultBytes: updated.totalResultBytes, rejectionCode: code, createdAt: now });
    return result(updated);
  });
}

async function freezeCandidate(database: VigiloDatabase, candidate: CandidateRow, files: FrozenCandidateFile[], now: Date, randomId: () => string): Promise<RepairCandidateResult> {
  const candidateIdentity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: candidate.githubRepositoryId, baseCommitSha: candidate.baseCommitSha, profileIdentity: candidate.profileIdentity, files });
  return database.transaction(async (transaction) => {
    await transaction.insert(repairCandidateFile).values(files.map((file) => ({ candidateId: candidate.id, ...file })));
    const [updated] = await transaction.update(repairCandidate).set({ state: 'frozen', candidateIdentity, completedAt: now, updatedAt: now }).where(and(eq(repairCandidate.id, candidate.id), eq(repairCandidate.state, 'freezing'))).returning();
    if (!updated) throw new RepairCandidateError('candidate_conflict');
    await transaction.insert(repairCandidateEvent).values({ id: randomId(), candidateId: updated.id, workspaceId: updated.workspaceId, eventType: 'frozen', candidateOrdinal: updated.ordinal, changedFileCount: updated.changedFileCount, totalResultBytes: updated.totalResultBytes, candidateIdentity, createdAt: now });
    return result(updated);
  });
}

export async function proposeRepairCandidate(
  database: VigiloDatabase,
  context: AuthenticatedWorkspace,
  gateway: CandidateSourceGateway,
  configuration: GitHubAppConfiguration,
  proposalInput: unknown,
  options: { clock?: () => Date; randomId?: () => string } = {},
): Promise<RepairCandidateResult> {
  const proposal = normalizeCandidateProposal(proposalInput);
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const reserved = await reserveCandidate(database, context, proposal, clock(), randomId);
  if (!reserved.ownsFreeze) {
    if (reserved.candidate.state === 'frozen') await selfCheckRepairCandidate(database, context, reserved.candidate.id);
    return result(reserved.candidate);
  }
  let frozen: RepairCandidateResult;
  try {
    const files = await validateBase(gateway, configuration, reserved.candidate, proposal);
    frozen = await freezeCandidate(database, reserved.candidate, files, clock(), randomId);
  } catch (error) {
    if (error instanceof RepairCandidateError) throw error;
    return rejectCandidate(database, reserved.candidate, rejectionCode(error), clock(), randomId);
  }
  await selfCheckRepairCandidate(database, context, frozen.id);
  return frozen;
}

export async function getRepairCandidate(database: VigiloDatabase, context: AuthenticatedWorkspace, candidateId: string): Promise<RepairCandidateResult | null> {
  const [row] = await database.select().from(repairCandidate).where(and(eq(repairCandidate.id, candidateId), eq(repairCandidate.workspaceId, context.workspace.id))).limit(1);
  return row ? result(row) : null;
}

export async function getLatestRepairCandidate(database: VigiloDatabase, context: AuthenticatedWorkspace, investigationId: string): Promise<RepairCandidateResult | null> {
  const [row] = await database.select().from(repairCandidate).where(and(eq(repairCandidate.investigationId, investigationId), eq(repairCandidate.workspaceId, context.workspace.id))).orderBy(desc(repairCandidate.ordinal)).limit(1);
  return row ? result(row) : null;
}

export async function selfCheckRepairCandidate(database: VigiloDatabase, context: AuthenticatedWorkspace, candidateId: string): Promise<{ candidateIdentity: string; files: FrozenCandidateFile[] }> {
  const [row] = await database.select().from(repairCandidate).where(and(eq(repairCandidate.id, candidateId), eq(repairCandidate.workspaceId, context.workspace.id))).limit(1);
  if (!row) throw new RepairCandidateError('candidate_not_found');
  if (row.state !== 'frozen' || !row.candidateIdentity) throw new RepairCandidateError('candidate_artifact_invalid');
  const stored = await database.select().from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, row.id));
  const files: FrozenCandidateFile[] = stored.map((file) => ({
    path: file.path,
    operation: file.operation as FrozenCandidateFile['operation'],
    baseBlobSha: file.baseBlobSha,
    baseContentSha256: file.baseContentSha256,
    resultContentSha256: file.resultContentSha256,
    resultByteLength: file.resultByteLength,
    resultingContent: file.resultingContent,
  }));
  try {
    if (files.length !== row.changedFileCount || files.reduce((total, file) => total + file.resultByteLength, 0) !== row.totalResultBytes) throw new CandidateArtifactError('candidate_artifact_invalid');
    const identity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: row.githubRepositoryId, baseCommitSha: row.baseCommitSha, profileIdentity: row.profileIdentity, files });
    if (identity !== row.candidateIdentity) throw new CandidateArtifactError('candidate_artifact_invalid');
    return { candidateIdentity: identity, files: [...files].sort((left, right) => left.path.localeCompare(right.path)) };
  } catch {
    throw new RepairCandidateError('candidate_artifact_invalid');
  }
}
