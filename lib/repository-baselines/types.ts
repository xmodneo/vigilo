import type { CommandEvidence } from '../../src/fixture-execution.ts';
import type { VerifiedGitHubInstallation } from '../github-app/types.ts';
import type { InstallationRepositoryMetadata } from '../execution-profiles/types.ts';

export const BASELINE_EVIDENCE_VERSION = 1 as const;

export type BaselineOutcome =
  | 'baseline_passed'
  | 'baseline_failed'
  | 'installation_failed'
  | 'typecheck_failed'
  | 'build_failed'
  | 'test_failed'
  | 'timed_out'
  | 'cancelled'
  | 'infrastructure_failed'
  | 'cleanup_failed';

export interface FrozenBaselineProfile {
  baseCommitSha: string;
  buildScript: 'build' | null;
  githubRepositoryId: number;
  installationId: number;
  packageJsonBlobSha: string;
  packageJsonContentSha256: string;
  packageLockBlobSha: string;
  packageLockContentSha256: string;
  profileIdentity: string;
  profileVersion: 2;
  testRunner: 'jest' | 'node-test' | 'vitest';
  testScript: 'test';
  typecheckScript: 'typecheck' | null;
  workspaceId: string;
}

export interface BaselineAuthority {
  profile: FrozenBaselineProfile;
  repository: InstallationRepositoryMetadata;
}

export interface GitHubBaselineGateway {
  createInstallationAccessToken(input: {
    installationId: number;
    repositoryId: number;
  }): Promise<{ accessToken: string; repository: InstallationRepositoryMetadata }>;
  downloadRepositoryArchive(input: {
    accessToken: string;
    owner: string;
    ref: string;
    repository: string;
  }): Promise<Buffer>;
  getInstallation(installationId: number): Promise<VerifiedGitHubInstallation>;
  getRepositoryMetadata(
    accessToken: string,
    owner: string,
    repository: string,
  ): Promise<InstallationRepositoryMetadata>;
  revokeInstallationAccessToken(accessToken: string): Promise<void>;
}

export interface FrozenBaselineInput extends BaselineAuthority {
  archive: Buffer;
  archiveSha256: string;
  runId: string;
  startedAt: Date;
}

export interface BaselineEvidence {
  evidenceVersion: typeof BASELINE_EVIDENCE_VERSION;
  runId: string;
  workspaceId: string;
  githubRepositoryId: number;
  installationId: number;
  profileIdentity: string;
  baseCommitSha: string;
  archiveSha256: string;
  sandbox: { name: string; sessionId: string | null; runtime: string; persistent: false };
  source: {
    materialized: boolean;
    identityBeforeExecution: string | null;
    identityAfterExecution: string | null;
    unchangedAfterExecution: boolean | null;
  };
  credentialsExposure: 'absent' | 'present' | 'not_checked';
  networkPolicyBeforeRepositoryExecution: 'deny-all' | 'unconfirmed';
  install: CommandEvidence;
  typecheck: CommandEvidence | null;
  build: CommandEvidence | null;
  test: CommandEvidence;
  executionOutcome: BaselineOutcome;
  overallOutcome: BaselineOutcome;
  cleanup: { stop: string; delete: string; lookup: string };
  error: { phase: string; code: string } | null;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}
