import { createHash } from 'node:crypto';
import { extname, posix } from 'node:path';

import { normalizeContextPath, pathDenied } from '../investigations/policy.ts';
import type { CandidateOperation, CandidateProposal, CandidateRejectionCode, NormalizedCandidateProposal } from './types.ts';

export const CANDIDATE_LIMITS = {
  maxChangedFiles: 16,
  maxFileBytes: 131_072,
  maxTotalResultBytes: 524_288,
  maxPathCharacters: 240,
  maxPathDepth: 20,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const OPERATIONS = new Set<CandidateOperation>(['add', 'modify', 'delete']);
const PROTECTED_NAMES = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const CANDIDATE_DENIED_SEGMENTS = new Set(['.vigilo', '.vercel', '.secrets', '.turbo', '.output', 'out']);
const BINARY_EXTENSIONS = new Set(['.bin', '.class', '.dll', '.dmg', '.exe', '.iso', '.jar', '.o', '.obj', '.so']);

export class CandidatePolicyError extends Error {
  constructor(public readonly code: CandidateRejectionCode | 'proposal_conflict' | 'candidate_conflict') {
    super(code);
    this.name = 'CandidatePolicyError';
  }
}

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function candidatePath(value: unknown): string {
  let path: string;
  try {
    path = normalizeContextPath(value);
  } catch {
    throw new CandidatePolicyError('invalid_path');
  }
  if (path !== path.normalize('NFC')) throw new CandidatePolicyError('invalid_path');
  const name = posix.basename(path).toLowerCase();
  const segments = path.toLowerCase().split('/');
  if (PROTECTED_NAMES.has(name)) throw new CandidatePolicyError('package_manifest_change_not_allowed');
  if (pathDenied(path) || segments.some((segment) => CANDIDATE_DENIED_SEGMENTS.has(segment))) throw new CandidatePolicyError('denied_path');
  if (BINARY_EXTENSIONS.has(extname(name))) throw new CandidatePolicyError('unsupported_file_type');
  return path;
}

export function candidatePathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function pathsConflict(left: string, right: string): boolean {
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function decodeText(value: unknown): { bytes: Buffer; text: string; sha: string } {
  if (!(value instanceof Uint8Array)) throw new CandidatePolicyError('malformed_proposal');
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 1 || bytes.byteLength > CANDIDATE_LIMITS.maxFileBytes) throw new CandidatePolicyError('change_budget_exceeded');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new CandidatePolicyError('binary_content');
  return { bytes, text, sha: sha256(bytes) };
}

function proposalIdentity(files: NormalizedCandidateProposal['files']): string {
  return sha256(JSON.stringify({
    version: 1,
    files: files.map((file) => ({
      path: file.path,
      operation: file.operation,
      expectedBaseIdentity: file.expectedBaseIdentity,
      resultContentSha256: file.resultContentSha256,
      resultByteLength: file.resultByteLength,
    })),
  }));
}

export function normalizeCandidateProposal(value: unknown): NormalizedCandidateProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, ['files', 'investigationId', 'proposalKey'])) throw new CandidatePolicyError('malformed_proposal');
  const input = value as Partial<CandidateProposal>;
  if (typeof input.proposalKey !== 'string' || !UUID.test(input.proposalKey) || typeof input.investigationId !== 'string' || !UUID.test(input.investigationId) || !Array.isArray(input.files) || input.files.length < 1) throw new CandidatePolicyError('malformed_proposal');
  if (input.files.length > CANDIDATE_LIMITS.maxChangedFiles) throw new CandidatePolicyError('change_budget_exceeded');
  const seen = new Set<string>();
  let totalResultBytes = 0;
  const files: NormalizedCandidateProposal['files'] = input.files.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exactKeys(raw as unknown as Record<string, unknown>, ['expectedBaseIdentity', 'operation', 'path', 'resultingContent'])) throw new CandidatePolicyError('malformed_proposal');
    const file = raw as CandidateProposal['files'][number];
    if (!OPERATIONS.has(file.operation)) throw new CandidatePolicyError('malformed_proposal');
    const path = candidatePath(file.path);
    const key = candidatePathKey(path);
    if (seen.has(key)) throw new CandidatePolicyError('invalid_path');
    seen.add(key);
    const needsBase = file.operation !== 'add';
    if ((needsBase && (typeof file.expectedBaseIdentity !== 'string' || !GIT_SHA.test(file.expectedBaseIdentity))) || (!needsBase && file.expectedBaseIdentity !== null)) throw new CandidatePolicyError('malformed_proposal');
    if (file.operation === 'delete') {
      if (file.resultingContent !== null) throw new CandidatePolicyError('malformed_proposal');
      return { path, operation: file.operation, expectedBaseIdentity: file.expectedBaseIdentity, resultingBytes: null, resultingText: null, resultContentSha256: null, resultByteLength: 0 };
    }
    const content = decodeText(file.resultingContent);
    totalResultBytes += content.bytes.byteLength;
    if (totalResultBytes > CANDIDATE_LIMITS.maxTotalResultBytes) throw new CandidatePolicyError('change_budget_exceeded');
    return { path, operation: file.operation, expectedBaseIdentity: file.expectedBaseIdentity, resultingBytes: content.bytes, resultingText: content.text, resultContentSha256: content.sha, resultByteLength: content.bytes.byteLength };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const pathKeys = files.map((file) => candidatePathKey(file.path));
  if (pathKeys.some((path, index) => pathKeys.slice(index + 1).some((other) => pathsConflict(path, other)))) throw new CandidatePolicyError('invalid_path');
  return { proposalKey: input.proposalKey, investigationId: input.investigationId, files, totalResultBytes, proposalIdentity: proposalIdentity(files) };
}
