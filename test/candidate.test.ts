import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, chmodSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOriginalFixture, EXPECTED_FIXTURE_HASH } from "../src/baseline.js";
import { validateCandidatePath, buildCandidate, freezeCandidate, collectTree, localTreeReader, sha256 } from "../src/candidate.js";

function repairedFiles() {
  return loadOriginalFixture().map(file => ({ ...file, mode: 0o644,
    content: file.path === "src/shipping-cost.ts" ? Buffer.from(file.content.toString().replace(" > ", " >= ")) : file.content,
  }));
}

test("rejects traversal, absolute paths, metadata and secret paths", () => {
  for (const path of ["../secret", "src/../../secret", "/etc/passwd", "C:/secret", "src\\file.ts", "src//file.ts", "./src/file.ts", "src/./file.ts", "src/%2e%2e/file", "src/file\0.ts", ".git/config", ".env.local", "src/.env", "credentials.json", "private.key", ".npmrc"]) {
    assert.throws(() => validateCandidatePath(path));
  }
  for (const path of ["src/shipping-cost.ts", ".gitignore", ".nvmrc", "package-lock.json"]) validateCandidatePath(path);
});

test("candidate identity is stable across enumeration order and changes with bytes", () => {
  const base = loadOriginalFixture();
  const files = repairedFiles();
  const candidate = buildCandidate(base, files);
  assert.equal(candidate.baseFixtureHash, EXPECTED_FIXTURE_HASH);
  assert.deepEqual(candidate.changes.map(change => change.path), ["src/shipping-cost.ts"]);
  assert.equal(candidate.candidateHash, buildCandidate(base, [...files].reverse()).candidateHash);
  const source = files.find(file => file.path === "src/shipping-cost.ts")!;
  source.content = Buffer.concat([source.content, Buffer.from("\n")]);
  assert.notEqual(candidate.candidateHash, buildCandidate(base, files).candidateHash);
  assert(Object.isFrozen(candidate));
  assert(Object.isFrozen(candidate.changes));
  assert(Object.isFrozen(candidate.changes[0]));
});

test("rejects hidden changes, deletions, protected-file edits and oversized artifacts", () => {
  const base = loadOriginalFixture();
  for (const path of ["test/shipping-cost.test.ts", "package-lock.json", "package.json", "tsconfig.json", ".gitignore", ".nvmrc"]) {
    const files = repairedFiles();
    files.find(file => file.path === path)!.content = Buffer.from("changed");
    assert.throws(() => buildCandidate(base, files));
  }
  assert.throws(() => buildCandidate(base, base.map(file => ({ ...file, mode: 0o644 }))));
  assert.throws(() => buildCandidate(base, repairedFiles().slice(1)));
  assert.throws(() => buildCandidate(base, [...repairedFiles(), { path: "src/.hidden", content: Buffer.from("hidden"), mode: 0o644 }]));
  const huge = repairedFiles();
  huge.find(file => file.path === "src/shipping-cost.ts")!.content = Buffer.alloc(64 * 1024);
  assert.throws(() => buildCandidate(base, huge));
});

test("filesystem collection detects dotfiles, symlinks and paths escaping the root", async context => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vigilo-candidate-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of repairedFiles()) {
    const directory = file.path.includes("/") ? join(root, file.path.split("/")[0]!) : root;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, file.path), file.content, { mode: 0o644 });
  }
  const base = loadOriginalFixture();
  assert.equal((await collectTree(localTreeReader, root, base)).length, 7);
  writeFileSync(join(root, ".hidden"), "hidden");
  await assert.rejects(collectTree(localTreeReader, root, base));
  rmSync(join(root, ".hidden"));
  rmSync(join(root, "src/shipping-cost.ts"));
  symlinkSync(join(root, "package.json"), join(root, "src/shipping-cost.ts"));
  await assert.rejects(collectTree(localTreeReader, root, base));
  await assert.rejects(collectTree({ ...localTreeReader, realpath: async () => "/outside" }, root, base));
});

test("frozen artifacts survive input mutation, are write-once, and reject tampering", context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-freeze-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "candidates");
  const files = repairedFiles();
  const candidate = buildCandidate(loadOriginalFixture(), files);
  const artifact = freezeCandidate(candidate, directory);
  const bytes = readFileSync(artifact);
  files.find(file => file.path === "src/shipping-cost.ts")!.content.fill(0);
  assert.deepEqual(readFileSync(artifact), bytes);
  assert.equal(freezeCandidate(candidate, directory), artifact);
  chmodSync(artifact, 0o600);
  writeFileSync(artifact, "tampered");
  assert.throws(() => freezeCandidate(candidate, directory));
  assert.equal(readFileSync(artifact, "utf8"), "tampered");
});

test("rejects invalid bases, duplicate files and changed executable permissions", () => {
  const base = loadOriginalFixture();
  assert.throws(() => buildCandidate([...base].reverse(), repairedFiles()));
  const files = repairedFiles();
  files[0] = files[1]!;
  assert.throws(() => buildCandidate(base, files));
  const executable = repairedFiles();
  executable.find(file => file.path === "src/shipping-cost.ts")!.mode = 0o755;
  assert.throws(() => buildCandidate(base, executable));
});

test("collector rejects hard links, unexpected directories, wrong types and oversized files", async context => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vigilo-tree-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of repairedFiles()) {
    mkdirSync(join(root, file.path.includes("/") ? file.path.split("/")[0]! : ""), { recursive: true });
    writeFileSync(join(root, file.path), file.content, { mode: 0o644 });
  }
  const base = loadOriginalFixture();
  mkdirSync(join(root, "src/.hidden"));
  await assert.rejects(collectTree(localTreeReader, root, base));
  rmSync(join(root, "src/.hidden"), { recursive: true });
  const source = join(root, "src/shipping-cost.ts");
  linkSync(source, join(root, "alias"));
  // Remove the alias from enumeration to prove nlink alone rejects a hard link.
  await assert.rejects(collectTree({ ...localTreeReader, readdir: async path => (await localTreeReader.readdir(path)).filter(name => name !== "alias") }, root, base));
  rmSync(join(root, "alias"));
  rmSync(source);
  mkdirSync(source);
  await assert.rejects(collectTree(localTreeReader, root, base));
  rmSync(source, { recursive: true });
  writeFileSync(source, Buffer.alloc(65_537));
  await assert.rejects(collectTree(localTreeReader, root, base));
});

test("freeze rejects forged content hashes and symlink artifact destinations", context => {
  const root = mkdtempSync(join(tmpdir(), "vigilo-artifact-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = buildCandidate(loadOriginalFixture(), repairedFiles());
  const forgedPayload = { schemaVersion: candidate.schemaVersion, baseFixtureHash: candidate.baseFixtureHash,
    changes: [{ ...candidate.changes[0]!, sha256: "0".repeat(64) }] };
  assert.throws(() => freezeCandidate({ ...forgedPayload, candidateHash: sha256(JSON.stringify(forgedPayload)) }, join(root, "forged")));
  const directory = join(root, "candidates");
  mkdirSync(directory);
  const other = join(root, "other");
  writeFileSync(other, "untouched");
  symlinkSync(other, join(directory, `${candidate.candidateHash}.json`));
  assert.throws(() => freezeCandidate(candidate, directory));
  assert.equal(readFileSync(other, "utf8"), "untouched");
});
