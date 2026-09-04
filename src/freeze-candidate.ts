import { APIError } from "@vercel/sandbox";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadOriginalFixture, EXPECTED_FIXTURE_HASH, fixtureHash } from "./baseline.js";
import { SandboxBoundary, CREDENTIALS_SCRIPT, requireNode24 } from "./sandbox-boundary.js";
import { buildCandidate, collectTree, freezeCandidate, CandidateError, sha256, type Candidate, type TreeReader } from "./candidate.js";

const ROOT = "/vercel/sandbox/fixture";
const PATCH_PATH = "/vercel/sandbox/vigilo-repair.patch";
const PATCH_HASH = "92d84ade6a0017d5d740baf3b7f28f64dfcaae683920899a401983b4819fc930";

function loadPatch() {
  const path = new URL("../../fixtures/repairs/free-shipping.patch", import.meta.url);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096) throw new CandidateError("invalid_patch_file");
  const content = readFileSync(path);
  if (sha256(content) !== PATCH_HASH) throw new CandidateError("patch_identity_mismatch");
  return content;
}

export async function runCandidateFreeze() {
  const boundary = new SandboxBoundary("vigilo-candidate", "deny-all", 240_000);
  const report = {
    success: false, baseFixtureIdentity: EXPECTED_FIXTURE_HASH,
    changedFileCount: 0, changedPaths: [] as string[], changedContentHashes: [] as { path: string; sha256: string }[],
    candidateIdentity: null as string | null, validation: "not_run", frozenOutsideSandbox: false,
    cleanup: boundary.cleanup, error: null as { phase: string; code: string } | null,
  };
  let phase = "local_integrity";
  try {
    const original = loadOriginalFixture();
    const patch = loadPatch();
    let candidate: Candidate | undefined;
    phase = "sandbox";
    await boundary.run(async (sandbox, signal) => {
      const runtime = await sandbox.runCommand({ cmd: "node", args: ["--version"], signal, timeoutMs: 10_000 });
      if (runtime.exitCode !== 0) throw new CandidateError("runtime_check_failed");
      requireNode24(await runtime.stdout({ signal }));
      const credentials = await sandbox.runCommand({ cmd: "node", args: ["-e", CREDENTIALS_SCRIPT], signal, timeoutMs: 10_000 });
      if (credentials.exitCode !== 0 || (await credentials.stdout({ signal })).trim() !== "absent") throw new CandidateError("credential_boundary_failed");
      const reader: TreeReader = {
        // withFileTypes uses enumeration that includes dotfiles in SDK 3.2.1.
        // https://vercel.com/docs/sandbox/sdk-reference#filesystem-class
        readdir: async path => (await sandbox.fs.readdir(path, { withFileTypes: true, signal })).map(entry => entry.name),
        lstat: path => sandbox.fs.lstat(path, { signal }),
        realpath: path => sandbox.fs.realpath(path, { signal }),
        read: async path => {
          const stream = await sandbox.readFile({ path }, { signal });
          if (!stream) throw new CandidateError("file_missing");
          return stream;
        },
      };
      phase = "upload";
      await sandbox.writeFiles(original.map(file => ({ path: `${ROOT}/${file.path}`, content: file.content, mode: 0o644 })), { signal });
      if (fixtureHash(await collectTree(reader, ROOT, original)) !== EXPECTED_FIXTURE_HASH) throw new CandidateError("uploaded_base_mismatch");
      await sandbox.writeFiles([{ path: PATCH_PATH, content: patch, mode: 0o644 }], { signal });
      const uploadedPatch = await sandbox.readFileToBuffer({ path: PATCH_PATH }, { signal });
      if (!uploadedPatch || sha256(uploadedPatch) !== PATCH_HASH) throw new CandidateError("uploaded_patch_mismatch");
      phase = "apply_patch";
      // The managed image includes Git but not patch. git apply works without a
      // repository or index: https://git-scm.com/docs/git-apply#_description
      const applied = await sandbox.runCommand({ cmd: "git", args: ["apply", "--whitespace=error-all", "-p1", PATCH_PATH],
        cwd: ROOT, timeoutMs: 10_000, signal });
      boundary.assertSameSession(sandbox);
      // Patch output is untrusted and irrelevant to candidate collection.
      if (applied.exitCode !== 0) throw new CandidateError("patch_command_failed");
      phase = "collect_candidate";
      candidate = buildCandidate(original, await collectTree(reader, ROOT, original));
      boundary.assertSameSession(sandbox);
      report.validation = "passed";
      report.changedFileCount = candidate.changes.length;
      report.changedPaths = candidate.changes.map(change => change.path);
      report.changedContentHashes = candidate.changes.map(({ path, sha256 }) => ({ path, sha256 }));
      report.candidateIdentity = candidate.candidateHash;
    });
    phase = "cleanup";
    if (boundary.cleanup.stop !== "confirmed" || boundary.cleanup.delete !== "confirmed" || boundary.cleanup.lookup !== "absent") {
      throw new CandidateError("cleanup_unconfirmed");
    }
    phase = "freeze_on_host";
    if (!candidate) throw new CandidateError("candidate_missing");
    loadOriginalFixture();
    const directory = fileURLToPath(new URL("../../.vigilo", import.meta.url));
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new CandidateError("unsafe_artifact_root");
    freezeCandidate(candidate, `${directory}/candidates`);
    report.frozenOutsideSandbox = true;
    report.success = true;
  } catch (error) {
    if (report.validation === "not_run") report.validation = "failed";
    report.error = { phase, code: error instanceof CandidateError ? error.message
      : error instanceof APIError ? `provider_http_${error.response.status}` : "operation_failed" };
  }
  return report;
}

if (import.meta.main) {
  const report = await runCandidateFreeze();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success ? 0 : 1;
}
