import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareGitPublication, verifyPreparedTree } from '../lib/repair-publications/git-objects.ts';
import type { FrozenCandidateFile } from '../lib/repair-candidates/types.ts';
import { buildPullRequestMetadata } from '../lib/repair-publications/identity.ts';

const COMMITTED_AT = new Date('2032-02-03T04:05:06.000Z');
const PROFILE = 'b'.repeat(64);

function git(directory: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: COMMITTED_AT.toISOString(),
      GIT_AUTHOR_EMAIL: 'publication@vigilo.invalid',
      GIT_AUTHOR_NAME: 'Vigilo',
      GIT_COMMITTER_DATE: COMMITTED_AT.toISOString(),
      GIT_COMMITTER_EMAIL: 'publication@vigilo.invalid',
      GIT_COMMITTER_NAME: 'Vigilo',
    },
    ...(input === undefined ? {} : { input }),
  }).trim();
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const oneEntryTreeSha = (mode: string, name: string, sha: string) => {
  const body = Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
  return createHash('sha1').update(`tree ${body.byteLength}\0`).update(body).digest('hex');
};

test('publication preparation reproduces Git blob, tree, and single-parent commit identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vigilo-publication-git-'));
  try {
    git(directory, ['init', '-q']);
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'README.md'), 'unchanged\n');
    await writeFile(join(directory, 'src/modify.ts'), 'export const value = 1;\n');
    await writeFile(join(directory, 'src/delete.ts'), 'delete me\n');
    git(directory, ['add', '.']);
    const baseTreeSha = git(directory, ['write-tree']);
    const baseCommitSha = git(directory, ['commit-tree', baseTreeSha], 'base\n');
    const recursive = git(directory, ['ls-tree', '-r', '-t', baseTreeSha]).split('\n').filter(Boolean).map((line) => {
      const match = /^(\d+) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(line);
      assert.ok(match);
      return { mode: match[1] === '40000' ? '040000' as const : match[1] as '100644', type: match[2] as 'blob' | 'tree' | 'commit', sha: match[3]!, path: match[4]!, size: null };
    });
    const modifyBase = recursive.find((entry) => entry.path === 'src/modify.ts')!;
    const deleteBase = recursive.find((entry) => entry.path === 'src/delete.ts')!;
    const modified = 'export const value = 2;\n';
    const added = 'export const added = true;\n';
    const files: FrozenCandidateFile[] = [
      { path: 'src/modify.ts', operation: 'modify', baseBlobSha: modifyBase.sha, baseContentSha256: sha256('export const value = 1;\n'), resultContentSha256: sha256(modified), resultByteLength: Buffer.byteLength(modified), resultingContent: modified },
      { path: 'src/delete.ts', operation: 'delete', baseBlobSha: deleteBase.sha, baseContentSha256: sha256('delete me\n'), resultContentSha256: null, resultByteLength: 0, resultingContent: null },
      { path: 'src/nested/added.ts', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256(added), resultByteLength: Buffer.byteLength(added), resultingContent: added },
    ];
    const prepared = prepareGitPublication({
      baseCommitSha,
      baseTreeSha,
      candidateIdentity: 'a'.repeat(64),
      committedAt: COMMITTED_AT,
      files,
      profileIdentity: PROFILE,
      treeEntries: recursive,
    });

    await writeFile(join(directory, 'src/modify.ts'), modified);
    await unlink(join(directory, 'src/delete.ts'));
    await mkdir(join(directory, 'src/nested'));
    await writeFile(join(directory, 'src/nested/added.ts'), added);
    git(directory, ['add', '-A']);
    const expectedTreeSha = git(directory, ['write-tree']);
    const expectedCommitSha = git(directory, ['commit-tree', expectedTreeSha, '-p', baseCommitSha], prepared.commit.message);

    assert.equal(prepared.treeSha, expectedTreeSha);
    assert.equal(prepared.commit.sha, expectedCommitSha);
    assert.deepEqual(prepared.changedPaths, ['src/delete.ts', 'src/modify.ts', 'src/nested/added.ts']);
    assert.equal(verifyPreparedTree(prepared, prepared.entries), true);
    assert.equal(prepared.entries.some((entry) => entry.path === 'README.md'), true);
    assert.equal(prepared.entries.some((entry) => entry.path === 'src/delete.ts'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication preparation fails closed for incomplete, unsafe, or non-regular base evidence', () => {
  const base = {
    baseCommitSha: '1'.repeat(40),
    baseTreeSha: '2'.repeat(40),
    candidateIdentity: '3'.repeat(64),
    committedAt: COMMITTED_AT,
    profileIdentity: PROFILE,
  };
  assert.throws(() => prepareGitPublication({ ...base, files: [], treeEntries: [], treeTruncated: true }), /publication_tree_incomplete/);
  assert.throws(() => prepareGitPublication({ ...base, files: [{ path: 'src/new.ts', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256('x'), resultByteLength: 1, resultingContent: 'x' }], treeEntries: [] }), /publication_tree_incomplete/);
  assert.throws(() => prepareGitPublication({ ...base, files: [{ path: '.github/workflows/ci.yml', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256('x'), resultByteLength: 1, resultingContent: 'x' }], treeEntries: [] }), /publication_path_not_allowed/);
  assert.throws(() => prepareGitPublication({ ...base, baseTreeSha: oneEntryTreeSha('120000', 'link', '4'.repeat(40)), files: [{ path: 'link', operation: 'modify', baseBlobSha: '4'.repeat(40), baseContentSha256: sha256('x'), resultContentSha256: sha256('y'), resultByteLength: 1, resultingContent: 'y' }], treeEntries: [{ path: 'link', mode: '120000', type: 'blob', sha: '4'.repeat(40), size: 1 }] }), /publication_base_invalid/);

  const existingBlob = '5'.repeat(40);
  const existingDirectory = oneEntryTreeSha('100644', 'existing.ts', existingBlob);
  const caseCollidingTree = oneEntryTreeSha('40000', 'Src', existingDirectory);
  assert.throws(() => prepareGitPublication({
    ...base,
    baseTreeSha: caseCollidingTree,
    files: [{ path: 'src/new.ts', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256('x'), resultByteLength: 1, resultingContent: 'x' }],
    treeEntries: [
      { path: 'Src', mode: '040000', type: 'tree', sha: existingDirectory, size: null },
      { path: 'Src/existing.ts', mode: '100644', type: 'blob', sha: existingBlob, size: 1 },
    ],
  }), /publication_base_invalid/);
});

test('draft PR metadata renders untrusted objective text literally and neutralizes display controls', () => {
  const metadata = buildPullRequestMetadata({
    publicationId: '11111111-1111-4111-8111-111111111111',
    objective: 'Repair failure\n# injected heading\u202e', objectiveHash: '1'.repeat(64), candidateIdentity: '2'.repeat(64),
    decisionIdentity: '3'.repeat(64), verificationId: '22222222-2222-4222-8222-222222222222', evidenceId: '33333333-3333-4333-8333-333333333333', evidenceIdentity: '4'.repeat(64),
    changedFiles: [{ path: 'src/value.ts', operation: 'modify' }],
  });
  assert.doesNotMatch(metadata.title, /[\n\r\u202e]/);
  assert.doesNotMatch(metadata.body, /\u202e/);
  assert.match(metadata.body, /    # injected heading\\u\{202e\}/);
  assert.match(metadata.body, /    modify src\/value\.ts/);
  assert.doesNotMatch(metadata.body, /resultingContent|sandbox|provider transcript/i);
});
