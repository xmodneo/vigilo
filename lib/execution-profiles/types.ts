export const EXECUTION_PROFILE_VERSION = 2 as const;

export type TestRunner = 'jest' | 'node-test' | 'vitest';

export interface NpmInstallEntrypoint {
  operation: 'ci';
  tool: 'npm';
}

export interface NpmScriptEntrypoint {
  script: 'build' | 'test' | 'typecheck';
  tool: 'npm';
}

export type UnsupportedProfileReason =
  | 'ambiguous_test_runner'
  | 'conflicting_lockfiles'
  | 'invalid_package_lock'
  | 'invalid_script_graph'
  | 'malformed_package_json'
  | 'missing_package_json'
  | 'missing_package_lock'
  | 'missing_test_script'
  | 'unsupported_monorepo'
  | 'unsupported_node_version'
  | 'unsupported_package_manager'
  | 'unsupported_test_runner';

export interface RepositoryRootEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'dir' | 'file' | 'submodule' | 'symlink';
}

export interface InspectedRepositoryFile {
  content: string;
  sha: string;
}

export interface RepositoryProfileInspection {
  baseCommitSha: string;
  githubRepositoryId: number;
  installationId: number;
  packageJson: InspectedRepositoryFile | null;
  packageLock: InspectedRepositoryFile | null;
  rootEntries: RepositoryRootEntry[];
  workspaceId: string;
}

export interface ReadyExecutionProfileDraft {
  baseCommitSha: string;
  build: NpmScriptEntrypoint | null;
  githubRepositoryId: number;
  install: NpmInstallEntrypoint;
  installationId: number;
  lockfileType: 'package-lock';
  nodeMajor: 24;
  packageJsonBlobSha: string;
  packageJsonContentSha256: string;
  packageLockBlobSha: string;
  packageLockContentSha256: string;
  packageManager: 'npm';
  profileIdentity: string;
  profileVersion: typeof EXECUTION_PROFILE_VERSION;
  runtimeFamily: 'node';
  status: 'ready';
  test: NpmScriptEntrypoint & { script: 'test' };
  testRunner: TestRunner;
  typecheck: (NpmScriptEntrypoint & { script: 'typecheck' }) | null;
  workspaceId: string;
}

export interface UnsupportedExecutionProfileDraft {
  baseCommitSha: string;
  githubRepositoryId: number;
  installationId: number;
  profileVersion: typeof EXECUTION_PROFILE_VERSION;
  reason: UnsupportedProfileReason;
  status: 'unsupported';
  workspaceId: string;
}

export type ExecutionProfileDraft =
  | ReadyExecutionProfileDraft
  | UnsupportedExecutionProfileDraft;

export interface InstallationRepositoryMetadata {
  defaultBranch: string;
  fullName: string;
  id: number;
  isPrivate: boolean;
  name: string;
  ownerId: number;
  ownerLogin: string;
}

export interface GitHubExecutionProfileGateway {
  createInstallationAccessToken(input: {
    installationId: number;
    repositoryId: number;
  }): Promise<{
    accessToken: string;
    repository: InstallationRepositoryMetadata;
  }>;
  getInstallation(installationId: number): Promise<import('../github-app/types.ts').VerifiedGitHubInstallation>;
  getRepositoryMetadata(
    accessToken: string,
    owner: string,
    repository: string,
  ): Promise<InstallationRepositoryMetadata>;
  getRepositoryFile(input: {
    accessToken: string;
    owner: string;
    path: 'package-lock.json' | 'package.json';
    ref: string;
    repository: string;
  }): Promise<InspectedRepositoryFile | null>;
  getRepositoryRoot(input: {
    accessToken: string;
    owner: string;
    ref: string;
    repository: string;
  }): Promise<RepositoryRootEntry[]>;
  resolveBranchCommit(input: {
    accessToken: string;
    branch: string;
    owner: string;
    repository: string;
  }): Promise<string>;
  revokeInstallationAccessToken(accessToken: string): Promise<void>;
}
