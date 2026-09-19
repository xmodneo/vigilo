import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return current.map(visit);
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
    }
    throw new Error('noncanonical_json');
  };
  return JSON.stringify(visit(value));
}

export function canonicalRecord(value: unknown, maxBytes: number): { snapshot: unknown; canonical: string; hash: string; bytes: number } {
  const canonical = canonicalJson(value);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes < 1 || bytes > maxBytes) throw new Error('canonical_budget_exceeded');
  return { snapshot: JSON.parse(canonical) as unknown, canonical, hash: createHash('sha256').update(canonical, 'utf8').digest('hex'), bytes };
}
