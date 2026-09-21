import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { and, eq, sql } from 'drizzle-orm';

import {
  account, aiCandidateGeneration, aiCandidateGenerationAttempt, aiInvestigation,
  candidateVerification, candidateVerificationAttempt, candidateVerificationEvidence,
  executionProfile, githubInstallation, humanReviewDecision, investigation, repairCandidate,
  repairCandidateFile, repairIntent, repairLoop, repairLoopIteration, repairRun,
  repository, repositoryBaseline, user, workspace,
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

const NOW = new Date('2032-02-03T04:05:06.000Z');
const COMMIT = 'a'.repeat(40); const SOURCE = 'c'.repeat(64);
const REPOSITORY_ID = 61001; const INSTALLATION_ID = 62001;
const FILE_CONTENT = '<script>alert("escaped")</script>\nexport const repaired = true;\n';

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
  await context.database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 1001, ownerLogin: 'reviewer', name: 'repo', fullName: 'reviewer/repo', defaultBranch: 'main', isPrivate: true });
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
