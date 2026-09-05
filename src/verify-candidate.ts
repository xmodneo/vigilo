import { APIError } from "@vercel/sandbox";
import { fileURLToPath } from "node:url";
import { EXPECTED_FIXTURE_HASH, loadOriginalFixture, fixtureHash, parseRepairedTests, TEST_NAMES } from "./baseline.js";
import { buildCandidate, collectTree, loadCandidate, sandboxTreeReader, CandidateError } from "./candidate.js";
import { SandboxBoundary, requireNode24 } from "./sandbox-boundary.js";
import { ROOT, INSTALL_POLICY, INSTALL_ARGS, commandEvidence, fixtureExecutor, boundedReport, ExecutionFailure } from "./fixture-execution.js";

// Host-recorded Task 1.4 provenance (docs/candidate.md). Session ID was not
// retained; the recorded unique sandbox NAME is the separation identifier.
export const VERIFICATION_CONTROL = Object.freeze({
  candidateHash: "5a83213ab30bc5e81a88f9910270ac64c0e3b402b66d13096b591da18f8ea346",
  repairSandbox: Object.freeze({ name: "vigilo-candidate-77e7b73a-b775-4bc3-b331-6f6f46bdac7c", sessionId: null }),
});
export type VerificationControl = { candidateHash: string; repairSandbox: { name: string; sessionId: string | null } };
const BASELINE_NEGATIVE_CONTROL = Object.freeze({
  evidence: "recorded_Task_1_3_live_run", source: "docs/baseline.md", observedAt: "2026-09-04",
  baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
  sandboxName: "vigilo-baseline-9f5034f9-924e-4e2c-85cd-5b27868edc1f", sessionId: "sbx_jFLCxCVLvo4tMdijFbwGJBUmzis8",
  outcome: "expected_baseline_application_failure", passed: 2, failed: 1, exitCode: 1,
  regression: TEST_NAMES[1]!, assertion: "expected_0_received_500", cleanup: "confirmed",
});

