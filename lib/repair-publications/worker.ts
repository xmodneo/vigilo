import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, lte } from 'drizzle-orm';
import type { JobResult } from 'pg-boss';

import { repairCandidateFile, repairPublication, repairPublicationAttempt, repairPublicationEvent, repository } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { HumanReviewError, resolveApprovedPublicationAuthority } from '../human-reviews/flow.ts';
import type { ApprovedHumanReviewAuthority } from '../human-reviews/types.ts';
import { selfCheckRepairCandidateForWorkspace } from '../repair-candidates/flow.ts';
import { parseRepairPublicationJobPayload, REPAIR_JOB_MAX_ATTEMPTS, type RepairQueueJob } from '../repair-runs/queue.ts';
import type { WorkerLogger } from '../repair-runs/worker.ts';
import { computePreparedPublicationIdentity, sha256Text } from './identity.ts';
import { prepareGitPublication, PublicationArtifactError, verifyPreparedTree, type PreparedGitPublication } from './git-objects.ts';
import type { PublicationPullRequest, RepairPublicationGateway } from './types.ts';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const REQUIRED_PERMISSIONS = { contents: 'write', metadata: 'read', pull_requests: 'write' } as const;
type PublicationRow = typeof repairPublication.$inferSelect;
type AttemptRow = typeof repairPublicationAttempt.$inferSelect;
export type PublicationAuthorityResolver = typeof resolveApprovedPublicationAuthority;

export interface RepairPublicationWorkerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: RepairPublicationGateway;
  logger: WorkerLogger;
  shutdownSignal?: AbortSignal;
  clock?: () => Date;
  randomId?: () => string;
}

type Claim = { kind: 'attempt'; publication: PublicationRow; attempt: AttemptRow } | { kind: 'busy'; publication: PublicationRow } | { kind: 'terminal'; publication: PublicationRow } | { kind: 'exhausted'; publication: PublicationRow };

class PublicationWorkerError extends Error {
  constructor(public readonly code: string, public readonly disposition: 'failed' | 'review_required' | 'retryable') { super(code); this.name = 'PublicationWorkerError'; }
}

const leaseEnd = (now: Date) => new Date(now.getTime() + LEASE_MS);
const safeCode = (error: unknown) => error instanceof PublicationWorkerError || error instanceof PublicationArtifactError || error instanceof HumanReviewError ? error.code : 'github_publication_failed';

function authorityMatches(publication: PublicationRow, authority: ApprovedHumanReviewAuthority): boolean {
  return publication.workspaceId === authority.workspaceId && publication.repairRunId === authority.repairRunId && publication.repairLoopId === authority.repairLoopId &&
    publication.humanReviewDecisionId === authority.humanReviewDecisionId && publication.humanReviewDecisionIdentity === authority.humanReviewDecisionIdentity &&
    publication.repairCandidateId === authority.repairCandidateId && publication.candidateIdentity === authority.candidateIdentity &&
    publication.candidateVerificationId === authority.candidateVerificationId && publication.verificationEvidenceId === authority.verificationEvidenceId &&
    publication.verificationEvidenceIdentity === authority.verificationEvidenceIdentity && publication.githubRepositoryId === authority.githubRepositoryId &&
    publication.installationId === authority.installationId && publication.baselineId === authority.baselineId && publication.baseCommitSha === authority.baseCommitSha &&
    publication.profileIdentity === authority.profileIdentity && publication.objectiveContractHash === authority.objectiveContractHash && publication.objectiveEvidenceHash === authority.objectiveEvidenceHash;
}

async function currentAuthority(database: VigiloDatabase, publication: PublicationRow, resolver: PublicationAuthorityResolver): Promise<void> {
  const authority = await resolver(database, publication.workspaceId, publication.humanReviewDecisionId);
  if (!authorityMatches(publication, authority)) throw new PublicationWorkerError('publication_authority_mismatch', 'failed');
}

