import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCandidate } from "../src/candidate.js";
import { loadOriginalFixture, EXPECTED_FIXTURE_HASH, TEST_NAMES } from "../src/baseline.js";
import { INSTALL_ARGS } from "../src/fixture-execution.js";
import { createEvidenceReport } from "../src/evidence.js";
import { generateEvidenceFile, writeEvidenceRecord } from "../src/evidence-report.js";

function inputs() {
  const base = loadOriginalFixture();
  const candidate = buildCandidate(base, base.map(file => ({ ...file, mode: 0o644,
    content: file.path === "src/shipping-cost.ts" ? Buffer.from(file.content.toString().replace(" > ", " >= ")) : file.content })));
  const command = (args: string[], exitCode = 0) => ({ command: ["npm", ...args], timeoutMs: 30_000,
    exitCode, timedOut: false, status: "completed", stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) });
  const cleanup = { stop: "confirmed", delete: "confirmed", lookup: "absent" };
  const network = { status: "passed", requested: "deny-all", readBack: "deny-all", sameSession: true };
  const source = { kind: "captured_execution", observedAt: null, itemId: null, outputTruncated: false };
  const repairName = "vigilo-repair-00000000-0000-4000-8000-000000000001";
  const changes = candidate.changes.map(({ path, sha256 }) => ({ path, sha256 }));
  const baseline = { source, result: {
    success: true, outcome: "expected_baseline_application_failure", error: null,
    sandbox: { name: "vigilo-baseline-00000000-0000-4000-8000-000000000002", sessionId: "sbx_baseline", image: "vercel/sandbox/node:24" },
    fixture: { sha256: EXPECTED_FIXTURE_HASH, localVerified: true, uploadedVerified: true, installedVerified: true, beforeTestsVerified: true },
    runtime: { node: "v24.19.0" }, install: command(INSTALL_ARGS), networkPolicyTransition: network,
    typecheck: command(["run", "typecheck"]), build: command(["run", "build"]), tests: { ...command(["test", "--", "--reporter=json"], 1), status: "expected_failure" },
    testResults: { total: 3, passed: 2, failed: 1, expectedFailingTest: TEST_NAMES[1], assertion: "expected_0_received_500" },
    credentialsExposure: "absent", cleanup,
  } };
  const freezing = { source, sandbox: { name: repairName }, result: {
    success: true, error: null, baseFixtureIdentity: EXPECTED_FIXTURE_HASH, candidateIdentity: candidate.candidateHash,
    changedFileCount: 1, changedPaths: ["src/shipping-cost.ts"], changedContentHashes: changes,
    validation: "passed", frozenOutsideSandbox: true, cleanup,
  } };
  const verification = { source, result: {
    success: true, outcome: "verified", error: null, baseFixtureIdentity: EXPECTED_FIXTURE_HASH, frozenCandidateIdentity: candidate.candidateHash,
    repairSandbox: { name: repairName, sessionId: null },
    verifierSandbox: { name: "vigilo-verifier-00000000-0000-4000-8000-000000000003", sessionId: "sbx_verifier" },
    distinctSandboxConfirmed: true, pristineBaseIntegrity: true, appliedCandidateIdentity: candidate.candidateHash, candidateIdentityMatches: true,
    changedPaths: ["src/shipping-cost.ts"], changedContentHashes: changes, dependencyInstallation: command(INSTALL_ARGS),
    networkPolicyBeforeRepositoryExecution: network, typecheck: command(["run", "typecheck"]), build: command(["run", "build"]),
    testCommand: { ...command(["test", "--", "--reporter=json"]), status: "passed" },
    tests: { total: 3, passed: 3, failed: 0, regression: { name: TEST_NAMES[1], status: "passed" } },
    sourceIdentityUnchangedAfterVerification: true, postVerificationCandidateIdentity: candidate.candidateHash,
    credentialsExposure: "absent", nodeVersion: "v24.19.0", cleanup,
  } };
  return { input: structuredClone({ schemaVersion: 1, createdAt: "2026-09-05T00:00:00.000Z", baseline, freezing, verification }), raw: JSON.stringify(candidate) };
}

test("complete observations produce a deterministic verified report without changing identities", () => {
  const { input, raw } = inputs();
  const report = createEvidenceReport(input, raw);
  assert.equal(report.classification.overallOutcome, "verified");
  assert.deepEqual(report, createEvidenceReport(JSON.parse(JSON.stringify(input)), raw));
  assert.equal(report.observations.candidate.candidateHash, JSON.parse(raw).candidateHash);
  assert.equal(report.observations.baseFixtureIdentity, EXPECTED_FIXTURE_HASH);
  assert.equal(report.observations.verification?.image, null);
  assert.equal(report.observations.freezing?.sandbox?.sessionId, null);
  assert.equal(report.schemaVersion, 1);
});

test("missing baseline or verification remains unknown and cannot be verified", () => {
  const { input, raw } = inputs();
  for (const stage of ["baseline", "verification", "freezing"]) {
    const report = createEvidenceReport({ ...input, [stage]: null }, raw);
    assert.equal(report.classification.overallOutcome, "incomplete");
  }
});

test("failed verification overrides an optimistic producer outcome", () => {
  const { input, raw } = inputs();
  input.verification.result.testCommand.exitCode = 1;
  assert.equal(createEvidenceReport(input, raw).classification.overallOutcome, "failed_verification");
  input.verification.result.testCommand.exitCode = 0;
  input.verification.result.success = false;
  assert.notEqual(createEvidenceReport(input, raw).classification.overallOutcome, "verified");
});

