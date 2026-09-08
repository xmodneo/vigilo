export interface GitHubAppConfiguration {
  appId: number;
  appSlug: string;
  baseUrl: string;
  clientId: string;
}

export interface GitHubApiConfiguration extends GitHubAppConfiguration {
  clientSecret: string;
}

export interface VerifiedGitHubInstallation {
  account: {
    id: number;
    login: string;
    type: 'Organization' | 'User';
  };
  appId: number;
  appSlug: string;
  id: number;
  permissions: Record<string, string>;
  suspendedAt: string | null;
}

export interface GitHubInstallationGateway {
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    repositoryId?: number;
  }): Promise<string>;
  getAuthenticatedUserId(accessToken: string): Promise<string>;
  listAccessibleInstallationIds(accessToken: string): Promise<number[]>;
  getInstallation(installationId: number): Promise<VerifiedGitHubInstallation>;
  revokeUserAuthorization(accessToken: string): Promise<void>;
}