async function claimAttempt(database: VigiloDatabase, publicationId: string, queueJobId: string, now: Date, randomId: () => string): Promise<Claim> {
  return database.transaction(async (transaction) => {
    let [publication] = await transaction.select().from(repairPublication).where(eq(repairPublication.id, publicationId)).for('update').limit(1);
    if (!publication) throw new PublicationWorkerError('publication_not_found', 'failed');
    if (['published', 'failed', 'review_required'].includes(publication.state)) return { kind: 'terminal', publication };
    const [active] = await transaction.select().from(repairPublicationAttempt).where(and(eq(repairPublicationAttempt.publicationId, publication.id), eq(repairPublicationAttempt.state, 'active'))).limit(1);
    if (active && active.leaseExpiresAt.getTime() > now.getTime()) return { kind: 'busy', publication };
    if (active) await transaction.update(repairPublicationAttempt).set({ state: 'abandoned', failureCode: 'stale_worker_recovery', completedAt: now }).where(and(eq(repairPublicationAttempt.id, active.id), eq(repairPublicationAttempt.ownershipToken, active.ownershipToken), eq(repairPublicationAttempt.state, 'active'), lte(repairPublicationAttempt.leaseExpiresAt, now)));
    const [latest] = await transaction.select().from(repairPublicationAttempt).where(eq(repairPublicationAttempt.publicationId, publication.id)).orderBy(desc(repairPublicationAttempt.attemptNumber)).limit(1);
    if ((latest?.attemptNumber ?? 0) >= REPAIR_JOB_MAX_ATTEMPTS) return { kind: 'exhausted', publication };
    const claimedFromState = publication.state;
    if (publication.state === 'queued') {
      [publication] = await transaction.update(repairPublication).set({ state: 'preparing', preparingStartedAt: now, updatedAt: now }).where(and(eq(repairPublication.id, publication.id), eq(repairPublication.state, 'queued'))).returning();
      if (!publication) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
    }
    const [attempt] = await transaction.insert(repairPublicationAttempt).values({
      id: randomId(), publicationId: publication.id, queueJobId, attemptNumber: (latest?.attemptNumber ?? 0) + 1,
      ownershipToken: randomId(), state: 'active', claimedAt: now, heartbeatAt: now, leaseExpiresAt: leaseEnd(now),
    }).returning();
    if (!attempt) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
    await transaction.insert(repairPublicationEvent).values({ id: randomId(), publicationId: publication.id, attemptId: attempt.id, workspaceId: publication.workspaceId, fromState: claimedFromState, toState: publication.state, checkpoint: publication.checkpoint, eventType: 'claimed', createdAt: now });
    return { kind: 'attempt', publication, attempt };
  });
}

async function assertOwnership(database: VigiloDatabase, attempt: AttemptRow, now: Date): Promise<void> {
  const [owned] = await database.update(repairPublicationAttempt).set({ heartbeatAt: now, leaseExpiresAt: leaseEnd(now) }).where(and(eq(repairPublicationAttempt.id, attempt.id), eq(repairPublicationAttempt.ownershipToken, attempt.ownershipToken), eq(repairPublicationAttempt.state, 'active'))).returning();
  if (!owned) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
}

async function checkpoint(dependencies: RepairPublicationWorkerDependencies, publication: PublicationRow, attempt: AttemptRow, values: Partial<PublicationRow> & { checkpoint: string; eventType: string; state?: string }, now: Date): Promise<PublicationRow> {
  return dependencies.database.transaction(async (transaction) => {
    const [ownedAttempt] = await transaction.select({ id: repairPublicationAttempt.id }).from(repairPublicationAttempt).where(and(eq(repairPublicationAttempt.id, attempt.id), eq(repairPublicationAttempt.ownershipToken, attempt.ownershipToken), eq(repairPublicationAttempt.state, 'active'))).limit(1);
    if (!ownedAttempt) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
    const fromState = publication.state;
    const { eventType, ...updates } = values;
    const [updated] = await transaction.update(repairPublication).set({ ...updates, updatedAt: now }).where(and(eq(repairPublication.id, publication.id), eq(repairPublication.state, publication.state), eq(repairPublication.checkpoint, publication.checkpoint))).returning();
    if (!updated) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
    await transaction.insert(repairPublicationEvent).values({ id: (dependencies.randomId ?? randomUUID)(), publicationId: publication.id, attemptId: attempt.id, workspaceId: publication.workspaceId, fromState, toState: updated.state, checkpoint: updated.checkpoint, eventType, createdAt: now });
    return updated;
  });
}

