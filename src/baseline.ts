import { APIError, type Sandbox } from "@vercel/sandbox";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SandboxBoundary, CREDENTIALS_SCRIPT, requireNode24 } from "./sandbox-boundary.js";

const FIXTURE_REVISION = "c349421fac7969ef761b2a799fc9749404cfc511";
export const EXPECTED_FIXTURE_HASH = "60c6da3af26475c6efd1212487ae1a12d77a069d98fe5dd24dfd301c8d85e596";
const FILES = [".gitignore", ".nvmrc", "package-lock.json", "package.json", "src/shipping-cost.ts", "test/shipping-cost.test.ts", "tsconfig.json"];
const ROOT = "/vercel/sandbox/fixture";
const TEST_NAMES = ["charges 500 cents below the free-shipping threshold", "offers free shipping at exactly 5000 cents", "offers free shipping above the threshold"];
const MAX_REPORT_BYTES = 65_536;
type FixtureFile = { path: string; content: Buffer };
type FailureKind = "infrastructure_failure" | "dependency_installation_failure" | "command_timeout" | "unexpected_test_failure" | "build_failure";
class BaselineFailure extends Error {
  constructor(readonly kind: FailureKind, code: string) { super(code); }
}
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

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_object");
  return value as Record<string, unknown>;
}

// Vitest 5 JSON reporter is untrusted data, never a source of commands or log text.
// https://vitest.dev/guide/reporters.html#json-reporter
export function parseBaselineTests(raw: string, exitCode: number | null) {
  try {
    if (exitCode !== 1 || Buffer.byteLength(raw) > MAX_REPORT_BYTES) throw new Error();
    const report = object(JSON.parse(raw));
    if (report.success !== false || report.numTotalTests !== 3 || report.numPassedTests !== 2 ||
        report.numFailedTests !== 1 || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
        report.numTotalTestSuites !== 1 || report.numFailedTestSuites !== 1 || report.numPassedTestSuites !== 0 || report.numPendingTestSuites !== 0 ||
        !Array.isArray(report.testResults) || report.testResults.length !== 1) throw new Error();
    const suite = object(report.testResults[0]);
    if (suite.status !== "failed" || suite.message !== "" || suite.name !== `${ROOT}/test/shipping-cost.test.ts` ||
        !Array.isArray(suite.assertionResults) || suite.assertionResults.length !== 3) throw new Error();
    const assertions = suite.assertionResults.map(object);
    for (const [index, name] of TEST_NAMES.entries()) {
      const matches = assertions.filter(entry => entry.title === name && entry.fullName === name);
      const entry = matches[0];
      if (matches.length !== 1 || !entry || entry.status !== (index === 1 ? "failed" : "passed") ||
          !Array.isArray(entry.failureMessages)) throw new Error();
      if (index === 1) {
        if (entry.failureMessages.length !== 1 || typeof entry.failureMessages[0] !== "string" ||
            entry.failureMessages[0].split("\n")[0] !== "AssertionError: expected 500 to be +0 // Object.is equality") throw new Error();
      } else if (entry.failureMessages.length !== 0) throw new Error();
    }
    return { total: 3, passed: 2, failed: 1, expectedFailingTest: TEST_NAMES[1]!, assertion: "expected_0_received_500" };
  } catch { throw new BaselineFailure("unexpected_test_failure", "baseline_test_report_mismatch"); }
}

// This trusted harness is supplied by Vigilo, outside the fixture files. Child
// output is bounded and hashed, not printed or interpreted as instructions.
// https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options
const COMMAND_SCRIPT = `
  const { spawnSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const input = JSON.parse(process.argv[1]);
  const result = spawnSync('npm', input.args, {
    cwd: input.cwd, timeout: input.timeoutMs, killSignal: 'SIGKILL',
    maxBuffer: 131072, encoding: 'utf8'
  });
  const hash = value => createHash('sha256').update(value ?? '').digest('hex');
  console.log(JSON.stringify({
    exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT',
    spawnFailed: Boolean(result.error), signalTermination: Boolean(result.signal),
    stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr)
  }));
`;

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

