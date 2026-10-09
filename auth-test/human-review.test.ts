import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Sandbox } from '@vercel/sandbox';

import { and, eq, sql } from 'drizzle-orm';

import {
  account, aiCandidateGeneration, aiCandidateGenerationAttempt, aiInvestigation,
  candidateVerification, candidateVerificationAttempt, candidateVerificationEvidence,
  executionBudgetGrant, executionBudgetGrantRevocation, executionProfile, externalExecutionEvent, externalExecutionLease, externalExecutionReservation,
  githubInstallation, humanReviewDecision, investigation, repairCandidate,
  repairCandidateFile, repairIntent, repairLoop, repairLoopIteration, repairRun,
  releaseAcceptance, releaseAcceptanceRevocation, repairPublication, repairPublicationAttempt, repairPublicationEvent, repository, repositoryBaseline, user, workspace,
} from '../db/schema.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { AccessDeniedError } from '../lib/auth/protected-context.ts';
import { computeCandidateIdentity, sha256 } from '../lib/repair-candidates/identity.ts';
import { canonicalRecord } from '../lib/repair-loops/canonical.ts';
import { deriveBaselineRecoveryContract } from '../lib/repair-loops/objective-contract.ts';
import { computeExecutionProfileIdentity } from '../lib/execution-profiles/detector.ts';
import {
  HumanReviewError,
  createHumanReviewDecision,
  getHumanReview,
  resolveApprovedHumanReviewAuthority,
  resolveApprovedPublicationAuthority,
} from '../lib/human-reviews/flow.ts';
import { createHumanReviewHandlers } from '../lib/human-reviews/handlers.ts';
import { CandidateVerificationError, startCandidateVerification } from '../lib/candidate-verifications/flow.ts';
import { createTestContext } from './support.ts';
import { createRepairPublication, RepairPublicationError } from '../lib/repair-publications/flow.ts';
import { processRepairPublicationJobForTest, reserveApprovedPublicationForTest } from '../lib/repair-publications/testing.ts';
import { processRepairPublicationJob } from '../lib/repair-publications/worker.ts';
import { parseRepairPublicationJobPayload, type TransactionalRepairPublicationQueue } from '../lib/repair-runs/queue.ts';
import { prepareGitPublication, type PreparedGitPublication } from '../lib/repair-publications/git-objects.ts';
import type { PublicationPullRequest, RepairPublicationGateway } from '../lib/repair-publications/types.ts';
import { createRepairPublicationHandlers } from '../lib/repair-publications/handlers.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { computeExecutionGrantIdentity, computeReleaseAcceptanceIdentity } from '../lib/external-execution/identity.ts';
import { acceptanceIdentityPayload, ReleaseAcceptanceError, resolveReleaseAcceptance } from '../lib/release-acceptance/resolver.ts';
import { computePublicationBootstrapPurpose, resolvePublicationReleaseAuthority } from '../lib/release-acceptance/publication-gate.ts';

const NOW = new Date('2032-02-03T04:05:06.000Z');
const COMMIT = 'a'.repeat(40); const SOURCE = 'c'.repeat(64);
const REPOSITORY_ID = 61001; const INSTALLATION_ID = 62001;
const RELEASE_SHA = '7'.repeat(40);
const FILE_CONTENT = '<script>alert("escaped")</script>\nexport const repaired = true;\n';

test('publication queue payload contains only its durable publication identifier', () => {
  const id = randomUUID();
  assert.deepEqual(parseRepairPublicationJobPayload({ version: 1, publicationId: id }), { version: 1, publicationId: id });
  assert.throws(() => parseRepairPublicationJobPayload({ version: 1, publicationId: id, repositoryId: REPOSITORY_ID }), /invalid_repair_publication_job_payload/);
});

