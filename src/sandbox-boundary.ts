import { APIError, Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export function requireNode24(output: string): string {
  const version = output.trim();
  if (!/^v24\.\d+\.\d+$/.test(version)) throw new Error("runtime_mismatch");
  return version;
}

export const CREDENTIALS_SCRIPT = `
  const names = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN'];
  console.log(names.some(name => Boolean(process.env[name])) ? 'present' : 'absent');
`;

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

// Shared Task 1.1 boundary. No host environment is passed to sandbox commands.
// https://vercel.com/docs/sandbox/sdk-reference
export class SandboxBoundary {
  readonly evidence;
  readonly cleanup = { stop: "not_needed", delete: "not_needed", lookup: "not_run" };
  readonly transition = { status: "not_run", requested: "deny-all", readBack: null as string | null, sameSession: false };
  private sandbox: Sandbox | undefined;
  private createAttempted = false;
  private credentials: { token: string; teamId: string; projectId: string } | Record<string, never> = {};

  constructor(prefix: string, private policy: NetworkPolicy, private timeoutMs: number) {
    this.evidence = {
      name: `${prefix}-${randomUUID()}`, sessionId: null as string | null, created: false,
      image: "vercel/sandbox/node:24", timeoutMs, persistent: false,
      initialNetworkPolicy: policy, settingsConfirmed: false,
    };
  }

  assertSameSession(sandbox: Sandbox) {
    if (sandbox.currentSession().sessionId !== this.evidence.sessionId) throw new Error("session_changed");
  }

  async denyAll(signal: AbortSignal) {
    this.transition.status = "failed";
    await this.sandbox!.update({ networkPolicy: "deny-all" }, { signal });
    const readBack = await Sandbox.get({ ...this.credentials, name: this.evidence.name, resume: false, signal });
    this.transition.readBack = typeof readBack.networkPolicy === "string" ? readBack.networkPolicy : "custom_or_missing";
    this.transition.sameSession = readBack.currentSession().sessionId === this.evidence.sessionId;
    if (this.transition.readBack !== "deny-all" || !this.transition.sameSession || readBack.currentSession().status !== "running") {
      throw new Error("network_policy_transition_failed");
    }
    this.transition.status = "passed";
  }

  async run(work: (sandbox: Sandbox, signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs - 30_000)]);
    try {
      requireNode24(process.version);
      const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
      if ((token || teamId || projectId) && !(token && teamId && projectId)) throw new Error("incomplete_credentials");
      if (!(token && teamId && projectId) && !process.env.VERCEL_OIDC_TOKEN) throw new Error("credentials_missing");
      this.credentials = token && teamId && projectId ? { token, teamId, projectId } : {};
      this.createAttempted = true;
      console.log(JSON.stringify({ event: "sandbox_requested", name: this.evidence.name }));
      this.sandbox = await Sandbox.create({
        ...this.credentials, name: this.evidence.name, image: this.evidence.image,
        persistent: false, timeout: this.timeoutMs, networkPolicy: this.policy, ports: [], signal,
      });
      this.evidence.created = true;
      if (this.sandbox.persistent || !isDeepStrictEqual(this.sandbox.networkPolicy, this.policy) || this.sandbox.timeout !== this.timeoutMs) {
        throw new Error("unsafe_provider_settings");
      }
      this.evidence.settingsConfirmed = true;
      this.evidence.sessionId = this.sandbox.currentSession().sessionId;
      await work(this.sandbox, signal);
    } finally {
      try { await this.close(); }
      finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    }
  }

  private async close() {
    if (!this.sandbox && this.createAttempted) {
      try {
        this.sandbox = await Sandbox.get({ ...this.credentials, name: this.evidence.name, resume: false, signal: AbortSignal.timeout(10_000) });
        this.evidence.created = true;
      } catch { this.cleanup.lookup = "unconfirmed_after_create_failure"; }
    }
    if (this.sandbox) {
      Object.assign(this.cleanup, await cleanupSandbox(this.sandbox));
      try {
        await Sandbox.get({ ...this.credentials, name: this.evidence.name, resume: false, signal: AbortSignal.timeout(10_000) });
        this.cleanup.lookup = "still_present";
      } catch (error) {
        this.cleanup.lookup = error instanceof APIError && error.response.status === 404 ? "absent" : "unconfirmed";
      }
    }
  }
}
