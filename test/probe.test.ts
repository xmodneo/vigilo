import assert from "node:assert/strict";
import test from "node:test";
import { APIError, Sandbox } from "@vercel/sandbox";
import { cleanupSandbox, classifyNetworkResult, requireNode24, runProbe, type NetworkObservation } from "../src/probe.js";

test("accepts Node 24 and rejects other or malformed runtime output", () => {
  assert.equal(requireNode24("v24.13.0\n"), "v24.13.0");
  for (const version of ["v22.0.0", "v26.0.0", "v240.0.0", "garbage"]) {
    assert.throws(() => requireNode24(version));
  }
});

const positive: NetworkObservation = {
  outcome: "response", tcpConnected: true, tlsConnected: true, httpStatus: 200,
};
const timeout: NetworkObservation = {
  outcome: "failed", tcpConnected: false, tlsConnected: false,
  failure: { category: "timeout", name: "ProbeTimeoutError", code: "PROBE_REQUEST_TIMEOUT" },
};

test("a timeout alone or failed positive control is inconclusive", () => {
  assert.equal(classifyNetworkResult(undefined, true, timeout), "inconclusive");
  assert.equal(classifyNetworkResult(timeout, true, timeout), "inconclusive");
  assert.equal(classifyNetworkResult({ ...positive, httpStatus: 503 }, true, timeout), "inconclusive");
  assert.equal(classifyNetworkResult(positive, false, timeout), "inconclusive");
});

test("failed communication counts as blocked only with both A/B prerequisites", () => {
  assert.equal(classifyNetworkResult(positive, true, timeout), "blocked");
  assert.equal(classifyNetworkResult(positive, true, {
    ...timeout, failure: { category: "network_error", name: "Error", code: "PROVIDER_SPECIFIC_CODE" },
  }), "blocked");
  assert.equal(classifyNetworkResult(positive, true, undefined), "inconclusive");
});

test("HTTP, TCP, or TLS connection after deny-all never counts as blocked", () => {
  assert.equal(classifyNetworkResult(positive, true, positive), "not_blocked");
  assert.equal(classifyNetworkResult(positive, true, { ...timeout, tcpConnected: true }), "not_blocked");
  assert.equal(classifyNetworkResult(positive, true, { ...timeout, tlsConnected: true }), "not_blocked");
});

test("deletion is still attempted when stopping fails; raw errors are not returned", async () => {
  let deleted = false;
  const result = await cleanupSandbox({
    async stop() { throw new Error("secret-token-must-not-appear"); },
    async delete() { deleted = true; },
  });
  assert.equal(deleted, true);
  assert.deepEqual(result, { stop: "failed", delete: "confirmed" });
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("failed deletion is reported instead of claiming cleanup succeeded", async () => {
  const result = await cleanupSandbox({
    async stop() {},
    async delete() { throw new Error("provider unavailable"); },
  });
  assert.deepEqual(result, { stop: "confirmed", delete: "failed" });
});

test("an intermediate command failure still stops and deletes the sandbox", async (context) => {
  const authNames = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_OIDC_TOKEN"];
  const original = authNames.map(name => process.env[name]);
  context.after(() => {
    authNames.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  });
  authNames.forEach(name => { delete process.env[name]; });
  process.env.VERCEL_OIDC_TOKEN = "unit-test-sentinel-never-forward";
  let stopped = false;
  let deleted = false;
  context.mock.method(console, "log", () => {});
  context.mock.method(Sandbox, "create", async () => ({
    persistent: false, networkPolicy: "allow-all", timeout: 120_000,
    currentSession() { return { sessionId: "test-session", status: "running" }; },
    async runCommand() { throw new Error("unit-test-sentinel-never-forward"); },
    async stop() { stopped = true; },
    async delete() { deleted = true; },
  }));
  context.mock.method(Sandbox, "get", async () => {
    throw new APIError(new Response(null, { status: 404 }));
  });

  const report = await runProbe();
  assert.equal(report.success, false);
  assert.deepEqual(report.error, { phase: "runtime", code: "operation_failed" });
  assert.equal(stopped && deleted, true);
  assert.deepEqual(report.cleanup, { stop: "confirmed", delete: "confirmed", lookup: "absent" });
  assert.equal(JSON.stringify(report).includes("unit-test-sentinel"), false);
});

test("A/B prerequisites fail closed and still clean up", async (context) => {
  const authNames = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_OIDC_TOKEN"];
  const original = authNames.map(name => process.env[name]);
  context.after(() => {
    authNames.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  });
  authNames.forEach(name => { delete process.env[name]; });
  process.env.VERCEL_OIDC_TOKEN = "unit-test-sentinel";

  for (const scenario of ["positive_failed", "update_failed", "wrong_session", "outbound_connected"] as const) {
    await context.test(scenario, async (child) => {
      child.mock.method(console, "log", () => {});
      let deleted = false;
      let policy = "allow-all";
      let updates = 0;
      const networkCommands: string[][] = [];
      const outputs = ["v24.19.0", "absent", "filesystem_ok",
        JSON.stringify(scenario === "positive_failed" ? timeout : positive), JSON.stringify(positive)];
      const fake = {
        persistent: false, timeout: 120_000,
        get networkPolicy() { return policy; },
        currentSession() {
          return { status: "running", sessionId: scenario === "wrong_session" && updates > 0 ? "different-session" : "test-session" };
        },
        async runCommand(params: { args: string[]; env?: unknown }) {
          assert.equal(params.env, undefined);
          assert.equal(JSON.stringify(params).includes("unit-test-sentinel"), false);
          if (params.args.includes("--input-type=module")) networkCommands.push(params.args);
          const output = outputs.shift();
          assert.notEqual(output, undefined);
          return { exitCode: 0, stdout: async () => output };
        },
        async update(params: { networkPolicy: string }) {
          updates++;
          assert.equal(params.networkPolicy, "deny-all");
          if (scenario === "update_failed") throw new Error("simulated provider failure");
          policy = params.networkPolicy;
        },
        async stop() {},
        async delete() { deleted = true; },
      };
      child.mock.method(Sandbox, "create", async (params: { networkPolicy: string; env?: unknown }) => {
        assert.equal(params.networkPolicy, "allow-all");
        assert.equal(params.env, undefined);
        return fake;
      });
      child.mock.method(Sandbox, "get", async (params: { resume: boolean }) => {
        assert.equal(params.resume, false);
        if (deleted) throw new APIError(new Response(null, { status: 404 }));
        return fake;
      });

      const report = await runProbe();
      assert.equal(report.success, false);
      assert.deepEqual(report.cleanup, { stop: "confirmed", delete: "confirmed", lookup: "absent" });
      assert.equal(updates, scenario === "positive_failed" ? 0 : 1);
      if (scenario === "outbound_connected") {
        assert.equal(report.outboundAfterDeny.status, "not_blocked");
        assert.equal(networkCommands.length, 2);
        assert.deepEqual(networkCommands[0], networkCommands[1]);
      } else {
        assert.equal(report.outboundAfterDeny.status, "inconclusive");
        assert.equal(networkCommands.length, 1);
      }
    });
  }
});