async function seedVerifiedReview(
  context: Awaited<ReturnType<typeof createTestContext>>,
  options: { checksPassed?: boolean; loopState?: 'verified' | 'review_required'; candidateSelfCheck?: boolean; objectiveEvidenceConsistent?: boolean; activeConflict?: boolean; evidenceAttemptMismatch?: boolean; evidenceOutcomeConsistent?: boolean } = {},
) {
  const checksPassed = options.checksPassed ?? true;
  const loopState = options.loopState ?? 'verified';
  const userId = randomUUID(); const workspaceId = randomUUID(); const runId = randomUUID(); const baselineId = randomUUID();
  const investigationId = randomUUID(); const aiInvestigationId = randomUUID(); const loopId = randomUUID(); const iterationId = randomUUID();
  const generationId = randomUUID(); const candidateId = randomUUID(); const verificationId = randomUUID(); const attemptId = randomUUID(); const evidenceId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'Reviewer', email: `${userId}@test.invalid`, emailVerified: true });
  await context.database.insert(account).values({ id: randomUUID(), issuer: 'local:oauth:github', accountId: '1001', providerId: 'github', userId });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await context.database.insert(githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId, githubAccountId: 1001, accountLogin: 'reviewer', accountType: 'User', status: 'active' });
  await context.database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 1001, ownerLogin: 'reviewer', name: 'repo', fullName: 'reviewer/repo', defaultBranch: 'main', isPrivate: false });
  const profileIdentity = computeExecutionProfileIdentity({ baseCommitSha: COMMIT, build: { script: 'build', tool: 'npm' }, githubRepositoryId: REPOSITORY_ID, install: { operation: 'ci', tool: 'npm' }, installationId: INSTALLATION_ID, lockfileType: 'package-lock', nodeMajor: 24, packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), packageManager: 'npm', profileVersion: 2, runtimeFamily: 'node', test: { script: 'test', tool: 'npm' }, testRunner: 'vitest', typecheck: { script: 'typecheck', tool: 'npm' }, workspaceId });
  const profile = { githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), status: 'ready' } as const;
  await context.database.insert(executionProfile).values(profile);
  const baseline = { id: baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity, baseCommitSha: COMMIT, archiveSha256: '2'.repeat(64), sandboxName: 'baseline-review', sourceIdentityBefore: SOURCE, sourceIdentityAfter: SOURCE, sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'failed', testExitCode: 1, testTimedOut: false, executionOutcome: 'test_failed', overallOutcome: 'test_failed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'npm_command_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 } as const;
  await context.database.insert(repositoryBaseline).values(baseline);
  await context.database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId, baselineOutcome: 'test_failed', failureClassification: 'customer_baseline_failure', failureCode: 'test_failed', baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  const repairIntentId = randomUUID(); const objectiveText = 'Repair the measured test failure.';
  await context.database.insert(repairIntent).values({ id: repairIntentId, repairRunId: runId, workspaceId, objective: objectiveText, objectiveHash: sha256(objectiveText) });
  await context.database.insert(investigation).values({ id: investigationId, repairRunId: runId, repairIntentId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: '3'.repeat(40), indexedPathCount: 1, attemptNumber: 1, completedAt: NOW, updatedAt: NOW });
  await context.database.insert(aiInvestigation).values({ id: aiInvestigationId, investigationId, executionOrdinal: 1, idempotencyKey: randomUUID(), repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 1, state: 'completed', queuedAt: NOW, investigationStartedAt: NOW, completedAt: NOW, completionReason: 'model_conclusion', conclusionStatus: 'diagnosis_found', summary: 'Diagnosis.', suspectedFiles: [{ path: 'src/repaired.ts', reason: 'Measured failure.' }], evidenceReferences: [{ kind: 'baseline', reference: baselineId }], proposedApproach: 'Repair.', confidence: 'medium', updatedAt: NOW });
  await context.database.insert(repairLoop).values({ id: loopId, repairRunId: runId, workspaceId, investigationId, aiInvestigationId, protocolVersion: 1, maxIterations: 2, idempotencyKey: randomUUID(), state: 'queued', wakeJobId: randomUUID(), createdAt: NOW, updatedAt: NOW });

  const file = { path: 'src/repaired.ts', operation: 'add' as const, baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256(FILE_CONTENT), resultByteLength: Buffer.byteLength(FILE_CONTENT), resultingContent: FILE_CONTENT };
  const candidateIdentity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity, files: [file] });
  const storedCandidateIdentity = options.candidateSelfCheck === false ? '6'.repeat(64) : candidateIdentity;
  await context.database.insert(repairCandidate).values({ id: candidateId, investigationId, repairRunId: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, formatVersion: 1, ordinal: 1, proposalKey: generationId, proposalIdentity: '4'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: file.resultByteLength, createdAt: NOW, freezingStartedAt: NOW, updatedAt: NOW });
  await context.database.insert(repairCandidateFile).values({ candidateId, ...file });
  await context.database.update(repairCandidate).set({ state: 'frozen', candidateIdentity: storedCandidateIdentity, completedAt: NOW, updatedAt: NOW }).where(eq(repairCandidate.id, candidateId));
  await context.database.insert(aiCandidateGeneration).values({ id: generationId, aiInvestigationId, executionOrdinal: 2, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 4, idempotencyKey: randomUUID(), state: 'frozen', repairCandidateId: candidateId, completionReason: 'proposal_ready', queuedAt: NOW, generationStartedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW });
  await context.database.insert(aiCandidateGenerationAttempt).values({ id: randomUUID(), generationId, queueJobId: randomUUID(), attemptNumber: 1, ownershipToken: randomUUID(), state: 'succeeded', claimedAt: NOW, heartbeatAt: NOW, finishedAt: NOW });
  const contract = deriveBaselineRecoveryContract({ repairRunId: runId, baseline, profile });
  await context.database.insert(repairLoopIteration).values({ id: iterationId, repairLoopId: loopId, ordinal: 1, aiCandidateGenerationId: generationId, objectiveContractVersion: contract.version, objectiveContractSnapshot: JSON.parse(contract.canonicalSnapshot), objectiveContractHash: contract.hash, objectiveContractBytes: contract.bytes, createdAt: NOW });

  const comparison = checksPassed ? 'previous_baseline_failure_resolved' : 'previous_baseline_failure_still_present';
  await context.database.insert(candidateVerification).values({ id: verificationId, candidateId, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, candidateIdentity: storedCandidateIdentity, formatVersion: 1, state: 'queued', createdAt: NOW, queuedAt: NOW, updatedAt: NOW });
  await context.database.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: NOW, updatedAt: NOW }).where(eq(candidateVerification.id, verificationId));
  let attemptVerificationId = verificationId;
  if (options.evidenceAttemptMismatch) {
    attemptVerificationId = randomUUID();
    await context.database.insert(candidateVerification).values({ id: attemptVerificationId, candidateId, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, candidateIdentity: storedCandidateIdentity, formatVersion: 1, state: 'infrastructure_failed', candidateArtifactIntegrity: 'valid', verificationContract: 'infrastructure_failed', baselineComparison: 'not_comparable', failureCode: 'provider_unavailable', createdAt: NOW, queuedAt: NOW, verificationStartedAt: NOW, completedAt: NOW, updatedAt: NOW });
  }
  await context.database.insert(candidateVerificationAttempt).values({ id: attemptId, verificationId: attemptVerificationId, queueJobId: randomUUID(), attemptNumber: 1, expectedEvidenceId: evidenceId, ownershipToken: randomUUID(), state: checksPassed ? 'succeeded' : 'checks_failed', claimedAt: NOW, heartbeatAt: NOW, finishedAt: NOW });
  await context.database.insert(candidateVerificationEvidence).values({ id: evidenceId, verificationId, attemptId, evidenceVersion: 1, candidateId, candidateIdentity: storedCandidateIdentity, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, baselineId, candidateArtifactIntegrity: 'valid', sandboxName: 'verification-review', distinctSandboxConfirmed: true, pristineSourceIdentity: SOURCE, pristineBaseIntegrity: 'valid', reconstructedSourceIdentity: '5'.repeat(64), candidateReconstruction: 'valid', credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: checksPassed ? 'completed' : 'failed', testExitCode: checksPassed ? 0 : 1, testTimedOut: false, sourceIdentityAfter: '5'.repeat(64), sourceIntegrityUnchanged: true, cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', executionOutcome: checksPassed && options.evidenceOutcomeConsistent !== false ? 'checks_passed' : 'test_failed', verificationContract: checksPassed ? 'checks_passed' : 'checks_failed', baselineComparison: checksPassed && options.evidenceOutcomeConsistent === false ? 'regression_detected' : comparison, repairObjectiveEvidence: 'not_measured', errorPhase: checksPassed ? null : 'test', errorCode: checksPassed ? null : 'npm_command_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await context.database.update(candidateVerificationAttempt).set({ evidenceId }).where(eq(candidateVerificationAttempt.id, attemptId));
  await context.database.update(candidateVerification).set({ state: 'completed', candidateArtifactIntegrity: 'valid', verificationContract: checksPassed ? 'checks_passed' : 'checks_failed', baselineComparison: comparison, evidenceId, completedAt: NOW, updatedAt: NOW }).where(eq(candidateVerification.id, verificationId));
  const objectiveEvidence = canonicalRecord({ version: 'baseline_recovery_evidence_v1', repairRunId: runId, baselineId, profileIdentity, candidateId, candidateIdentity: storedCandidateIdentity, verificationId, evidenceId, objectiveContractVersion: contract.version, objectiveContractHash: contract.hash, result: loopState === 'verified' ? 'satisfied' : 'not_measured', evaluatedChecks: loopState === 'verified' && options.objectiveEvidenceConsistent !== false ? ['test'] : [] }, 16 * 1024);
  await context.database.update(repairLoop).set({ state: 'running', startedAt: NOW, updatedAt: NOW }).where(eq(repairLoop.id, loopId));
  await context.database.update(repairLoopIteration).set({ candidateVerificationId: verificationId, objectiveEvidence: loopState === 'verified' ? 'satisfied' : 'not_measured', objectiveEvidenceSnapshot: objectiveEvidence.snapshot, objectiveEvidenceHash: objectiveEvidence.hash, objectiveEvidenceBytes: objectiveEvidence.bytes, decision: loopState === 'verified' ? 'verified' : 'verification_non_repairable', decidedAt: NOW }).where(eq(repairLoopIteration.id, iterationId));
  await context.database.update(repairLoop).set(loopState === 'verified' ? { state: 'verified', selectedCandidateId: candidateId, selectedVerificationId: verificationId, selectedEvidenceId: evidenceId, completedAt: NOW, updatedAt: NOW } : { state: 'review_required', completedAt: NOW, updatedAt: NOW }).where(eq(repairLoop.id, loopId));

  if (options.activeConflict) await context.database.insert(aiCandidateGeneration).values({ id: randomUUID(), aiInvestigationId, executionOrdinal: 3, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 4, idempotencyKey: randomUUID(), state: 'created', createdAt: NOW, updatedAt: NOW });

  const owner = { sessionId: randomUUID(), user: { id: userId, name: 'Reviewer', email: `${userId}@test.invalid` }, githubUserId: '1001', workspace: { id: workspaceId, ownerUserId: userId } } satisfies AuthenticatedWorkspace;
  return { owner, userId, workspaceId, runId, baselineId, investigationId, aiInvestigationId, profileIdentity, loopId, iterationId, generationId, candidateId, candidateIdentity: storedCandidateIdentity, verificationId, evidenceId, file };
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
type PublicationRow = typeof repairPublication.$inferSelect;

class FakePublicationGateway implements RepairPublicationGateway {
  readonly calls: string[] = [];
  branch: string | null = null;
  pullRequests: PublicationPullRequest[] = [];
  defaultBranchReads = 0;
  advanceDefaultAt = Number.POSITIVE_INFINITY;
  branchConflict = false;
  uncertainPr = false;
  substitutePr = false;
  conflictingPr = false;
  failRevocation = false;
  tokenRepositoryPrivate = false;
  revoked = false;
  beforeBranchRead: (() => Promise<void>) | null = null;
  beforePullRequestList: (() => Promise<void>) | null = null;
  afterBranchCreate: (() => Promise<void>) | null = null;
  beforePullRequestGet: (() => Promise<void>) | null = null;
  remoteRepositoryPrivate = false;

  constructor(private readonly row: PublicationRow, private readonly prepared: PreparedGitPublication) {}
  async getInstallation() { this.calls.push('installation'); return { id: INSTALLATION_ID, appId: 1, appSlug: 'vigilo', suspendedAt: null, permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' } }; }
  async createPublicationAccessToken() { this.calls.push('token'); return { accessToken: 'test-token', expiresAt: new Date(NOW.getTime() + 30_000), repository: { id: REPOSITORY_ID, ownerLogin: 'reviewer', name: 'repo', fullName: 'reviewer/repo', defaultBranch: 'main', isPrivate: this.tokenRepositoryPrivate } }; }
  async revokeInstallationAccessToken() { this.calls.push('revoke'); this.revoked = true; if (this.failRevocation) throw new Error('revocation_failed'); }
  async getRepositoryMetadata() { return { id: REPOSITORY_ID, ownerLogin: 'reviewer', name: 'repo', fullName: 'reviewer/repo', defaultBranch: 'main', isPrivate: this.remoteRepositoryPrivate }; }
  async resolveBranchCommit() { this.defaultBranchReads += 1; return this.defaultBranchReads >= this.advanceDefaultAt ? '9'.repeat(40) : COMMIT; }
  async getBranchCommit() {
    const beforeRead = this.beforeBranchRead; this.beforeBranchRead = null;
    if (beforeRead) await beforeRead();
    if (this.branchConflict) return '8'.repeat(40);
    return this.branch;
  }
  async getCommit(input: { commitSha: string }) {
    if (input.commitSha === COMMIT) return { sha: COMMIT, treeSha: EMPTY_TREE, parents: ['0'.repeat(40)], message: 'base', author: { name: 'Base', email: 'base@test.invalid', date: NOW.toISOString() }, committer: { name: 'Base', email: 'base@test.invalid', date: NOW.toISOString() } };
    return { sha: this.prepared.commit.sha, treeSha: this.prepared.treeSha, parents: [COMMIT], message: this.prepared.commit.message, author: { ...this.prepared.commit.author, date: this.prepared.commit.committedAt }, committer: { ...this.prepared.commit.author, date: this.prepared.commit.committedAt } };
  }
  async getTree(input: { treeSha: string }) { return input.treeSha === EMPTY_TREE ? { entries: [], truncated: false } : { entries: this.prepared.entries.map((entry) => ({ ...entry, size: 1 })), truncated: false }; }
  async getBlob(): Promise<{ bytes: Buffer; sha: string }> { throw new Error('unexpected_base_blob'); }
  async createBlob(input: { bytes: Buffer }) { this.calls.push('blob'); return this.prepared.blobs.find((blob) => blob.bytes.equals(input.bytes))!.sha; }
  async createTree() { this.calls.push('tree'); return this.prepared.treeSha; }
  async createCommit() { this.calls.push('commit'); return this.prepared.commit.sha; }
  async createBranch(input: { commitSha: string }) {
    this.calls.push('branch'); this.branch = input.commitSha;
    const afterCreate = this.afterBranchCreate; this.afterBranchCreate = null;
    if (afterCreate) await afterCreate();
  }
  private pr(): PublicationPullRequest { return { id: 7001, number: 17, nodeId: 'PR_node', url: 'https://github.com/reviewer/repo/pull/17', state: 'open', draft: true, title: this.row.pullRequestTitle, body: this.row.pullRequestBody, headRef: this.row.targetBranch, headSha: this.prepared.commit.sha, baseRef: 'main', baseSha: COMMIT, repositoryId: REPOSITORY_ID }; }
  async createDraftPullRequest() { this.calls.push('pr'); if (this.uncertainPr) throw new Error('transport_unknown'); const pr = this.pr(); this.pullRequests = [pr]; return pr; }
  async listPullRequests() {
    const beforeList = this.beforePullRequestList; this.beforePullRequestList = null;
    if (beforeList) await beforeList();
    if (this.conflictingPr) return [{ ...this.pr(), title: 'Conflicting pre-existing pull request' }];
    return this.pullRequests;
  }
  async getPullRequest() {
    const beforeGet = this.beforePullRequestGet; this.beforePullRequestGet = null;
    if (beforeGet) await beforeGet();
    const value = this.pullRequests[0] ?? this.pr(); return this.substitutePr ? { ...value, headSha: '7'.repeat(40) } : value;
  }
}

async function approvedPublication(context: Awaited<ReturnType<typeof createTestContext>>) {
  const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  const authority = await resolveApprovedHumanReviewAuthority(context.database, seeded.workspaceId, decision.id);
  const queue: TransactionalRepairPublicationQueue = { enqueuePublication: async (_transaction, payload) => payload.publicationId };
  const publication = await reserveApprovedPublicationForTest(context.database, seeded.owner, queue, authority, { decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID() }, { clock: () => NOW });
  const [row] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, publication.id)); assert.ok(row);
  const prepared = prepareGitPublication({ baseCommitSha: COMMIT, baseTreeSha: EMPTY_TREE, candidateIdentity: seeded.candidateIdentity, committedAt: NOW, files: [seeded.file], profileIdentity: seeded.profileIdentity, treeEntries: [] });
  return { authority, publication, row, prepared };
}

const grantLimits = {
  logicalRequests: 10, providerAttempts: 10, inputTokens: 10_000, outputTokens: 10_000,
  sandboxIdentities: 10, sandboxRuntimeMs: 100_000, verificationAttempts: 10, repairLoopIterations: 10,
  maxConcurrentExternalOperations: 4,
};

async function insertAcceptance(
  context: Awaited<ReturnType<typeof createTestContext>>,
  values: Partial<typeof releaseAcceptance.$inferInsert> & Pick<typeof releaseAcceptance.$inferInsert, 'kind' | 'workspaceId'>,
) {
  const row = {
    id: randomUUID(), version: 1, state: 'passed', releasedCommitSha: RELEASE_SHA,
    protocolVersion: null, repairRunId: null, repairLoopId: null, repairLoopIterationId: null,
    aiCandidateGenerationId: null, repairCandidateId: null, candidateIdentity: null,
    candidateVerificationId: null, verificationEvidenceId: null, verificationEvidenceIdentity: null,
    objectiveContractHash: null, objectiveEvidenceHash: null, humanReviewDecisionId: null,
    repairPublicationId: null, providerId: null, modelId: null, sandboxExecutionIdentity: null,
    executionBudgetGrantId: null, executionReservationIds: [] as string[], reviewedBy: 'release-reviewer',
    acceptedAt: NOW, createdAt: NOW, acceptanceIdentity: '',
    boundaryVersion: values.kind === 'repair_loop_live' ? 'repair-loop-live-v1'
      : values.kind === 'human_review_live' ? 'human-review-v1'
        : values.kind === 'draft_publication_live' ? 'draft-publication-v1' : 'external-authority-v1',
    ...values,
  } satisfies typeof releaseAcceptance.$inferInsert;
  row.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(row as typeof releaseAcceptance.$inferSelect));
  const [created] = await context.database.insert(releaseAcceptance).values(row).returning();
  assert.ok(created);
  return created;
}

async function seedPublicationAcceptances(context: Awaited<ReturnType<typeof createTestContext>>) {
  const seeded = await approvedPublication(context);
  const operatorId = seeded.authority.reviewerUserId;
  const accountGrantId = randomUUID(); const operationGrantId = randomUUID();
  const expiresAt = new Date('2033-01-01T00:00:00.000Z');
  await context.database.insert(executionBudgetGrant).values({
    id: accountGrantId, version: 1, scope: 'account', maxLogicalRequests: grantLimits.logicalRequests,
    maxProviderAttempts: grantLimits.providerAttempts, maxInputTokens: grantLimits.inputTokens,
    maxOutputTokens: grantLimits.outputTokens, maxSandboxIdentities: grantLimits.sandboxIdentities,
    maxSandboxRuntimeMs: grantLimits.sandboxRuntimeMs, maxVerificationAttempts: grantLimits.verificationAttempts,
    maxRepairLoopIterations: grantLimits.repairLoopIterations, maxConcurrentExternalOperations: grantLimits.maxConcurrentExternalOperations,
    expiresAt, authorizedBy: operatorId, createdAt: NOW,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null,
      githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null,
      acceptancePurpose: null, limits: grantLimits, expiresAt: expiresAt.toISOString(), authorizedBy: operatorId }),
  });
  const operationLimits = { ...grantLimits, logicalRequests: 1, repairLoopIterations: 1, maxConcurrentExternalOperations: 0 };
  await context.database.insert(executionBudgetGrant).values({
    id: operationGrantId, version: 1, scope: 'operation', workspaceId: seeded.authority.workspaceId,
    repairRunId: seeded.authority.repairRunId, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT,
    operationCategory: 'repair_loop_iteration', providerId: 'vigilo', maxLogicalRequests: 1,
    maxProviderAttempts: operationLimits.providerAttempts, maxInputTokens: operationLimits.inputTokens,
    maxOutputTokens: operationLimits.outputTokens, maxSandboxIdentities: operationLimits.sandboxIdentities,
    maxSandboxRuntimeMs: operationLimits.sandboxRuntimeMs, maxVerificationAttempts: operationLimits.verificationAttempts,
    maxRepairLoopIterations: 1, maxConcurrentExternalOperations: 0, expiresAt, authorizedBy: operatorId, createdAt: NOW,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId: seeded.authority.workspaceId,
      repairRunId: seeded.authority.repairRunId, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT,
      operationCategory: 'repair_loop_iteration', providerId: 'vigilo', modelId: null, acceptancePurpose: null,
      limits: operationLimits, expiresAt: expiresAt.toISOString(), authorizedBy: operatorId }),
  });
  const sandboxBinding = { name: 'verification-review', teamId: 'team_test', projectId: 'project_test' };
  let sandboxCreateDispatches = 0;
  const authorizer = new DurableExternalExecutionAuthorizer(context.database, { clock: () => NOW, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://vercel.com'); assert.equal(url.pathname, '/api/v3/sandboxes');
    assert.equal(init?.method, 'POST'); assert.equal(JSON.parse(String(init.body)).name, sandboxBinding.name);
    assert.equal(++sandboxCreateDispatches, 1, 'acceptance fixture permits exactly one fake creation dispatch');
    const session = { id: 'test-review-session', memory: 2048, vcpus: 1, region: 'test', timeout: 1000,
      status: 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
    return Response.json({ session, sandbox: { name: sandboxBinding.name, persistent: false,
      createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: session.status }, routes: [] });
  } });
  const execution = await authorizer.reserve({
    grantId: operationGrantId, accountGrantId,
    scope: { workspaceId: seeded.authority.workspaceId, repairRunId: seeded.authority.repairRunId,
      githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, operationCategory: 'repair_loop_iteration', providerId: 'vigilo' },
    amounts: { logicalRequests: 1, providerAttempts: 0, inputTokens: 0, outputTokens: 0,
      sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 1 },
  });
  await execution.complete('succeeded');
  const liveReservations = [execution.reservationId];
  for (const category of ['gemini_candidate_generation', 'sandbox_verification'] as const) {
    const model = category === 'gemini_candidate_generation';
    const grantId = randomUUID();
    const scope = { workspaceId: seeded.authority.workspaceId, repairRunId: seeded.authority.repairRunId,
      githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, operationCategory: category,
      providerId: model ? 'google' : 'vercel', ...(model ? { modelId: 'gemini-3.1-flash-lite' } : {}) };
    const amounts = { logicalRequests: 1, providerAttempts: 1, inputTokens: model ? 100 : 0, outputTokens: model ? 100 : 0,
      sandboxIdentities: model ? 0 : 1, sandboxRuntimeMs: model ? 0 : 1000,
      ...(!model ? { sandboxResourceClass: 'vcpu_1' as const } : {}), verificationAttempts: model ? 0 : 1, repairLoopIterations: 0 };
    await context.database.insert(executionBudgetGrant).values({
      id: grantId, version: 1, scope: 'operation', ...scope, maxLogicalRequests: 1, maxProviderAttempts: 1,
      maxInputTokens: amounts.inputTokens, maxOutputTokens: amounts.outputTokens,
      maxSandboxIdentities: amounts.sandboxIdentities, maxSandboxRuntimeMs: amounts.sandboxRuntimeMs,
      sandboxResourceClass: model ? null : 'vcpu_1', maxVerificationAttempts: amounts.verificationAttempts,
      maxRepairLoopIterations: 0, maxConcurrentExternalOperations: 0, expiresAt, authorizedBy: operatorId, createdAt: NOW,
      grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'operation', ...scope, modelId: model ? 'gemini-3.1-flash-lite' : null,
        acceptancePurpose: null, limits: { ...amounts, maxConcurrentExternalOperations: 0 }, expiresAt: expiresAt.toISOString(), authorizedBy: operatorId }),
    });
    const permit = await authorizer.reserve({ grantId, accountGrantId, scope, amounts, ...(!model ? { sandbox: sandboxBinding } : {}) });
    if (model) {
      const ordinal = await permit.beginProviderAttempt();
      await permit.finishProviderAttempt(ordinal, 'succeeded');
    } else {
      // Exercise the real identity-bearing admission/SDK parsing contract, not
      // a generic attempt API that cannot authorize a Sandbox creation.
      const sandbox = await Sandbox.create({ ...sandboxBinding, token: 'test-only-not-real-vercel-token',
        image: 'vercel/sandbox/node:24', persistent: false, timeout: 1000, resources: { vcpus: 1 }, fetch: permit.meteredFetch });
      assert.ok(permit.resolveSandboxCreation);
      await permit.resolveSandboxCreation({ name: sandbox.name, sessionId: sandbox.currentSession().sessionId });
    }
    await permit.complete('succeeded');
    liveReservations.push(permit.reservationId);
  }
  assert.equal(sandboxCreateDispatches, 1);
  const [evidence] = await context.database.select().from(candidateVerificationEvidence)
    .where(eq(candidateVerificationEvidence.id, seeded.authority.verificationEvidenceId));
  assert.ok(evidence);
  const repair = await insertAcceptance(context, {
    kind: 'repair_loop_live', workspaceId: seeded.authority.workspaceId, protocolVersion: 4, reviewedBy: operatorId,
    repairRunId: seeded.authority.repairRunId, repairLoopId: seeded.authority.repairLoopId,
    repairLoopIterationId: seeded.authority.repairLoopIterationId, aiCandidateGenerationId: seeded.authority.aiCandidateGenerationId,
    repairCandidateId: seeded.authority.repairCandidateId, candidateIdentity: seeded.authority.candidateIdentity,
    candidateVerificationId: seeded.authority.candidateVerificationId, verificationEvidenceId: seeded.authority.verificationEvidenceId,
    verificationEvidenceIdentity: seeded.authority.verificationEvidenceIdentity, objectiveContractHash: seeded.authority.objectiveContractHash,
    objectiveEvidenceHash: seeded.authority.objectiveEvidenceHash, providerId: 'google', modelId: 'gemini-3.1-flash-lite',
    sandboxExecutionIdentity: computeReleaseAcceptanceIdentity({ sandboxName: evidence.sandboxName, sandboxSessionId: evidence.sandboxSessionId,
      verificationId: seeded.authority.candidateVerificationId, evidenceId: seeded.authority.verificationEvidenceId }),
    executionBudgetGrantId: accountGrantId, executionReservationIds: liveReservations,
  });
  const human = await insertAcceptance(context, {
    kind: 'human_review_live', workspaceId: seeded.authority.workspaceId, repairRunId: seeded.authority.repairRunId, reviewedBy: operatorId,
    repairLoopId: seeded.authority.repairLoopId, repairLoopIterationId: seeded.authority.repairLoopIterationId,
    aiCandidateGenerationId: seeded.authority.aiCandidateGenerationId, repairCandidateId: seeded.authority.repairCandidateId,
    candidateIdentity: seeded.authority.candidateIdentity, candidateVerificationId: seeded.authority.candidateVerificationId,
    verificationEvidenceId: seeded.authority.verificationEvidenceId, verificationEvidenceIdentity: seeded.authority.verificationEvidenceIdentity,
    objectiveContractHash: seeded.authority.objectiveContractHash, objectiveEvidenceHash: seeded.authority.objectiveEvidenceHash,
    humanReviewDecisionId: seeded.authority.humanReviewDecisionId,
  });
  const security = await insertAcceptance(context, {
    kind: 'security_cost_control', workspaceId: seeded.authority.workspaceId, reviewedBy: operatorId,
    executionBudgetGrantId: accountGrantId, executionReservationIds: liveReservations,
  });
  return { ...seeded, accountGrantId, authorizer, repair, human, security, expiresAt };
}

