import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_FIXTURE_HASH, TEST_NAMES } from "../src/baseline.js";
import { PROJECT_ROOT, validateMilestoneProof, validateFailureDemo } from "../src/demo.js";

const hash = "a".repeat(64);
const clean = () => ({ stop: "confirmed", delete: "confirmed", lookup: "absent" });

test("demo host root is normalized for artifact containment checks", () => {
  assert.equal(PROJECT_ROOT.endsWith("/"), false);
});

function proof() {
  return {
    baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
    baseline: { success: true, outcome: "expected_baseline_application_failure",
      sandbox: { name: "vigilo-repair-a", sessionId: "sbx_repair" },
      testResults: { total: 3, passed: 2, failed: 1, expectedFailingTest: TEST_NAMES[1] }, cleanup: clean(),
      credentialsExposure: "absent" },
    candidate: { success: true, baseFixtureIdentity: EXPECTED_FIXTURE_HASH, candidateIdentity: hash,
      changedFileCount: 1, changedPaths: ["src/shipping-cost.ts"], validation: "passed", frozenOutsideSandbox: true,
      sandbox: { name: "vigilo-repair-a", sessionId: "sbx_repair" }, cleanup: clean() },
    verification: { success: true, outcome: "verified", baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
      frozenCandidateIdentity: hash, appliedCandidateIdentity: hash,
      candidateIdentityMatches: true, repairSandbox: { name: "vigilo-repair-a", sessionId: "sbx_repair" },
      verifierSandbox: { name: "vigilo-verifier-b", sessionId: "sbx_verifier" }, distinctSandboxConfirmed: true,
      tests: { total: 3, passed: 3, failed: 0, regression: { name: TEST_NAMES[1], status: "passed" } },
      sourceIdentityUnchangedAfterVerification: true, postVerificationCandidateIdentity: hash,
      credentialsExposure: "absent", cleanup: clean() },
    evidence: { reportId: "b".repeat(64), classification: { overallOutcome: "verified" },
      observations: { baseFixtureIdentity: EXPECTED_FIXTURE_HASH, candidate: { candidateHash: hash } } },
  };
}

test("complete Milestone 1 proof is accepted", () => {
  assert.equal(validateMilestoneProof(proof()).candidateIdentity, hash);
});

test("every happy-path proof remains fail closed", () => {
  const mutations = [
    (value: any) => { value.baseFixtureIdentity = "0".repeat(64); },
    (value: any) => { value.baseline.testResults.failed = 0; },
    (value: any) => { value.baseline.credentialsExposure = "present"; },
    (value: any) => { value.candidate.changedPaths = []; },
    (value: any) => { value.candidate.candidateIdentity = "0".repeat(64); },
    (value: any) => { value.verification.verifierSandbox.sessionId = "sbx_repair"; },
    (value: any) => { value.verification.tests.failed = 1; },
    (value: any) => { value.verification.sourceIdentityUnchangedAfterVerification = false; },
    (value: any) => { value.verification.cleanup.delete = "failed"; },
    (value: any) => { value.evidence.classification.overallOutcome = "incomplete"; },
  ];
  for (const mutate of mutations) {
    const value = proof();
    mutate(value);
    assert.throws(() => validateMilestoneProof(value), /milestone_proof_incomplete/);
  }
});

test("selected Task 1.7 failure demo requires classification, bounded diagnostics, and cleanup", () => {
  const value = { scenario: "installation_failure", classifiedOutcome: "dependency_installation_failure",
    diagnosticsPresent: true, credentialsExposure: "absent", furtherWorkStarted: false,
    cleanup: { requested: true, ...clean() }, acceptancePassed: true };
  assert.equal(validateFailureDemo(value).classifiedOutcome, "dependency_installation_failure");
  for (const bad of [
    { ...value, classifiedOutcome: "unexpected_completion" },
    { ...value, diagnosticsPresent: false },
    { ...value, cleanup: { ...value.cleanup, stop: "failed" } },
    { ...value, acceptancePassed: false },
  ]) assert.throws(() => validateFailureDemo(bad), /failure_demo_incomplete/);
});
