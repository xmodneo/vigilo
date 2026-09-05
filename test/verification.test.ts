import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, createReadStream, readFileSync } from "node:fs";
import { readdir, lstat, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import { APIError, Sandbox } from "@vercel/sandbox";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCandidate, parseCandidate, loadCandidate, collectTree, localTreeReader } from "../src/candidate.js";
import { loadOriginalFixture, parseRepairedTests, TEST_NAMES } from "../src/baseline.js";
import { runVerification, VERIFICATION_CONTROL } from "../src/verify-candidate.js";

function passingReport() {
  return { success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{ name: "/vercel/sandbox/fixture/test/shipping-cost.test.ts", status: "passed", message: "",
      assertionResults: TEST_NAMES.map(title => ({ title, fullName: title, status: "passed", failureMessages: [] })) }] };
}

test("verification accepts exactly three passing tests and rejects failed or abnormal test runs", () => {
  const report = passingReport();
  assert.deepEqual(parseRepairedTests(JSON.stringify(report), 0), { total: 3, passed: 3, failed: 0,
    regression: { name: TEST_NAMES[1], status: "passed" } });
  for (const code of [1, 2, 137, null]) assert.throws(() => parseRepairedTests(JSON.stringify(report), code));
  report.testResults[0]!.assertionResults[1]!.status = "failed";
  assert.throws(() => parseRepairedTests(JSON.stringify(report), 0));
  report.testResults[0]!.assertionResults[1]!.status = "skipped";
  assert.throws(() => parseRepairedTests(JSON.stringify(report), 0));
});

function repaired() {
  const base = loadOriginalFixture();
  return buildCandidate(base, base.map(file => ({ ...file, mode: 0o644,
    content: file.path === "src/shipping-cost.ts" ? Buffer.from(file.content.toString().replace(" > ", " >= ")) : file.content })));
}

test("candidate data rejects wrong base, corrupted bytes and mismatched identity", () => {
  const candidate = repaired();
  assert.equal(parseCandidate(JSON.stringify(candidate)).candidateHash, candidate.candidateHash);
  assert.throws(() => parseCandidate(JSON.stringify({ ...candidate, baseFixtureHash: "0".repeat(64) })));
  assert.throws(() => parseCandidate(JSON.stringify({ ...candidate, changes: [{ ...candidate.changes[0], contentBase64: "Y29ycnVwdA==" }] })));
  assert.throws(() => parseCandidate(JSON.stringify({ ...candidate, candidateHash: "0".repeat(64) })));
  for (const raw of ["null", "{}", "bad json", " ".repeat(16_385)]) assert.throws(() => parseCandidate(raw));
});

test("loader consumes a bounded frozen data file without a patch dependency", context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-verifier-input-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "candidate.json");
  writeFileSync(file, JSON.stringify(repaired()));
  assert.equal(loadCandidate(file).candidateHash, repaired().candidateHash);
  writeFileSync(file, " ".repeat(16_385));
  assert.throws(() => loadCandidate(file));
});

test("execution artifacts do not hide source mutation or new source files", async context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-verifier-tree-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  // macOS temporary paths can have symlinked ancestors; use their canonical root.
  const canonical = await localTreeReader.realpath(root);
  const base = loadOriginalFixture();
  for (const file of base) {
    mkdirSync(join(root, file.path.includes("/") ? file.path.split("/")[0]! : ""), { recursive: true });
    writeFileSync(join(root, file.path), file.content, { mode: 0o644 });
  }
  const candidate = repaired();
  const change = candidate.changes[0]!;
  writeFileSync(join(root, change.path), Buffer.from(change.contentBase64, "base64"));
  for (const dir of ["node_modules", "dist", ".vitest"]) mkdirSync(join(root, dir));
  await assert.rejects(collectTree(localTreeReader, canonical, base));
  assert.equal(buildCandidate(base, await collectTree(localTreeReader, canonical, base, true)).candidateHash, candidate.candidateHash);
  writeFileSync(join(root, change.path), "mutated after test");
  assert.notEqual(buildCandidate(base, await collectTree(localTreeReader, canonical, base, true)).candidateHash, candidate.candidateHash);
  writeFileSync(join(root, "src/.unexpected"), "hidden");
  await assert.rejects(collectTree(localTreeReader, canonical, base, true));
});

