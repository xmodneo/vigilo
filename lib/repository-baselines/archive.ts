export interface ArchiveLimits {
  maximumDepth: number;
  maximumEntries: number;
  maximumFileBytes: number;
  maximumPathBytes: number;
  maximumTarBytes: number;
  maximumTotalFileBytes: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = {
  maximumDepth: 32,
  maximumEntries: 5_000,
  maximumFileBytes: 10 * 1024 * 1024,
  maximumPathBytes: 512,
  maximumTarBytes: 256 * 1024 * 1024,
  maximumTotalFileBytes: 200 * 1024 * 1024,
} as const;

// Trusted Vigilo harness. It parses and extracts the GitHub-produced gzip/tar
// stream without invoking repository code or following archive-provided links.
export const SAFE_ARCHIVE_EXTRACTION_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const input = JSON.parse(process.argv[1]);
const limits = input.limits;
const fail = () => { throw new Error('archive_rejected'); };
if (!input || typeof input.archivePath !== 'string' || typeof input.root !== 'string' ||
    typeof input.expectedCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.expectedCommitSha) ||
    !limits || !Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)) fail();
const root = path.resolve(input.root);
const rootPrefix = root + path.sep;
fs.mkdirSync(root, { recursive: false, mode: 0o700 });

const octal = (block, start, length) => {
  const raw = block.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(raw)) fail();
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
};
const text = (block, start, length) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  const value = field.subarray(0, end < 0 ? field.length : end).toString('utf8');
  if (value.includes('\uFFFD') || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
};
const validateChecksum = block => {
  const expected = octal(block, 148, 8);
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block[index];
  }
  if (actual !== expected) fail();
};
const normalize = name => {
  if (!name || name.startsWith('/') || name.includes('\\') || Buffer.byteLength(name) > limits.maximumPathBytes) fail();
  const parts = name.replace(/\/+$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail();
  if (parts.length < 1 || parts.length - 1 > limits.maximumDepth) fail();
  return parts;
};

let pending = Buffer.alloc(0);
let current = null;
let entries = 0;
let totalFileBytes = 0;
let totalTarBytes = 0;
let zeroBlocks = 0;
let ended = false;
let archiveRoot = null;
let archiveRootDirectorySeen = false;
let paxCommit = null;
const paths = new Map();

const acceptGlobalPax = body => {
  if (paxCommit || entries !== 0 || archiveRoot || body.length > 1_024) fail();
  let offset = 0;
  const values = new Map();
  while (offset < body.length) {
    const space = body.indexOf(32, offset);
    if (space < 0 || space - offset > 10) fail();
    const lengthText = body.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail();
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > body.length) fail();
    const record = body.subarray(space + 1, offset + length);
    if (record.at(-1) !== 10) fail();
    const content = record.subarray(0, -1).toString('utf8');
    const equals = content.indexOf('=');
    if (equals <= 0) fail();
    const key = content.slice(0, equals);
    const value = content.slice(equals + 1);
    if (key !== 'comment' || values.has(key) || !/^[a-f0-9]{40}$/.test(value)) fail();
    values.set(key, value);
    offset += length;
  }
  if (values.size !== 1 || values.get('comment') !== input.expectedCommitSha) fail();
  paxCommit = values.get('comment');
};

const addPath = (relative, type) => {
  if (!relative || paths.has(relative)) fail();
  const parts = relative.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    if (paths.get(parts.slice(0, index).join('/')) === 'file') fail();
  }
  if (type === 'file') {
    for (const existing of paths.keys()) if (existing.startsWith(relative + '/')) fail();
  }
  paths.set(relative, type);
  entries += 1;
  if (entries > limits.maximumEntries) fail();
};

const beginEntry = block => {
  if (block.every(byte => byte === 0)) {
    zeroBlocks += 1;
    if (zeroBlocks >= 2) ended = true;
    return;
  }
  if (zeroBlocks !== 0 || ended) fail();
  validateChecksum(block);
  const typeByte = block[156];
  const size = octal(block, 124, 12);
  if (typeByte === 103) {
    if (text(block, 0, 100) !== 'pax_global_header' || size > 1_024) fail();
    current = { chunks: [], kind: 'global', padding: (512 - (size % 512)) % 512, remaining: size };
    return;
  }
  const name = text(block, 0, 100);
  const prefix = text(block, 345, 155);
  const parts = normalize(prefix ? prefix + '/' + name : name);
  const rootPart = parts.shift();
  if (!archiveRoot) archiveRoot = rootPart;
  if (rootPart !== archiveRoot) fail();
  const relative = parts.join('/');
  const type = typeByte === 0 || typeByte === 48 ? 'file' : typeByte === 53 ? 'directory' : null;
  if (!type) fail();
  if (type === 'directory' && size !== 0) fail();
  if (!relative) {
    if (type !== 'directory' || archiveRootDirectorySeen) fail();
    archiveRootDirectorySeen = true;
    current = { kind: 'directory', remaining: 0, padding: 0 };
    return;
  }
  addPath(relative, type === 'file' ? 'file' : 'directory');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(rootPrefix)) fail();
  if (type === 'directory') {
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    current = { kind: 'directory', remaining: 0, padding: 0 };
    return;
  }
  if (size > limits.maximumFileBytes) fail();
  totalFileBytes += size;
  if (totalFileBytes > limits.maximumTotalFileBytes) fail();
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(absolute, flags, octal(block, 100, 8) & 0o111 ? 0o755 : 0o644);
  current = { descriptor, kind: 'file', remaining: size, padding: (512 - (size % 512)) % 512 };
};

const consume = () => {
  while (true) {
    if (ended) {
      if (pending.some(byte => byte !== 0)) fail();
      pending = Buffer.alloc(0);
      return;
    }
    if (!current) {
      if (pending.length < 512) return;
      const block = pending.subarray(0, 512);
      pending = pending.subarray(512);
      beginEntry(block);
      continue;
    }
    if (current.remaining > 0) {
      if (pending.length === 0) return;
      const length = Math.min(current.remaining, pending.length);
      if (current.kind === 'global') current.chunks.push(Buffer.from(pending.subarray(0, length)));
      else fs.writeSync(current.descriptor, pending, 0, length);
      pending = pending.subarray(length);
      current.remaining -= length;
      if (current.remaining > 0) return;
      if (current.kind === 'global') acceptGlobalPax(Buffer.concat(current.chunks));
      else if (current.kind === 'file') fs.closeSync(current.descriptor);
    }
    if (pending.length < current.padding) return;
    pending = pending.subarray(current.padding);
    current = null;
  }
};

(async () => {
  const source = fs.createReadStream(input.archivePath);
  const gunzip = zlib.createGunzip();
  source.pipe(gunzip);
  for await (const chunk of gunzip) {
    totalTarBytes += chunk.length;
    if (totalTarBytes > limits.maximumTarBytes) {
      source.destroy(); gunzip.destroy(); fail();
    }
    pending = Buffer.concat([pending, chunk]);
    consume();
  }
  consume();
  if (!ended || current || pending.length !== 0 || !archiveRoot || entries === 0 || paxCommit !== input.expectedCommitSha) fail();
  fs.rmSync(input.archivePath, { force: true });
  console.log(JSON.stringify({ entries, totalFileBytes }));
})().catch(() => { process.exitCode = 1; });
`;