for (const defect of ['ambiguous_outcome', 'ambiguous_lease', 'unresolved_outcome', 'missing_authority'] as const) {
  test(`M7.7 release audit: ${defect} cannot be laundered through an otherwise passed acceptance`, async (t) => {
    const context = await createTestContext(); t.after(() => context.client.close());
    const seeded = await seedPublicationAcceptances(context);
    const boundary = { kind: 'repair_loop_live' as const, workspaceId: seeded.authority.workspaceId,
      releasedCommitSha: RELEASE_SHA, boundaryVersion: 'repair-loop-live-v1', protocolVersion: 4,
      providerId: 'google', modelId: 'gemini-3.1-flash-lite' };
    assert.equal((await resolveReleaseAcceptance(context.database, boundary)).id, seeded.repair.id);
    const [reservation] = await context.database.select().from(externalExecutionReservation).where(and(
      eq(externalExecutionReservation.repairRunId, seeded.authority.repairRunId),
      eq(externalExecutionReservation.operationCategory, 'sandbox_verification'),
    ));
    assert.ok(reservation);
    // Deliberate catalog tampering is confined to this isolated PGlite fixture:
    // prove the unchanged resolver independently refuses forged/incomplete audit.
    if (defect === 'ambiguous_lease') {
      await context.database.execute(sql`drop trigger external_execution_lease_mutation_guard on external_execution_lease`);
      await context.database.update(externalExecutionLease).set({ state: 'ambiguous', failureCode: 'provider_attempt_ambiguous' })
        .where(eq(externalExecutionLease.reservationId, reservation.id));
    } else if (defect === 'missing_authority') {
      await context.database.execute(sql`drop trigger release_acceptance_mutation_guard on release_acceptance`);
      const changed = { ...seeded.repair, executionReservationIds: seeded.repair.executionReservationIds.filter((id) => id !== reservation.id) };
      await context.database.update(releaseAcceptance).set({ executionReservationIds: changed.executionReservationIds,
        acceptanceIdentity: computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(changed)) }).where(eq(releaseAcceptance.id, changed.id));
    } else {
      await context.database.execute(sql`drop trigger external_execution_event_mutation_guard on external_execution_event`);
      const outcome = and(eq(externalExecutionEvent.reservationId, reservation.id), eq(externalExecutionEvent.eventType, 'attempt_succeeded'));
      if (defect === 'unresolved_outcome') await context.database.delete(externalExecutionEvent).where(outcome);
      else await context.database.update(externalExecutionEvent).set({ eventType: 'attempt_ambiguous', failureCode: 'provider_attempt_ambiguous' }).where(outcome);
    }
    await assert.rejects(resolveReleaseAcceptance(context.database, boundary),
      (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_boundary_mismatch');
  });
}

async function insertBootstrapGrant(
  context: Awaited<ReturnType<typeof createTestContext>>,
  seeded: Awaited<ReturnType<typeof seedPublicationAcceptances>>,
  options: { purpose?: string; expiresAt?: Date; authorizedBy?: string } = {},
) {
  const id = randomUUID();
  const purpose = options.purpose ?? computePublicationBootstrapPurpose(seeded.authority, RELEASE_SHA);
  const expiresAt = options.expiresAt ?? seeded.expiresAt;
  const authorizedBy = options.authorizedBy ?? seeded.authority.reviewerUserId;
  const limits = { logicalRequests: 1, providerAttempts: 0, inputTokens: 0, outputTokens: 0,
    sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0,
    maxConcurrentExternalOperations: 0 };
  await context.database.insert(executionBudgetGrant).values({
    id, version: 1, scope: 'one_shot', workspaceId: seeded.authority.workspaceId,
    repairRunId: seeded.authority.repairRunId, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT,
    operationCategory: 'release_acceptance_one_shot', providerId: 'vigilo', acceptancePurpose: purpose,
    maxLogicalRequests: 1, maxProviderAttempts: 0, maxInputTokens: 0, maxOutputTokens: 0,
    maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0,
    maxConcurrentExternalOperations: 0, expiresAt, authorizedBy, createdAt: NOW,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'one_shot', workspaceId: seeded.authority.workspaceId,
      repairRunId: seeded.authority.repairRunId, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT,
      operationCategory: 'release_acceptance_one_shot', providerId: 'vigilo', modelId: null, acceptancePurpose: purpose,
      limits, expiresAt: expiresAt.toISOString(), authorizedBy }),
  });
  return { id, purpose };
}

