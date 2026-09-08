import {
  createPrivateKey,
  sign,
  type KeyObject,
} from 'node:crypto';

import type {
  GitHubApiConfiguration,
  GitHubInstallationGateway,
  VerifiedGitHubInstallation,
} from './types.ts';
import type {
  GitHubRepositoryAccessGateway,
  GitHubUserInstallationRepository,
} from '../github-repositories/types.ts';

const API_BASE_URL = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const GITHUB_BASE_URL = 'https://github.com';
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class GitHubProviderError extends Error {
  constructor() {
    super('github_api_error');
    this.name = 'GitHubProviderError';
  }
}

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createGitHubAppJwt(
  clientId: string,
  privateKey: string | KeyObject,
  now = new Date(),
): string {
  try {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
    const payload = encodeJson({
      exp: issuedAt + 540,
      iat: issuedAt - 60,
      iss: clientId,
    });
    const unsigned = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString(
      'base64url',
    );
    return `${unsigned}.${signature}`;
  } catch {
    throw new GitHubProviderError();
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    throw new GitHubProviderError();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GitHubProviderError();
      }
      chunks.push(value);
    }
  } catch {
    throw new GitHubProviderError();
  }

  try {
    const body = Buffer.concat(chunks, length).toString('utf8');
    return JSON.parse(body) as unknown;
  } catch {
    throw new GitHubProviderError();
  }
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubProviderError();
  }
  return value;
}

function nonemptyString(value: unknown, maximumLength = 255): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GitHubProviderError();
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubProviderError();
  }
  return value as Record<string, unknown>;
}

function parseInstallation(value: unknown): VerifiedGitHubInstallation {
  const record = objectValue(value);
  const account = objectValue(record.account);
  const permissionsRecord = objectValue(record.permissions);
  const permissions: Record<string, string> = {};
  for (const [name, permission] of Object.entries(permissionsRecord)) {
    permissions[nonemptyString(name)] = nonemptyString(permission);
  }

  const suspendedAt = record.suspended_at;
  if (suspendedAt !== null && typeof suspendedAt !== 'string') {
    throw new GitHubProviderError();
  }
  const accountType = nonemptyString(account.type);
  if (accountType !== 'Organization' && accountType !== 'User') {
    throw new GitHubProviderError();
  }

  return {
    account: {
      id: positiveSafeInteger(account.id),
      login: nonemptyString(account.login),
      type: accountType,
    },
    appId: positiveSafeInteger(record.app_id),
    appSlug: nonemptyString(record.app_slug),
    id: positiveSafeInteger(record.id),
    permissions,
    suspendedAt,
  };
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new GitHubProviderError();
  return value;
}

function parseUserInstallationRepository(value: unknown): GitHubUserInstallationRepository {
  const record = objectValue(value);
  const owner = objectValue(record.owner);
  const permissions = objectValue(record.permissions);
  const defaultBranch = record.default_branch;
  if (defaultBranch !== null && typeof defaultBranch !== 'string') {
    throw new GitHubProviderError();
  }
  return {
    defaultBranch: defaultBranch === null ? null : nonemptyString(defaultBranch),
    fullName: nonemptyString(record.full_name, 512),
    id: positiveSafeInteger(record.id),
    isPrivate: booleanValue(record.private),
    name: nonemptyString(record.name),
    ownerId: positiveSafeInteger(owner.id),
    ownerLogin: nonemptyString(owner.login),
    permissions: {
      admin: booleanValue(permissions.admin),
      push: booleanValue(permissions.push),
    },
  };
}

export class GitHubApiClient implements GitHubInstallationGateway, GitHubRepositoryAccessGateway {
  private readonly privateKey: KeyObject;

  constructor(
    private readonly configuration: GitHubApiConfiguration,
    privateKeyPem: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      this.privateKey = createPrivateKey(privateKeyPem);
    } catch {
      throw new GitHubProviderError();
    }
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    repositoryId?: number;
  }): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.configuration.clientId,
      client_secret: this.configuration.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    if (input.repositoryId !== undefined) {
      body.set('repository_id', String(input.repositoryId));
    }
    const result = objectValue(
      await this.requestJson(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
        body: body.toString(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      }),
    );
    return nonemptyString(result.access_token, 1_024);
  }

  async getAuthenticatedUserId(accessToken: string): Promise<string> {
    const result = objectValue(
      await this.apiJson('/user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return String(positiveSafeInteger(result.id));
  }

  async listAccessibleInstallationIds(accessToken: string): Promise<number[]> {
    const result = objectValue(
      await this.apiJson('/user/installations?per_page=100', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    if (!Array.isArray(result.installations) || result.installations.length > 100) {
      throw new GitHubProviderError();
    }
    return result.installations.map((value) =>
      positiveSafeInteger(objectValue(value).id),
    );
  }

  async getInstallation(installationId: number): Promise<VerifiedGitHubInstallation> {
    const jwt = createGitHubAppJwt(
      this.configuration.clientId,
      this.privateKey,
      this.now(),
    );
    return parseInstallation(
      await this.apiJson(`/app/installations/${installationId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
  }

  async listUserInstallationRepositories(
    accessToken: string,
    installationId: number,
  ): Promise<GitHubUserInstallationRepository[]> {
    const repositories: GitHubUserInstallationRepository[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = objectValue(
        await this.apiJson(
          `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      if (!Array.isArray(result.repositories) || result.repositories.length > 100) {
        throw new GitHubProviderError();
      }
      repositories.push(...result.repositories.map(parseUserInstallationRepository));
      if (result.repositories.length < 100) return repositories;
    }
    throw new GitHubProviderError();
  }

  async revokeUserAccessToken(accessToken: string): Promise<void> {
    const authorization = Buffer.from(
      `${this.configuration.clientId}:${this.configuration.clientSecret}`,
      'utf8',
    ).toString('base64');
    const response = await this.request(
      `${API_BASE_URL}/applications/${encodeURIComponent(this.configuration.clientId)}/token`,
      {
        body: JSON.stringify({ access_token: accessToken }),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        method: 'DELETE',
      },
    );
    if (response.status !== 204) throw new GitHubProviderError();
  }

  async revokeUserAuthorization(accessToken: string): Promise<void> {
    const authorization = Buffer.from(
      `${this.configuration.clientId}:${this.configuration.clientSecret}`,
      'utf8',
    ).toString('base64');
    const response = await this.request(
      `${API_BASE_URL}/applications/${encodeURIComponent(this.configuration.clientId)}/grant`,
      {
        body: JSON.stringify({ access_token: accessToken }),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        method: 'DELETE',
      },
    );
    if (response.status !== 204) {
      throw new GitHubProviderError();
    }
  }

  private apiJson(path: string, init: RequestInit): Promise<unknown> {
    return this.requestJson(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...init.headers,
      },
    });
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    return readBoundedJson(await this.request(url, init));
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(url, {
        ...init,
        headers: {
          'User-Agent': 'Vigilo',
          ...init.headers,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubProviderError();
    }
  }
}