async function terminal(dependencies: RepairPublicationWorkerDependencies, publication: PublicationRow, attempt: AttemptRow | null, disposition: 'failed' | 'review_required', code: string, now: Date): Promise<boolean> {
  return dependencies.database.transaction(async (transaction) => {
    if (attempt) {
      const [finishedAttempt] = await transaction.update(repairPublicationAttempt).set({ state: 'failed', failureCode: code, completedAt: now }).where(and(eq(repairPublicationAttempt.id, attempt.id), eq(repairPublicationAttempt.ownershipToken, attempt.ownershipToken), eq(repairPublicationAttempt.state, 'active'))).returning({ id: repairPublicationAttempt.id });
      if (!finishedAttempt) return false;
    }
    const [updated] = await transaction.update(repairPublication).set({ state: disposition, failureCode: code, completedAt: now, updatedAt: now }).where(and(eq(repairPublication.id, publication.id), eq(repairPublication.state, publication.state), eq(repairPublication.checkpoint, publication.checkpoint))).returning();
    if (!updated) return false;
    await transaction.insert(repairPublicationEvent).values({ id: (dependencies.randomId ?? randomUUID)(), publicationId: publication.id, ...(attempt ? { attemptId: attempt.id } : {}), workspaceId: publication.workspaceId, fromState: publication.state, toState: disposition, checkpoint: updated.checkpoint, eventType: disposition, failureCode: code, createdAt: now });
    return true;
  });
}

function exactPermissions(value: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(value).sort()) === JSON.stringify(Object.entries(REQUIRED_PERMISSIONS).sort());
}

function exactPullRequest(pr: PublicationPullRequest, publication: PublicationRow): boolean {
  return pr.repositoryId === publication.githubRepositoryId && pr.state === 'open' && pr.draft && pr.title === publication.pullRequestTitle && pr.body === publication.pullRequestBody &&
    pr.headRef === publication.targetBranch && pr.headSha === publication.expectedCommitSha && pr.baseRef === publication.targetBaseBranch && pr.baseSha === publication.baseCommitSha &&
    pr.body.includes(`<!-- vigilo-publication:v1:${publication.id} -->`);
}

function exactPullRequestMatches(pullRequests: PublicationPullRequest[], publication: PublicationRow): PublicationPullRequest[] {
  const matches = pullRequests.filter((pullRequest) => exactPullRequest(pullRequest, publication));
  if (matches.length !== pullRequests.length) throw new PublicationWorkerError('github_pr_ambiguous', 'review_required');
  return matches;
}

function branchMayAlreadyExist(publication: PublicationRow): boolean {
  return ['branch_create_requested', 'branch_verified', 'pr_create_requested', 'pr_verified'].includes(publication.checkpoint);
}

async function prepare(dependencies: RepairPublicationWorkerDependencies, publication: PublicationRow, accessToken: string, owner: string, name: string, now: Date): Promise<PreparedGitPublication> {
  const [selected] = await dependencies.database.select().from(repository).where(and(eq(repository.githubRepositoryId, publication.githubRepositoryId), eq(repository.workspaceId, publication.workspaceId), eq(repository.installationId, publication.installationId))).limit(1);
  if (!selected || !selected.defaultBranch || selected.ownerLogin !== owner || selected.name !== name || selected.fullName !== `${owner}/${name}`) throw new PublicationWorkerError('repository_state_changed', 'failed');
  const metadata = await dependencies.gateway.getRepositoryMetadata(accessToken, owner, name);
  if (metadata.id !== selected.githubRepositoryId || metadata.fullName !== selected.fullName || metadata.defaultBranch !== selected.defaultBranch || metadata.isPrivate !== selected.isPrivate) throw new PublicationWorkerError('repository_state_changed', 'failed');
  const head = await dependencies.gateway.resolveBranchCommit({ accessToken, owner, repository: name, branch: metadata.defaultBranch });
  if (head !== publication.baseCommitSha && !branchMayAlreadyExist(publication)) throw new PublicationWorkerError('base_branch_advanced', 'failed');
  const baseCommit = await dependencies.gateway.getCommit({ accessToken, owner, repository: name, commitSha: publication.baseCommitSha });
  const tree = await dependencies.gateway.getTree({ accessToken, owner, repository: name, treeSha: baseCommit.treeSha });
  const checked = await selfCheckRepairCandidateForWorkspace(dependencies.database, publication.workspaceId, publication.repairCandidateId);
  if (checked.candidateIdentity !== publication.candidateIdentity) throw new PublicationWorkerError('candidate_artifact_invalid', 'failed');
  for (const file of checked.files.filter((value) => value.operation !== 'add')) {
    const blob = await dependencies.gateway.getBlob({ accessToken, owner, repository: name, blobSha: file.baseBlobSha!, maxBytes: 131_072 });
    const gitSha = createHash('sha1').update(`blob ${blob.bytes.byteLength}\0`).update(blob.bytes).digest('hex');
    if (blob.sha !== file.baseBlobSha || gitSha !== file.baseBlobSha || sha256Text(blob.bytes) !== file.baseContentSha256) throw new PublicationWorkerError('publication_base_invalid', 'failed');
  }
  return prepareGitPublication({ baseCommitSha: publication.baseCommitSha, baseTreeSha: baseCommit.treeSha, candidateIdentity: publication.candidateIdentity, committedAt: publication.createdAt, files: checked.files, profileIdentity: publication.profileIdentity, treeEntries: tree.entries, treeTruncated: tree.truncated });
}

