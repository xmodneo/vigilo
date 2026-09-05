import type { Sandbox } from "@vercel/sandbox";
import { SandboxBoundary, CREDENTIALS_SCRIPT } from "./sandbox-boundary.js";

export const ROOT = "/vercel/sandbox/fixture";
export const INSTALL_POLICY = { allow: ["registry.npmjs.org"] };
export const INSTALL_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--fetch-retries=0", "--fetch-timeout=15000"];
const MAX_REPORT_BYTES = 65_536;
export type FailureKind = "infrastructure_failure" | "dependency_installation_failure" | "command_timeout" | "unexpected_test_failure" | "build_failure" | "candidate_verification_failure";
export class ExecutionFailure extends Error {
  constructor(readonly kind: FailureKind, code: string) { super(code); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_object");
  return value as Record<string, unknown>;
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

type CommandEvidence = {
  command: string[]; timeoutMs: number; status: string; exitCode: number | null;
  timedOut: boolean; stdoutSha256?: string; stderrSha256?: string;
};
export function commandEvidence(args: string[], timeoutMs: number): CommandEvidence {
  return { command: ["npm", ...args], timeoutMs, status: "not_run", exitCode: null, timedOut: false };
}

export async function boundedReport(sandbox: Sandbox, signal: AbortSignal) {
  const stream = await sandbox.readFile({ path: `${ROOT}/.vitest/json/output.json` }, { signal });
  if (!stream) throw new ExecutionFailure("unexpected_test_failure", "test_report_missing");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REPORT_BYTES) throw new ExecutionFailure("unexpected_test_failure", "test_report_too_large");
      chunks.push(buffer);
    }
  } finally {
    if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function fixtureExecutor(sandbox: Sandbox, boundary: SandboxBoundary, signal: AbortSignal) {
  const trustedNode = async (args: string[]) => {
    const result = await sandbox.runCommand({ cmd: "node", args, signal });
    boundary.assertSameSession(sandbox);
    if (result.exitCode !== 0) throw new ExecutionFailure("infrastructure_failure", "harness_command_failed");
    return (await result.stdout()).trim();
  };
  const credentialsAbsent = async () => {
    if (await trustedNode(["-e", CREDENTIALS_SCRIPT]) !== "absent") throw new ExecutionFailure("infrastructure_failure", "credentials_present");
  };
  const npm = async (evidence: CommandEvidence, failureKind: FailureKind, allowNonzero = false) => {
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
      throw new ExecutionFailure("command_timeout", "npm_deadline_exceeded");
    }
    if (result.spawnFailed || result.signalTermination || result.exitCode === null) throw new ExecutionFailure("infrastructure_failure", "abnormal_command_termination");
    if (!allowNonzero && result.exitCode !== 0) throw new ExecutionFailure(failureKind, "npm_command_failed");
    evidence.status = "completed";
  };
  return { trustedNode, credentialsAbsent, npm };
}