test("invalid artifact data is rejected before any verifier is provisioned", async context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-invalid-verifier-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  let creates = 0;
  context.mock.method(Sandbox, "create", async () => { creates++; throw new Error("must not provision"); });
  for (const candidate of [
    { ...repaired(), baseFixtureHash: "wrong" },
    { ...repaired(), candidateHash: "wrong" },
    { ...repaired(), changes: [{ ...repaired().changes[0], contentBase64: "Y29ycnVwdA==" }] },
  ]) {
    const path = join(root, "candidate.json");
    writeFileSync(path, JSON.stringify(candidate));
    const result = await runVerification(path);
    assert.equal(result.success, false);
    assert.equal(result.outcome, "invalid_candidate");
  }
  assert.equal(creates, 0);
});

test("fresh verifier uses only frozen bytes, gates scripts, rejects failures and always cleans up", async context => {
  const authNames = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_OIDC_TOKEN"];
  const originalEnv = authNames.map(name => process.env[name]);
  context.after(() => authNames.forEach((name, i) => {
    if (originalEnv[i] === undefined) delete process.env[name]; else process.env[name] = originalEnv[i];
  }));
  authNames.forEach(name => { delete process.env[name]; });
  process.env.VERCEL_OIDC_TOKEN = "host-only-verifier-sentinel";
  for (const scenario of ["passed", "failed_tests", "mutated_source", "typecheck_failed", "install_failed", "policy_failed", "same_sandbox", "same_session", "cleanup_failed"]) {
    await context.test(scenario, async child => {
      const temporary = mkdtempSync(join(tmpdir(), "vigilo-verifier-work-"));
      const host = await realpath(temporary);
      child.after(() => rmSync(host, { recursive: true, force: true }));
      const path = join(host, "candidate.json");
      const candidate = repaired();
      writeFileSync(path, JSON.stringify(candidate));
      const remoteRoot = "/vercel/sandbox/fixture";
      const local = (remote: string) => { assert(remote.startsWith(remoteRoot)); return join(host, "fixture", remote.slice(remoteRoot.length)); };
      let policy: unknown = { allow: ["registry.npmjs.org"] };
      let stopped = false, deleted = false, confirmedPolicy = false;
      let uploads = 0;
      const scripts: string[][] = [];
      const report = passingReport();
      const fake = {
        name: "", persistent: false, timeout: 240_000,
        get networkPolicy() { return policy; },
        currentSession: () => ({ sessionId: "fresh-verifier-session", status: "running" }),
        fs: {
          readdir: async (remote: string) => (await readdir(local(remote))).map(name => ({ name })),
          lstat: (remote: string) => lstat(local(remote)),
          realpath: async (remote: string) => { assert.equal(await realpath(local(remote)), local(remote)); return remote; },
        },
        async writeFiles(files: { path: string; content: Buffer }[]) {
          uploads++;
          if (uploads === 1) assert.equal(files.length, 7);
          else {
            assert.equal(uploads, 2);
            assert.equal(files.length, 1);
            assert.equal(files[0]!.path, `${remoteRoot}/src/shipping-cost.ts`);
            assert.deepEqual(files[0]!.content, Buffer.from(candidate.changes[0]!.contentBase64, "base64"));
          }
          for (const file of files) {
            assert(!file.path.endsWith(".patch"));
            const target = local(file.path);
            mkdirSync(join(target, ".."), { recursive: true });
            writeFileSync(target, file.content, { mode: 0o644 });
          }
        },
        async readFile({ path }: { path: string }) {
          return path.endsWith("/.vitest/json/output.json") ? Readable.from([JSON.stringify(report)]) : createReadStream(local(path));
        },
        async runCommand(params: { cmd: string; args: string[]; env?: unknown }) {
          assert.equal(params.cmd, "node"); // No Git/patch applicator can run in the verifier.
          assert.equal(params.env, undefined);
          assert(!JSON.stringify(params).includes("host-only-verifier-sentinel"));
          let output = "absent";
          if (params.args[0] === "--version") output = "v24.19.0";
          else if (params.args.length === 3) {
            const { args } = JSON.parse(params.args[2]!) as { args: string[] };
            scripts.push(args);
            const install = args[0] === "ci";
            if (install) {
              assert.deepEqual(policy, { allow: ["registry.npmjs.org"] });
              assert(args.includes("--ignore-scripts"));
              mkdirSync(local(`${remoteRoot}/node_modules`));
            } else { assert.equal(policy, "deny-all"); assert(confirmedPolicy); }
            if (args[0] === "test" && scenario === "mutated_source") writeFileSync(local(`${remoteRoot}/src/shipping-cost.ts`), "mutated");
            const failed = (scenario === "install_failed" && install) || (scenario === "typecheck_failed" && args[1] === "typecheck") || (scenario === "failed_tests" && args[0] === "test");
            if (scenario === "failed_tests") report.testResults[0]!.assertionResults[1]!.status = "failed";
            output = JSON.stringify({ exitCode: failed ? 1 : 0, timedOut: false, spawnFailed: false, signalTermination: false,
              stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) });
          }
          return { exitCode: 0, stdout: async () => output };
        },
        async update() { if (scenario === "policy_failed") throw new Error("policy failed"); policy = "deny-all"; },
        async stop() { stopped = true; },
        async delete() { if (scenario === "cleanup_failed") throw new Error("delete failed"); deleted = true; },
      };
      child.mock.method(console, "log", () => {});
      child.mock.method(Sandbox, "create", async (params: { name: string; snapshot?: unknown; source?: unknown; env?: unknown }) => {
        assert.equal(params.snapshot, undefined); assert.equal(params.source, undefined); assert.equal(params.env, undefined);
        fake.name = scenario === "same_sandbox" ? VERIFICATION_CONTROL.repairSandbox.name : params.name;
        return fake;
      });
      child.mock.method(Sandbox, "get", async () => {
        if (deleted) throw new APIError(new Response(null, { status: 404 }));
        confirmedPolicy = policy === "deny-all";
        return fake;
      });
      const control = scenario === "same_session" ? { candidateHash: candidate.candidateHash,
        repairSandbox: { name: VERIFICATION_CONTROL.repairSandbox.name, sessionId: "fresh-verifier-session" } }
        : VERIFICATION_CONTROL;
      const result = await runVerification(path, control);
      assert.equal(result.success, scenario === "passed");
      assert(stopped);
      assert.equal(deleted, scenario !== "cleanup_failed");
      if (["failed_tests", "mutated_source", "typecheck_failed"].includes(scenario)) assert.equal(result.outcome, "candidate_verification_failure");
      if (["install_failed", "policy_failed", "same_sandbox", "same_session", "cleanup_failed"].includes(scenario)) assert.equal(result.outcome, "verifier_infrastructure_failure");
      if (scenario === "mutated_source") assert.equal(result.sourceIdentityUnchangedAfterVerification, false);
      if (scenario === "passed") {
        assert(result.distinctSandboxConfirmed && result.candidateIdentityMatches && result.sourceIdentityUnchangedAfterVerification);
        assert.equal(result.tests?.passed, 3);
        assert.equal(result.tests?.failed, 0);
      }
      if (["install_failed", "policy_failed", "same_sandbox", "same_session"].includes(scenario)) assert(scripts.every(args => args[0] === "ci"));
      assert(!JSON.stringify(result).includes("host-only-verifier-sentinel"));
      const verifierSource = readFileSync(new URL("../../src/verify-candidate.ts", import.meta.url), "utf8");
      assert(!verifierSource.includes("free-shipping.patch") && !verifierSource.includes("./freeze-candidate"));
    });
  }
});
