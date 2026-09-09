import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { ARCHIVE_LIMITS, SAFE_ARCHIVE_EXTRACTION_SCRIPT, type ArchiveLimits } from '../lib/repository-baselines/archive.ts';

type Entry = { body?: Buffer; link?: string; name: string; type?: string };
const COMMIT = 'a'.repeat(40);

function octal(value: number, length: number) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function archive(entries: Entry[], corruptChecksum = false) {
  const blocks: Buffer[] = [];
  const paxBody = Buffer.from(`52 comment=${COMMIT}\n`);
  for (const entry of [{ body: paxBody, name: 'pax_global_header', type: 'g' }, ...entries]) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write(octal(0o644, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    header.write(octal(body.length, 12), 124, 12, 'ascii');
    header.write(octal(0, 12), 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    if (entry.link) header.write(entry.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    const sum = header.reduce((value, byte) => value + byte, 0) + (corruptChecksum ? 1 : 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(blocks));
}

function extract(entries: Entry[], options: { corruptChecksum?: boolean; expectedCommitSha?: string; limits?: Partial<ArchiveLimits> } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'vigilo-archive-test-'));
  const archivePath = path.join(directory, 'source.tar.gz');
  const root = path.join(directory, 'source');
  writeFileSync(archivePath, archive(entries, options.corruptChecksum));
  const result = spawnSync(process.execPath, ['-e', SAFE_ARCHIVE_EXTRACTION_SCRIPT, JSON.stringify({
    archivePath,
    expectedCommitSha: options.expectedCommitSha ?? COMMIT,
    limits: { ...ARCHIVE_LIMITS, ...options.limits },
    root,
  })], { encoding: 'utf8', timeout: 10_000 });
  return { directory, result, root };
}

test('safe extractor accepts bounded regular files under one archive root', (t) => {
  const value = extract([
    { name: 'octo-repo/' , type: '5' },
    { name: 'octo-repo/src/', type: '5' },
    { body: Buffer.from('safe source'), name: 'octo-repo/src/index.ts' },
  ]);
  t.after(() => rmSync(value.directory, { force: true, recursive: true }));
  assert.equal(value.result.status, 0);
  assert.equal(readFileSync(path.join(value.root, 'src/index.ts'), 'utf8'), 'safe source');
  assert.deepEqual(JSON.parse(value.result.stdout), { entries: 2, totalFileBytes: 11 });
});

test('safe extractor rejects traversal, absolute, normalized escape, and deep paths', async (t) => {
  const cases = [
    'octo-repo/../escape',
    '/absolute/path',
    'octo-repo/src/../../escape',
    `octo-repo/${Array.from({ length: 34 }, () => 'd').join('/')}`,
  ];
  for (const name of cases) await t.test(name.slice(0, 30), (child) => {
    const value = extract([{ body: Buffer.from('x'), name }]);
    child.after(() => rmSync(value.directory, { force: true, recursive: true }));
    assert.notEqual(value.result.status, 0);
  });
});

test('safe extractor rejects links and every special archive entry type', async (t) => {
  for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g']) await t.test(`type-${type}`, (child) => {
    const value = extract([{ link: '../../escape', name: 'octo-repo/item', type }]);
    child.after(() => rmSync(value.directory, { force: true, recursive: true }));
    assert.notEqual(value.result.status, 0);
  });
});

test('safe extractor rejects duplicates, path conflicts, count, file, total, and tar size limits', async (t) => {
  const cases: Array<{ entries: Entry[]; limits?: Partial<ArchiveLimits> }> = [
    { entries: [{ name: 'octo-repo/a' }, { name: 'octo-repo/a' }] },
    { entries: [{ name: 'octo-repo/', type: '5' }, { name: 'octo-repo/', type: '5' }] },
    { entries: [{ name: 'octo-repo/a' }, { name: 'octo-repo/a/b' }] },
    { entries: [{ name: 'octo-repo/a' }, { name: 'octo-repo/b' }], limits: { maximumEntries: 1 } },
    { entries: [{ body: Buffer.alloc(5), name: 'octo-repo/a' }], limits: { maximumFileBytes: 4 } },
    { entries: [{ body: Buffer.alloc(6), name: 'octo-repo/a' }, { body: Buffer.alloc(6), name: 'octo-repo/b' }], limits: { maximumTotalFileBytes: 10 } },
    { entries: [{ body: Buffer.alloc(513), name: 'octo-repo/a' }], limits: { maximumTarBytes: 1_536 } },
  ];
  for (const [index, candidate] of cases.entries()) await t.test(`limit-${index}`, (child) => {
    const value = extract(candidate.entries, candidate.limits ? { limits: candidate.limits } : {});
    child.after(() => rmSync(value.directory, { force: true, recursive: true }));
    assert.notEqual(value.result.status, 0);
  });
});

test('safe extractor rejects malformed gzip and invalid tar checksums', (t) => {
  const checksum = extract([{ name: 'octo-repo/a' }], { corruptChecksum: true });
  t.after(() => rmSync(checksum.directory, { force: true, recursive: true }));
  assert.notEqual(checksum.result.status, 0);

  const directory = mkdtempSync(path.join(tmpdir(), 'vigilo-archive-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const archivePath = path.join(directory, 'source.tar.gz');
  writeFileSync(archivePath, 'not gzip');
  const result = spawnSync(process.execPath, ['-e', SAFE_ARCHIVE_EXTRACTION_SCRIPT, JSON.stringify({
    archivePath, expectedCommitSha: COMMIT, limits: ARCHIVE_LIMITS, root: path.join(directory, 'source'),
  })], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(result.status, 0);
});

test('safe extractor rejects an archive whose provider commit record differs from the frozen profile', (t) => {
  const value = extract([{ body: Buffer.from('source'), name: 'octo-repo/index.ts' }], {
    expectedCommitSha: 'b'.repeat(40),
  });
  t.after(() => rmSync(value.directory, { force: true, recursive: true }));
  assert.notEqual(value.result.status, 0);
});
