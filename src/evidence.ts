import { createHash } from "node:crypto";
import { parseCandidate } from "./candidate.js";
import { EXPECTED_FIXTURE_HASH, TEST_NAMES } from "./baseline.js";
import { INSTALL_ARGS } from "./fixture-execution.js";

// Version 1 schema: explicit allowlisted fields, no passthrough runtime objects.
// Every absent observation decodes to null. Invalid present values fail closed.
export class EvidenceError extends Error {
  constructor() { super("invalid_evidence"); }
}
type Decoder<T> = (value: unknown) => T | null;
function requireValid(value: unknown): asserts value { if (!value) throw new EvidenceError(); }
const optional = <T>(decode: (value: unknown) => T): Decoder<T> => value => value == null ? null : decode(value);
const boolean = optional(value => { requireValid(typeof value === "boolean"); return value; });
const integer = optional(value => { requireValid(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000); return value; });
const matches = (pattern: RegExp) => optional(value => { requireValid(typeof value === "string" && pattern.test(value)); return value; });
const oneOf = <const T extends readonly string[]>(...values: T) => optional(value => {
  requireValid(typeof value === "string" && values.includes(value)); return value as T[number];
});
const hash = matches(/^[a-f0-9]{64}$/);
const nodeVersion = matches(/^v24\.\d{1,4}\.\d{1,4}$/);
const timestamp = optional(value => {
  requireValid(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  return value;
});
function object(value: unknown): Record<string, unknown> {
  requireValid(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
function fields<S extends Record<string, Decoder<unknown>>>(shape: S): Decoder<{ [K in keyof S]: ReturnType<S[K]> }> {
  return optional(value => {
    const input = object(value);
    return Object.fromEntries(Object.entries(shape).map(([key, decode]) => [key, decode(input[key])])) as { [K in keyof S]: ReturnType<S[K]> };
  });
}
const list = <T>(decode: Decoder<T>): Decoder<(T | null)[]> => optional(value => {
  requireValid(Array.isArray(value) && value.length <= 16); return value.map(decode);
});
const path = oneOf("src/shipping-cost.ts");
const changes = list(fields({ path, sha256: hash }));
const sandbox = fields({
  name: matches(/^vigilo-(?:baseline|candidate|verifier)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  sessionId: matches(/^sbx_[A-Za-z0-9]{1,64}$/),
});
const cleanup = fields({ stop: oneOf("confirmed", "failed", "not_needed"), delete: oneOf("confirmed", "failed", "not_needed"),
  lookup: oneOf("absent", "still_present", "unconfirmed", "unconfirmed_after_create_failure", "not_run") });
const network = fields({ status: oneOf("passed", "failed", "not_run"), requested: oneOf("deny-all"),
  readBack: oneOf("deny-all", "allow-all", "custom_or_missing"), sameSession: boolean });
const credentials = oneOf("absent", "present", "not_checked");
const image = oneOf("vercel/sandbox/node:24");
const COMMANDS = [["npm", ...INSTALL_ARGS], ["npm", "run", "typecheck"], ["npm", "run", "build"], ["npm", "test", "--", "--reporter=json"]];
const command = optional(value => {
  const input = object(value);
  const args = input.command == null ? null : COMMANDS.find(args => JSON.stringify(args) === JSON.stringify(input.command));
  requireValid(args !== undefined);
  return {
    command: args ? [...args] : null, exitCode: integer(input.exitCode), timeoutMs: integer(input.timeoutMs), timedOut: boolean(input.timedOut),
    status: oneOf("completed", "passed", "expected_failure", "failed", "timed_out", "not_run")(input.status),
    output: { textIncluded: false as const, trust: "untrusted" as const,
      sourceTruncated: boolean(input.outputTruncated), reportTruncated: false,
      stdoutSha256: hash(input.stdoutSha256), stderrSha256: hash(input.stderrSha256) },
  };
});
const source = fields({ kind: oneOf("captured_execution", "imported_tool_output"),
  itemId: matches(/^exec-[a-f0-9-]{36}$/), observedAt: timestamp, outputTruncated: boolean });
function stage<S extends Record<string, Decoder<unknown>>>(value: unknown, shape: S) {
  if (value == null) return null;
  const envelope = object(value), result = object(envelope.result);
  const decoded = fields(shape)(result)!;
  // A raw error, stdout, environment, or any unknown property is never copied.
  if (result.error != null) object(result.error);
  return { ...decoded, provenance: source(envelope.source),
    producerClaims: { success: boolean(result.success), outcome: oneOf("verified", "expected_baseline_application_failure", "invalid_candidate",
      "verifier_infrastructure_failure", "candidate_verification_failure", "infrastructure_failure", "dependency_installation_failure",
      "command_timeout", "unexpected_test_failure", "build_failure")(result.outcome) },
    errorPresent: result.error === undefined ? null : result.error !== null };
}
type Truth = boolean | null;
const all = (...values: Truth[]): Truth => values.includes(false) ? false : values.includes(null) ? null : true;
const eq = (actual: unknown, expected: unknown): Truth => actual == null ? null : JSON.stringify(actual) === JSON.stringify(expected);
const clean = (value: ReturnType<typeof cleanup>) => all(eq(value?.stop, "confirmed"), eq(value?.delete, "confirmed"), eq(value?.lookup, "absent"));
const isolated = (value: ReturnType<typeof network>) => all(eq(value?.status, "passed"), eq(value?.requested, "deny-all"), eq(value?.readBack, "deny-all"), eq(value?.sameSession, true));
const ran = (value: ReturnType<typeof command>, index: number, code = 0): Truth => all(
  eq(value?.command, COMMANDS[index]), eq(value?.exitCode, code), eq(value?.timedOut, false),
  value?.timeoutMs == null ? null : value.timeoutMs > 0,
  value?.status == null ? null : ["completed", "passed", "expected_failure"].includes(value.status),
  value?.output.sourceTruncated === true ? false : true,
);

export function createEvidenceReport(input: unknown, candidateData: string) {
  const data = object(input);
  requireValid(data.schemaVersion === 1);
  const createdAt = timestamp(data.createdAt); requireValid(createdAt);
  const candidate = parseCandidate(candidateData);
  const baseline = stage(data.baseline, {
    sandbox, fixture: fields({ sha256: hash, localVerified: boolean, uploadedVerified: boolean, installedVerified: boolean, beforeTestsVerified: boolean }),
    runtime: fields({ node: nodeVersion }), install: command, networkPolicyTransition: network, typecheck: command, build: command, tests: command,
    testResults: fields({ total: integer, passed: integer, failed: integer, expectedFailingTest: oneOf(...TEST_NAMES), assertion: oneOf("expected_0_received_500") }),
    credentialsExposure: credentials, cleanup,
  });
  const freezing = stage(data.freezing, {
    baseFixtureIdentity: hash, candidateIdentity: hash, changedFileCount: integer, changedPaths: list(path), changedContentHashes: changes,
    validation: oneOf("passed", "failed", "not_run"), frozenOutsideSandbox: boolean, credentialsExposure: credentials, cleanup,
  });
  const verification = stage(data.verification, {
    baseFixtureIdentity: hash, frozenCandidateIdentity: hash, repairSandbox: sandbox, verifierSandbox: sandbox,
    distinctSandboxConfirmed: boolean, pristineBaseIntegrity: boolean, appliedCandidateIdentity: hash, candidateIdentityMatches: boolean,
    changedPaths: list(path), changedContentHashes: changes, dependencyInstallation: command, networkPolicyBeforeRepositoryExecution: network,
    typecheck: command, build: command, testCommand: command,
    tests: fields({ total: integer, passed: integer, failed: integer, regression: fields({ name: oneOf(...TEST_NAMES), status: oneOf("passed", "failed", "skipped") }) }),
    sourceIdentityUnchangedAfterVerification: boolean, postVerificationCandidateIdentity: hash, credentialsExposure: credentials, nodeVersion,
    cleanup, image,
  });
  const repairSandbox = data.freezing == null ? null : sandbox(object(data.freezing).sandbox);
  const baselineImage = data.baseline == null ? null : image(object(object(data.baseline).result).sandbox == null ? null : object(object(object(data.baseline).result).sandbox).image);
  const changeHashes = candidate.changes.map(({ path, sha256 }) => ({ path, sha256 }));
  const paths = candidate.changes.map(change => change.path);
  const checks = {
    recordsComplete: baseline && freezing && verification ? true : null,
    identityAgreement: all(eq(baseline?.fixture?.sha256, candidate.baseFixtureHash),
      eq(freezing?.baseFixtureIdentity, candidate.baseFixtureHash), eq(freezing?.candidateIdentity, candidate.candidateHash),
      eq(verification?.baseFixtureIdentity, candidate.baseFixtureHash), eq(verification?.frozenCandidateIdentity, candidate.candidateHash)),
    baselineBroken: all(eq(baseline?.fixture?.sha256, candidate.baseFixtureHash), eq(baseline?.fixture?.localVerified, true),
      eq(baseline?.fixture?.uploadedVerified, true), eq(baseline?.fixture?.installedVerified, true), eq(baseline?.fixture?.beforeTestsVerified, true),
      ran(baseline?.install ?? null, 0), isolated(baseline?.networkPolicyTransition ?? null), ran(baseline?.typecheck ?? null, 1), ran(baseline?.build ?? null, 2), ran(baseline?.tests ?? null, 3, 1),
      eq(baseline?.testResults?.total, 3), eq(baseline?.testResults?.passed, 2), eq(baseline?.testResults?.failed, 1),
      eq(baseline?.testResults?.expectedFailingTest, TEST_NAMES[1]), eq(baseline?.testResults?.assertion, "expected_0_received_500"),
      eq(baseline?.credentialsExposure, "absent"), clean(baseline?.cleanup ?? null), eq(baseline?.errorPresent, false), eq(baseline?.producerClaims.success, true)),
    frozenCandidateValid: all(eq(freezing?.baseFixtureIdentity, candidate.baseFixtureHash), eq(freezing?.candidateIdentity, candidate.candidateHash),
      eq(freezing?.changedPaths, paths), eq(freezing?.changedContentHashes, changeHashes), eq(freezing?.changedFileCount, 1),
      eq(freezing?.validation, "passed"), eq(freezing?.frozenOutsideSandbox, true), clean(freezing?.cleanup ?? null), eq(freezing?.errorPresent, false), eq(freezing?.producerClaims.success, true)),
    exactCandidate: all(eq(verification?.baseFixtureIdentity, candidate.baseFixtureHash), eq(verification?.frozenCandidateIdentity, candidate.candidateHash),
      eq(verification?.appliedCandidateIdentity, candidate.candidateHash), eq(verification?.candidateIdentityMatches, true),
      eq(verification?.changedPaths, paths), eq(verification?.changedContentHashes, changeHashes)),
    freshSandbox: all(eq(verification?.distinctSandboxConfirmed, true), eq(verification?.pristineBaseIntegrity, true),
      repairSandbox?.name == null ? null : eq(verification?.repairSandbox?.name, repairSandbox.name),
      verification?.verifierSandbox?.name == null || repairSandbox?.name == null ? null : verification.verifierSandbox.name !== repairSandbox.name,
      verification?.verifierSandbox?.sessionId == null ? null : true,
      repairSandbox?.sessionId == null || verification?.verifierSandbox?.sessionId == null ? true : repairSandbox.sessionId !== verification.verifierSandbox.sessionId),
    verificationPassed: all(ran(verification?.dependencyInstallation ?? null, 0), isolated(verification?.networkPolicyBeforeRepositoryExecution ?? null),
      ran(verification?.typecheck ?? null, 1), ran(verification?.build ?? null, 2), ran(verification?.testCommand ?? null, 3),
      eq(verification?.tests?.total, 3), eq(verification?.tests?.passed, 3), eq(verification?.tests?.failed, 0),
      eq(verification?.tests?.regression?.name, TEST_NAMES[1]), eq(verification?.tests?.regression?.status, "passed"),
      eq(verification?.credentialsExposure, "absent"), verification?.nodeVersion == null ? null : true,
      clean(verification?.cleanup ?? null), eq(verification?.errorPresent, false), eq(verification?.producerClaims.success, true), eq(verification?.producerClaims.outcome, "verified")),
    sourceUnchanged: all(eq(verification?.sourceIdentityUnchangedAfterVerification, true), eq(verification?.postVerificationCandidateIdentity, candidate.candidateHash)),
    completeRecordCapture: all(...[baseline, freezing, verification].map(record => record?.provenance?.outputTruncated == null ? null : !record.provenance.outputTruncated)),
  };
  const overallOutcome = checks.identityAgreement === false || checks.exactCandidate === false || checks.sourceUnchanged === false || checks.freshSandbox === false ? "invalid_verification"
    : Object.values(checks).includes(false) ? "failed_verification" : Object.values(checks).includes(null) ? "incomplete" : "verified";
  const report = {
    schemaVersion: 1 as const, createdAt,
    observations: { baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
      candidate: { schemaVersion: candidate.schemaVersion, candidateHash: candidate.candidateHash, changedPaths: paths, changedContentHashes: changeHashes, artifactValidation: "passed" },
      baseline: baseline ? { ...baseline, image: baselineImage } : null,
      freezing: freezing ? { ...freezing, sandbox: repairSandbox, image: null, nodeVersion: null } : null, verification },
    classification: { rulesVersion: 1 as const, overallOutcome, checks },
  };
  const reportId = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  return { ...report, reportId };
}
export type EvidenceReportV1 = ReturnType<typeof createEvidenceReport>;
