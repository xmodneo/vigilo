import { canonicalJson } from '../repair-loops/canonical.ts';

export type ProviderAccountIdentity =
  | { kind: 'google_project'; projectId: string }
  | { kind: 'vercel_team_project'; teamId: string; projectId: string };

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function googleProjectIdentity(projectId: string): ProviderAccountIdentity {
  if (!validId(projectId)) throw new Error('provider_account_identity_invalid');
  return Object.freeze({ kind: 'google_project', projectId });
}

export function vercelTeamProjectIdentity(teamId: string, projectId: string): ProviderAccountIdentity {
  if (!validId(teamId) || !validId(projectId)) throw new Error('provider_account_identity_invalid');
  return Object.freeze({ kind: 'vercel_team_project', teamId, projectId });
}

export function canonicalProviderAccountIdentity(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider_account_identity_invalid');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(',');
  if (input.kind === 'google_project' && keys === 'kind,projectId' && validId(input.projectId)) return canonicalJson(input);
  if (input.kind === 'vercel_team_project' && keys === 'kind,projectId,teamId' && validId(input.teamId) && validId(input.projectId)) return canonicalJson(input);
  throw new Error('provider_account_identity_invalid');
}

export function accountIdentityMatches(providerId: string, value: unknown): value is ProviderAccountIdentity {
  if (providerId === 'vigilo') return value === null;
  try {
    const canonical = canonicalProviderAccountIdentity(value);
    return (providerId === 'google' && canonical.includes('"kind":"google_project"')) ||
      ((providerId === 'vercel' || providerId === 'vercel-sandbox') && canonical.includes('"kind":"vercel_team_project"'));
  } catch { return false; }
}
