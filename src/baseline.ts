import { APIError } from "@vercel/sandbox";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SandboxBoundary, requireNode24 } from "./sandbox-boundary.js";
import { ROOT, INSTALL_POLICY, INSTALL_ARGS, object, commandEvidence, boundedReport, fixtureExecutor, ExecutionFailure as BaselineFailure } from "./fixture-execution.js";

const FIXTURE_REVISION = "c349421fac7969ef761b2a799fc9749404cfc511";
export const EXPECTED_FIXTURE_HASH = "60c6da3af26475c6efd1212487ae1a12d77a069d98fe5dd24dfd301c8d85e596";
const FILES = [".gitignore", ".nvmrc", "package-lock.json", "package.json", "src/shipping-cost.ts", "test/shipping-cost.test.ts", "tsconfig.json"];
export const TEST_NAMES = ["charges 500 cents below the free-shipping threshold", "offers free shipping at exactly 5000 cents", "offers free shipping above the threshold"];
const MAX_REPORT_BYTES = 65_536;
type FixtureFile = { path: string; content: Buffer };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function fixtureHash(files: FixtureFile[]) {
  return sha256(JSON.stringify(files.map(file => ({ path: file.path, sha256: sha256(file.content) }))));
}

export function loadOriginalFixture(): FixtureFile[] {
  const directory = new URL("../../fixtures/free-shipping/", import.meta.url);
  const files = FILES.map(path => {
    const localPath = fileURLToPath(new URL(path, directory));
    if (!lstatSync(localPath).isFile()) throw new BaselineFailure("infrastructure_failure", "fixture_not_regular_file");
    return { path, content: readFileSync(localPath) };
  });
  if (fixtureHash(files) !== EXPECTED_FIXTURE_HASH) throw new BaselineFailure("infrastructure_failure", "fixture_integrity_mismatch");
  return files;
}

// Vitest 5 JSON reporter is untrusted data, never a source of commands or log text.
// https://vitest.dev/guide/reporters.html#json-reporter
function parseFixtureTests(raw: string, exitCode: number | null, repaired: boolean) {
  const failures = repaired ? 0 : 1;
  try {
    if (exitCode !== failures || Buffer.byteLength(raw) > MAX_REPORT_BYTES) throw new Error();
    const report = object(JSON.parse(raw));
    if (report.success !== repaired || report.numTotalTests !== 3 || report.numPassedTests !== 3 - failures ||
        report.numFailedTests !== failures || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
        report.numTotalTestSuites !== 1 || report.numFailedTestSuites !== failures || report.numPassedTestSuites !== 1 - failures || report.numPendingTestSuites !== 0 ||
        !Array.isArray(report.testResults) || report.testResults.length !== 1) throw new Error();
    const suite = object(report.testResults[0]);
    if (suite.status !== (repaired ? "passed" : "failed") || suite.message !== "" || suite.name !== `${ROOT}/test/shipping-cost.test.ts` ||
        !Array.isArray(suite.assertionResults) || suite.assertionResults.length !== 3) throw new Error();
    const assertions = suite.assertionResults.map(object);
    for (const [index, name] of TEST_NAMES.entries()) {
      const matches = assertions.filter(entry => entry.title === name && entry.fullName === name);
      const entry = matches[0];
      if (matches.length !== 1 || !entry || entry.status !== (!repaired && index === 1 ? "failed" : "passed") ||
          !Array.isArray(entry.failureMessages)) throw new Error();
      if (!repaired && index === 1) {
        if (entry.failureMessages.length !== 1 || typeof entry.failureMessages[0] !== "string" ||
            entry.failureMessages[0].split("\n")[0] !== "AssertionError: expected 500 to be +0 // Object.is equality") throw new Error();
      } else if (entry.failureMessages.length !== 0) throw new Error();
    }
    return { total: 3, passed: 3 - failures, failed: failures, regression: { name: TEST_NAMES[1]!, status: repaired ? "passed" : "failed" } };
  } catch { throw new BaselineFailure("unexpected_test_failure", repaired ? "repaired_test_report_mismatch" : "baseline_test_report_mismatch"); }
}

export function parseBaselineTests(raw: string, exitCode: number | null) {
  const result = parseFixtureTests(raw, exitCode, false);
  return { total: result.total, passed: result.passed, failed: result.failed, expectedFailingTest: result.regression.name, assertion: "expected_0_received_500" };
}

export function parseRepairedTests(raw: string, exitCode: number | null) {
  return parseFixtureTests(raw, exitCode, true);
}