async function verifyDefaultBranch(dependencies: RepairPublicationWorkerDependencies, publication: PublicationRow, accessToken: string, owner: string, name: string, afterBranch: boolean): Promise<void> {
  const head = await dependencies.gateway.resolveBranchCommit({ accessToken, owner, repository: name, branch: publication.targetBaseBranch! });
  if (head !== publication.baseCommitSha) throw new PublicationWorkerError(afterBranch ? 'base_advanced_after_branch' : 'base_branch_advanced', afterBranch ? 'review_required' : 'failed');
}

async function verifyTargetBranch(dependencies: RepairPublicationWorkerDependencies, publication: PublicationRow, accessToken: string, owner: string, name: string): Promise<void> {
  const head = await dependencies.gateway.getBranchCommit({ accessToken, owner, repository: name, branch: publication.targetBranch });
  if (head !== publication.expectedCommitSha) throw new PublicationWorkerError('github_branch_conflict', 'review_required');
}

async function execute(dependencies: RepairPublicationWorkerDependencies, initial: PublicationRow, attempt: AttemptRow, resolver: PublicationAuthorityResolver): Promise<PublicationRow> {
  let publication = initial; const now = dependencies.clock ?? (() => new Date());
  await currentAuthority(dependencies.database, publication, resolver);
  const installation = await dependencies.gateway.getInstallation(publication.installationId);
  if (installation.id !== publication.installationId || installation.appId !== dependencies.configuration.appId || installation.appSlug !== dependencies.configuration.appSlug || installation.suspendedAt !== null || !exactPermissions(installation.permissions)) throw new PublicationWorkerError('installation_unavailable', 'failed');
  const token = await dependencies.gateway.createPublicationAccessToken({ installationId: publication.installationId, repositoryId: publication.githubRepositoryId });
  const owner = token.repository.ownerLogin; const name = token.repository.name;
  let revocationFailed = false;
  let operationError: unknown = null;
  try {
    const prepared = await prepare(dependencies, publication, token.accessToken, owner, name, now());
    if (publication.preparedPublicationIdentity === null) {
      const preparedIdentity = computePreparedPublicationIdentity({ publicationIntentIdentity: publication.publicationIntentIdentity, targetBaseBranch: token.repository.defaultBranch, expectedBaseTreeSha: prepared.baseTreeSha, expectedTreeSha: prepared.treeSha, expectedCommitSha: prepared.commit.sha });
      publication = await checkpoint(dependencies, publication, attempt, { state: 'publishing', checkpoint: 'authority_prepared', eventType: 'prepared', targetBaseBranch: token.repository.defaultBranch, expectedBaseTreeSha: prepared.baseTreeSha, expectedTreeSha: prepared.treeSha, expectedCommitSha: prepared.commit.sha, preparedPublicationIdentity: preparedIdentity, publishingStartedAt: now() }, now());
    } else if (publication.expectedBaseTreeSha !== prepared.baseTreeSha || publication.expectedTreeSha !== prepared.treeSha || publication.expectedCommitSha !== prepared.commit.sha || publication.targetBaseBranch !== token.repository.defaultBranch || publication.preparedPublicationIdentity !== computePreparedPublicationIdentity({ publicationIntentIdentity: publication.publicationIntentIdentity, targetBaseBranch: publication.targetBaseBranch, expectedBaseTreeSha: prepared.baseTreeSha, expectedTreeSha: prepared.treeSha, expectedCommitSha: prepared.commit.sha })) throw new PublicationWorkerError('prepared_authority_mismatch', 'failed');

    await currentAuthority(dependencies.database, publication, resolver);
    if (!branchMayAlreadyExist(publication)) await verifyDefaultBranch(dependencies, publication, token.accessToken, owner, name, false);
    if (['authority_prepared'].includes(publication.checkpoint)) {
      for (const blob of prepared.blobs) { await assertOwnership(dependencies.database, attempt, now()); const remote = await dependencies.gateway.createBlob({ accessToken: token.accessToken, owner, repository: name, bytes: blob.bytes }); if (remote !== blob.sha) throw new PublicationWorkerError('remote_object_mismatch', 'failed'); }
      await assertOwnership(dependencies.database, attempt, now());
      const mutations = (await dependencies.database.select().from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, publication.repairCandidateId))).map((file) => ({ path: file.path, mode: '100644' as const, type: 'blob' as const, sha: file.operation === 'delete' ? null : prepared.blobs.find((blob) => blob.path === file.path)!.sha }));
      const treeSha = await dependencies.gateway.createTree({ accessToken: token.accessToken, owner, repository: name, baseTreeSha: prepared.baseTreeSha, entries: mutations });
      if (treeSha !== prepared.treeSha) throw new PublicationWorkerError('remote_object_mismatch', 'failed');
      const remoteTree = await dependencies.gateway.getTree({ accessToken: token.accessToken, owner, repository: name, treeSha });
      if (remoteTree.truncated || !verifyPreparedTree(prepared, remoteTree.entries.filter((entry) => entry.type !== 'tree').map((entry) => ({ path: entry.path, mode: entry.mode as '100644', type: entry.type as 'blob', sha: entry.sha })))) throw new PublicationWorkerError('remote_object_mismatch', 'failed');
      await assertOwnership(dependencies.database, attempt, now());
      const commitSha = await dependencies.gateway.createCommit({ accessToken: token.accessToken, owner, repository: name, message: prepared.commit.message, treeSha: prepared.treeSha, parentSha: publication.baseCommitSha, author: { ...prepared.commit.author, date: prepared.commit.committedAt } });
      if (commitSha !== prepared.commit.sha) throw new PublicationWorkerError('remote_object_mismatch', 'failed');
      const commit = await dependencies.gateway.getCommit({ accessToken: token.accessToken, owner, repository: name, commitSha });
      if (commit.sha !== prepared.commit.sha || commit.treeSha !== prepared.treeSha || commit.parents.length !== 1 || commit.parents[0] !== publication.baseCommitSha || commit.message !== prepared.commit.message || commit.author.name !== prepared.commit.author.name || commit.author.email !== prepared.commit.author.email || commit.author.date !== prepared.commit.committedAt || JSON.stringify(commit.author) !== JSON.stringify(commit.committer)) throw new PublicationWorkerError('remote_object_mismatch', 'failed');
      publication = await checkpoint(dependencies, publication, attempt, { checkpoint: 'objects_verified', eventType: 'objects_verified' }, now());
    }

    if (publication.checkpoint === 'objects_verified') publication = await checkpoint(dependencies, publication, attempt, { checkpoint: 'branch_create_requested', eventType: 'branch_requested' }, now());
    if (publication.checkpoint === 'branch_create_requested') {
      await currentAuthority(dependencies.database, publication, resolver); await assertOwnership(dependencies.database, attempt, now());
      let branch = await dependencies.gateway.getBranchCommit({ accessToken: token.accessToken, owner, repository: name, branch: publication.targetBranch });
      if (branch === null) {
        await currentAuthority(dependencies.database, publication, resolver);
        await verifyDefaultBranch(dependencies, publication, token.accessToken, owner, name, false);
        await assertOwnership(dependencies.database, attempt, now());
        try { await dependencies.gateway.createBranch({ accessToken: token.accessToken, owner, repository: name, branch: publication.targetBranch, commitSha: publication.expectedCommitSha! }); } catch { branch = await dependencies.gateway.getBranchCommit({ accessToken: token.accessToken, owner, repository: name, branch: publication.targetBranch }); if (branch === null) throw new PublicationWorkerError('github_branch_outcome_unknown', 'retryable'); }
        branch = await dependencies.gateway.getBranchCommit({ accessToken: token.accessToken, owner, repository: name, branch: publication.targetBranch });
      }
      if (branch !== publication.expectedCommitSha) throw new PublicationWorkerError('github_branch_conflict', 'review_required');
      publication = await checkpoint(dependencies, publication, attempt, { checkpoint: 'branch_verified', eventType: 'branch_verified', remoteBranchCommitSha: branch }, now());
    }

    if (publication.checkpoint === 'branch_verified') { await verifyTargetBranch(dependencies, publication, token.accessToken, owner, name); await verifyDefaultBranch(dependencies, publication, token.accessToken, owner, name, true); publication = await checkpoint(dependencies, publication, attempt, { checkpoint: 'pr_create_requested', eventType: 'pr_requested' }, now()); }
    if (publication.checkpoint === 'pr_create_requested') {
      await currentAuthority(dependencies.database, publication, resolver); await verifyTargetBranch(dependencies, publication, token.accessToken, owner, name); await assertOwnership(dependencies.database, attempt, now());
      let matches = exactPullRequestMatches(await dependencies.gateway.listPullRequests({ accessToken: token.accessToken, owner, repository: name, head: publication.targetBranch, base: publication.targetBaseBranch! }), publication);
      if (matches.length === 0 && attempt.attemptNumber === 1) {
        await currentAuthority(dependencies.database, publication, resolver);
        await verifyTargetBranch(dependencies, publication, token.accessToken, owner, name);
        await verifyDefaultBranch(dependencies, publication, token.accessToken, owner, name, true);
        await assertOwnership(dependencies.database, attempt, now());
        try { const created = await dependencies.gateway.createDraftPullRequest({ accessToken: token.accessToken, owner, repository: name, title: publication.pullRequestTitle, body: publication.pullRequestBody, head: publication.targetBranch, base: publication.targetBaseBranch! }); matches = exactPullRequest(created, publication) ? [created] : []; }
        catch { matches = exactPullRequestMatches(await dependencies.gateway.listPullRequests({ accessToken: token.accessToken, owner, repository: name, head: publication.targetBranch, base: publication.targetBaseBranch! }), publication); }
      }
      if (matches.length !== 1) throw new PublicationWorkerError(matches.length > 1 ? 'github_pr_ambiguous' : 'github_pr_outcome_unknown', 'review_required');
      const verified = await dependencies.gateway.getPullRequest({ accessToken: token.accessToken, owner, repository: name, number: matches[0]!.number });
      if (!exactPullRequest(verified, publication) || verified.id !== matches[0]!.id) throw new PublicationWorkerError('github_pr_mismatch', 'review_required');
      publication = await checkpoint(dependencies, publication, attempt, { checkpoint: 'pr_verified', eventType: 'pr_verified', githubPullRequestId: verified.id, githubPullRequestNumber: verified.number, githubPullRequestNodeId: verified.nodeId, githubPullRequestUrl: verified.url }, now());
    }
    if (publication.checkpoint === 'pr_verified') {
      await currentAuthority(dependencies.database, publication, resolver); await verifyTargetBranch(dependencies, publication, token.accessToken, owner, name); await verifyDefaultBranch(dependencies, publication, token.accessToken, owner, name, true); await assertOwnership(dependencies.database, attempt, now());
      if (publication.githubPullRequestNumber === null || publication.githubPullRequestId === null) throw new PublicationWorkerError('github_pr_mismatch', 'review_required');
      const verified = await dependencies.gateway.getPullRequest({ accessToken: token.accessToken, owner, repository: name, number: publication.githubPullRequestNumber });
      if (!exactPullRequest(verified, publication) || verified.id !== publication.githubPullRequestId) throw new PublicationWorkerError('github_pr_mismatch', 'review_required');
    }
  } catch (error) {
    operationError = error;
  } finally {
    try { await dependencies.gateway.revokeInstallationAccessToken(token.accessToken); } catch { revocationFailed = true; }
  }
  if (revocationFailed) throw new PublicationWorkerError('token_revocation_unconfirmed', publication.preparedPublicationIdentity === null ? 'failed' : 'review_required');
  if (operationError !== null) throw operationError;
  return publication;
}

