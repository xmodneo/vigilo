import { fileURLToPath } from "node:url";
import { APIError } from "@vercel/sandbox";
import { EXPECTED_FIXTURE_HASH, TEST_NAMES, createBaselineReport, executeBaseline, fixtureHash, loadOriginalFixture } from "./baseline.js";
import { CandidateError, type Candidate } from "./candidate.js";
import { collectPredeterminedCandidate, freezeCandidateOnHost } from "./freeze-candidate.js";
import { object, INSTALL_POLICY, ExecutionFailure } from "./fixture-execution.js";
import { SandboxBoundary } from "./sandbox-boundary.js";
import { runVerification } from "./verify-candidate.js";
import { generateEvidenceFile, writeEvidenceRecord } from "./evidence-report.js";
import { runFailureScenario } from "./failure-cleanup.js";

function clean(value: unknown) {
  const cleanup = object(value);
  return cleanup.stop === "confirmed" && cleanup.delete === "confirmed" && cleanup.lookup === "absent";
}
function requireProof(condition: unknown, code = "milestone_proof_incomplete"): asserts condition {
  if (!condition) throw new Error(code);
}
function hostArtifactPath(value: unknown) {
  requireProof(typeof value === "string" && value.startsWith(`${PROJECT_ROOT}/`), "artifact_path_missing");
  return value;
}
function relativeArtifactPath(value: unknown) {
  return hostArtifactPath(value).slice(PROJECT_ROOT.length + 1);
}

export function validateMilestoneProof(input: unknown) {
  const proof = object(input);
  const baseline = object(proof.baseline);
  const baselineTests = object(baseline.testResults);
  const candidate = object(proof.candidate);
  const repairSandbox = object(candidate.sandbox);
  const verification = object(proof.verification);
  const verificationTests = object(verification.tests);
  const regression = object(verificationTests.regression);
  const verifierSandbox = object(verification.verifierSandbox);
  const recordedRepairSandbox = object(verification.repairSandbox);
  const evidence = object(proof.evidence);
  const classification = object(evidence.classification);
  const observations = object(evidence.observations);
  const evidenceCandidate = object(observations.candidate);
  const candidateIdentity = candidate.candidateIdentity;
  requireProof(proof.baseFixtureIdentity === EXPECTED_FIXTURE_HASH &&
    baseline.success === true && baseline.outcome === "expected_baseline_application_failure" &&
    baselineTests.total === 3 && baselineTests.passed === 2 && baselineTests.failed === 1 &&
    baselineTests.expectedFailingTest === TEST_NAMES[1] && baseline.credentialsExposure === "absent" && clean(baseline.cleanup) &&
    candidate.success === true && candidate.baseFixtureIdentity === EXPECTED_FIXTURE_HASH &&
    typeof candidateIdentity === "string" && /^[a-f0-9]{64}$/.test(candidateIdentity) &&
    candidate.changedFileCount === 1 && JSON.stringify(candidate.changedPaths) === JSON.stringify(["src/shipping-cost.ts"]) &&
    candidate.validation === "passed" && candidate.frozenOutsideSandbox === true && clean(candidate.cleanup) &&
    repairSandbox.name === object(baseline.sandbox).name && repairSandbox.sessionId === object(baseline.sandbox).sessionId &&
    verification.success === true && verification.outcome === "verified" &&
    verification.baseFixtureIdentity === EXPECTED_FIXTURE_HASH && verification.frozenCandidateIdentity === candidateIdentity &&
    verification.appliedCandidateIdentity === candidateIdentity && verification.candidateIdentityMatches === true &&
    recordedRepairSandbox.name === repairSandbox.name && recordedRepairSandbox.sessionId === repairSandbox.sessionId &&
    verification.distinctSandboxConfirmed === true && verifierSandbox.name !== repairSandbox.name &&
    typeof verifierSandbox.sessionId === "string" && verifierSandbox.sessionId !== repairSandbox.sessionId &&
    verificationTests.total === 3 && verificationTests.passed === 3 && verificationTests.failed === 0 &&
    regression.name === TEST_NAMES[1] && regression.status === "passed" &&
    verification.sourceIdentityUnchangedAfterVerification === true &&
    verification.postVerificationCandidateIdentity === candidateIdentity && verification.credentialsExposure === "absent" &&
    clean(verification.cleanup) && classification.overallOutcome === "verified" &&
    observations.baseFixtureIdentity === EXPECTED_FIXTURE_HASH && evidenceCandidate.candidateHash === candidateIdentity &&
    typeof evidence.reportId === "string" && /^[a-f0-9]{64}$/.test(evidence.reportId));
  return { baseFixtureIdentity: EXPECTED_FIXTURE_HASH, candidateIdentity,
    reportId: evidence.reportId as string, repairSandbox: { name: repairSandbox.name as string, sessionId: repairSandbox.sessionId as string },
    verifierSandbox: { name: verifierSandbox.name as string, sessionId: verifierSandbox.sessionId as string } };
}