test('partial acceptance sets and wrong release or subject identities remain unavailable', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedPublicationAcceptances(context);
  await assert.rejects(
    resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW }),
    (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_missing',
  );
  await assert.rejects(
    resolvePublicationReleaseAuthority(context.database, seeded.authority, '8'.repeat(40), { clock: () => NOW }),
    (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_missing',
  );
  await insertBootstrapGrant(context, seeded);
  for (const changed of [
    { ...seeded.authority, workspaceId: randomUUID() },
    { ...seeded.authority, githubRepositoryId: REPOSITORY_ID + 1 },
    { ...seeded.authority, baseCommitSha: '9'.repeat(40) },
    { ...seeded.authority, repairCandidateId: randomUUID() },
    { ...seeded.authority, candidateIdentity: '9'.repeat(64) },
    { ...seeded.authority, candidateVerificationId: randomUUID() },
    { ...seeded.authority, verificationEvidenceId: randomUUID() },
    { ...seeded.authority, verificationEvidenceIdentity: '9'.repeat(64) },
    { ...seeded.authority, humanReviewDecisionId: randomUUID() },
  ]) await assert.rejects(resolvePublicationReleaseAuthority(context.database, changed, RELEASE_SHA, { clock: () => NOW }));
});

test('acceptance-publication bootstrap is exact, expiring, revocable, and one-shot under concurrency', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedPublicationAcceptances(context);
  const bootstrap = await insertBootstrapGrant(context, seeded);
  const eligible = await resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW });
  assert.deepEqual(eligible.releaseAuthorization, {
    mode: 'acceptance_bootstrap', releasedCommitSha: RELEASE_SHA,
    acceptanceIds: [seeded.repair.id, seeded.human.id, seeded.security.id], purpose: bootstrap.purpose,
    oneShotGrantId: bootstrap.id, accountGrantId: seeded.accountGrantId, reservationId: null,
  });
  const request = {
    grantId: bootstrap.id, accountGrantId: seeded.accountGrantId, operationKey: seeded.publication.id,
    scope: { workspaceId: seeded.authority.workspaceId, repairRunId: seeded.authority.repairRunId,
      githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, operationCategory: 'release_acceptance_one_shot' as const,
      providerId: 'vigilo', acceptancePurpose: bootstrap.purpose },
    amounts: { logicalRequests: 1, providerAttempts: 0, inputTokens: 0, outputTokens: 0,
      sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0 },
  };
  const outcomes = await Promise.allSettled([seeded.authorizer.reserve(request), seeded.authorizer.reserve(request)]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const permit = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof seeded.authorizer.reserve>>> => outcome.status === 'fulfilled')!.value;
  const active = await resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW, operationKey: seeded.publication.id });
  assert.equal(active.releaseAuthorization.mode, 'acceptance_bootstrap');
  if (active.releaseAuthorization.mode === 'acceptance_bootstrap') assert.equal(active.releaseAuthorization.reservationId, permit.reservationId);
  await assert.rejects(resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW }));
  await permit.complete('ambiguous', 'provider_attempt_ambiguous');
  await assert.rejects(resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW, operationKey: seeded.publication.id }));

  const expiredContext = await createTestContext(); t.after(() => expiredContext.client.close());
  const expired = await seedPublicationAcceptances(expiredContext);
  await insertBootstrapGrant(expiredContext, expired, { expiresAt: new Date(NOW.getTime() - 1_000) });
  await assert.rejects(resolvePublicationReleaseAuthority(expiredContext.database, expired.authority, RELEASE_SHA, { clock: () => NOW }));

  const revokedContext = await createTestContext(); t.after(() => revokedContext.client.close());
  const revoked = await seedPublicationAcceptances(revokedContext); const revokedGrant = await insertBootstrapGrant(revokedContext, revoked);
  await revokedContext.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: revokedGrant.id, reasonCode: 'operator_revoked', revokedBy: 'release-operator', createdAt: NOW });
  await assert.rejects(resolvePublicationReleaseAuthority(revokedContext.database, revoked.authority, RELEASE_SHA, { clock: () => NOW }),
    (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_revoked');

  const wrongContext = await createTestContext(); t.after(() => wrongContext.client.close());
  const wrong = await seedPublicationAcceptances(wrongContext);
  await insertBootstrapGrant(wrongContext, wrong, { purpose: `draft-pr-v1:${'f'.repeat(64)}` });
  await assert.rejects(resolvePublicationReleaseAuthority(wrongContext.database, wrong.authority, RELEASE_SHA, { clock: () => NOW }));

  const issuerContext = await createTestContext(); t.after(() => issuerContext.client.close());
  const issuer = await seedPublicationAcceptances(issuerContext);
  await insertBootstrapGrant(issuerContext, issuer, { authorizedBy: 'test-issuer' });
  await assert.rejects(resolvePublicationReleaseAuthority(issuerContext.database, issuer.authority, RELEASE_SHA, { clock: () => NOW }));
});

