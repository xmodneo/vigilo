import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HUMAN_REVIEW_VERSION,
  computeHumanReviewDecisionIdentity,
  computeHumanReviewSubjectIdentity,
  computeVerificationEvidenceIdentity,
} from '../lib/human-reviews/identity.ts';

const HASH = 'a'.repeat(64);
const UUID = '11111111-1111-4111-8111-111111111111';

const evidence = {
  evidenceVersion: 1,
  verificationId: UUID,
  attemptId: '22222222-2222-4222-8222-222222222222',
  attemptVerificationId: UUID,
  attemptExpectedEvidenceId: '33333333-3333-4333-8333-333333333333',
  attemptEvidenceId: '33333333-3333-4333-8333-333333333333',
  attemptState: 'succeeded',
  evidenceId: '33333333-3333-4333-8333-333333333333',
  candidateId: '44444444-4444-4444-8444-444444444444',
  candidateIdentity: HASH,
  workspaceId: '55555555-5555-4555-8555-555555555555',
  githubRepositoryId: 42,
  installationId: 43,
  baseCommitSha: 'b'.repeat(40),
  profileIdentity: 'c'.repeat(64),
  baselineId: '66666666-6666-4666-8666-666666666666',
  candidateArtifactIntegrity: 'valid',
  distinctSandboxConfirmed: true,
  pristineSourceIdentity: 'd'.repeat(64),
  pristineBaseIntegrity: 'valid',
  reconstructedSourceIdentity: 'e'.repeat(64),
  candidateReconstruction: 'valid',
  credentialsExposure: 'absent',
  networkPolicy: 'deny-all',
  installStatus: 'completed', installExitCode: 0, installTimedOut: false,
  typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false,
  buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false,
  testStatus: 'completed', testExitCode: 0, testTimedOut: false,
  sourceIdentityAfter: 'e'.repeat(64), sourceIntegrityUnchanged: true,
  cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent',
  executionOutcome: 'checks_passed', verificationContract: 'checks_passed',
  baselineComparison: 'previous_baseline_failure_resolved', repairObjectiveEvidence: 'not_measured',
  errorPhase: null, errorCode: null,
  startedAt: '2031-01-02T03:04:05.000Z', completedAt: '2031-01-02T03:04:06.000Z', durationMs: 1000,
};

test('human review identities are canonical and bind evidence, subject, reviewer, and decision', () => {
  const evidenceIdentity = computeVerificationEvidenceIdentity(evidence);
  assert.match(evidenceIdentity, /^[0-9a-f]{64}$/);
  assert.equal(computeVerificationEvidenceIdentity({ ...evidence }), evidenceIdentity);
  assert.notEqual(computeVerificationEvidenceIdentity({ ...evidence, testExitCode: 1 }), evidenceIdentity);

  const subject = {
    version: HUMAN_REVIEW_VERSION,
    workspaceId: evidence.workspaceId,
    repairRunId: '77777777-7777-4777-8777-777777777777',
    repairLoopId: '88888888-8888-4888-8888-888888888888',
    repairLoopIterationId: '99999999-9999-4999-8999-999999999999',
    aiCandidateGenerationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repairCandidateId: evidence.candidateId,
    candidateIdentity: evidence.candidateIdentity,
    candidateVerificationId: evidence.verificationId,
    verificationEvidenceId: evidence.evidenceId,
    githubRepositoryId: evidence.githubRepositoryId,
    installationId: evidence.installationId,
    baselineId: evidence.baselineId,
    baseCommitSha: evidence.baseCommitSha,
    profileIdentity: evidence.profileIdentity,
    objectiveContractHash: 'f'.repeat(64),
    objectiveEvidenceHash: '1'.repeat(64),
    verificationEvidenceIdentity: evidenceIdentity,
  } as const;
  const subjectIdentity = computeHumanReviewSubjectIdentity(subject);
  assert.equal(computeHumanReviewSubjectIdentity({ ...subject }), subjectIdentity);
  assert.notEqual(computeHumanReviewSubjectIdentity({ ...subject, repairCandidateId: UUID }), subjectIdentity);
  assert.notEqual(computeHumanReviewSubjectIdentity({ ...subject, candidateVerificationId: '12111111-1111-4111-8111-111111111111' }), subjectIdentity);
  assert.notEqual(computeHumanReviewSubjectIdentity({ ...subject, verificationEvidenceId: UUID }), subjectIdentity);
  assert.notEqual(computeHumanReviewSubjectIdentity({ ...subject, objectiveEvidenceHash: '2'.repeat(64) }), subjectIdentity);
  assert.notEqual(
    computeHumanReviewDecisionIdentity({ subjectIdentity, reviewerUserId: UUID, decision: 'approved' }),
    computeHumanReviewDecisionIdentity({ subjectIdentity, reviewerUserId: UUID, decision: 'rejected' }),
  );
});
