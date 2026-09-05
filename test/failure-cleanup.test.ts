import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox, APIError } from "@vercel/sandbox";
import { SandboxBoundary, ExecutionCancelled } from "../src/sandbox-boundary.js";
import { fixtureExecutor, commandEvidence, INSTALL_ARGS, ExecutionFailure } from "../src/fixture-execution.js";
import { classifyFailure, expiryConfirmed, runFailureScenario, observeSandbox } from "../src/failure-cleanup.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("explicit cancellation interrupts work and preserves independent cleanup even if stop fails", async context => {
  const names = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_OIDC_TOKEN"];
  const old = names.map(name => process.env[name]);
  context.after(() => names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }));
  names.forEach(name => { delete process.env[name]; });
  process.env.VERCEL_OIDC_TOKEN = "host-only-failure-sentinel";
  context.mock.method(console, "log", () => {});
  const controller = new AbortController();
  let deleted = false, furtherWork = false;
  context.mock.method(Sandbox, "create", async () => ({
    persistent: false, networkPolicy: "deny-all", timeout: 90_000,
    currentSession: () => ({ sessionId: "test-session", status: "running" }),
    async stop({ signal }: { signal: AbortSignal }) { assert(!signal.aborted); throw new Error("private-provider-error"); },
    async delete({ signal }: { signal: AbortSignal }) { assert(!signal.aborted); deleted = true; },
  }));
  context.mock.method(Sandbox, "get", async () => { throw new APIError(new Response(null, { status: 404 })); });
  const boundary = new SandboxBoundary("vigilo-failure", "deny-all", 90_000);
  await assert.rejects(boundary.run(async (_sandbox, signal) => {
    controller.abort();
    signal.throwIfAborted();
    furtherWork = true;
  }, controller.signal), ExecutionCancelled);
  assert(!furtherWork && deleted);
  assert.deepEqual(boundary.cleanup, { stop: "failed", delete: "confirmed", lookup: "absent" });
  assert.deepEqual(boundary.cleanupErrors, [{ operation: "stop", code: "provider_operation_failed" }]);
  assert(!JSON.stringify(boundary.cleanupErrors).includes("private-provider-error"));
});

test("real npm missing-lock failure and timeout preserve bounded diagnostics without raw text", async context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-command-failure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "failure-control", version: "1.0.0", scripts: { test: "node hang.cjs" } }));
  writeFileSync(join(root, "hang.cjs"), 'console.log("controlled_started"); setTimeout(() => {}, 2000);');
  // Real trusted wrapper + real npm, with only its remote transport replaced.
  const sandbox = { async runCommand({ args }: { args: string[] }) {
    const input = JSON.parse(args[2]!); input.cwd = root;
    const run = spawnSync(process.execPath, [args[0]!, args[1]!, JSON.stringify(input)], { encoding: "utf8", timeout: 5000 });
    return { exitCode: run.status, stdout: async () => run.stdout };
  } } as unknown as Sandbox;
  const execution = fixtureExecutor(sandbox, { assertSameSession() {} } as unknown as SandboxBoundary, new AbortController().signal);
  const install = commandEvidence([...INSTALL_ARGS, "--offline"], 3000);
  await assert.rejects(execution.npm(install, "dependency_installation_failure"), { kind: "dependency_installation_failure" });
  assert.equal(install.exitCode, 1);
  assert.equal(install.diagnostics?.npmCode, "EUSAGE");
  assert.equal(install.diagnostics?.textIncluded, false);
  assert(install.diagnostics!.stderrBytes > 0);
  const timeout = commandEvidence(["test"], 500);
  await assert.rejects(execution.npm(timeout, "unexpected_test_failure"), { kind: "command_timeout" });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.diagnostics?.spawnCode, "ETIMEDOUT");
  assert(!JSON.stringify(timeout).includes("controlled_started"));
});

test("failure classification never converts execution or cleanup failures into a repaired result", () => {
  assert.equal(classifyFailure(new ExecutionCancelled()), "cancelled");
  assert.equal(classifyFailure(new ExecutionFailure("command_timeout", "deadline")), "command_timeout");
  assert.equal(classifyFailure(new ExecutionFailure("dependency_installation_failure", "npm")), "dependency_installation_failure");
  assert.equal(classifyFailure(new Error("secret")), "infrastructure_failure");
  assert.equal(classifyFailure(null), "unexpected_completion");
});