test('normal HTTP authority cannot use the operator bootstrap', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedPublicationAcceptances(context);
  await insertBootstrapGrant(context, seeded);
  const previous = process.env.VIGILO_RELEASE_SHA;
  process.env.VIGILO_RELEASE_SHA = RELEASE_SHA;
  try {
    await assert.rejects(resolveApprovedPublicationAuthority(context.database, seeded.authority.workspaceId, seeded.authority.humanReviewDecisionId),
      (error: unknown) => error instanceof HumanReviewError && error.code === 'live_acceptance_pending');
  } finally {
    if (previous === undefined) delete process.env.VIGILO_RELEASE_SHA;
    else process.env.VIGILO_RELEASE_SHA = previous;
  }
});

test('revoked cost authority and synthetic execution without provider audit cannot open bootstrap', async (t) => {
  for (const scenario of ['revoked', 'no_provider_audit'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close());
    const seeded = await seedPublicationAcceptances(context);
    await insertBootstrapGrant(context, seeded);
    if (scenario === 'revoked') await context.database.insert(executionBudgetGrantRevocation).values({
      id: randomUUID(), grantId: seeded.accountGrantId, reasonCode: 'operator_revoked', revokedBy: 'release-operator', createdAt: NOW,
    });
    else {
      await context.database.execute(sql`drop trigger external_execution_event_mutation_guard on external_execution_event`);
      await context.database.execute(sql`delete from external_execution_event where event_type like 'attempt_%'`);
    }
    await assert.rejects(resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW }));
  }
});

test('a late branch response cannot revive an expired publication attempt or create a PR', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await approvedPublication(context);
  const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
  let now = NOW;
  gateway.afterBranchCreate = async () => { now = new Date(NOW.getTime() + 91_000); };
  const result = await processRepairPublicationJobForTest(
    { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never,
    { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' },
      gateway, logger: { write() {} }, clock: () => now }, async () => seeded.authority,
  );
  assert.equal(result.status, 'failed');
  assert.equal(gateway.calls.includes('pr'), false);
  const [stored] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
  assert.notEqual(stored?.state, 'published');
});

test('a remote public-to-private transition fences the next publication write', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await approvedPublication(context);
  const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
  gateway.afterBranchCreate = async () => { gateway.remoteRepositoryPrivate = true; };
  await processRepairPublicationJobForTest(
    { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never,
    { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' },
      gateway, logger: { write() {} }, clock: () => NOW }, async () => seeded.authority,
  );
  assert.equal(gateway.calls.includes('branch'), true);
  assert.equal(gateway.calls.includes('pr'), false);
  assert.equal(gateway.revoked, true);
  const [stored] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
  assert.equal(stored?.failureCode, 'private_repository_not_supported');
  assert.notEqual(stored?.state, 'published');
});

test('the complete exact acceptance set opens only normal publication and revocation closes it', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedPublicationAcceptances(context);
  const bootstrap = await insertBootstrapGrant(context, seeded);
  const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
  const resolver = (database: typeof context.database) => resolvePublicationReleaseAuthority(database, seeded.authority, RELEASE_SHA, { clock: () => NOW, operationKey: seeded.publication.id });
  const published = await processRepairPublicationJobForTest(
    { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never,
    { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' },
      gateway, logger: { write() {} }, clock: () => NOW, executionAuthority: seeded.authorizer },
    resolver,
  );
  assert.equal(published.status, 'completed');
  const [reservation] = await context.database.select().from(externalExecutionReservation)
    .where(eq(externalExecutionReservation.operationKey, seeded.publication.id));
  assert.ok(reservation);
  const [lease] = await context.database.select().from(externalExecutionLease)
    .where(eq(externalExecutionLease.reservationId, reservation.id));
  assert.equal(lease?.state, 'succeeded');
  const draft = await insertAcceptance(context, {
    kind: 'draft_publication_live', workspaceId: seeded.authority.workspaceId, reviewedBy: seeded.authority.reviewerUserId,
    repairRunId: seeded.authority.repairRunId, repairLoopId: seeded.authority.repairLoopId,
    repairLoopIterationId: seeded.authority.repairLoopIterationId, aiCandidateGenerationId: seeded.authority.aiCandidateGenerationId,
    repairCandidateId: seeded.authority.repairCandidateId, candidateIdentity: seeded.authority.candidateIdentity,
    candidateVerificationId: seeded.authority.candidateVerificationId, verificationEvidenceId: seeded.authority.verificationEvidenceId,
    verificationEvidenceIdentity: seeded.authority.verificationEvidenceIdentity, objectiveContractHash: seeded.authority.objectiveContractHash,
    objectiveEvidenceHash: seeded.authority.objectiveEvidenceHash, humanReviewDecisionId: seeded.authority.humanReviewDecisionId,
    repairPublicationId: seeded.publication.id, executionBudgetGrantId: bootstrap.id, executionReservationIds: [reservation.id],
  });
  const resolved = await resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW });
  assert.equal(resolved.releaseAuthorization.mode, 'normal');
  for (const changed of [
    { ...seeded.authority, githubRepositoryId: REPOSITORY_ID + 1 },
    { ...seeded.authority, baseCommitSha: '9'.repeat(40) },
    { ...seeded.authority, repairCandidateId: randomUUID() },
    { ...seeded.authority, candidateIdentity: '9'.repeat(64) },
    { ...seeded.authority, candidateVerificationId: randomUUID() },
    { ...seeded.authority, verificationEvidenceId: randomUUID() },
    { ...seeded.authority, verificationEvidenceIdentity: '9'.repeat(64) },
    { ...seeded.authority, humanReviewDecisionId: randomUUID() },
    { ...seeded.authority, humanReviewDecisionIdentity: '9'.repeat(64) },
    { ...seeded.authority, reviewSubjectIdentity: '9'.repeat(64) },
  ]) await assert.rejects(
    resolvePublicationReleaseAuthority(context.database, changed, RELEASE_SHA, { clock: () => NOW }),
    (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_boundary_mismatch',
  );
  await context.database.insert(releaseAcceptanceRevocation).values({ id: randomUUID(), acceptanceId: draft.id, reasonCode: 'boundary_changed', revokedBy: 'release-reviewer', createdAt: NOW });
  await assert.rejects(resolvePublicationReleaseAuthority(context.database, seeded.authority, RELEASE_SHA, { clock: () => NOW }),
    (error: unknown) => error instanceof ReleaseAcceptanceError && error.code === 'acceptance_revoked');
});

test('bootstrap worker consumes ambiguity and post-response revocation fences further GitHub writes', async (t) => {
  const run = async (revokeAfterBranch: boolean) => {
    const context = await createTestContext(); t.after(() => context.client.close());
    const seeded = await seedPublicationAcceptances(context);
    await insertBootstrapGrant(context, seeded);
    const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
    gateway.uncertainPr = !revokeAfterBranch;
    if (revokeAfterBranch) gateway.afterBranchCreate = async () => {
      await context.database.insert(releaseAcceptanceRevocation).values({
        id: randomUUID(), acceptanceId: seeded.human.id, reasonCode: 'boundary_changed', revokedBy: 'release-reviewer', createdAt: NOW,
      });
    };
    const resolver = async (database: typeof context.database) => {
      try {
        return await resolvePublicationReleaseAuthority(database, seeded.authority, RELEASE_SHA, { clock: () => NOW, operationKey: seeded.publication.id });
      } catch {
        throw new HumanReviewError('live_acceptance_pending');
      }
    };
    const result = await processRepairPublicationJobForTest(
      { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never,
      { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' },
        gateway, logger: { write() {} }, clock: () => NOW, executionAuthority: seeded.authorizer },
      resolver,
    );
    assert.equal(result.status, 'completed');
    const [reservation] = await context.database.select().from(externalExecutionReservation)
      .where(eq(externalExecutionReservation.operationKey, seeded.publication.id));
    assert.ok(reservation);
    const [lease] = await context.database.select().from(externalExecutionLease)
      .where(eq(externalExecutionLease.reservationId, reservation.id));
    assert.equal(lease?.state, 'ambiguous');
    assert.equal(gateway.calls.includes('branch'), true);
    assert.equal(gateway.calls.includes('pr'), !revokeAfterBranch);
    const beforeRetry = [...gateway.calls];
    await processRepairPublicationJobForTest(
      { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never,
      { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' },
        gateway, logger: { write() {} }, clock: () => NOW, executionAuthority: seeded.authorizer },
      resolver,
    );
    assert.deepEqual(gateway.calls, beforeRetry);
  };
  await run(false);
  await run(true);
});

test('eligible exact evidence can be approved and remains immutable and release-gated', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  assert.equal(review.status, 'awaiting_decision');
  assert.equal(review.subject?.candidate.files[0]?.resultingContent, FILE_CONTENT);
  assert.equal(review.subject?.candidate.id, seeded.candidateId);
  assert.equal(review.subject?.verification.id, seeded.verificationId);
  assert.equal(review.subject?.verification.evidenceId, seeded.evidenceId);
  assert.equal(review.liveAcceptanceStatus, 'pending');
  assert.ok(review.history.items.some((item) => item.kind === 'candidate_verification_attempt'));
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  assert.equal(decision.decision, 'approved');
  await assert.rejects(context.database.update(humanReviewDecision).set({ decision: 'rejected' }).where(eq(humanReviewDecision.id, decision.id)));
  const authority = await resolveApprovedHumanReviewAuthority(context.database, seeded.workspaceId, decision.id);
  assert.deepEqual({ candidateId: authority.repairCandidateId, verificationId: authority.candidateVerificationId, evidenceId: authority.verificationEvidenceId }, { candidateId: seeded.candidateId, verificationId: seeded.verificationId, evidenceId: seeded.evidenceId });
  await assert.rejects(resolveApprovedPublicationAuthority(context.database, seeded.workspaceId, decision.id), (error: unknown) => error instanceof HumanReviewError && error.code === 'live_acceptance_pending');
  await context.database.execute(sql`drop trigger human_review_decision_mutation_guard on human_review_decision`);
  await context.database.update(humanReviewDecision).set({ githubRepositoryId: REPOSITORY_ID + 1 }).where(eq(humanReviewDecision.id, decision.id));
  await assert.rejects(resolveApprovedHumanReviewAuthority(context.database, seeded.workspaceId, decision.id), (error: unknown) => error instanceof HumanReviewError && error.code === 'human_review_ineligible');
});

test('a rejected human decision cannot become live acceptance evidence', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, {
    decision: 'rejected', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID(),
  });
  await assert.rejects(context.database.insert(releaseAcceptance).values({
    id: randomUUID(), version: 1, kind: 'human_review_live', state: 'passed', boundaryVersion: 'human-review-v1',
    releasedCommitSha: '7'.repeat(40), workspaceId: seeded.workspaceId, repairRunId: seeded.runId,
    repairCandidateId: seeded.candidateId, candidateIdentity: seeded.candidateIdentity,
    candidateVerificationId: seeded.verificationId, verificationEvidenceId: seeded.evidenceId,
    humanReviewDecisionId: decision.id, executionReservationIds: [], reviewedBy: seeded.userId,
    acceptedAt: NOW, acceptanceIdentity: '8'.repeat(64), createdAt: NOW,
  }));
});

