import { APIError } from "@vercel/sandbox";
import { SandboxBoundary, CREDENTIALS_SCRIPT, requireNode24 } from "./sandbox-boundary.js";
export { cleanupSandbox, requireNode24 } from "./sandbox-boundary.js";

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

const NETWORK_URL = "https://example.com/";
const REQUEST_TIMEOUT_MS = 10_000;

// Harmless, fixed commands only. No local environment or credential is forwarded.
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
  const boundary = new SandboxBoundary("vigilo-probe", "allow-all", 120_000);
  const report = {
    success: false,
    sandbox: boundary.evidence,
    runtime: { status: "not_run", version: null as string | null },
    filesystem: { status: "not_run", path: "/tmp/vigilo-probe.txt" },
    credentialsExposure: "not_checked",
    networkRequest: { url: NETWORK_URL, method: "HEAD", timeoutMs: REQUEST_TIMEOUT_MS },
    outboundPositiveControl: { status: "not_run", observation: undefined as NetworkObservation | undefined },
    networkPolicyTransition: boundary.transition,
    outboundAfterDeny: { status: "inconclusive", observation: undefined as NetworkObservation | undefined },
    cleanup: boundary.cleanup,
    error: null as { phase: string; code: string } | null,
  };
  let phase = "boundary";
  try {
    await boundary.run(async (sandbox, workSignal) => {
      const activeSandbox = sandbox;
      const command = async (args: string[]) => {
        const result = await activeSandbox.runCommand({ cmd: "node", args, signal: workSignal });
        boundary.assertSameSession(activeSandbox);
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
      await boundary.denyAll(workSignal);

      phase = "outbound_after_deny";
      report.outboundAfterDeny.observation = await request();
      report.outboundAfterDeny.status = classifyNetworkResult(
        report.outboundPositiveControl.observation, report.networkPolicyTransition.status === "passed", report.outboundAfterDeny.observation,
      );
      if (report.outboundAfterDeny.status !== "blocked") throw new Error("network_denial_unproven");
    });
  } catch (error) {
    const known = ["credentials_missing", "incomplete_credentials", "runtime_mismatch", "unsafe_provider_settings", "command_failed", "filesystem_failed", "network_denial_unproven", "positive_control_failed", "network_policy_transition_failed", "credentials_present", "session_changed"];
    // Do not serialize SDK error bodies, stack traces, request headers, or secrets.
    const code = error instanceof APIError ? `provider_http_${error.response.status}`
      : error instanceof Error && known.includes(error.message) ? error.message : "operation_failed";
    report.error = { phase, code };
  }
  report.success = report.error === null && report.outboundAfterDeny.status === "blocked" && report.credentialsExposure === "absent" && report.cleanup.stop === "confirmed" &&
    report.cleanup.delete === "confirmed" && report.cleanup.lookup === "absent";
  return report;
}

if (import.meta.main) {
  const report = await runProbe();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success ? 0 : 1;
}