test("candidate mismatch and source mutation invalidate verification", () => {
  const { input, raw } = inputs();
  input.verification.result.appliedCandidateIdentity = "0".repeat(64);
  assert.equal(createEvidenceReport(input, raw).classification.overallOutcome, "invalid_verification");
  input.verification.result.appliedCandidateIdentity = JSON.parse(raw).candidateHash;
  input.verification.result.sourceIdentityUnchangedAfterVerification = false;
  assert.equal(createEvidenceReport(input, raw).classification.overallOutcome, "invalid_verification");
});

test("a conflicting freeze identity or shared session invalidates the evidence chain", () => {
  const { input, raw } = inputs();
  input.freezing.result.candidateIdentity = "0".repeat(64);
  assert.equal(createEvidenceReport(input, raw).classification.overallOutcome, "invalid_verification");
  input.freezing.result.candidateIdentity = JSON.parse(raw).candidateHash;
  const sharedSession = { ...input.freezing, sandbox: { ...input.freezing.sandbox, sessionId: "sbx_verifier" } };
  assert.equal(createEvidenceReport({ ...input, freezing: sharedSession }, raw).classification.overallOutcome, "invalid_verification");
});

test("unknown fields and untrusted output are excluded, and truncation is explicit", () => {
  const { input, raw } = inputs();
  const secret = "sk_live_secret_sentinel_never_include";
  const polluted = { ...input, env: { TOKEN: secret }, runtime: process.env,
    verification: { ...input.verification, result: { ...input.verification.result,
      env: { TOKEN: secret }, stdout: secret, testCommand: { ...input.verification.result.testCommand,
        stdout: secret.repeat(1000), stderr: secret, outputTruncated: true } } } };
  const report = createEvidenceReport(polluted, raw);
  assert(!JSON.stringify(report).includes(secret));
  assert.equal(report.observations.verification?.testCommand?.output.sourceTruncated, true);
  assert.equal(report.observations.verification?.testCommand?.output.textIncluded, false);
  assert.notEqual(report.classification.overallOutcome, "verified");
});

test("malformed execution records and unsafe data in retained fields are rejected", () => {
  const { input, raw } = inputs();
  for (const bad of [[], "bad", { ...input, schemaVersion: 2 }, { ...input, createdAt: "tomorrow" },
    { ...input, baseline: { source: input.baseline.source, result: { install: { exitCode: "0" } } } },
    { ...input, verification: { source: input.verification.source, result: { verifierSandbox: { name: "sk_live_secret" } } } }]) {
    assert.throws(() => createEvidenceReport(bad, raw), /invalid_evidence/);
  }
});

test("local generation is repeatable, bounded, and writes only under the evidence directory", context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-evidence-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { input, raw } = inputs();
  mkdirSync(join(root, ".vigilo/candidates"), { recursive: true });
  mkdirSync(join(root, ".vigilo/evidence/records"), { recursive: true });
  const candidatePath = join(root, `.vigilo/candidates/${JSON.parse(raw).candidateHash}.json`);
  writeFileSync(candidatePath, raw);
  const recordsPath = join(root, ".vigilo/evidence/records/workflow.json");
  writeFileSync(recordsPath, JSON.stringify(input));
  const first = generateEvidenceFile(root);
  assert(first.path.startsWith(join(root, ".vigilo/evidence/reports/")));
  assert.equal(first.path, generateEvidenceFile(root).path);
  assert.equal(readFileSync(candidatePath, "utf8"), raw);
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), first.report);
  const stored = writeEvidenceRecord(root, input);
  assert.match(stored.name, /^[a-f0-9]{64}\.json$/);
  assert.equal(writeEvidenceRecord(root, input).path, stored.path);
  assert.equal(generateEvidenceFile(root, { recordName: stored.name,
    candidateHash: JSON.parse(raw).candidateHash }).report.classification.overallOutcome, "verified");
  writeFileSync(recordsPath, " ".repeat(262_145));
  assert.throws(() => generateEvidenceFile(root));
  rmSync(recordsPath);
  symlinkSync(candidatePath, recordsPath);
  assert.throws(() => generateEvidenceFile(root));
});

test("each mandatory verifier gate must remain proven even when the producer claims verified", () => {
  const { input, raw } = inputs();
  const variants = [
    { ...input.verification.result, tests: null },
    { ...input.verification.result, error: { message: "private secret" } },
    { ...input.verification.result, cleanup: { stop: "failed", delete: "confirmed", lookup: "absent" } },
    { ...input.verification.result, networkPolicyBeforeRepositoryExecution: null },
    { ...input.verification.result, credentialsExposure: "present" },
    { ...input.verification.result, distinctSandboxConfirmed: false },
    { ...input.verification.result, pristineBaseIntegrity: false },
    { ...input.verification.result, candidateIdentityMatches: false },
    { ...input.verification.result, postVerificationCandidateIdentity: "0".repeat(64) },
  ];
  for (const result of variants) {
    const report = createEvidenceReport({ ...input, verification: { ...input.verification, result } }, raw);
    assert.notEqual(report.classification.overallOutcome, "verified");
    assert(!JSON.stringify(report).includes("private secret"));
  }
});