test("expiry requires actual process loss, a passed provider deadline, and a terminal independent observation", () => {
  const facts = { childSignal: "SIGKILL", expiresAt: 1000, observedAt: 2000, status: "stopped", sameSession: true };
  assert(expiryConfirmed(facts));
  assert(expiryConfirmed({ ...facts, status: "absent", sameSession: null }));
  for (const change of [{ childSignal: null }, { observedAt: 999 }, { status: "running" }, { status: "unconfirmed" }, { sameSession: false }]) {
    assert(!expiryConfirmed({ ...facts, ...change }));
  }
});

test("controlled scenarios keep execution outcomes separate from failed cleanup and stop further work", async context => {
  const auth = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_OIDC_TOKEN"];
  const old = auth.map(name => process.env[name]);
  context.after(() => auth.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }));
  auth.forEach(name => { delete process.env[name]; });
  process.env.VERCEL_OIDC_TOKEN = "host-only-failure-sentinel";
  for (const scenario of ["installation_failure", "command_timeout", "cancellation"] as const) {
    await context.test(scenario, async child => {
      child.mock.method(console, "log", () => {});
      let deleted = false;
      const fake = {
        persistent: false, networkPolicy: "deny-all", timeout: 120_000,
        currentSession: () => ({ sessionId: "test-session", status: "running" }),
        async update() {}, async writeFiles() {},
        async runCommand(params: { args: string[]; signal: AbortSignal; env?: unknown }) {
          assert.equal(params.env, undefined);
          assert(!JSON.stringify(params).includes("host-only-failure-sentinel"));
          let output = "absent";
          if (params.args[0] === "--version") output = "v24.19.0";
          if (params.args[1]?.includes("spawnSync")) {
            if (scenario === "cancellation") await new Promise((_resolve, reject) => params.signal.addEventListener("abort", () => reject(params.signal.reason), { once: true }));
            output = JSON.stringify({ exitCode: scenario === "command_timeout" ? null : 1,
              timedOut: scenario === "command_timeout", spawnFailed: scenario === "command_timeout", signalTermination: scenario === "command_timeout",
              stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64), diagnostics: { stdoutBytes: 20, stderrBytes: 100,
                outputTruncated: false, spawnCode: scenario === "command_timeout" ? "ETIMEDOUT" : null, npmCode: "EUSAGE" } });
          }
          return { exitCode: 0, stdout: async () => output };
        },
        async stop() { throw new Error("secret provider response"); },
        async delete() { deleted = true; },
      };
      child.mock.method(Sandbox, "create", async () => fake);
      child.mock.method(Sandbox, "get", async () => {
        if (deleted) throw new APIError(new Response(null, { status: 404 }));
        return fake;
      });
      const report = await runFailureScenario(scenario);
      assert.equal(report.classifiedOutcome, scenario === "installation_failure" ? "dependency_installation_failure" : scenario === "cancellation" ? "cancelled" : scenario);
      assert(!report.acceptancePassed && !report.furtherWorkStarted);
      assert(report.diagnosticsPresent);
      assert.equal(report.cleanup.stop, "failed");
      assert.equal(report.cleanup.delete, "confirmed");
      assert.equal(report.cleanup.lookup, "absent");
      assert(!JSON.stringify(report).includes("secret provider response"));
      assert.equal(report.cancellationObserved, scenario === "cancellation");
    });
  }
});

test("provider inspection never resumes a stopped sandbox and never calls authentication failure absence", async context => {
  context.mock.method(Sandbox, "get", async (params: { resume: boolean }) => {
    assert.equal(params.resume, false);
    throw new APIError(new Response(null, { status: 401 }));
  });
  const observed = await observeSandbox("owned-sandbox", "known-session");
  assert.equal(observed.status, "unconfirmed");
  assert.equal(observed.errorCode, "provider_http_401");
});

test("already cancelled work never provisions a sandbox", async context => {
  context.mock.method(Sandbox, "create", () => { assert.fail("must not provision"); });
  const boundary = new SandboxBoundary("vigilo-failure", "deny-all", 120_000);
  await assert.rejects(boundary.run(async () => assert.fail("must not execute"), AbortSignal.abort()), ExecutionCancelled);
  assert.equal(boundary.evidence.created, false);
  assert.equal(boundary.cleanup.stop, "not_needed");
});
