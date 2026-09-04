import { APIError, Sandbox } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";

export function requireNode24(output: string): string {
  const version = output.trim();
  if (!/^v24\.\d+\.\d+$/.test(version)) throw new Error("runtime_mismatch");
  return version;
}

export type NetworkObservation = {
  outcome: "response" | "failed";
  tcpConnected: boolean;
  tlsConnected: boolean;
  httpStatus?: number;
  failure?: { category: "timeout" | "network_error"; name: string; code: string };
};

function positiveControlPassed(observation: NetworkObservation | undefined) {
  return observation?.outcome === "response" && observation.tcpConnected && observation.tlsConnected &&
    observation.httpStatus !== undefined && observation.httpStatus >= 200 && observation.httpStatus < 300;
}

export function classifyNetworkResult(
  positive: NetworkObservation | undefined,
  transitionConfirmed: boolean,
  after: NetworkObservation | undefined,
) {
  if (after?.outcome === "response" || after?.tcpConnected || after?.tlsConnected) return "not_blocked";
  // No error-string allowlist: failure only proves denial in this controlled A/B sequence.
  return positiveControlPassed(positive) && transitionConfirmed && after?.outcome === "failed" && after.failure
    ? "blocked" : "inconclusive";
}

type CleanupTarget = {
  stop(options: { signal: AbortSignal }): Promise<unknown>;
  delete(options: { signal: AbortSignal; deleteOrphanSnapshots: boolean }): Promise<unknown>;
};

export async function cleanupSandbox(sandbox: CleanupTarget) {
  const result: { stop: "confirmed" | "failed"; delete: "confirmed" | "failed" } = {
    stop: "failed", delete: "failed",
  };
  // https://vercel.com/docs/sandbox/sdk-reference#sandbox.stop
  // Use independent signals: failed/cancelled work must not cancel cleanup.
  try {
    await sandbox.stop({ signal: AbortSignal.timeout(20_000) });
    result.stop = "confirmed";
  } catch { /* Continue to deletion even if stopping fails. */ }
  try {
    await sandbox.delete({ signal: AbortSignal.timeout(20_000), deleteOrphanSnapshots: true });
    result.delete = "confirmed";
  } catch { /* Report uncertainty; never print SDK errors containing requests. */ }
  return result;
}

const IMAGE = "vercel/sandbox/node:24";
const DEADLINE_MS = 120_000;
const NETWORK_URL = "https://example.com/";
const REQUEST_TIMEOUT_MS = 10_000;

// Harmless, fixed commands only. No local environment or credential is forwarded.
const CREDENTIALS_SCRIPT = `
  const names = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN'];
  console.log(names.some(name => Boolean(process.env[name])) ? 'present' : 'absent');
`;
const FILESYSTEM_SCRIPT = `
  const fs = require('node:fs');
  const path = '/tmp/vigilo-probe.txt';
  fs.writeFileSync(path, 'vigilo-probe-ok', { flag: 'wx' });
  if (fs.readFileSync(path, 'utf8') !== 'vigilo-probe-ok') process.exit(3);
  fs.unlinkSync(path);
  console.log('filesystem_ok');
`;

// Each invocation is a fresh Node process with a fresh connection (agent: false).
// https://nodejs.org/docs/latest-v24.x/api/https.html#httpsrequesturl-options-callback
const NETWORK_SCRIPT = `
  import https from 'node:https';
  const observation = await new Promise(resolve => {
    let tcpConnected = false;
    let tlsConnected = false;
    const finish = result => {
      clearTimeout(timer);
      resolve({ ...result, tcpConnected, tlsConnected });
    };
    const request = https.request('${NETWORK_URL}', { method: 'HEAD', agent: false }, response => {
      response.resume();
      finish({ outcome: 'response', httpStatus: response.statusCode });
    });
    request.on('socket', socket => {
      socket.once('connect', () => { tcpConnected = true; });
      socket.once('secureConnect', () => { tlsConnected = true; });
    });
    request.once('error', error => finish({
      outcome: 'failed',
      failure: {
        category: error.code === 'PROBE_REQUEST_TIMEOUT' ? 'timeout' : 'network_error',
        name: error.name, code: error.code ?? 'UNKNOWN'
      }
    }));
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request deadline elapsed'), {
      name: 'ProbeTimeoutError', code: 'PROBE_REQUEST_TIMEOUT'
    })), ${REQUEST_TIMEOUT_MS});
    request.end();
  });
  console.log(JSON.stringify(observation));
`;

