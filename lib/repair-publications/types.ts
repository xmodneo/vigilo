import type { GitTreeEntry } from '../investigations/types.ts';

export const PUBLICATION_VERSION = 1 as const;
export const PUBLICATION_STATES = ['queued', 'preparing', 'publishing', 'published', 'failed', 'review_required'] as const;
export const PUBLICATION_CHECKPOINTS = ['reserved', 'authority_prepared', 'objects_verified', 'branch_create_requested', 'branch_verified', 'pr_create_requested', 'pr_verified', 'completed'] as const;
export type RepairPublicationState = (typeof PUBLICATION_STATES)[number];
export type RepairPublicationCheckpoint = (typeof PUBLICATION_CHECKPOINTS)[number];

export interface RepairPublicationResult {
  id: string;
  repairRunId: string;
  state: RepairPublicationState;
  checkpoint: RepairPublicationCheckpoint;
  targetBranch: string;
  targetBaseBranch: string | null;
  expectedCommitSha: string | null;
  remoteBranchCommitSha: string | null;
  pullRequest: null | { id: number; number: number; url: string; nodeId: string };
  failureCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface PublicationToken {
  accessToken: string;
  expiresAt: Date;
  repository: PublicationRepository;
}

export interface PublicationRepository {
  id: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface PublicationCommit {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

export interface PublicationPullRequest {
  id: number;
  number: number;
  nodeId: string;
  url: string;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  repositoryId: number;
}

export interface RepairPublicationGateway {
  getInstallation(installationId: number): Promise<{ id: number; appId: number; appSlug: string; suspendedAt: string | null; permissions: Record<string, string> }>;
  createPublicationAccessToken(input: { installationId: number; repositoryId: number }): Promise<PublicationToken>;
  revokeInstallationAccessToken(accessToken: string): Promise<void>;
  getRepositoryMetadata(accessToken: string, owner: string, repository: string): Promise<PublicationRepository>;
  resolveBranchCommit(input: { accessToken: string; owner: string; repository: string; branch: string }): Promise<string | null>;
  getBranchCommit(input: { accessToken: string; owner: string; repository: string; branch: string }): Promise<string | null>;
  getCommit(input: { accessToken: string; owner: string; repository: string; commitSha: string }): Promise<PublicationCommit>;
  getTree(input: { accessToken: string; owner: string; repository: string; treeSha: string }): Promise<{ entries: GitTreeEntry[]; truncated: boolean }>;
  getBlob(input: { accessToken: string; owner: string; repository: string; blobSha: string; maxBytes?: number }): Promise<{ bytes: Buffer; sha: string }>;
  createBlob(input: { accessToken: string; owner: string; repository: string; bytes: Buffer }): Promise<string>;
  createTree(input: { accessToken: string; owner: string; repository: string; baseTreeSha: string; entries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> }): Promise<string>;
  createCommit(input: { accessToken: string; owner: string; repository: string; message: string; treeSha: string; parentSha: string; author: { name: string; email: string; date: string } }): Promise<string>;
  createBranch(input: { accessToken: string; owner: string; repository: string; branch: string; commitSha: string }): Promise<void>;
  createDraftPullRequest(input: { accessToken: string; owner: string; repository: string; title: string; body: string; head: string; base: string }): Promise<PublicationPullRequest>;
  listPullRequests(input: { accessToken: string; owner: string; repository: string; head: string; base: string }): Promise<PublicationPullRequest[]>;
  getPullRequest(input: { accessToken: string; owner: string; repository: string; number: number }): Promise<PublicationPullRequest>;
}