type CommandEvidence = {
  command: string[]; timeoutMs: number; status: string; exitCode: number | null;
  timedOut: boolean; stdoutSha256?: string; stderrSha256?: string;
};
function commandEvidence(args: string[], timeoutMs: number): CommandEvidence {
  return { command: ["npm", ...args], timeoutMs, status: "not_run", exitCode: null, timedOut: false };
}

async function boundedReport(sandbox: Sandbox, signal: AbortSignal) {
  const stream = await sandbox.readFile({ path: `${ROOT}/.vitest/json/output.json` }, { signal });
  if (!stream) throw new BaselineFailure("unexpected_test_failure", "test_report_missing");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REPORT_BYTES) throw new BaselineFailure("unexpected_test_failure", "test_report_too_large");
      chunks.push(buffer);
    }
  } finally {
    if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runBaseline() {
  // No wildcard domains, CIDR ranges, credentials brokering, or GitHub access.
  // https://vercel.com/docs/sandbox/concepts/firewall#user-defined
  const boundary = new SandboxBoundary("vigilo-baseline", { allow: ["registry.npmjs.org"] }, 240_000);
  const report = {
    success: false, outcome: "infrastructure_failure",
    sandbox: boundary.evidence,
    fixture: { name: "free-shipping", revision: FIXTURE_REVISION, sha256: EXPECTED_FIXTURE_HASH,
      fileCount: FILES.length, localVerified: false, uploadedVerified: false, installedVerified: false, beforeTestsVerified: false },
    runtime: { node: null as string | null }, credentialsExposure: "not_checked",
    install: commandEvidence(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=15000"], 90_000),
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
      const trustedNode = async (args: string[]) => {
        const result = await sandbox.runCommand({ cmd: "node", args, signal });
        boundary.assertSameSession(sandbox);
        if (result.exitCode !== 0) throw new BaselineFailure("infrastructure_failure", "harness_command_failed");
        return (await result.stdout()).trim();
      };
      const verifyRemote = async () => {
        if (await trustedNode(["-e", integrityScript()]) !== EXPECTED_FIXTURE_HASH) {
          throw new BaselineFailure("infrastructure_failure", "remote_fixture_integrity_mismatch");
        }
      };
      const credentialsAbsent = async () => {
        report.credentialsExposure = await trustedNode(["-e", CREDENTIALS_SCRIPT]) === "absent" ? "absent" : "present";
        if (report.credentialsExposure !== "absent") throw new BaselineFailure("infrastructure_failure", "credentials_present");
      };
      const npm = async (evidence: CommandEvidence, failureKind: FailureKind) => {
        evidence.status = "failed";
        const result = object(JSON.parse(await trustedNode(["-e", COMMAND_SCRIPT, JSON.stringify({
          args: evidence.command.slice(1), cwd: ROOT, timeoutMs: evidence.timeoutMs,
        })])));
        if (!(result.exitCode === null || Number.isInteger(result.exitCode)) || typeof result.timedOut !== "boolean" ||
            typeof result.spawnFailed !== "boolean" || typeof result.signalTermination !== "boolean" ||
            typeof result.stdoutSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.stdoutSha256) ||
            typeof result.stderrSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.stderrSha256)) throw new Error("invalid_command_result");
        evidence.exitCode = result.exitCode as number | null;
        evidence.timedOut = result.timedOut;
        evidence.stdoutSha256 = result.stdoutSha256;
        evidence.stderrSha256 = result.stderrSha256;
        if (result.timedOut) {
          evidence.status = "timed_out";
          throw new BaselineFailure("command_timeout", "npm_deadline_exceeded");
        }
        if (result.spawnFailed || result.signalTermination || result.exitCode === null) throw new BaselineFailure("infrastructure_failure", "abnormal_command_termination");
        if (evidence !== report.tests && result.exitCode !== 0) throw new BaselineFailure(failureKind, "npm_command_failed");
        evidence.status = "completed";
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
      await npm(report.tests, "unexpected_test_failure");
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
