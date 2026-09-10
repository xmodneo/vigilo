import type { InvestigationSourceGateway } from '../investigations/types.ts';

export const CANDIDATE_FORMAT_VERSION = 1 as const;
export const CANDIDATE_STATES = ['freezing', 'frozen', 'rejected'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];
export type CandidateOperation = 'add' | 'modify' | 'delete';

export type CandidateRejectionCode =
  | 'add_path_already_exists'
  | 'base_file_missing'
  | 'base_identity_mismatch'
  | 'binary_content'
  | 'change_budget_exceeded'
  | 'denied_path'
  | 'infrastructure_failed'
  | 'installation_unavailable'
  | 'invalid_path'
  | 'malformed_proposal'
  | 'no_effective_change'
  | 'package_manifest_change_not_allowed'
  | 'repository_access_lost'
  | 'source_evidence_incomplete'
  | 'unsupported_file_type';

export interface CandidateProposal {
  proposalKey: string;
  investigationId: string;
  files: Array<{
    path: string;
    operation: CandidateOperation;
    expectedBaseIdentity: string | null;
    resultingContent: Uint8Array | null;
  }>;
}

export interface NormalizedCandidateProposal {
  proposalKey: string;
  investigationId: string;
  proposalIdentity: string;
  totalResultBytes: number;
  files: Array<{
    path: string;
    operation: CandidateOperation;
    expectedBaseIdentity: string | null;
    resultingBytes: Buffer | null;
    resultingText: string | null;
    resultContentSha256: string | null;
    resultByteLength: number;
  }>;
}

export interface FrozenCandidateFile {
  path: string;
  operation: CandidateOperation;
  baseBlobSha: string | null;
  baseContentSha256: string | null;
  resultContentSha256: string | null;
  resultByteLength: number;
  resultingContent: string | null;
}

export interface RepairCandidateResult {
  id: string;
  investigationId: string;
  repairRunId: string;
  ordinal: number;
  state: CandidateState;
  formatVersion: 1;
  githubRepositoryId: number;
  installationId: number;
  baseCommitSha: string;
  profileIdentity: string;
  candidateIdentity: string | null;
  changedFileCount: number;
  totalResultBytes: number;
  rejectionCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export type CandidateSourceGateway = InvestigationSourceGateway;
