import { createHash } from "node:crypto";
import { createReadStream, constants, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, fsyncSync, fchmodSync, linkSync, rmSync, lstatSync, fstatSync, readFileSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXPECTED_FIXTURE_HASH, fixtureHash } from "./baseline.js";

type File = { path: string; content: Buffer };
type CollectedFile = File & { mode: number };
const SOURCE = "src/shipping-cost.ts";
const MAX_FILE_BYTES = 65_536;
const MAX_TREE_BYTES = 131_072;
const MAX_ARTIFACT_BYTES = 16_384;
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export class CandidateError extends Error {}
function requireSafe(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CandidateError(code);
}

export function validateCandidatePath(path: string) {
  requireSafe(typeof path === "string" && path.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(path), "invalid_path");
  for (const segment of path.split("/")) {
    requireSafe(segment !== "" && segment !== "." && segment !== "..", "invalid_path_segment");
    requireSafe(!/^(?:\.git|\.env.*|\.npmrc|\.ssh|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(segment) &&
      !/\.(?:pem|key|p12|pfx)$/i.test(segment), "forbidden_path");
  }
}

function verifiedBase(base: File[]) {
  requireSafe(fixtureHash(base) === EXPECTED_FIXTURE_HASH, "base_identity_mismatch");
  return new Map(base.map(file => [file.path, file.content]));
}

export function buildCandidate(base: File[], files: CollectedFile[]) {
  const original = verifiedBase(base);
  requireSafe(files.length === original.size, "file_set_mismatch");
  const seen = new Set<string>();
  let bytes = 0;
  const changes = [];
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    validateCandidatePath(file.path);
    requireSafe(original.has(file.path) && !seen.has(file.path), "unexpected_or_duplicate_file");
    seen.add(file.path);
    requireSafe(file.mode === 0o644 && Buffer.isBuffer(file.content), "unexpected_file_attributes");
    bytes += file.content.length;
    requireSafe(file.content.length <= MAX_FILE_BYTES && bytes <= MAX_TREE_BYTES, "candidate_too_large");
    if (!file.content.equals(original.get(file.path)!)) {
      requireSafe(file.path === SOURCE, "protected_file_changed");
      changes.push(Object.freeze({ path: file.path, sha256: sha256(file.content), byteLength: file.content.length,
        contentBase64: file.content.toString("base64") }));
    }
  }
  requireSafe(changes.length === 1, "expected_source_change_missing");
  const payload = { schemaVersion: 1 as const, baseFixtureHash: EXPECTED_FIXTURE_HASH, changes: Object.freeze(changes) };
  // Canonical serialization includes the actual changed bytes, not just metadata.
  const candidate = Object.freeze({ ...payload, candidateHash: sha256(JSON.stringify(payload)) });
  requireSafe(Buffer.byteLength(JSON.stringify(candidate)) <= MAX_ARTIFACT_BYTES, "artifact_too_large");
  return candidate;
}
export type Candidate = ReturnType<typeof buildCandidate>;

type FileStat = {
  mode: number; size: number; nlink: number; ino: number; mtimeMs: number; ctimeMs: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
};
export type TreeReader = {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  read(path: string): Promise<AsyncIterable<Uint8Array | string>>;
};
export const localTreeReader: TreeReader = {
  readdir, lstat, realpath, read: async path => createReadStream(path),
};