function integrityScript() {
  return `
    const fs = require('node:fs');
    const { createHash } = require('node:crypto');
    const root = ${JSON.stringify(ROOT)};
    const paths = ${JSON.stringify(FILES)};
    const files = paths.map(path => {
      if (!fs.lstatSync(root + '/' + path).isFile()) throw new Error('not_regular');
      return { path, sha256: createHash('sha256').update(fs.readFileSync(root + '/' + path)).digest('hex') };
    });
    console.log(createHash('sha256').update(JSON.stringify(files)).digest('hex'));
  `;
}

export async function runBaseline() {
  // No wildcard domains, CIDR ranges, credentials brokering, or GitHub access.
  // https://vercel.com/docs/sandbox/concepts/firewall#user-defined
  const boundary = new SandboxBoundary("vigilo-baseline", INSTALL_POLICY, 240_000);
  const report = {
    success: false, outcome: "infrastructure_failure",
    sandbox: boundary.evidence,
    fixture: { name: "free-shipping", revision: FIXTURE_REVISION, sha256: EXPECTED_FIXTURE_HASH,
      fileCount: FILES.length, localVerified: false, uploadedVerified: false, installedVerified: false, beforeTestsVerified: false },
    runtime: { node: null as string | null }, credentialsExposure: "not_checked",
    install: commandEvidence(INSTALL_ARGS, 90_000),
    networkPolicyTransition: boundary.transition,
    typecheck: commandEvidence(["run", "typecheck"], 30_000),
    build: commandEvidence(["run", "build"], 30_000),
    tests: commandEvidence(["test", "--", "--reporter=json"], 30_000),
    testResults: null as ReturnType<typeof parseBaselineTests> | null,
    cleanup: boundary.cleanup, error: null as { phase: string; code: string } | null,
  };
  let phase = "fixture_integrity";
  try {
    const files = loadOriginalFixture();
    report.fixture.localVerified = true;
    phase = "boundary";
    await boundary.run(async (sandbox, signal) => {
      const execution = fixtureExecutor(sandbox, boundary, signal);
      const { trustedNode, npm } = execution;
      const verifyRemote = async () => {
        if (await trustedNode(["-e", integrityScript()]) !== EXPECTED_FIXTURE_HASH) {
          throw new BaselineFailure("infrastructure_failure", "remote_fixture_integrity_mismatch");
        }
      };
      const credentialsAbsent = async () => {
        await execution.credentialsAbsent();
        report.credentialsExposure = "absent";
      };

      phase = "runtime";
      report.runtime.node = requireNode24(await trustedNode(["--version"]));
      await credentialsAbsent();
      phase = "upload";
      await sandbox.writeFiles(files.map(file => ({ path: `${ROOT}/${file.path}`, content: file.content })), { signal });
      await verifyRemote();
      report.fixture.uploadedVerified = true;
      phase = "install";
      await npm(report.install, "dependency_installation_failure");
      phase = "network_policy_transition";
      await boundary.denyAll(signal);
      await credentialsAbsent();
      await verifyRemote();
      report.fixture.installedVerified = true;
      // All repository-controlled scripts are below the confirmed deny-all gate.
      phase = "typecheck";
      await npm(report.typecheck, "build_failure");
      phase = "build";
      await npm(report.build, "build_failure");
      await verifyRemote();
      report.fixture.beforeTestsVerified = true;
      phase = "tests";
      await npm(report.tests, "unexpected_test_failure", true);
      report.testResults = parseBaselineTests(await boundedReport(sandbox, signal), report.tests.exitCode);
      report.tests.status = "expected_failure";
      report.outcome = "expected_baseline_application_failure";
    });
  } catch (error) {
    report.outcome = error instanceof BaselineFailure ? error.kind : "infrastructure_failure";
    report.error = { phase, code: error instanceof BaselineFailure ? error.message
      : error instanceof APIError ? `provider_http_${error.response.status}` : "operation_failed" };
  }
  const cleaned = report.cleanup.stop === "confirmed" && report.cleanup.delete === "confirmed" && report.cleanup.lookup === "absent";
  if (!cleaned && report.error === null) {
    report.outcome = "infrastructure_failure";
    report.error = { phase: "cleanup", code: "cleanup_unconfirmed" };
  }
  report.success = report.outcome === "expected_baseline_application_failure" && cleaned && report.error === null;
  return report;
}

if (import.meta.main) {
  const report = await runBaseline();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success ? 0 : 1;
}