test('production publication reservation remains hard-closed and performs no queue or GitHub work', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  let queueCalls = 0;
  const queue: TransactionalRepairPublicationQueue = { enqueuePublication: async (_transaction, payload) => { queueCalls += 1; return payload.publicationId; } };
  await assert.rejects(
    createRepairPublication(context.database, seeded.owner, queue, seeded.runId, { decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID() }),
    (error: unknown) => error instanceof HumanReviewError && error.code === 'live_acceptance_pending',
  );
  assert.equal(queueCalls, 0);
  assert.equal((await context.database.select().from(repairPublication)).length, 0);
});

test('test-local publication reservation is exact, idempotent, immutable, and workspace isolated', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  const authority = await resolveApprovedHumanReviewAuthority(context.database, seeded.workspaceId, decision.id);
  const key = randomUUID(); let queueCalls = 0;
  const queue: TransactionalRepairPublicationQueue = { enqueuePublication: async (_transaction, payload) => { queueCalls += 1; return payload.publicationId; } };
  const [first, second] = await Promise.all([
    reserveApprovedPublicationForTest(context.database, seeded.owner, queue, authority, { decisionIdentity: decision.decisionIdentity, idempotencyKey: key }, { clock: () => new Date(NOW.getTime() + 789) }),
    reserveApprovedPublicationForTest(context.database, seeded.owner, queue, authority, { decisionIdentity: decision.decisionIdentity, idempotencyKey: key }, { clock: () => new Date(NOW.getTime() + 789) }),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(queueCalls, 1);
  const [stored] = await context.database.select().from(repairPublication);
  assert.ok(stored);
  assert.equal(stored.createdAt.toISOString(), NOW.toISOString());
  assert.deepEqual({ run: stored.repairRunId, loop: stored.repairLoopId, decision: stored.humanReviewDecisionId, candidate: stored.repairCandidateId, verification: stored.candidateVerificationId, evidence: stored.verificationEvidenceId }, { run: seeded.runId, loop: seeded.loopId, decision: decision.id, candidate: seeded.candidateId, verification: seeded.verificationId, evidence: seeded.evidenceId });
  assert.equal((await context.database.select().from(repairPublicationEvent)).length, 1);
  await assert.rejects(context.database.update(repairPublication).set({ targetBranch: `vigilo/repair/${'f'.repeat(64)}` }).where(eq(repairPublication.id, first.id)));
  await assert.rejects(context.database.delete(repairPublication).where(eq(repairPublication.id, first.id)));
  const [event] = await context.database.select().from(repairPublicationEvent).where(eq(repairPublicationEvent.publicationId, first.id)); assert.ok(event);
  await assert.rejects(context.database.update(repairPublicationEvent).set({ eventType: 'failed' }).where(eq(repairPublicationEvent.id, event.id)));
  await assert.rejects(context.database.delete(repairPublicationEvent).where(eq(repairPublicationEvent.id, event.id)));
  const foreign = { ...seeded.owner, workspace: { ...seeded.owner.workspace, id: randomUUID() } };
  await assert.rejects(reserveApprovedPublicationForTest(context.database, foreign, queue, authority, { decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID() }), (error: unknown) => error instanceof RepairPublicationError && error.code === 'publication_invalid_request');
});

test('production publication worker rechecks the real release gate before any GitHub operation', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  const authority = await resolveApprovedHumanReviewAuthority(context.database, seeded.workspaceId, decision.id);
  const queue: TransactionalRepairPublicationQueue = { enqueuePublication: async (_transaction, payload) => payload.publicationId };
  const publication = await reserveApprovedPublicationForTest(context.database, seeded.owner, queue, authority, { decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID() }, { clock: () => NOW });
  let gatewayCalls = 0;
  const unavailable = new Proxy({}, { get: () => async () => { gatewayCalls += 1; throw new Error('unexpected_gateway_call'); } });
  const result = await processRepairPublicationJob({ id: publication.id, data: { version: 1, publicationId: publication.id } } as never, { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' }, gateway: unavailable as never, logger: { write() {} }, clock: () => NOW });
  assert.equal(result.status, 'completed');
  assert.equal(gatewayCalls, 0);
  const [failed] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, publication.id));
  assert.deepEqual({ state: failed?.state, code: failed?.failureCode }, { state: 'failed', code: 'live_acceptance_pending' });
});

test('publication handlers accept only explicit same-origin confirmation and remain gate-closed', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const decision = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  let queued = 0;
  const handlers = createRepairPublicationHandlers({ database: context.database, configuration: { baseUrl: 'http://localhost:3000' } as never, queue: { enqueuePublication: async (_transaction, payload) => { queued += 1; return payload.publicationId; } }, resolveContext: async () => seeded.owner });
  const body = new URLSearchParams({ confirmation: 'publish_draft', decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID() });
  const forbidden = await handlers.create(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body }), seeded.runId);
  assert.equal(forbidden.status, 403);
  const closed = await handlers.create(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }, body }), seeded.runId);
  assert.equal(closed.status, 303); assert.match(closed.headers.get('location')!, /live_acceptance_pending/); assert.equal(queued, 0);
  const forged = new URLSearchParams({ confirmation: 'publish_draft', decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID(), repositoryId: String(REPOSITORY_ID) });
  const rejected = await handlers.create(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }, body: forged }), seeded.runId);
  assert.match(rejected.headers.get('location')!, /publication_invalid_request/);
  const oversized = new URLSearchParams({ confirmation: 'publish_draft', decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID(), padding: 'x'.repeat(2_000) });
  const tooLarge = await handlers.create(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }, body: oversized }), seeded.runId);
  assert.match(tooLarge.headers.get('location')!, /publication_invalid_request/);
  const wrongMedia = await handlers.create(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: '{}' }), seeded.runId);
  assert.match(wrongMedia.headers.get('location')!, /publication_invalid_request/);
  const read = await handlers.read(new Request('http://localhost:3000/api'), seeded.runId);
  assert.equal(read.headers.get('cache-control'), 'private, no-store'); assert.deepEqual(await read.json(), { publication: null, events: [] });
});

