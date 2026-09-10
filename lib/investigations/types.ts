export const INVESTIGATION_STATES = ['created', 'context_preparing', 'ready', 'failed', 'cancelled'] as const;
export type InvestigationState = (typeof INVESTIGATION_STATES)[number];

export interface GitTreeEntry {
  mode: '040000' | '100644' | '100755' | '120000' | '160000';
  path: string;
  sha: string;
  size: number | null;
  type: 'blob' | 'tree' | 'commit';
}

export interface InvestigationSourceGateway {
  createInstallationAccessToken(input: { installationId: number; repositoryId: number }): Promise<{
    accessToken: string;
    repository: { id: number; name: string; ownerLogin: string };
  }>;
  getCommitTree(input: { accessToken: string; owner: string; repository: string; commitSha: string }): Promise<{ commitSha: string; treeSha: string }>;
  getTree(input: { accessToken: string; owner: string; repository: string; treeSha: string }): Promise<{ entries: GitTreeEntry[]; truncated: boolean }>;
  getBlob(input: { accessToken: string; owner: string; repository: string; blobSha: string; maxBytes?: number }): Promise<{ bytes: Buffer; sha: string }>;
  getInstallation(installationId: number): Promise<{ appId: number; appSlug: string; id: number; suspendedAt: string | null }>;
  revokeInstallationAccessToken(accessToken: string): Promise<void>;
}

export interface InvestigationResult {
  id: string;
  repairRunId: string;
  repairObjective: string;
  state: InvestigationState;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
  baselineId: string;
  treeSha: string | null;
  indexedPathCount: number;
  excludedPathCount: number;
  treeTruncated: boolean;
  contextBudget: { version: 1; maxTreeEntries: 2000; maxFileBytes: 65536; maxCumulativeBytes: 1048576; maxOperations: 50 };
  failureCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}
