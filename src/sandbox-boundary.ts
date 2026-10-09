import { APIError, Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sandboxCredentials, SandboxConfigurationError, SandboxTransportError } from "../lib/external-execution/sandbox-auth.ts";

import { ExternalExecutionAuthorityError, ZERO_EXTERNAL_EXECUTION_AUTHORITY, type ExternalExecutionAuthorizer, type ExternalExecutionPermit, type ExternalExecutionScope, type SandboxResourceClass } from "../lib/external-execution/types.ts";

export const VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE = 96;
export const DEFAULT_SANDBOX_RESOURCE_CLASS: SandboxResourceClass = "vcpu_1";

function vcpus(resourceClass: SandboxResourceClass): number {
  return Number(resourceClass.slice("vcpu_".length));
}

export function requireNode24(output: string): string {
  const version = output.trim();
  if (!/^v24\.\d+\.\d+$/.test(version)) throw new Error("runtime_mismatch");
  return version;
}

export const CREDENTIALS_SCRIPT = `
  const names = [
    'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN',
    'DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_SECRET',
    'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TOKEN', 'GH_TOKEN'
  ];
  console.log(names.some(name => Boolean(process.env[name])) ? 'present' : 'absent');
`;

type CleanupTarget = {
  stop(options: { signal: AbortSignal }): Promise<unknown>;
  delete(options: { signal: AbortSignal; deleteOrphanSnapshots: boolean }): Promise<unknown>;
};

export interface SandboxLifecycleObserver {
  requested?(evidence: { name: string }): Promise<void>;
  created?(evidence: { name: string; sessionId: string }): Promise<void>;
  cleaned?(evidence: { name: string; sessionId: string | null; stop: string; delete: string; lookup: string }): Promise<void>;
}

export type CleanupError = { operation: "stop" | "delete" | "lookup"; code: string };
export function providerErrorCode(error: unknown) {
  return error instanceof ExternalExecutionAuthorityError || error instanceof SandboxConfigurationError || error instanceof SandboxTransportError ? error.code : error instanceof APIError ? `provider_http_${error.response.status}` : "provider_operation_failed";
}
export class ExecutionCancelled extends Error {
  constructor() { super("execution_cancelled"); }
}

export async function cleanupSandbox(sandbox: CleanupTarget, errors: CleanupError[]) {
  const result: { stop: "confirmed" | "failed"; delete: "confirmed" | "failed" } = {
    stop: "failed", delete: "failed",
  };
  // https://vercel.com/docs/sandbox/sdk-reference#sandbox.stop
  // Use independent signals: failed/cancelled work must not cancel cleanup.
  try {
    await sandbox.stop({ signal: AbortSignal.timeout(20_000) });
    result.stop = "confirmed";
  } catch (error) { errors.push({ operation: "stop", code: providerErrorCode(error) }); }
  try {
    await sandbox.delete({ signal: AbortSignal.timeout(20_000), deleteOrphanSnapshots: true });
    result.delete = "confirmed";
  } catch (error) { errors.push({ operation: "delete", code: providerErrorCode(error) }); }
  return result;
}

export function readSandboxCredentials(): { token: string; teamId: string; projectId: string } {
  return sandboxCredentials(process.env);
}