test('test-local worker publishes and reconciles one exact branch and draft PR', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const seeded = await approvedPublication(context); const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
  const job = { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never;
  const dependencies = { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' }, gateway, logger: { write() {} }, clock: () => NOW };
  const result = await processRepairPublicationJobForTest(job, dependencies, async () => seeded.authority);
  assert.equal(result.status, 'completed');
  const [published] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
  assert.deepEqual({ state: published?.state, checkpoint: published?.checkpoint, branch: published?.remoteBranchCommitSha, pr: published?.githubPullRequestNumber }, { state: 'published', checkpoint: 'completed', branch: seeded.prepared.commit.sha, pr: 17 });
  assert.deepEqual(gateway.calls, ['installation', 'token', 'blob', 'tree', 'commit', 'branch', 'pr', 'revoke']);
  assert.equal(gateway.revoked, true);
  const before = gateway.calls.length;
  assert.equal((await processRepairPublicationJobForTest(job, dependencies, async () => seeded.authority)).status, 'completed');
  assert.equal(gateway.calls.length, before);
  const [attempt] = await context.database.select().from(repairPublicationAttempt).where(eq(repairPublicationAttempt.publicationId, seeded.publication.id)); assert.ok(attempt);
  await assert.rejects(context.database.update(repairPublicationAttempt).set({ ownershipToken: randomUUID() }).where(eq(repairPublicationAttempt.id, attempt.id)));
  await assert.rejects(context.database.delete(repairPublicationAttempt).where(eq(repairPublicationAttempt.id, attempt.id)));
});

test('branch or PR substitution, base advance, ambiguous PR creation, and revocation failure stop closed', async (t) => {
  for (const scenario of ['branch_conflict', 'base_advance', 'uncertain_pr', 'pr_substitution', 'pr_collision', 'revoke_failure', 'revoke_after_error'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close());
    const seeded = await approvedPublication(context); const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
    if (scenario === 'branch_conflict' || scenario === 'revoke_after_error') gateway.branchConflict = true;
    if (scenario === 'base_advance') gateway.advanceDefaultAt = 5;
    if (scenario === 'uncertain_pr') gateway.uncertainPr = true;
    if (scenario === 'pr_substitution') gateway.substitutePr = true;
    if (scenario === 'pr_collision') gateway.conflictingPr = true;
    if (scenario === 'revoke_failure' || scenario === 'revoke_after_error') gateway.failRevocation = true;
    const result = await processRepairPublicationJobForTest({ id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never, { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' }, gateway, logger: { write() {} }, clock: () => NOW }, async () => seeded.authority);
    assert.equal(result.status, 'completed', scenario);
    const [stored] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
    assert.equal(stored?.state, 'review_required', scenario);
    assert.equal(stored?.failureCode, scenario === 'branch_conflict' ? 'github_branch_conflict' : scenario === 'base_advance' ? 'base_advanced_after_branch' : scenario === 'uncertain_pr' ? 'github_pr_outcome_unknown' : scenario === 'pr_substitution' ? 'github_pr_mismatch' : scenario === 'pr_collision' ? 'github_pr_ambiguous' : 'token_revocation_unconfirmed');
    assert.equal(gateway.revoked, true, scenario);
    if (scenario === 'branch_conflict' || scenario === 'base_advance' || scenario === 'pr_collision') assert.ok(!gateway.calls.includes('pr'), scenario);
  }
});

test('lease loss cannot authorize a successor GitHub write or stale terminal transition', async (t) => {
  const abandonActiveAttempt = async (context: Awaited<ReturnType<typeof createTestContext>>, publicationId: string) => {
    const [attempt] = await context.database.select().from(repairPublicationAttempt).where(and(eq(repairPublicationAttempt.publicationId, publicationId), eq(repairPublicationAttempt.state, 'active'))).limit(1);
    assert.ok(attempt);
    await context.database.update(repairPublicationAttempt).set({ state: 'abandoned', failureCode: 'stale_worker_recovery', completedAt: NOW }).where(eq(repairPublicationAttempt.id, attempt.id));
  };

  for (const boundary of ['branch_create', 'pr_create', 'terminal'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close());
    const seeded = await approvedPublication(context); const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
    if (boundary === 'pr_create') gateway.beforePullRequestList = () => abandonActiveAttempt(context, seeded.publication.id);
    else gateway.beforeBranchRead = () => abandonActiveAttempt(context, seeded.publication.id);
    if (boundary === 'terminal') gateway.branchConflict = true;

    const result = await processRepairPublicationJobForTest(
      { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never,
      { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' }, gateway, logger: { write() {} }, clock: () => NOW },
      async () => seeded.authority,
    );
    assert.deepEqual({ status: result.status, code: result.output?.code }, { status: 'failed', code: 'publication_ownership_lost' }, boundary);
    const [stored] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
    assert.equal(stored?.state, 'publishing', boundary);
    assert.equal(stored?.checkpoint, boundary === 'pr_create' ? 'pr_create_requested' : 'branch_create_requested', boundary);
    if (boundary !== 'pr_create') assert.equal(gateway.calls.includes('branch'), false, boundary);
    assert.equal(gateway.calls.includes('pr'), false, boundary);
  }
});

test('restart records exact branch and PR facts before classifying an advanced base', async (t) => {
  const abandonActiveAttempt = async (context: Awaited<ReturnType<typeof createTestContext>>, publicationId: string) => {
    const [attempt] = await context.database.select().from(repairPublicationAttempt).where(and(eq(repairPublicationAttempt.publicationId, publicationId), eq(repairPublicationAttempt.state, 'active'))).limit(1);
    assert.ok(attempt);
    await context.database.update(repairPublicationAttempt).set({ state: 'abandoned', failureCode: 'stale_worker_recovery', completedAt: NOW }).where(eq(repairPublicationAttempt.id, attempt.id));
  };

  for (const boundary of ['branch', 'pull_request'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close());
    const seeded = await approvedPublication(context); const gateway = new FakePublicationGateway(seeded.row, seeded.prepared);
    if (boundary === 'branch') gateway.afterBranchCreate = () => abandonActiveAttempt(context, seeded.publication.id);
    else gateway.beforePullRequestGet = () => abandonActiveAttempt(context, seeded.publication.id);
    const job = { id: seeded.publication.id, data: { version: 1, publicationId: seeded.publication.id } } as never;
    const dependencies = { database: context.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' }, gateway, logger: { write() {} }, clock: () => NOW };

    const interrupted = await processRepairPublicationJobForTest(job, dependencies, async () => seeded.authority);
    assert.deepEqual({ status: interrupted.status, code: interrupted.output?.code }, { status: 'failed', code: 'publication_ownership_lost' }, boundary);
    const [beforeResume] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
    assert.equal(beforeResume?.checkpoint, boundary === 'branch' ? 'branch_create_requested' : 'pr_create_requested', boundary);

    gateway.advanceDefaultAt = gateway.defaultBranchReads + 1;
    const resumed = await processRepairPublicationJobForTest(job, dependencies, async () => seeded.authority);
    assert.equal(resumed.status, 'completed', boundary);
    const [afterResume] = await context.database.select().from(repairPublication).where(eq(repairPublication.id, seeded.publication.id));
    assert.deepEqual({ state: afterResume?.state, code: afterResume?.failureCode, branch: afterResume?.remoteBranchCommitSha }, { state: 'review_required', code: 'base_advanced_after_branch', branch: seeded.prepared.commit.sha }, boundary);
    assert.equal(afterResume?.githubPullRequestNumber, boundary === 'pull_request' ? 17 : null, boundary);
  }
});

test('normal rejection is immutable while unmeasured and failed verification subjects stay ineligible', async (t) => {
  const rejectedContext = await createTestContext(); t.after(() => rejectedContext.client.close()); const rejectedSeed = await seedVerifiedReview(rejectedContext);
  const eligible = await getHumanReview(rejectedContext.database, rejectedSeed.owner, rejectedSeed.runId);
  const rejected = await createHumanReviewDecision(rejectedContext.database, rejectedSeed.owner, rejectedSeed.runId, { decision: 'rejected', reviewSubjectIdentity: eligible.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  assert.equal(rejected.decision, 'rejected');
  await assert.rejects(resolveApprovedHumanReviewAuthority(rejectedContext.database, rejectedSeed.workspaceId, rejected.id), (error: unknown) => error instanceof HumanReviewError && error.code === 'decision_not_approved');
  await assert.rejects(resolveApprovedPublicationAuthority(rejectedContext.database, rejectedSeed.workspaceId, rejected.id), (error: unknown) => error instanceof HumanReviewError && error.code === 'decision_not_approved');

  const failedContext = await createTestContext(); t.after(() => failedContext.client.close()); const failed = await seedVerifiedReview(failedContext, { checksPassed: false });
  assert.deepEqual((await getHumanReview(failedContext.database, failed.owner, failed.runId)).status, 'ineligible');
  const unmeasuredContext = await createTestContext(); t.after(() => unmeasuredContext.client.close()); const unmeasured = await seedVerifiedReview(unmeasuredContext, { loopState: 'review_required' });
  const review = await getHumanReview(unmeasuredContext.database, unmeasured.owner, unmeasured.runId);
  assert.equal(review.status, 'ineligible'); assert.equal(review.ineligibleReason, 'objective_not_measured');
});

test('human review and publication fail closed when the selected repository becomes private', async (t) => {
  const reviewContext = await createTestContext(); t.after(() => reviewContext.client.close());
  const reviewSeed = await seedVerifiedReview(reviewContext);
  await reviewContext.database.update(repository).set({ isPrivate: true }).where(eq(repository.githubRepositoryId, REPOSITORY_ID));
  const review = await getHumanReview(reviewContext.database, reviewSeed.owner, reviewSeed.runId);
  assert.equal(review.status, 'ineligible');
  assert.equal(review.ineligibleReason, 'private_repository_not_supported');
  assert.equal(review.subject, null);
  await assert.rejects(
    createHumanReviewDecision(reviewContext.database, reviewSeed.owner, reviewSeed.runId, {
      decision: 'approved', reviewSubjectIdentity: '9'.repeat(64), idempotencyKey: randomUUID(),
    }),
    (error: unknown) => error instanceof HumanReviewError && error.code === 'private_repository_not_supported',
  );

  const publicationContext = await createTestContext(); t.after(() => publicationContext.client.close());
  const publicationSeed = await approvedPublication(publicationContext);
  const gateway = new FakePublicationGateway(publicationSeed.row, publicationSeed.prepared);
  gateway.tokenRepositoryPrivate = true;
  const result = await processRepairPublicationJobForTest(
    { id: publicationSeed.publication.id, data: { version: 1, publicationId: publicationSeed.publication.id } } as never,
    { database: publicationContext.database, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' }, gateway, logger: { write() {} }, clock: () => NOW },
    async () => publicationSeed.authority,
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(gateway.calls, ['installation', 'token', 'revoke']);
  const [stored] = await publicationContext.database.select().from(repairPublication).where(eq(repairPublication.id, publicationSeed.publication.id));
  assert.deepEqual({ state: stored?.state, code: stored?.failureCode }, { state: 'failed', code: 'private_repository_not_supported' });
});

test('candidate, objective-evidence, active-conflict, and missing-loop eligibility failures fail closed', async (t) => {
  const candidateContext = await createTestContext(); t.after(() => candidateContext.client.close());
  const invalidCandidate = await seedVerifiedReview(candidateContext, { candidateSelfCheck: false });
  assert.equal((await getHumanReview(candidateContext.database, invalidCandidate.owner, invalidCandidate.runId)).ineligibleReason, 'candidate_invalid');

  const evidenceContext = await createTestContext(); t.after(() => evidenceContext.client.close());
  const invalidEvidence = await seedVerifiedReview(evidenceContext, { objectiveEvidenceConsistent: false });
  assert.equal((await getHumanReview(evidenceContext.database, invalidEvidence.owner, invalidEvidence.runId)).ineligibleReason, 'evidence_invalid');

  const outcomeContext = await createTestContext(); t.after(() => outcomeContext.client.close());
  const inconsistentOutcome = await seedVerifiedReview(outcomeContext, { evidenceOutcomeConsistent: false });
  assert.equal((await getHumanReview(outcomeContext.database, inconsistentOutcome.owner, inconsistentOutcome.runId)).ineligibleReason, 'evidence_invalid');

  const attemptContext = await createTestContext(); t.after(() => attemptContext.client.close());
  const mismatchedAttempt = await seedVerifiedReview(attemptContext, { evidenceAttemptMismatch: true });
  assert.equal((await getHumanReview(attemptContext.database, mismatchedAttempt.owner, mismatchedAttempt.runId)).ineligibleReason, 'evidence_invalid');
  const [mismatchedIteration] = await attemptContext.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.id, mismatchedAttempt.iterationId));
  await assert.rejects(attemptContext.database.insert(humanReviewDecision).values({
    id: randomUUID(), version: 1, workspaceId: mismatchedAttempt.workspaceId, reviewerUserId: mismatchedAttempt.userId,
    repairRunId: mismatchedAttempt.runId, repairLoopId: mismatchedAttempt.loopId, repairLoopIterationId: mismatchedAttempt.iterationId,
    aiCandidateGenerationId: mismatchedAttempt.generationId, repairCandidateId: mismatchedAttempt.candidateId,
    candidateIdentity: mismatchedAttempt.candidateIdentity, candidateVerificationId: mismatchedAttempt.verificationId,
    verificationEvidenceId: mismatchedAttempt.evidenceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID,
    baselineId: mismatchedAttempt.baselineId, baseCommitSha: COMMIT, profileIdentity: mismatchedAttempt.profileIdentity,
    objectiveContractHash: mismatchedIteration!.objectiveContractHash, objectiveEvidenceHash: mismatchedIteration!.objectiveEvidenceHash!,
    verificationEvidenceIdentity: '7'.repeat(64), reviewSubjectIdentity: '8'.repeat(64), decision: 'approved',
    decisionIdentity: '9'.repeat(64), idempotencyKey: randomUUID(), createdAt: NOW,
  }));

  const conflictContext = await createTestContext(); t.after(() => conflictContext.client.close());
  const conflict = await seedVerifiedReview(conflictContext, { activeConflict: true });
  assert.equal((await getHumanReview(conflictContext.database, conflict.owner, conflict.runId)).ineligibleReason, 'active_conflict');
  assert.equal((await getHumanReview(conflictContext.database, conflict.owner, randomUUID())).ineligibleReason, 'repair_loop_not_verified');

  const ambiguousContext = await createTestContext(); t.after(() => ambiguousContext.client.close());
  const ambiguous = await seedVerifiedReview(ambiguousContext);
  const [selectedIteration] = await ambiguousContext.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.id, ambiguous.iterationId));
  await ambiguousContext.database.execute(sql`drop trigger repair_loop_iteration_update_guard on repair_loop_iteration`);
  await ambiguousContext.database.execute(sql`alter table repair_loop_iteration drop constraint repair_loop_iteration_ai_candidate_generation_id_key`);
  await ambiguousContext.database.execute(sql`alter table repair_loop_iteration drop constraint repair_loop_iteration_candidate_verification_id_key`);
  await ambiguousContext.database.insert(repairLoopIteration).values({
    id: randomUUID(), repairLoopId: ambiguous.loopId, ordinal: 2, aiCandidateGenerationId: ambiguous.generationId,
    previousIterationId: ambiguous.iterationId, objectiveContractVersion: selectedIteration!.objectiveContractVersion,
    objectiveContractSnapshot: selectedIteration!.objectiveContractSnapshot, objectiveContractHash: selectedIteration!.objectiveContractHash,
    objectiveContractBytes: selectedIteration!.objectiveContractBytes, feedbackVersion: 1, feedbackSnapshot: {},
    feedbackHash: '6'.repeat(64), feedbackBytes: 2, feedbackVerificationId: ambiguous.verificationId,
    feedbackEvidenceId: ambiguous.evidenceId, candidateVerificationId: ambiguous.verificationId,
    objectiveEvidence: 'satisfied', objectiveEvidenceSnapshot: selectedIteration!.objectiveEvidenceSnapshot,
    objectiveEvidenceHash: selectedIteration!.objectiveEvidenceHash, objectiveEvidenceBytes: selectedIteration!.objectiveEvidenceBytes,
    decision: 'verified', decidedAt: NOW, createdAt: NOW,
  });
  assert.equal((await getHumanReview(ambiguousContext.database, ambiguous.owner, ambiguous.runId)).ineligibleReason, 'authority_mismatch');
});

test('stale subjects, idempotency conflicts, and concurrent opposite decisions fail closed', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId); const key = randomUUID();
  await assert.rejects(createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: '9'.repeat(64), idempotencyKey: key }), (error: unknown) => error instanceof HumanReviewError && error.code === 'review_subject_stale');
  const first = await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: key });
  assert.equal((await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: key })).id, first.id);
  await assert.rejects(createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'rejected', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: key }), (error: unknown) => error instanceof HumanReviewError && error.code === 'idempotency_conflict');

  const raceContext = await createTestContext(); t.after(() => raceContext.client.close()); const raceSeed = await seedVerifiedReview(raceContext); const raceReview = await getHumanReview(raceContext.database, raceSeed.owner, raceSeed.runId);
  const outcomes = await Promise.allSettled(['approved', 'rejected'].map((decision) => createHumanReviewDecision(raceContext.database, raceSeed.owner, raceSeed.runId, { decision: decision as 'approved' | 'rejected', reviewSubjectIdentity: raceReview.reviewSubjectIdentity!, idempotencyKey: randomUUID() })));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal((await raceContext.database.select().from(humanReviewDecision)).length, 1);

  const sameContext = await createTestContext(); t.after(() => sameContext.client.close()); const sameSeed = await seedVerifiedReview(sameContext); const sameReview = await getHumanReview(sameContext.database, sameSeed.owner, sameSeed.runId);
  const sameOutcomes = await Promise.allSettled([randomUUID(), randomUUID()].map((idempotencyKey) => createHumanReviewDecision(sameContext.database, sameSeed.owner, sameSeed.runId, { decision: 'approved', reviewSubjectIdentity: sameReview.reviewSubjectIdentity!, idempotencyKey })));
  assert.equal(sameOutcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal((await sameContext.database.select().from(humanReviewDecision)).length, 1);
});

