import { Sandbox, APIError } from "@vercel/sandbox";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxBoundary, ExecutionCancelled, requireNode24, providerErrorCode } from "./sandbox-boundary.js";
import { ROOT, INSTALL_ARGS, fixtureExecutor, commandEvidence, ExecutionFailure } from "./fixture-execution.js";

export function classifyFailure(error: unknown) {
  return error instanceof ExecutionCancelled ? "cancelled" : error instanceof ExecutionFailure ? error.kind
    : error === null ? "unexpected_completion" : "infrastructure_failure";
}
export function expiryConfirmed(facts: { childSignal: string | null; expiresAt: number; observedAt: number; status: string; sameSession: boolean | null }) {
  return facts.childSignal === "SIGKILL" && facts.observedAt >= facts.expiresAt &&
    (facts.status === "absent" || (facts.status === "stopped" && facts.sameSession === true));
}

export type Scenario = "installation_failure" | "command_timeout" | "cancellation";
const LONG_SCRIPT = `
  const fs = require('node:fs');
  const names = ['VERCEL_TOKEN','VERCEL_TEAM_ID','VERCEL_PROJECT_ID','VERCEL_OIDC_TOKEN'];
  const state = names.some(name => Boolean(process.env[name])) ? 'present' : 'absent';
  fs.writeFileSync('.started', state);
  console.log('controlled_operation_started');
  setTimeout(() => {}, 60000);
`;
const READY_SCRIPT = `const fs = require('node:fs'); const p = ${JSON.stringify(ROOT + "/.started")};
  console.log(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'not_started');`;

export async function runFailureScenario(scenario: Scenario) {
  const boundary = new SandboxBoundary("vigilo-failure", "deny-all", 120_000);
  const controller = new AbortController();
  const command = commandEvidence(scenario === "installation_failure" ? [...INSTALL_ARGS, "--offline"] : ["test"],
    scenario === "command_timeout" ? 1500 : 30_000);
  const result = {
    scenario, sandbox: boundary.evidence, executionPhase: "provision", classifiedOutcome: "infrastructure_failure",
    command, operationStarted: false, cancellationRequested: false, cancellationObserved: false, furtherWorkStarted: false,
    diagnosticsPresent: false, credentialsExposure: "not_checked", nodeVersion: null as string | null,
    networkPolicy: boundary.transition, setupIdentity: null as string | null,
    cleanup: { requested: false, ...boundary.cleanup }, cleanupErrors: boundary.cleanupErrors,
    errorCode: null as string | null, acceptancePassed: false,
  };
  let failure: unknown = null;
  try {
    await boundary.run(async (sandbox, signal) => {
      const execution = fixtureExecutor(sandbox, boundary, signal);
      result.nodeVersion = requireNode24(await execution.trustedNode(["--version"]));
      await execution.credentialsAbsent(); result.credentialsExposure = "absent";
      await boundary.denyAll(signal);
      // Deliberately no lockfile: npm ci rejects before fetching. No original fixture is edited.
      const files = [
        { path: `${ROOT}/package.json`, content: Buffer.from(JSON.stringify({ name: "vigilo-failure-control", private: true,
          version: "1.0.0", scripts: { test: "node hang.cjs" } })) },
        { path: `${ROOT}/hang.cjs`, content: Buffer.from(LONG_SCRIPT) },
      ];
      result.setupIdentity = createHash("sha256").update(Buffer.concat(files.map(f => f.content))).digest("hex");
      await sandbox.writeFiles(files, { signal });
      result.executionPhase = scenario === "installation_failure" ? "dependency_installation" : "repository_test";
      if (scenario === "cancellation") {
        // Attach the rejection handler immediately. Abort stops the SDK wait;
        // boundary.finally stops/deletes the entire VM, including npm descendants.
        const pending = execution.npm(command, "unexpected_test_failure").then(() => null, error => error as unknown);
        try {
          const readyDeadline = Date.now() + 10_000;
          while (Date.now() < readyDeadline) {
            const state = await execution.trustedNode(["-e", READY_SCRIPT]);
            if (state === "present") throw new Error("credentials_present");
            if (state === "absent") { result.operationStarted = true; break; }
            await delay(100, undefined, { signal });
          }
          if (!result.operationStarted) throw new Error("operation_not_started");
          result.cancellationRequested = true;
          controller.abort();
          const error = await pending;
          signal.throwIfAborted();
          if (error) throw error;
        } finally {
          controller.abort();
          await pending;
        }
      } else {
        try { await execution.npm(command, "dependency_installation_failure"); }
        finally {
          if (scenario === "command_timeout") {
            result.operationStarted = await execution.trustedNode(["-e", READY_SCRIPT]) === "absent";
          }
        }
      }
      result.furtherWorkStarted = true;
    }, controller.signal);
  } catch (error) {
    failure = error;
    result.errorCode = error instanceof ExecutionCancelled ? "execution_cancelled"
      : error instanceof ExecutionFailure ? error.message : providerErrorCode(error);
  }
  result.classifiedOutcome = classifyFailure(failure);
  result.cancellationObserved = failure instanceof ExecutionCancelled;
  if (result.cancellationObserved) command.status = "cancelled";
  result.diagnosticsPresent = Boolean(command.diagnostics && command.diagnostics.stdoutBytes + command.diagnostics.stderrBytes > 0) ||
    (result.operationStarted && result.cancellationObserved);
  result.cleanup = { requested: boundary.evidence.created, ...boundary.cleanup };
  const expected = scenario === "installation_failure" ? "dependency_installation_failure" : scenario === "cancellation" ? "cancelled" : "command_timeout";
  const factsMatch = scenario === "installation_failure" ? command.exitCode === 1 && command.diagnostics?.npmCode === "EUSAGE" && !command.timedOut
    : scenario === "command_timeout" ? command.timedOut && result.operationStarted
      : result.cancellationRequested && result.cancellationObserved && !command.timedOut && result.operationStarted;
  result.acceptancePassed = result.classifiedOutcome === expected && factsMatch && !result.furtherWorkStarted && result.diagnosticsPresent &&
    result.credentialsExposure === "absent" && boundary.transition.status === "passed" &&
    boundary.cleanup.stop === "confirmed" && boundary.cleanup.delete === "confirmed" && boundary.cleanup.lookup === "absent";
  return result;
}

// Metadata-only lookup. Never execute a command through an observer: SDK commands may auto-resume.
export async function observeSandbox(name: string, sessionId: string) {
  try {
    const sandbox = await Sandbox.get({ name, resume: false, signal: AbortSignal.timeout(10_000) });
    return { sandbox, status: sandbox.status as string, sameSession: sandbox.currentSession().sessionId === sessionId, errorCode: null };
  } catch (error) {
    return { sandbox: null, status: error instanceof APIError && error.response.status === 404 ? "absent" : "unconfirmed",
      sameSession: null, errorCode: error instanceof APIError && error.response.status === 404 ? null : providerErrorCode(error) };
  }
}