export async function runProbe() {
  const name = `vigilo-probe-${randomUUID()}`;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const workSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
  const report = {
    success: false,
    sandbox: { name, sessionId: null as string | null, created: false, image: IMAGE, timeoutMs: DEADLINE_MS, persistent: false, initialNetworkPolicy: "allow-all", settingsConfirmed: false },
    runtime: { status: "not_run", version: null as string | null },
    filesystem: { status: "not_run", path: "/tmp/vigilo-probe.txt" },
    credentialsExposure: "not_checked",
    networkRequest: { url: NETWORK_URL, method: "HEAD", timeoutMs: REQUEST_TIMEOUT_MS },
    outboundPositiveControl: { status: "not_run", observation: undefined as NetworkObservation | undefined },
    networkPolicyTransition: { status: "not_run", requested: "deny-all", readBack: null as string | null, sameSession: false },
    outboundAfterDeny: { status: "inconclusive", observation: undefined as NetworkObservation | undefined },
    cleanup: { stop: "not_needed", delete: "not_needed", lookup: "not_run" },
    error: null as { phase: string; code: string } | null,
  };
  let sandbox: Sandbox | undefined;
  let createAttempted = false;
  let phase = "authentication";
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  const credentials = token && teamId && projectId ? { token, teamId, projectId } : {};

  try {
    requireNode24(process.version);
    if ((token || teamId || projectId) && !(token && teamId && projectId)) throw new Error("incomplete_credentials");
    if (!(token && teamId && projectId) && !process.env.VERCEL_OIDC_TOKEN) throw new Error("credentials_missing");
    phase = "create";
    createAttempted = true;
    // Persist the unique name in terminal output before a possibly ambiguous create.
    console.log(JSON.stringify({ event: "sandbox_requested", name }));
    // https://vercel.com/docs/sandbox/sdk-reference#sandbox.create
    sandbox = await Sandbox.create({
      ...credentials, name, image: IMAGE, persistent: false,
      timeout: DEADLINE_MS, networkPolicy: "allow-all", ports: [], signal: workSignal,
    });
    report.sandbox.created = true;
    phase = "settings";
    if (sandbox.persistent || sandbox.networkPolicy !== "allow-all" || sandbox.timeout !== DEADLINE_MS) {
      throw new Error("unsafe_provider_settings");
    }
    report.sandbox.settingsConfirmed = true;
    report.sandbox.sessionId = sandbox.currentSession().sessionId;

    const activeSandbox = sandbox;
    const command = async (args: string[]) => {
      const result = await activeSandbox.runCommand({ cmd: "node", args, signal: workSignal });
      if (activeSandbox.currentSession().sessionId !== report.sandbox.sessionId) throw new Error("session_changed");
      if (result.exitCode !== 0) throw new Error("command_failed");
      return (await result.stdout()).trim();
    };
    phase = "runtime";
    report.runtime.version = requireNode24(await command(["--version"]));
    report.runtime.status = "passed";
    phase = "credentials_exposure";
    const exposure = await command(["-e", CREDENTIALS_SCRIPT]);
    report.credentialsExposure = exposure === "absent" ? "absent" : "present";
    if (report.credentialsExposure !== "absent") throw new Error("credentials_present");
    phase = "filesystem";
    if (await command(["-e", FILESYSTEM_SCRIPT]) !== "filesystem_ok") throw new Error("filesystem_failed");
    report.filesystem.status = "passed";

    const request = async (): Promise<NetworkObservation> => JSON.parse(await command(["--input-type=module", "-e", NETWORK_SCRIPT]));
    phase = "outbound_positive_control";
    report.outboundPositiveControl.status = "failed";
    report.outboundPositiveControl.observation = await request();
    if (!positiveControlPassed(report.outboundPositiveControl.observation)) throw new Error("positive_control_failed");
    report.outboundPositiveControl.status = "passed";

    phase = "network_policy_transition";
    report.networkPolicyTransition.status = "failed";
    // Applies to the currently running VM; do not use deprecated updateNetworkPolicy().
    // https://vercel.com/docs/sandbox/sdk-reference#sandbox.update
    await sandbox.update({ networkPolicy: "deny-all" }, { signal: workSignal });
    const readBack = await Sandbox.get({ ...credentials, name, resume: false, signal: workSignal });
    report.networkPolicyTransition.readBack = typeof readBack.networkPolicy === "string" ? readBack.networkPolicy : "custom_or_missing";
    report.networkPolicyTransition.sameSession = readBack.currentSession().sessionId === report.sandbox.sessionId;
    if (report.networkPolicyTransition.readBack !== "deny-all" || !report.networkPolicyTransition.sameSession ||
        readBack.currentSession().status !== "running") throw new Error("network_policy_transition_failed");
    report.networkPolicyTransition.status = "passed";

    phase = "outbound_after_deny";
    report.outboundAfterDeny.observation = await request();
    report.outboundAfterDeny.status = classifyNetworkResult(
      report.outboundPositiveControl.observation, report.networkPolicyTransition.status === "passed", report.outboundAfterDeny.observation,
    );
    if (report.outboundAfterDeny.status !== "blocked") throw new Error("network_denial_unproven");
  } catch (error) {
    const known = ["credentials_missing", "incomplete_credentials", "runtime_mismatch", "unsafe_provider_settings", "command_failed", "filesystem_failed", "network_denial_unproven", "positive_control_failed", "network_policy_transition_failed", "credentials_present", "session_changed"];
    // Do not serialize SDK error bodies, stack traces, request headers, or secrets.
    const code = controller.signal.aborted ? "cancelled"
      : error instanceof APIError ? `provider_http_${error.response.status}`
      : error instanceof Error && known.includes(error.message) ? error.message : "operation_failed";
    report.error = { phase, code };
  } finally {
    if (!sandbox && createAttempted) {
      try {
        sandbox = await Sandbox.get({ ...credentials, name, resume: false, signal: AbortSignal.timeout(10_000) });
        report.sandbox.created = true;
      } catch {
        report.cleanup.lookup = "unconfirmed_after_create_failure";
      }
    }
    if (sandbox) {
      Object.assign(report.cleanup, await cleanupSandbox(sandbox));
      try {
        await Sandbox.get({ ...credentials, name, resume: false, signal: AbortSignal.timeout(10_000) });
        report.cleanup.lookup = "still_present";
      } catch (error) {
        report.cleanup.lookup = error instanceof APIError && error.response.status === 404 ? "absent" : "unconfirmed";
      }
    }
    report.success = report.error === null && report.outboundAfterDeny.status === "blocked" && report.credentialsExposure === "absent" && report.cleanup.stop === "confirmed" &&
      report.cleanup.delete === "confirmed" && report.cleanup.lookup === "absent";
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  return report;
}

if (import.meta.main) {
  const report = await runProbe();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success ? 0 : 1;
}
