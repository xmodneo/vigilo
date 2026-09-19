import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveBaselineRecoveryContract,
  evaluateBaselineRecovery,
  validateStoredBaselineRecoveryContract,
  type BaselineRecoveryEvidence,
} from '../lib/repair-loops/objective-contract.ts';
import { decideRepairLoopOutcome } from '../lib/repair-loops/decision.ts';
import { canonicalRecord } from '../lib/repair-loops/canonical.ts';

const HASH = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

const baseline = (overrides: Record<string, unknown> = {}) => ({
  id: 'baseline-id', workspaceId: 'workspace-id', githubRepositoryId: 1,
  installationId: 2, evidenceVersion: 1, profileIdentity: HASH,
  baseCommitSha: COMMIT, sourceIdentityBefore: HASH, sourceIdentityAfter: HASH,
  sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all',
  installStatus: 'completed', installExitCode: 0, installTimedOut: false,
  typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false,
  buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false,
  testStatus: 'failed', testExitCode: 1, testTimedOut: false,
  executionOutcome: 'test_failed', overallOutcome: 'test_failed',
  cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent',
  ...overrides,
});

const profile = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'workspace-id', githubRepositoryId: 1, installationId: 2,
  profileIdentity: HASH, baseCommitSha: COMMIT, status: 'ready',
  typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test',
  ...overrides,
});

const evidence = (overrides: Record<string, unknown> = {}) => ({
  id: 'evidence-id', verificationId: 'verification-id', candidateId: 'candidate-id',
  candidateIdentity: HASH, workspaceId: 'workspace-id', githubRepositoryId: 1,
  installationId: 2, baselineId: 'baseline-id', profileIdentity: HASH,
  baseCommitSha: COMMIT, evidenceVersion: 1, candidateArtifactIntegrity: 'valid',
  distinctSandboxConfirmed: true, pristineBaseIntegrity: 'valid',
  candidateReconstruction: 'valid', credentialsExposure: 'absent',
  networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0,
  installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0,
  typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0,
  buildTimedOut: false, testStatus: 'completed', testExitCode: 0,
  testTimedOut: false, reconstructedSourceIdentity: HASH, sourceIdentityAfter: HASH,
  sourceIntegrityUnchanged: true, cleanupStop: 'confirmed', cleanupDelete: 'confirmed',
  cleanupLookup: 'absent', verificationContract: 'checks_passed',
  baselineComparison: 'previous_baseline_failure_resolved', executionOutcome: 'checks_passed',
  ...overrides,
}) as BaselineRecoveryEvidence;

test('baseline_recovery_v1 is server-derived from measured failed required phases', () => {
  const contract = deriveBaselineRecoveryContract({ repairRunId: 'run-id', baseline: baseline(), profile: profile() });
  assert.equal(contract.version, 'baseline_recovery_v1');
  assert.deepEqual(contract.requiredChecks, ['test']);
  assert.match(contract.hash, /^[0-9a-f]{64}$/);
  assert.equal(contract.bytes, Buffer.byteLength(contract.canonicalSnapshot));
  assert.equal(contract.measurable, true);
});

test('stored objective contracts reject malformed checks and mismatched frozen authority', () => {
  const contract = deriveBaselineRecoveryContract({ repairRunId: 'run-id', baseline: baseline(), profile: profile() });
  const authority = { repairRunId: 'run-id', workspaceId: 'workspace-id', githubRepositoryId: 1, installationId: 2, baselineId: 'baseline-id', profileIdentity: HASH, baseCommitSha: COMMIT };
  assert.equal(validateStoredBaselineRecoveryContract(JSON.parse(contract.canonicalSnapshot), contract.hash, contract.bytes, authority).hash, contract.hash);
  const malformed = canonicalRecord({ ...JSON.parse(contract.canonicalSnapshot), requiredChecks: ['unrelated'], baselineFailures: { unrelated: { status: 'failed', exitCode: 1, timedOut: false } } }, 16 * 1024);
  assert.throws(() => validateStoredBaselineRecoveryContract(malformed.snapshot, malformed.hash, malformed.bytes, authority), /objective_contract_invalid/);
  assert.throws(() => validateStoredBaselineRecoveryContract(JSON.parse(contract.canonicalSnapshot), contract.hash, contract.bytes, { ...authority, baselineId: 'foreign-baseline' }), /objective_contract_invalid/);
});

