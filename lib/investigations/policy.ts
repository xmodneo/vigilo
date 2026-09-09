import { extname, posix } from 'node:path';

export const CONTEXT_BUDGET = {
  version: 1 as const,
  maxTreeEntries: 2_000 as const,
  maxListPaths: 200,
  maxPathCharacters: 240,
  maxPathDepth: 20,
  maxFileBytes: 65_536 as const,
  maxCumulativeBytes: 1_048_576 as const,
  maxOperations: 50 as const,
  maxSearchQueryBytes: 128,
  maxSearchCandidateFiles: 50,
  maxSearchBytes: 262_144,
  maxSearchMatches: 25,
  maxSearchLineCharacters: 400,
};

const DENIED_SEGMENTS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'vendor']);
const DENIED_NAMES = new Set(['.env', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'service-account.json', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'id_rsa', 'id_ed25519']);
const DENIED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.mp3', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf', '.eot', '.map']);
const SEARCHABLE_EXTENSIONS = new Set(['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss', '.html', '.yml', '.yaml', '.toml', '.sql', '.sh']);

export class ContextPolicyError extends Error {
  constructor(public readonly code: 'unsafe_path' | 'path_denied' | 'query_invalid') {
    super(code);
    this.name = 'ContextPolicyError';
  }
}

export function normalizeContextPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > CONTEXT_BUDGET.maxPathCharacters || value.includes('\\') || value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) throw new ContextPolicyError('unsafe_path');
  const normalized = posix.normalize(value);
  const segments = normalized.split('/');
  if (normalized !== value || normalized === '.' || segments.some((segment) => !segment || segment === '.' || segment === '..') || segments.length > CONTEXT_BUDGET.maxPathDepth) throw new ContextPolicyError('unsafe_path');
  return normalized;
}

export function pathDenied(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  return segments.some((segment) => DENIED_SEGMENTS.has(segment)) || name.startsWith('.env.') || DENIED_NAMES.has(name) || DENIED_EXTENSIONS.has(extname(name)) || /\.min\.(?:js|css)$/.test(name);
}

export function requireReadablePath(value: unknown): string {
  const path = normalizeContextPath(value);
  if (pathDenied(path)) throw new ContextPolicyError('path_denied');
  return path;
}

export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new ContextPolicyError('query_invalid');
  const query = value.normalize('NFC').trim();
  if (!query || Buffer.byteLength(query, 'utf8') > CONTEXT_BUDGET.maxSearchQueryBytes || /[\u0000-\u001f\u007f]/.test(query)) throw new ContextPolicyError('query_invalid');
  return query;
}

export function searchablePath(path: string): boolean {
  return !pathDenied(path) && SEARCHABLE_EXTENSIONS.has(extname(path.toLowerCase()));
}

export function strictUtf8(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
