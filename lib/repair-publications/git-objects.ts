import { createHash } from 'node:crypto';

import { candidatePath, candidatePathKey, CANDIDATE_LIMITS } from '../repair-candidates/policy.ts';
import { sha256 } from '../repair-candidates/identity.ts';
import type { FrozenCandidateFile } from '../repair-candidates/types.ts';
import type { GitTreeEntry } from '../investigations/types.ts';
import { normalizeContextPath } from '../investigations/policy.ts';

const GIT_SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
export const PUBLICATION_MAX_TREE_ENTRIES = 100_000;
export const PUBLICATION_AUTHOR = { name: 'Vigilo', email: 'publication@vigilo.invalid' } as const;

export class PublicationArtifactError extends Error {
  constructor(public readonly code:
    | 'publication_artifact_invalid'
    | 'publication_base_invalid'
    | 'publication_path_not_allowed'
    | 'publication_tree_incomplete') {
    super(code);
    this.name = 'PublicationArtifactError';
  }
}

interface GitLeaf {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  type: 'blob' | 'commit';
  sha: string;
}

export interface PreparedPublicationBlob {
  path: string;
  bytes: Buffer;
  sha: string;
}

export interface PreparedGitPublication {
  baseCommitSha: string;
  baseTreeSha: string;
  blobs: PreparedPublicationBlob[];
  changedPaths: string[];
  commit: {
    author: typeof PUBLICATION_AUTHOR;
    committedAt: string;
    message: string;
    parentSha: string;
    sha: string;
    treeSha: string;
  };
  entries: GitLeaf[];
  treeSha: string;
}

function gitObjectSha(type: 'blob' | 'tree' | 'commit', content: Buffer): string {
  return createHash('sha1').update(`${type} ${content.byteLength}\0`, 'utf8').update(content).digest('hex');
}

function assertSha(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new PublicationArtifactError('publication_artifact_invalid');
}

function isWorkflowPath(path: string): boolean {
  return candidatePathKey(path).startsWith('.github/workflows/');
}

function treeSortName(name: string, directory: boolean): Buffer {
  return Buffer.from(`${name}${directory ? '/' : ''}`, 'utf8');
}

function calculateTree(entries: GitLeaf[]): string {
  type Directory = { directories: Map<string, Directory>; leaves: Map<string, GitLeaf> };
  const root: Directory = { directories: new Map(), leaves: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let directory = root;
    for (const segment of parts.slice(0, -1)) {
      let child = directory.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), leaves: new Map() };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    const name = parts.at(-1)!;
    if (directory.leaves.has(name) || directory.directories.has(name)) throw new PublicationArtifactError('publication_tree_incomplete');
    directory.leaves.set(name, entry);
  }
  const visit = (directory: Directory): string => {
    const values: Array<{ name: string; directory: boolean; mode: string; sha: string }> = [];
    for (const [name, child] of directory.directories) values.push({ name, directory: true, mode: '40000', sha: visit(child) });
    for (const [name, leaf] of directory.leaves) values.push({ name, directory: false, mode: leaf.mode, sha: leaf.sha });
    values.sort((left, right) => Buffer.compare(treeSortName(left.name, left.directory), treeSortName(right.name, right.directory)));
    const chunks: Buffer[] = [];
    for (const value of values) {
      chunks.push(Buffer.from(`${value.mode} ${value.name}\0`, 'utf8'), Buffer.from(value.sha, 'hex'));
    }
    return gitObjectSha('tree', Buffer.concat(chunks));
  };
  return visit(root);
}

function commitSha(input: { treeSha: string; parentSha: string; committedAt: Date; message: string }): string {
  if (!Number.isFinite(input.committedAt.getTime()) || input.committedAt.getUTCMilliseconds() !== 0) throw new PublicationArtifactError('publication_artifact_invalid');
  const timestamp = Math.floor(input.committedAt.getTime() / 1_000);
  const identity = `${PUBLICATION_AUTHOR.name} <${PUBLICATION_AUTHOR.email}> ${timestamp} +0000`;
  const content = Buffer.from(`tree ${input.treeSha}\nparent ${input.parentSha}\nauthor ${identity}\ncommitter ${identity}\n\n${input.message}`, 'utf8');
  return gitObjectSha('commit', content);
}