export async function recoverSandbox(
  identity: { name: string; sessionId: string | null; knownAttempt?: { kind: 'baseline' | 'verification'; id: string } },
  authority: ExternalExecutionAuthorizer = ZERO_EXTERNAL_EXECUTION_AUTHORITY,
  scope?: ExternalExecutionScope,
): Promise<{ stop: string; delete: string; lookup: string; errors: CleanupError[] }> {
  if (!scope) throw new ExternalExecutionAuthorityError("execution_authority_missing");
  const credentials = readSandboxCredentials();
  const permit = await authority.reserve({
    scope,
    sandbox: { name: identity.name, projectId: credentials.projectId, teamId: credentials.teamId },
    ...(identity.knownAttempt ? { cleanup: { kind: identity.knownAttempt.kind, attemptId: identity.knownAttempt.id } } : {}),
    amounts: {
      logicalRequests: 1, providerAttempts: VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE,
      inputTokens: 0, outputTokens: 0, sandboxIdentities: 0, sandboxRuntimeMs: 60_000,
      sandboxResourceClass: DEFAULT_SANDBOX_RESOURCE_CLASS,
      verificationAttempts: 0, repairLoopIterations: 0,
    },
  });
  const errors: CleanupError[] = [];
  const result = { stop: "not_needed", delete: "not_needed", lookup: "unconfirmed", errors };
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ ...credentials, name: identity.name, resume: false, signal: AbortSignal.timeout(10_000), fetch: permit.meteredFetch });
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) {
      await permit.complete("succeeded");
      return { ...result, lookup: "absent" };
    }
    errors.push({ operation: "lookup", code: providerErrorCode(error) });
    await permit.complete("ambiguous", "provider_attempt_ambiguous");
    return result;
  }
  if (identity.sessionId && sandbox.currentSession().sessionId !== identity.sessionId) {
    errors.push({ operation: "lookup", code: "provider_operation_failed" });
    await permit.complete("failed", "sandbox_cleanup_unresolved");
    return result;
  }
  Object.assign(result, await cleanupSandbox(sandbox, errors));
  try {
    await Sandbox.get({ ...credentials, name: identity.name, resume: false, signal: AbortSignal.timeout(10_000), fetch: permit.meteredFetch });
    result.lookup = "still_present";
  } catch (error) {
    result.lookup = error instanceof APIError && error.response.status === 404 ? "absent" : "unconfirmed";
    if (result.lookup === "unconfirmed") errors.push({ operation: "lookup", code: providerErrorCode(error) });
  }
  const clean = result.lookup === "absent";
  await permit.complete(clean ? "succeeded" : "failed", clean ? undefined : "sandbox_cleanup_unresolved");
  return result;
}

// Shared Task 1.1 boundary. No host environment is passed to sandbox commands.
// https://vercel.com/docs/sandbox/sdk-reference
export class SandboxBoundary {
  readonly evidence;
  readonly cleanup = { stop: "not_needed", delete: "not_needed", lookup: "not_run" };
  readonly cleanupErrors: CleanupError[] = [];
  readonly transition = { status: "not_run", requested: "deny-all", readBack: null as string | null, sameSession: false };
  private sandbox: Sandbox | undefined;
  private createAttempted = false;
  private credentials: { token: string; teamId: string; projectId: string } | undefined;
  private permit: ExternalExecutionPermit | undefined;

  constructor(
    prefix: string,
    private policy: NetworkPolicy,
    private timeoutMs: number,
    private observer?: SandboxLifecycleObserver,
    private authority: ExternalExecutionAuthorizer = ZERO_EXTERNAL_EXECUTION_AUTHORITY,
    private scope?: ExternalExecutionScope,
    private resourceClass: SandboxResourceClass = DEFAULT_SANDBOX_RESOURCE_CLASS,
  ) {
    this.evidence = {
      name: `${prefix}-${randomUUID()}`, sessionId: null as string | null, created: false,
      image: "vercel/sandbox/node:24", timeoutMs, persistent: false,
      initialNetworkPolicy: policy, resourceClass, vcpus: vcpus(resourceClass), settingsConfirmed: false,
    };
  }

  assertSameSession(sandbox: Sandbox) {
    if (sandbox.currentSession().sessionId !== this.evidence.sessionId) throw new Error("session_changed");
  }

  async denyAll(signal: AbortSignal) {
    this.transition.status = "failed";
    await this.sandbox!.update({ networkPolicy: "deny-all" }, { signal });
    const readBack = await Sandbox.get({ ...this.credentials!, name: this.evidence.name, resume: false, signal, fetch: this.permit!.meteredFetch });
    this.transition.readBack = typeof readBack.networkPolicy === "string" ? readBack.networkPolicy : "custom_or_missing";
    this.transition.sameSession = readBack.currentSession().sessionId === this.evidence.sessionId;
    if (this.transition.readBack !== "deny-all" || !this.transition.sameSession || readBack.currentSession().status !== "running") {
      throw new Error("network_policy_transition_failed");
    }
    this.transition.status = "passed";
  }