export async function processRepairPublicationJobWithResolverInternal(job: RepairQueueJob, dependencies: RepairPublicationWorkerDependencies, resolver: PublicationAuthorityResolver): Promise<JobResult> {
  let payload;
  try { payload = parseRepairPublicationJobPayload(job.data); } catch { return { id: job.id, status: 'deadletter', output: { code: 'invalid_repair_publication_job_payload' } }; }
  const clock = dependencies.clock ?? (() => new Date()); const randomId = dependencies.randomId ?? randomUUID;
  const claim = await claimAttempt(dependencies.database, payload.publicationId, job.id, clock(), randomId);
  if (claim.kind === 'terminal' || claim.kind === 'busy') return { id: job.id, status: 'completed' };
  if (claim.kind === 'exhausted') { await terminal(dependencies, claim.publication, null, 'failed', 'publication_retry_exhausted', clock()); return { id: job.id, status: 'completed' }; }
  const controller = new AbortController(); const abort = () => controller.abort();
  job.signal?.addEventListener('abort', abort, { once: true }); dependencies.shutdownSignal?.addEventListener('abort', abort, { once: true });
  const heartbeat = setInterval(() => { void assertOwnership(dependencies.database, claim.attempt, clock()).catch(() => controller.abort()); }, HEARTBEAT_MS);
  let current = claim.publication;
  try {
    current = await execute(dependencies, current, claim.attempt, resolver);
    if (controller.signal.aborted) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
    await dependencies.database.transaction(async (transaction) => {
      const [finishedAttempt] = await transaction.update(repairPublicationAttempt).set({ state: 'succeeded', completedAt: clock() }).where(and(eq(repairPublicationAttempt.id, claim.attempt.id), eq(repairPublicationAttempt.ownershipToken, claim.attempt.ownershipToken), eq(repairPublicationAttempt.state, 'active'))).returning();
      if (!finishedAttempt) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
      const [published] = await transaction.update(repairPublication).set({ state: 'published', checkpoint: 'completed', completedAt: clock(), updatedAt: clock() }).where(and(eq(repairPublication.id, current.id), eq(repairPublication.state, 'publishing'), eq(repairPublication.checkpoint, 'pr_verified'))).returning();
      if (!published) throw new PublicationWorkerError('publication_ownership_lost', 'retryable');
      await transaction.insert(repairPublicationEvent).values({ id: randomId(), publicationId: current.id, attemptId: claim.attempt.id, workspaceId: current.workspaceId, fromState: 'publishing', toState: 'published', checkpoint: 'completed', eventType: 'completed', createdAt: clock() });
    });
    return { id: job.id, status: 'completed' };
  } catch (error) {
    const disposition = error instanceof PublicationWorkerError ? error.disposition : error instanceof PublicationArtifactError || error instanceof HumanReviewError ? 'failed' : 'retryable';
    const code = safeCode(error);
    if (disposition === 'retryable') {
      await dependencies.database.update(repairPublicationAttempt).set({ state: 'failed', failureCode: code, completedAt: clock() }).where(and(eq(repairPublicationAttempt.id, claim.attempt.id), eq(repairPublicationAttempt.ownershipToken, claim.attempt.ownershipToken), eq(repairPublicationAttempt.state, 'active')));
      dependencies.logger.write({ event: 'retry_classified', code });
      return { id: job.id, status: 'failed', output: { code } };
    }
    const [latest] = await dependencies.database.select().from(repairPublication).where(eq(repairPublication.id, current.id)).limit(1);
    const transitioned = await terminal(dependencies, latest ?? current, claim.attempt, disposition, code, clock());
    if (!transitioned) {
      dependencies.logger.write({ event: 'retry_classified', code: 'publication_ownership_lost' });
      return { id: job.id, status: 'failed', output: { code: 'publication_ownership_lost' } };
    }
    return { id: job.id, status: 'completed' };
  } finally {
    clearInterval(heartbeat); job.signal?.removeEventListener('abort', abort); dependencies.shutdownSignal?.removeEventListener('abort', abort);
  }
}

export function processRepairPublicationJob(job: RepairQueueJob, dependencies: RepairPublicationWorkerDependencies): Promise<JobResult> {
  return processRepairPublicationJobWithResolverInternal(job, dependencies, resolveApprovedPublicationAuthority);
}
