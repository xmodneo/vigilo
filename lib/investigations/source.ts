import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { CONTEXT_BUDGET, normalizeContextPath, pathDenied } from './policy.ts';
import type { GitTreeEntry, InvestigationSourceGateway } from './types.ts';

export class InvestigationSourceError extends Error {
  constructor(public readonly code: 'installation_unavailable' | 'source_context_unavailable' | 'source_tree_invalid' | 'token_revocation_failed') {
    super(code);
    this.name = 'InvestigationSourceError';
  }
}

export async function withScopedRepositoryToken<T>(
  gateway: InvestigationSourceGateway,
  configuration: GitHubAppConfiguration,
  identity: { installationId: number; githubRepositoryId: number },
  operation: (input: { accessToken: string; owner: string; repository: string }) => Promise<T>,
): Promise<T> {
  const installation = await gateway.getInstallation(identity.installationId);
  if (installation.id !== identity.installationId || installation.appId !== configuration.appId || installation.appSlug !== configuration.appSlug || installation.suspendedAt !== null) throw new InvestigationSourceError('installation_unavailable');
  const scoped = await gateway.createInstallationAccessToken({ installationId: identity.installationId, repositoryId: identity.githubRepositoryId });
  if (scoped.repository.id !== identity.githubRepositoryId) {
    try { await gateway.revokeInstallationAccessToken(scoped.accessToken); }
    catch { throw new InvestigationSourceError('token_revocation_failed'); }
    throw new InvestigationSourceError('installation_unavailable');
  }
  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await operation({ accessToken: scoped.accessToken, owner: scoped.repository.ownerLogin, repository: scoped.repository.name });
  } catch (error) {
    operationError = error;
  }
  try {
    await gateway.revokeInstallationAccessToken(scoped.accessToken);
  } catch {
    throw new InvestigationSourceError('token_revocation_failed');
  }
  if (operationError) throw operationError;
  return value as T;
}

export interface PreparedTreeEntry {
  path: string;
  depth: number;
  kind: 'blob' | 'tree' | 'symlink' | 'submodule';
  mode: GitTreeEntry['mode'];
  objectSha: string;
  sizeBytes: number | null;
  readable: boolean;
}

export function prepareTreeEntries(entries: GitTreeEntry[], providerTruncated: boolean): {
  entries: PreparedTreeEntry[];
  excludedPathCount: number;
  truncated: boolean;
} {
  const accepted: PreparedTreeEntry[] = [];
  let excludedPathCount = 0;
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.includes('\\') || /[\u0000-\u001f\u007f]/.test(entry.path) || entry.path.split('/').some((segment) => segment === '..' || segment === '.' || !segment)) throw new InvestigationSourceError('source_tree_invalid');
    if (entry.path.length > CONTEXT_BUDGET.maxPathCharacters || entry.path.split('/').length > CONTEXT_BUDGET.maxPathDepth || pathDenied(entry.path)) {
      excludedPathCount += 1;
      continue;
    }
    const path = normalizeContextPath(entry.path);
    const kind = entry.mode === '120000' ? 'symlink' : entry.mode === '160000' || entry.type === 'commit' ? 'submodule' : entry.type;
    const coherent = (kind === 'tree' && entry.type === 'tree' && entry.mode === '040000') ||
      (kind === 'blob' && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && entry.size !== null) ||
      (kind === 'symlink' && entry.type === 'blob' && entry.mode === '120000') ||
      (kind === 'submodule' && entry.type === 'commit' && entry.mode === '160000');
    if (!coherent) throw new InvestigationSourceError('source_tree_invalid');
    accepted.push({
      path,
      depth: path.split('/').length,
      kind,
      mode: entry.mode,
      objectSha: entry.sha,
      sizeBytes: entry.size,
      readable: kind === 'blob' && entry.size !== null && entry.size <= CONTEXT_BUDGET.maxFileBytes,
    });
  }
  accepted.sort((left, right) => left.path.localeCompare(right.path));
  const truncated = providerTruncated || accepted.length > CONTEXT_BUDGET.maxTreeEntries;
  if (accepted.length > CONTEXT_BUDGET.maxTreeEntries) {
    excludedPathCount += accepted.length - CONTEXT_BUDGET.maxTreeEntries;
    accepted.length = CONTEXT_BUDGET.maxTreeEntries;
  }
  return { entries: accepted, excludedPathCount, truncated };
}
