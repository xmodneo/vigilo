export interface GitHubRepository {
  defaultBranch: string | null;
  fullName: string;
  id: number;
  isPrivate: boolean;
  name: string;
  ownerId: number;
  ownerLogin: string;
}

export interface GitHubUserInstallationRepository extends GitHubRepository {
  permissions: {
    admin: boolean;
    push: boolean;
  };
}

export interface GitHubRepositoryAccessGateway {
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    repositoryId?: number;
  }): Promise<string>;
  getAuthenticatedUserId(accessToken: string): Promise<string>;
  listAccessibleInstallationIds(accessToken: string): Promise<number[]>;
  listUserInstallationRepositories(
    accessToken: string,
    installationId: number,
  ): Promise<GitHubUserInstallationRepository[]>;
  revokeUserAccessToken(accessToken: string): Promise<void>;
}
