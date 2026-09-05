import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxBoundary, cleanupSandbox, providerErrorCode, type CleanupError } from "./sandbox-boundary.js";
import { fixtureExecutor } from "./fixture-execution.js";
import { expiryConfirmed, observeSandbox, runFailureScenario } from "./failure-cleanup.js";

const EXPIRY_MS = 60_000;
type Ready = { name: string; sessionId: string; expiresAt: number; timeoutMs: number; credentialsExposure: "absent"; running: true };
function readyRecord(value: unknown): Ready {
  const x = value as Ready | null;
  if (!x || typeof x !== "object" || !/^vigilo-expiry-[a-f0-9-]{36}$/.test(x.name) ||
      !/^sbx_[A-Za-z0-9]{1,64}$/.test(x.sessionId) || !Number.isSafeInteger(x.expiresAt) ||
      x.expiresAt <= Date.now() || x.expiresAt > Date.now() + EXPIRY_MS + 10_000 ||
      x.timeoutMs !== EXPIRY_MS || x.credentialsExposure !== "absent" || x.running !== true) throw new Error("invalid_expiry_record");
  return { name: x.name, sessionId: x.sessionId, expiresAt: x.expiresAt, timeoutMs: x.timeoutMs, credentialsExposure: "absent", running: true };
}
async function expiryChild() {
  const boundary = new SandboxBoundary("vigilo-expiry", "deny-all", EXPIRY_MS);
  try {
    await boundary.run(async (sandbox, signal) => {
      const execution = fixtureExecutor(sandbox, boundary, signal);
      await execution.credentialsAbsent();
      const expiresAt = sandbox.expiresAt?.getTime();
      if (!expiresAt || sandbox.status !== "running") throw new Error("expiry_unavailable");
      await new Promise<void>((resolve, reject) => process.send!({ name: boundary.evidence.name,
        sessionId: boundary.evidence.sessionId, expiresAt, timeoutMs: sandbox.timeout,
        credentialsExposure: "absent", running: true }, error => error ? reject(error) : resolve()));
      // SIGKILL bypasses this process's finally. A normal error/SIGTERM still cleans up.
      await delay(EXPIRY_MS, undefined, { signal });
    });
  } catch { process.exitCode = 1; }
}

export async function runExpiryScenario() {
  const child = fork(fileURLToPath(import.meta.url), ["--expiry-child"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
  });
  let childSignal: string | null = null;
  const exited = new Promise<void>(resolve => child.once("exit", (_code, signal) => { childSignal = signal; resolve(); }));
  const report = {
    scenario: "process_loss", sandbox: null as Ready | null, executionPhase: "provision",
    classifiedOutcome: "infrastructure_failure", diagnosticsPresent: false, credentialsExposure: "not_checked",
    cleanup: { requested: false, stop: "not_requested", delete: "not_requested", lookup: "unconfirmed" },
    providerExpiryFallback: { requestedTimeoutMs: EXPIRY_MS, expiresAt: null as string | null,
      childSignal: null as string | null, observedAt: null as string | null, status: "not_observed", sameSession: null as boolean | null, confirmed: false },
    observerCleanup: { requested: false, stop: "not_needed", delete: "not_needed", lookup: "not_run", errors: [] as CleanupError[] },
    errorCode: null as string | null, acceptancePassed: false, unexpectedlyActive: null as boolean | null,
  };
  try {
    report.sandbox = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child_ready_timeout")), 20_000);
      child.once("message", message => { clearTimeout(timer); try { resolve(readyRecord(message)); } catch (e) { reject(e); } });
      child.once("error", () => { clearTimeout(timer); reject(new Error("child_failed")); });
      void exited.then(() => { clearTimeout(timer); reject(new Error("child_exited_before_ready")); });
    });
    const ready = report.sandbox;
    report.credentialsExposure = ready.credentialsExposure;
    report.providerExpiryFallback.expiresAt = new Date(ready.expiresAt).toISOString();
    // Preserve the provider identity in the supervising process before destroying local control.
    console.log(JSON.stringify({ event: "expiry_sandbox_recorded", ...ready }));
    if (!child.kill("SIGKILL")) throw new Error("child_kill_failed");
    await exited;
    report.providerExpiryFallback.childSignal = childSignal;
    report.executionPhase = "independent_expiry_observation";
    await delay(Math.max(0, ready.expiresAt + 2000 - Date.now()));
    let observation = await observeSandbox(ready.name, ready.sessionId);
    // Bounded allowance for provider state propagation; never resume or extend the VM.
    const observationDeadline = ready.expiresAt + 20_000;
    while (["running", "stopping", "pending"].includes(observation.status) && Date.now() < observationDeadline) {
      await delay(2000);
      observation = await observeSandbox(ready.name, ready.sessionId);
    }
    const observedAt = Date.now();
    Object.assign(report.providerExpiryFallback, { observedAt: new Date(observedAt).toISOString(),
      status: observation.status, sameSession: observation.sameSession,
      confirmed: expiryConfirmed({ childSignal, expiresAt: ready.expiresAt, observedAt, status: observation.status, sameSession: observation.sameSession }) });
    report.cleanup.lookup = observation.status === "absent" ? "absent" : "not_deleted_by_harness";
    report.unexpectedlyActive = observation.status === "unconfirmed" ? null : ["running", "stopping", "pending"].includes(observation.status);
    report.diagnosticsPresent = true;
    report.errorCode = observation.errorCode;
    report.classifiedOutcome = report.providerExpiryFallback.confirmed ? "provider_expiry_confirmed" : "provider_expiry_unconfirmed";
  } catch (error) { report.errorCode = providerErrorCode(error); }
  finally {
    // Only the deliberately killed child skips its lifecycle finally. Normal parent
    // errors terminate the owned child gracefully; observer housekeeping uses the shared cleanup.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    if (report.sandbox) {
      const current = await observeSandbox(report.sandbox.name, report.sandbox.sessionId);
      if (current.sandbox) {
        report.observerCleanup.requested = true;
        Object.assign(report.observerCleanup, await cleanupSandbox(current.sandbox, report.observerCleanup.errors));
        const after = await observeSandbox(report.sandbox.name, report.sandbox.sessionId);
        report.observerCleanup.lookup = after.status === "absent" ? "absent" : "unconfirmed";
      } else {
        report.observerCleanup.lookup = current.status === "absent" ? "absent" : "unconfirmed";
        if (current.errorCode) report.observerCleanup.errors.push({ operation: "lookup", code: current.errorCode });
      }
    }
  }
  report.acceptancePassed = report.providerExpiryFallback.confirmed && report.credentialsExposure === "absent" &&
    report.observerCleanup.lookup === "absent" && report.observerCleanup.errors.length === 0;
  return report;
}

if (import.meta.main) {
  if (process.argv[2] === "--expiry-child" && process.send) await expiryChild();
  else {
    let passed = true;
    for (const scenario of ["installation_failure", "command_timeout", "cancellation"] as const) {
      const report = await runFailureScenario(scenario);
      console.log(JSON.stringify(report, null, 2));
      passed &&= report.acceptancePassed;
    }
    const expiry = await runExpiryScenario();
    console.log(JSON.stringify(expiry, null, 2));
    process.exitCode = passed && expiry.acceptancePassed ? 0 : 1;
  }
}