export function prepareGitPublication(input: {
  baseCommitSha: string;
  baseTreeSha: string;
  candidateIdentity: string;
  committedAt: Date;
  files: FrozenCandidateFile[];
  profileIdentity: string;
  treeEntries: GitTreeEntry[];
  treeTruncated?: boolean;
}): PreparedGitPublication {
  assertSha(input.baseCommitSha, GIT_SHA);
  assertSha(input.baseTreeSha, GIT_SHA);
  assertSha(input.candidateIdentity, HASH);
  assertSha(input.profileIdentity, HASH);
  if (input.treeTruncated || input.treeEntries.length > PUBLICATION_MAX_TREE_ENTRIES) throw new PublicationArtifactError('publication_tree_incomplete');
  if (input.files.length < 1 || input.files.length > CANDIDATE_LIMITS.maxChangedFiles) throw new PublicationArtifactError('publication_artifact_invalid');

  const exact = new Map<string, GitTreeEntry>();
  const folded = new Map<string, number>();
  for (const entry of input.treeEntries) {
    let path: string;
    try { path = normalizeContextPath(entry.path); } catch { throw new PublicationArtifactError('publication_tree_incomplete'); }
    if (path !== entry.path || exact.has(path) || !GIT_SHA.test(entry.sha)) throw new PublicationArtifactError('publication_tree_incomplete');
    exact.set(path, entry);
    const key = candidatePathKey(path);
    folded.set(key, (folded.get(key) ?? 0) + 1);
  }
  for (const entry of input.treeEntries.filter((value) => value.type === 'tree')) {
    if (!input.treeEntries.some((value) => value.path.startsWith(`${entry.path}/`) && value.type !== 'tree')) throw new PublicationArtifactError('publication_tree_incomplete');
  }

  const leaves = new Map<string, GitLeaf>();
  for (const entry of input.treeEntries) {
    if (entry.type === 'tree') continue;
    if (!['100644', '100755', '120000', '160000'].includes(entry.mode) || (entry.type !== 'blob' && entry.type !== 'commit')) throw new PublicationArtifactError('publication_tree_incomplete');
    leaves.set(entry.path, { path: entry.path, mode: entry.mode as GitLeaf['mode'], type: entry.type as GitLeaf['type'], sha: entry.sha });
  }
  for (const file of input.files) {
    let path: string;
    try { path = candidatePath(file.path); } catch { throw new PublicationArtifactError('publication_path_not_allowed'); }
    if (path !== file.path || isWorkflowPath(path)) throw new PublicationArtifactError('publication_path_not_allowed');
  }
  if (calculateTree([...leaves.values()]) !== input.baseTreeSha) throw new PublicationArtifactError('publication_tree_incomplete');

  const blobs: PreparedPublicationBlob[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of [...input.files].sort((left, right) => left.path.localeCompare(right.path))) {
    let path: string;
    try { path = candidatePath(file.path); } catch { throw new PublicationArtifactError('publication_path_not_allowed'); }
    if (path !== file.path || isWorkflowPath(path)) throw new PublicationArtifactError('publication_path_not_allowed');
    const key = candidatePathKey(path);
    if (seen.has(key)) throw new PublicationArtifactError('publication_artifact_invalid');
    seen.add(key);
    const base = exact.get(path);
    if (file.operation === 'add') {
      if (file.baseBlobSha !== null || file.baseContentSha256 !== null || base || (folded.get(key) ?? 0) !== 0) throw new PublicationArtifactError('publication_base_invalid');
      const segments = path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const ancestorPath = segments.slice(0, index).join('/');
        const ancestor = exact.get(ancestorPath);
        const ancestorCount = folded.get(candidatePathKey(ancestorPath)) ?? 0;
        if (ancestorCount !== 0 && (ancestorCount !== 1 || !ancestor || ancestor.type !== 'tree' || ancestor.mode !== '040000')) throw new PublicationArtifactError('publication_base_invalid');
      }
    } else {
      if (!base || base.type !== 'blob' || base.mode !== '100644' || (folded.get(key) ?? 0) !== 1 || base.sha !== file.baseBlobSha || !file.baseContentSha256 || !HASH.test(file.baseContentSha256)) throw new PublicationArtifactError('publication_base_invalid');
    }
    if (file.operation === 'delete') {
      if (file.resultingContent !== null || file.resultContentSha256 !== null || file.resultByteLength !== 0) throw new PublicationArtifactError('publication_artifact_invalid');
      leaves.delete(path);
      continue;
    }
    if (file.resultingContent === null || !file.resultContentSha256 || !HASH.test(file.resultContentSha256)) throw new PublicationArtifactError('publication_artifact_invalid');
    const bytes = Buffer.from(file.resultingContent, 'utf8');
    totalBytes += bytes.byteLength;
    if (bytes.byteLength < 1 || bytes.byteLength !== file.resultByteLength || bytes.byteLength > CANDIDATE_LIMITS.maxFileBytes || totalBytes > CANDIDATE_LIMITS.maxTotalResultBytes || sha256(bytes) !== file.resultContentSha256) throw new PublicationArtifactError('publication_artifact_invalid');
    const sha = gitObjectSha('blob', bytes);
    blobs.push({ path, bytes, sha });
    leaves.set(path, { path, mode: '100644', type: 'blob', sha });
  }
  const entries = [...leaves.values()].sort((left, right) => left.path.localeCompare(right.path));
  const treeSha = calculateTree(entries);
  const message = `Vigilo repair ${input.candidateIdentity}\n`;
  const sha = commitSha({ treeSha, parentSha: input.baseCommitSha, committedAt: input.committedAt, message });
  return {
    baseCommitSha: input.baseCommitSha,
    baseTreeSha: input.baseTreeSha,
    blobs,
    changedPaths: [...seen].map((key) => input.files.find((file) => candidatePathKey(file.path) === key)!.path).sort(),
    commit: { author: PUBLICATION_AUTHOR, committedAt: input.committedAt.toISOString(), message, parentSha: input.baseCommitSha, sha, treeSha },
    entries,
    treeSha,
  };
}

export function verifyPreparedTree(prepared: PreparedGitPublication, entries: Array<Pick<GitLeaf, 'path' | 'mode' | 'type' | 'sha'>>): boolean {
  if (entries.length !== prepared.entries.length) return false;
  const normalized = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  return normalized.every((entry, index) => {
    const expected = prepared.entries[index];
    return expected?.path === entry.path && expected.mode === entry.mode && expected.type === entry.type && expected.sha === entry.sha;
  }) && calculateTree(normalized as GitLeaf[]) === prepared.treeSha;
}