  async run(work: (sandbox: Sandbox, signal: AbortSignal) => Promise<void>, cancellation?: AbortSignal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs - 30_000), ...(cancellation ? [cancellation] : [])]);
    let failure: unknown;
    try {
      signal.throwIfAborted();
      requireNode24(process.version);
      if (!this.scope) throw new ExternalExecutionAuthorityError("execution_authority_missing");
      this.credentials = readSandboxCredentials();
      this.permit = await this.authority.reserve({
        scope: this.scope,
        sandbox: { name: this.evidence.name, projectId: this.credentials.projectId, teamId: this.credentials.teamId },
        amounts: {
          logicalRequests: 1,
          providerAttempts: VERCEL_SANDBOX_PROVIDER_ATTEMPT_ALLOWANCE,
          inputTokens: 0,
          outputTokens: 0,
          sandboxIdentities: 1,
          sandboxRuntimeMs: this.timeoutMs,
          sandboxResourceClass: this.resourceClass,
          verificationAttempts: this.scope.operationCategory === "sandbox_verification" ? 1 : 0,
          repairLoopIterations: 0,
        },
      });
      await this.permit.assertOwnership();
      await this.observer?.requested?.({ name: this.evidence.name });
      this.createAttempted = true;
      console.log(JSON.stringify({ event: "sandbox_requested", name: this.evidence.name }));
      this.sandbox = await Sandbox.create({
        ...this.credentials, name: this.evidence.name, image: this.evidence.image,
        persistent: false, timeout: this.timeoutMs, networkPolicy: this.policy, ports: [], signal,
        resources: { vcpus: vcpus(this.resourceClass) }, fetch: this.permit.meteredFetch,
      });
      await this.permit.resolveSandboxCreation?.({ name: this.sandbox.name, sessionId: this.sandbox.currentSession().sessionId });
      this.evidence.created = true;
      if (this.sandbox.persistent || !isDeepStrictEqual(this.sandbox.networkPolicy, this.policy) || this.sandbox.timeout !== this.timeoutMs) {
        throw new Error("unsafe_provider_settings");
      }
      this.evidence.settingsConfirmed = true;
      this.evidence.sessionId = this.sandbox.currentSession().sessionId;
      await this.observer?.created?.({ name: this.evidence.name, sessionId: this.evidence.sessionId });
      await work(this.sandbox, signal);
      signal.throwIfAborted();
    } catch (error) {
      failure = error;
      if (this.createAttempted && !this.sandbox && this.permit?.resolveSandboxCreation) {
        // SDK response parsing failed or transport lost its result. Resolve only
        // an unmatched create attempt; never replace an existing outcome.
        try { await this.permit.resolveSandboxCreation(); } catch { /* Durable unmatched start remains conservative evidence. */ }
        if (!(error instanceof ExternalExecutionAuthorityError) && !(error instanceof SandboxTransportError)) {
          failure = new ExternalExecutionAuthorityError('provider_attempt_ambiguous');
        }
      }
      if (failure instanceof ExternalExecutionAuthorityError) throw failure;
      if (controller.signal.aborted || cancellation?.aborted) throw new ExecutionCancelled();
      throw failure;
    } finally {
      try {
        await this.close();
        if (this.permit) {
          const clean = this.cleanup.stop === "confirmed" && this.cleanup.delete === "confirmed" && this.cleanup.lookup === "absent";
          const uncertain = failure instanceof ExternalExecutionAuthorityError && failure.code === 'provider_attempt_ambiguous';
          try {
            await this.permit.complete(uncertain ? 'ambiguous' : failure ? 'failed' : clean ? 'succeeded' : 'failed',
              uncertain ? 'provider_attempt_ambiguous' : failure instanceof ExternalExecutionAuthorityError ? failure.code : clean ? undefined : 'sandbox_cleanup_unresolved');
          } catch (error) {
            // Cleanup/outcome persistence must not mask a terminal authority
            // refusal with a retryable infrastructure classification.
            if (!(failure instanceof ExternalExecutionAuthorityError)) throw error;
          }
        }
      }
      finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    }
  }

  private async close() {
    if (!this.sandbox && this.createAttempted) {
      try {
        this.sandbox = await Sandbox.get({ ...this.credentials!, name: this.evidence.name, resume: false, signal: AbortSignal.timeout(10_000), fetch: this.permit!.meteredFetch });
        this.evidence.created = true;
      } catch (error) {
        this.cleanup.lookup = "unconfirmed_after_create_failure";
        this.cleanupErrors.push({ operation: "lookup", code: providerErrorCode(error) });
      }
    }
    if (this.sandbox) {
      Object.assign(this.cleanup, await cleanupSandbox(this.sandbox, this.cleanupErrors));
      try {
        await Sandbox.get({ ...this.credentials!, name: this.evidence.name, resume: false, signal: AbortSignal.timeout(10_000), fetch: this.permit!.meteredFetch });
        this.cleanup.lookup = "still_present";
      } catch (error) {
        this.cleanup.lookup = error instanceof APIError && error.response.status === 404 ? "absent" : "unconfirmed";
        if (this.cleanup.lookup === "unconfirmed") this.cleanupErrors.push({ operation: "lookup", code: providerErrorCode(error) });
      }
    }
    await this.observer?.cleaned?.({ name: this.evidence.name, sessionId: this.evidence.sessionId, ...this.cleanup });
  }
}