test('baseline_recovery_v1 is not measurable without trustworthy failing required checks', () => {
  const passing = deriveBaselineRecoveryContract({ repairRunId: 'run-id', baseline: baseline({ testStatus: 'completed', testExitCode: 0, executionOutcome: 'baseline_passed', overallOutcome: 'baseline_passed' }), profile: profile() });
  assert.equal(passing.measurable, false);
  assert.deepEqual(passing.requiredChecks, []);
  const ambiguous = deriveBaselineRecoveryContract({ repairRunId: 'run-id', baseline: baseline({ testExitCode: null }), profile: profile() });
  assert.equal(ambiguous.measurable, false);
});

test('exact trustworthy evidence satisfies, fails, or cannot measure the contract', () => {
  const contract = deriveBaselineRecoveryContract({ repairRunId: 'run-id', baseline: baseline(), profile: profile() });
  assert.equal(evaluateBaselineRecovery(contract, evidence()).result, 'satisfied');
  assert.equal(evaluateBaselineRecovery(contract, evidence({ verificationContract: 'checks_failed', executionOutcome: 'test_failed', testStatus: 'failed', testExitCode: 1, baselineComparison: 'previous_baseline_failure_still_present' })).result, 'failed');
  assert.equal(evaluateBaselineRecovery(contract, evidence({ verificationId: 'foreign' }), { verificationId: 'verification-id', candidateId: 'candidate-id', candidateIdentity: HASH, evidenceId: 'evidence-id' }).result, 'not_measured');
  assert.equal(evaluateBaselineRecovery(contract, evidence({ testStatus: 'not_run', testExitCode: null })).result, 'not_measured');
});

test('deterministic decision table never verifies an unmeasured objective', () => {
  assert.deepEqual(decideRepairLoopOutcome({ iterationOrdinal: 1, maxIterations: 2, verificationDisposition: 'trustworthy', objectiveEvidence: 'satisfied', regression: false }), { iterationDecision: 'verified', loopState: 'verified', scheduleNext: false });
  assert.deepEqual(decideRepairLoopOutcome({ iterationOrdinal: 1, maxIterations: 2, verificationDisposition: 'trustworthy', objectiveEvidence: 'failed', regression: false }), { iterationDecision: 'repairable_failure', loopState: 'running', scheduleNext: true });
  assert.deepEqual(decideRepairLoopOutcome({ iterationOrdinal: 1, maxIterations: 2, verificationDisposition: 'trustworthy', objectiveEvidence: 'satisfied', regression: true }), { iterationDecision: 'repairable_failure', loopState: 'running', scheduleNext: true });
  assert.deepEqual(decideRepairLoopOutcome({ iterationOrdinal: 1, maxIterations: 2, verificationDisposition: 'trustworthy', objectiveEvidence: 'not_measured', regression: false }), { iterationDecision: 'verification_non_repairable', loopState: 'review_required', scheduleNext: false });
  assert.equal(decideRepairLoopOutcome({ iterationOrdinal: 2, maxIterations: 2, verificationDisposition: 'trustworthy', objectiveEvidence: 'failed', regression: false }).loopState, 'limit_reached');
});

test('integrity and infrastructure failures stop without another outer iteration', () => {
  assert.equal(decideRepairLoopOutcome({ iterationOrdinal: 1, maxIterations: 2, verificationDisposition: 'integrity_failure', objectiveEvidence: 'not_measured', regression: false }).loopState, 'failed');
  assert.equal(decideRepairLoopOutcome({ iterationOrdinal: 1, maxIterations: 2, verificationDisposition: 'infrastructure_failure', objectiveEvidence: 'not_measured', regression: false }).loopState, 'failed');
});