test('a human decision closes new generation, candidate, verification, and reverification ownership', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seedVerifiedReview(context);
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  await createHumanReviewDecision(context.database, seeded.owner, seeded.runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });

  await assert.rejects(context.database.insert(aiCandidateGeneration).values({ id: randomUUID(), aiInvestigationId: seeded.aiInvestigationId, executionOrdinal: 3, investigationId: seeded.investigationId, repairRunId: seeded.runId, baselineId: seeded.baselineId, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 4, idempotencyKey: randomUUID(), state: 'created', createdAt: NOW, updatedAt: NOW }));
  await assert.rejects(context.database.insert(repairCandidate).values({ id: randomUUID(), investigationId: seeded.investigationId, repairRunId: seeded.runId, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, formatVersion: 1, ordinal: 2, proposalKey: randomUUID(), proposalIdentity: '7'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: 1, freezingStartedAt: NOW, updatedAt: NOW }));
  await assert.rejects(context.database.insert(candidateVerification).values({ id: randomUUID(), candidateId: seeded.candidateId, investigationId: seeded.investigationId, repairRunId: seeded.runId, baselineId: seeded.baselineId, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, candidateIdentity: seeded.candidateIdentity, formatVersion: 1, state: 'queued', queuedAt: NOW, updatedAt: NOW }));
  await assert.rejects(startCandidateVerification(context.database, seeded.owner, seeded.candidateId, { enqueueVerification: async () => randomUUID() }, { reverify: true }), (error: unknown) => error instanceof CandidateVerificationError && error.code === 'repair_run_reviewed');
});

test('historical terminal reverification does not replace selected evidence or block review', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seedVerifiedReview(context);
  const historicalId = randomUUID();
  await context.database.insert(candidateVerification).values({ id: historicalId, candidateId: seeded.candidateId, investigationId: (await context.database.select().from(repairCandidate).where(eq(repairCandidate.id, seeded.candidateId)))[0]!.investigationId, repairRunId: seeded.runId, baselineId: (await context.database.select().from(repairRun).where(eq(repairRun.id, seeded.runId)))[0]!.baselineId!, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, candidateIdentity: seeded.candidateIdentity, formatVersion: 1, state: 'infrastructure_failed', candidateArtifactIntegrity: null, verificationContract: 'infrastructure_failed', baselineComparison: 'not_comparable', failureCode: 'provider_unavailable', createdAt: new Date(NOW.getTime() - 1_000), queuedAt: new Date(NOW.getTime() - 1_000), verificationStartedAt: new Date(NOW.getTime() - 1_000), completedAt: new Date(NOW.getTime() - 1_000), updatedAt: new Date(NOW.getTime() - 1_000) });
  const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  assert.equal(review.status, 'awaiting_decision'); assert.equal(review.subject?.verification.id, seeded.verificationId);
  const [iteration] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.id, seeded.iterationId));
  await assert.rejects(context.database.insert(humanReviewDecision).values({
    id: randomUUID(), version: 1, workspaceId: seeded.workspaceId, reviewerUserId: seeded.userId,
    repairRunId: seeded.runId, repairLoopId: seeded.loopId, repairLoopIterationId: seeded.iterationId,
    aiCandidateGenerationId: seeded.generationId, repairCandidateId: seeded.candidateId,
    candidateIdentity: seeded.candidateIdentity, candidateVerificationId: historicalId,
    verificationEvidenceId: seeded.evidenceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID,
    baselineId: seeded.baselineId, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity,
    objectiveContractHash: iteration!.objectiveContractHash, objectiveEvidenceHash: iteration!.objectiveEvidenceHash!,
    verificationEvidenceIdentity: '8'.repeat(64), reviewSubjectIdentity: '9'.repeat(64), decision: 'approved',
    decisionIdentity: 'a'.repeat(64), idempotencyKey: randomUUID(), createdAt: NOW,
  }));
});

test('handlers isolate workspaces and accept only the three-field decision contract', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seedVerifiedReview(context); const review = await getHumanReview(context.database, seeded.owner, seeded.runId);
  const outsider = { ...seeded.owner, workspace: { id: randomUUID(), ownerUserId: randomUUID() } };
  const handlers = createHumanReviewHandlers({ database: context.database, configuration: { baseUrl: 'http://localhost:3000' } as never, resolveContext: async (headers) => headers.get('x-outsider') ? outsider : seeded.owner });
  const body = new URLSearchParams({ decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  const response = await handlers.decide(new Request(`http://localhost:3000/api/repair-runs/${seeded.runId}/human-review-decisions`, { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body.toString())) }, body }), seeded.runId);
  assert.equal(response.status, 303);
  const forged = new URLSearchParams({ ...Object.fromEntries(body), candidateId: seeded.candidateId });
  const forgedResponse = await handlers.decide(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(forged.toString())) }, body: forged }), seeded.runId);
  assert.equal(forgedResponse.status, 303);
  assert.match(forgedResponse.headers.get('location') ?? '', /error=invalid_decision/);
  const oversized = new URLSearchParams({ decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID(), padding: 'x'.repeat(1_024) });
  const oversizedResponse = await handlers.decide(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }, body: oversized }), seeded.runId);
  assert.match(oversizedResponse.headers.get('location') ?? '', /error=invalid_decision/);
  const invalidMediaResponse = await handlers.decide(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded-unsupported' }, body }), seeded.runId);
  assert.match(invalidMediaResponse.headers.get('location') ?? '', /error=invalid_decision/);
  const forbidden = await handlers.read(new Request('http://localhost:3000/api'), seeded.runId);
  assert.equal(forbidden.status, 200);
  assert.equal((await handlers.read(new Request('http://localhost:3000/api', { headers: { 'x-outsider': '1' } }), seeded.runId)).status, 404);

  const anonymous = createHumanReviewHandlers({ database: context.database, configuration: { baseUrl: 'http://localhost:3000' }, resolveContext: async () => { throw new AccessDeniedError('unauthorized'); } });
  assert.equal((await anonymous.read(new Request('http://localhost:3000/api'), seeded.runId)).status, 401);
  const anonymousDecision = await anonymous.decide(new Request('http://localhost:3000/api', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body.toString())) }, body }), seeded.runId);
  assert.match(anonymousDecision.headers.get('location') ?? '', /\/sign-in$/);
});