// Enumerate ALL entries (including hidden files), then independently read every
// allowed file. No diff, Git status, ignore rule, or sandbox hash is trusted.
export async function collectTree(reader: TreeReader, root: string, base: File[]): Promise<CollectedFile[]> {
  const original = verifiedBase(base);
  const directories = new Set(["", "src", "test"]);
  requireSafe(root.startsWith("/") && resolve(root) === root, "invalid_root");
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  async function walk(relative: string) {
    const path = relative ? `${root}/${relative}` : root;
    const before = await reader.lstat(path);
    requireSafe(!before.isSymbolicLink() && (before.isFile() || before.isDirectory()), "unexpected_file_type");
    requireSafe(await reader.realpath(path) === path, "path_outside_root");
    if (before.isDirectory()) {
      requireSafe(directories.has(relative), "unexpected_directory");
      const names = (await reader.readdir(path)).sort();
      requireSafe(names.length <= 16 && new Set(names).size === names.length, "invalid_directory_entries");
      for (const name of names) {
        validateCandidatePath(name);
        requireSafe(!name.includes("/"), "invalid_entry_name");
        const child = relative ? `${relative}/${name}` : name;
        requireSafe(original.has(child) || directories.has(child), "unexpected_entry");
        await walk(child);
      }
      requireSafe(JSON.stringify((await reader.readdir(path)).sort()) === JSON.stringify(names), "tree_changed_during_collection");
    } else {
      requireSafe(original.has(relative) && before.nlink === 1 && (before.mode & 0o7777) === 0o644, "unexpected_file_attributes");
      requireSafe(Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= MAX_FILE_BYTES, "file_too_large");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of await reader.read(path)) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        totalBytes += buffer.length;
        requireSafe(size <= MAX_FILE_BYTES && totalBytes <= MAX_TREE_BYTES, "tree_too_large");
        chunks.push(buffer);
      }
      requireSafe(size === before.size, "file_size_changed");
      files.push({ path: relative, mode: before.mode & 0o7777, content: Buffer.concat(chunks) });
    }
    const after = await reader.lstat(path);
    requireSafe(before.ino === after.ino && before.mode === after.mode && before.size === after.size &&
      before.nlink === after.nlink && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    "tree_changed_during_collection");
  }
  await walk("");
  requireSafe(files.length === original.size && new Set(files.map(file => file.path)).size === original.size, "file_set_mismatch");
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// A single host-side artifact contains both manifest and changed bytes. Publish
// atomically without replacing an existing identity; read-only is defense in depth.
export function freezeCandidate(candidate: Candidate, directory: string): string {
  requireSafe(candidate.schemaVersion === 1 && candidate.baseFixtureHash === EXPECTED_FIXTURE_HASH && candidate.changes.length === 1, "invalid_candidate_manifest");
  const change = candidate.changes[0]!;
  requireSafe(change.path === SOURCE && typeof change.contentBase64 === "string" && change.contentBase64.length <= MAX_ARTIFACT_BYTES, "invalid_candidate_change");
  const content = Buffer.from(change.contentBase64, "base64");
  requireSafe(content.toString("base64") === change.contentBase64 && content.length === change.byteLength && sha256(content) === change.sha256, "changed_content_mismatch");
  const payload = { schemaVersion: 1, baseFixtureHash: EXPECTED_FIXTURE_HASH, changes: [
    { path: change.path, sha256: change.sha256, byteLength: change.byteLength, contentBase64: change.contentBase64 },
  ] };
  requireSafe(candidate.candidateHash === sha256(JSON.stringify(payload)), "candidate_identity_mismatch");
  const bytes = Buffer.from(JSON.stringify({ ...payload, candidateHash: candidate.candidateHash }) + "\n");
  requireSafe(bytes.length <= MAX_ARTIFACT_BYTES, "artifact_too_large");
  const target = resolve(directory);
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  requireSafe(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink(), "unsafe_artifact_directory");
  const destination = join(target, `${candidate.candidateHash}.json`);
  const staging = mkdtempSync(join(target, ".stage-"));
  try {
    const source = join(staging, "candidate.json");
    const fd = openSync(source, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); fchmodSync(fd, 0o444); }
    finally { closeSync(fd); }
    try { linkSync(source, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(existing);
        requireSafe(stat.isFile() && stat.size === bytes.length && (stat.mode & 0o7777) === 0o444, "artifact_conflict");
        requireSafe(readFileSync(existing).equals(bytes), "artifact_conflict");
      } finally { closeSync(existing); }
    }
    return destination;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