export async function runVerification(
  candidatePath = fileURLToPath(new URL(`../../.vigilo/candidates/${VERIFICATION_CONTROL.candidateHash}.json`, import.meta.url)),
  control: VerificationControl = VERIFICATION_CONTROL,
) {
  const boundary = new SandboxBoundary("vigilo-verifier", INSTALL_POLICY, 240_000);
  const report = {
    success: false, outcome: "invalid_candidate", baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
    frozenCandidateIdentity: null as string | null, repairSandbox: control.repairSandbox,
    verifierSandbox: { name: null as string | null, sessionId: null as string | null },
    distinctSandboxConfirmed: false,
    separationIdentifier: control.repairSandbox.sessionId === null ? "sandbox_name" : "sandbox_name_and_session",
    pristineBaseIntegrity: false, appliedCandidateIdentity: null as string | null, candidateIdentityMatches: false,
    changedPaths: [] as string[], changedContentHashes: [] as { path: string; sha256: string }[],
    dependencyInstallation: commandEvidence(INSTALL_ARGS, 90_000),
    networkPolicyBeforeRepositoryExecution: boundary.transition,
    typecheck: commandEvidence(["run", "typecheck"], 30_000), build: commandEvidence(["run", "build"], 30_000),
    testCommand: commandEvidence(["test", "--", "--reporter=json"], 30_000),
    tests: null as ReturnType<typeof parseRepairedTests> | null,
    sourceIdentityUnchangedAfterVerification: false, postVerificationCandidateIdentity: null as string | null,
    baselineNegativeControl: BASELINE_NEGATIVE_CONTROL,
    credentialsExposure: "not_checked", nodeVersion: null as string | null,
    cleanup: boundary.cleanup, error: null as { phase: string; code: string } | null,
  };
  let phase = "load_frozen_candidate";
  try {
    const frozen = loadCandidate(candidatePath);
    if (frozen.candidateHash !== control.candidateHash) throw new CandidateError("candidate_provenance_mismatch");
    report.frozenCandidateIdentity = frozen.candidateHash;
    const base = loadOriginalFixture();
    report.outcome = "verifier_infrastructure_failure";
    phase = "provision_fresh_verifier";
    await boundary.run(async (sandbox, signal) => {
      const verifierSessionId = sandbox.currentSession().sessionId;
      report.verifierSandbox = { name: sandbox.name, sessionId: verifierSessionId };
      if (sandbox.name !== boundary.evidence.name || sandbox.name === control.repairSandbox.name ||
          control.repairSandbox.sessionId !== null && verifierSessionId === control.repairSandbox.sessionId) {
        throw new ExecutionFailure("infrastructure_failure", "verifier_not_distinct");
      }
      boundary.assertSameSession(sandbox);
      report.distinctSandboxConfirmed = true;
      const execution = fixtureExecutor(sandbox, boundary, signal);
      report.nodeVersion = requireNode24(await execution.trustedNode(["--version"]));
      const checkCredentials = async () => {
        await execution.credentialsAbsent();
        report.credentialsExposure = "absent";
      };
      await checkCredentials();
      const reader = sandboxTreeReader(sandbox, signal);
      phase = "pristine_base";
      await sandbox.writeFiles(base.map(file => ({ path: `${ROOT}/${file.path}`, content: file.content, mode: 0o644 })), { signal });
      if (fixtureHash(await collectTree(reader, ROOT, base)) !== EXPECTED_FIXTURE_HASH) throw new CandidateError("pristine_base_mismatch");
      report.pristineBaseIntegrity = true;
      phase = "apply_frozen_bytes";
      await sandbox.writeFiles(frozen.changes.map(change => ({ path: `${ROOT}/${change.path}`, content: Buffer.from(change.contentBase64, "base64"), mode: 0o644 })), { signal });
      const applied = buildCandidate(base, await collectTree(reader, ROOT, base));
      report.appliedCandidateIdentity = applied.candidateHash;
      report.candidateIdentityMatches = applied.candidateHash === frozen.candidateHash;
      report.changedPaths = applied.changes.map(change => change.path);
      report.changedContentHashes = applied.changes.map(({ path, sha256 }) => ({ path, sha256 }));
      if (!report.candidateIdentityMatches) throw new CandidateError("applied_candidate_mismatch");

      phase = "dependency_installation";
      await execution.npm(report.dependencyInstallation, "dependency_installation_failure");
      phase = "network_policy";
      await boundary.denyAll(signal);
      await checkCredentials();
      phase = "post_install_integrity";
      if (buildCandidate(base, await collectTree(reader, ROOT, base, true)).candidateHash !== frozen.candidateHash) {
        throw new ExecutionFailure("infrastructure_failure", "installation_modified_source");
      }
      phase = "typecheck";
      await execution.npm(report.typecheck, "candidate_verification_failure");
      phase = "build";
      await execution.npm(report.build, "candidate_verification_failure");
      phase = "tests";
      await execution.npm(report.testCommand, "candidate_verification_failure", true);
      // Re-read source bytes even if the test command exited nonzero. A passing
      // report cannot rescue a tree that no longer matches the frozen candidate.
      phase = "post_verification_integrity";
      const after = buildCandidate(base, await collectTree(reader, ROOT, base, true));
      report.postVerificationCandidateIdentity = after.candidateHash;
      report.sourceIdentityUnchangedAfterVerification = after.candidateHash === frozen.candidateHash;
      if (!report.sourceIdentityUnchangedAfterVerification) throw new ExecutionFailure("candidate_verification_failure", "source_modified_during_verification");
      phase = "tests";
      report.tests = parseRepairedTests(await boundedReport(sandbox, signal), report.testCommand.exitCode);
      report.testCommand.status = "passed";
      await checkCredentials();
      boundary.assertSameSession(sandbox);
      report.outcome = "verified";
    });
  } catch (error) {
    if (report.outcome !== "invalid_candidate") {
      report.outcome = (error instanceof ExecutionFailure && error.kind === "candidate_verification_failure") ||
        (["tests", "post_verification_integrity"].includes(phase) && (error instanceof CandidateError || error instanceof ExecutionFailure && error.kind === "unexpected_test_failure"))
        ? "candidate_verification_failure" : "verifier_infrastructure_failure";
    }
    if (error instanceof ExecutionFailure && error.message === "credentials_present") report.credentialsExposure = "present";
    report.error = { phase, code: error instanceof CandidateError || error instanceof ExecutionFailure ? error.message
      : error instanceof APIError ? `provider_http_${error.response.status}` : "operation_failed" };
  }
  if (boundary.evidence.created && (report.cleanup.stop !== "confirmed" || report.cleanup.delete !== "confirmed" || report.cleanup.lookup !== "absent")) {
    report.outcome = "verifier_infrastructure_failure";
    report.error = { phase: "cleanup", code: "cleanup_unconfirmed" };
  }
  report.success = report.outcome === "verified" && report.cleanup.lookup === "absent" && report.error === null;
  return report;
}

if (import.meta.main) {
  const report = await runVerification();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success ? 0 : 1;
}