export function validateFailureDemo(input: unknown) {
  const result = object(input);
  requireProof(result.scenario === "installation_failure" && result.classifiedOutcome === "dependency_installation_failure" &&
    result.diagnosticsPresent === true && result.credentialsExposure === "absent" && result.furtherWorkStarted === false &&
    object(result.cleanup).requested === true && clean(result.cleanup) && result.acceptancePassed === true,
  "failure_demo_incomplete");
  return result;
}

type Progress = (message: string) => void;
function errorCode(error: unknown) {
  return error instanceof CandidateError || error instanceof ExecutionFailure ? error.message
    : error instanceof APIError ? `provider_http_${error.response.status}` : "operation_failed";
}

export async function runMilestoneDemo(progress: Progress = () => {}) {
  const boundary = new SandboxBoundary("vigilo-repair", INSTALL_POLICY, 300_000);
  const baseline = createBaselineReport(boundary);
  const candidateResult = {
    success: false, baseFixtureIdentity: EXPECTED_FIXTURE_HASH, candidateIdentity: null as string | null,
    changedFileCount: 0, changedPaths: [] as string[], changedContentHashes: [] as { path: string; sha256: string }[],
    validation: "not_run", frozenOutsideSandbox: false, credentialsExposure: "not_checked",
    sandbox: boundary.evidence, cleanup: boundary.cleanup, error: null as { phase: string; code: string } | null,
  };
  let verification: Awaited<ReturnType<typeof runVerification>> | null = null;
  let evidence: ReturnType<typeof generateEvidenceFile>["report"] | null = null;
  let evidencePath: string | null = null;
  let recordPath: string | null = null;
  let candidate: Candidate | undefined;
  let candidatePath: string | null = null;
  let phase = "fixture_integrity";
  try {
    const original = loadOriginalFixture();
    requireProof(fixtureHash(original) === EXPECTED_FIXTURE_HASH);
    baseline.fixture.localVerified = true;
    progress("fixture identity validated");
    phase = "repair_sandbox";
    await boundary.run(async (sandbox, signal) => {
      await executeBaseline(sandbox, boundary, signal, original, baseline, value => { phase = `baseline:${value}`; });
      requireProof(baseline.outcome === "expected_baseline_application_failure" && baseline.testResults?.passed === 2 &&
        baseline.testResults.failed === 1 && baseline.testResults.expectedFailingTest === TEST_NAMES[1]);
      progress("broken baseline reproduced: 2 passed, 1 known failure");
      phase = "candidate:apply";
      candidate = await collectPredeterminedCandidate(sandbox, boundary, signal, original, true,
        value => { phase = `candidate:${value}`; });
      candidateResult.validation = "passed";
      candidateResult.candidateIdentity = candidate.candidateHash;
      candidateResult.changedFileCount = candidate.changes.length;
      candidateResult.changedPaths = candidate.changes.map(change => change.path);
      candidateResult.changedContentHashes = candidate.changes.map(({ path, sha256 }) => ({ path, sha256 }));
      candidateResult.credentialsExposure = baseline.credentialsExposure;
      progress("predetermined repair collected as exact candidate bytes");
      phase = "candidate:freeze_host";
      candidatePath = freezeCandidateOnHost(candidate);
      candidateResult.frozenOutsideSandbox = true;
      candidateResult.success = true;
      progress("candidate frozen and validated outside sandbox");
    });
    requireProof(clean(boundary.cleanup));
    baseline.success = true;
    progress("repair sandbox destroyed and absence confirmed");
    requireProof(candidate);
    const frozenCandidatePath = hostArtifactPath(candidatePath);

    phase = "fresh_verification";
    const repairSandbox = { name: boundary.evidence.name, sessionId: boundary.evidence.sessionId };
    requireProof(typeof repairSandbox.sessionId === "string");
    verification = await runVerification(frozenCandidatePath, { candidateHash: candidate.candidateHash,
      repairSandbox: { name: repairSandbox.name, sessionId: repairSandbox.sessionId } });
    requireProof(verification.success && verification.outcome === "verified" && clean(verification.cleanup));
    progress("fresh verifier passed: 3 passed, 0 failed; cleanup confirmed");

    phase = "evidence";
    const createdAt = new Date().toISOString();
    const source = { kind: "captured_execution", itemId: null, observedAt: createdAt, outputTruncated: false };
    const records = { schemaVersion: 1, createdAt,
      baseline: { source, result: baseline },
      freezing: { source, sandbox: repairSandbox, result: candidateResult },
      verification: { source, result: verification } };
    const stored = writeEvidenceRecord(PROJECT_ROOT, records);
    recordPath = stored.path;
    const generated = generateEvidenceFile(PROJECT_ROOT, { recordName: stored.name, candidateHash: candidate.candidateHash });
    evidence = generated.report;
    evidencePath = generated.path;
    requireProof(evidence.classification.overallOutcome === "verified");
    requireProof(fixtureHash(loadOriginalFixture()) === EXPECTED_FIXTURE_HASH);
    const proof = validateMilestoneProof({ baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
      baseline, candidate: candidateResult, verification, evidence });
    progress("structured evidence generated; committed fixture unchanged");
    return { success: true, outcome: "milestone_1_demonstrated", ...proof,
      baseline: { nodeVersion: baseline.runtime.node, networkPolicyBeforeRepositoryExecution: boundary.transition.readBack,
        passed: 2, failed: 1, regression: TEST_NAMES[1], cleanup: baseline.cleanup },
      candidate: { changedPaths: candidateResult.changedPaths, changedContentHashes: candidateResult.changedContentHashes,
        frozenOutsideSandbox: true },
      verification: { passed: 3, failed: 0, regression: TEST_NAMES[1], sourceIdentityUnchanged: true,
        nodeVersion: verification.nodeVersion,
        networkPolicyBeforeRepositoryExecution: verification.networkPolicyBeforeRepositoryExecution.readBack,
        distinctSandboxConfirmed: verification.distinctSandboxConfirmed, cleanup: verification.cleanup },
      credentialsExposure: "absent", fixtureUnchanged: true,
      artifacts: { candidatePath: relativeArtifactPath(frozenCandidatePath),
        recordPath: relativeArtifactPath(recordPath), evidencePath: relativeArtifactPath(evidencePath),
        evidenceOutcome: evidence.classification.overallOutcome } };
  } catch (error) {
    if (!baseline.success && baseline.error === null) baseline.error = { phase, code: errorCode(error) };
    if (!candidateResult.success && candidateResult.error === null) candidateResult.error = { phase, code: errorCode(error) };
    return { success: false, outcome: "milestone_1_failed", phase, errorCode: errorCode(error),
      repairCleanup: boundary.cleanup, verifierCleanup: verification?.cleanup ?? null,
      baselineOutcome: baseline.outcome, candidateIdentity: candidateResult.candidateIdentity,
      verificationOutcome: verification?.outcome ?? null, evidenceOutcome: evidence?.classification.overallOutcome ?? null };
  }
}

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

if (import.meta.main) {
  if (process.argv[2] === "--failure") {
    console.log("[vigilo] running controlled dependency-installation failure");
    const result = await runFailureScenario("installation_failure");
    try { validateFailureDemo(result); }
    catch { result.acceptancePassed = false; }
    console.log(JSON.stringify({ demo: "failure", ...result }, null, 2));
    process.exitCode = result.acceptancePassed ? 0 : 1;
  } else {
    const result = await runMilestoneDemo(message => console.log(`[vigilo] ${message}`));
    console.log(JSON.stringify({ demo: "happy_path", ...result }, null, 2));
    process.exitCode = result.success ? 0 : 1;
  }
}
