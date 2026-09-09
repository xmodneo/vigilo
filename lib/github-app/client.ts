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
import type {
  GitHubExecutionProfileGateway,
  InspectedRepositoryFile,
  InstallationRepositoryMetadata,
  RepositoryRootEntry,
} from '../execution-profiles/types.ts';

const API_BASE_URL = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const GITHUB_BASE_URL = 'https://github.com';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
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

async function readBoundedBuffer(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new GitHubProviderError();
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared && (!Number.isSafeInteger(declared) || declared > maximumBytes)) {
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
      if (length > maximumBytes) {
        await reader.cancel();
        throw new GitHubProviderError();
      }
      chunks.push(value);
    }
  } catch {
    throw new GitHubProviderError();
  }
  return Buffer.concat(chunks, length);
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

function parseInstallationRepository(value: unknown): InstallationRepositoryMetadata {
  const record = objectValue(value);
  const owner = objectValue(record.owner);
  return {
    defaultBranch: nonemptyString(record.default_branch),
    fullName: nonemptyString(record.full_name, 512),
    id: positiveSafeInteger(record.id),
    isPrivate: booleanValue(record.private),
    name: nonemptyString(record.name),
    ownerId: positiveSafeInteger(owner.id),
    ownerLogin: nonemptyString(owner.login),
  };
}

function gitSha(value: unknown): string {
  const sha = nonemptyString(value, 40);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubProviderError();
  return sha;
}

function parseRootEntries(value: unknown): RepositoryRootEntry[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new GitHubProviderError();
  const seen = new Set<string>();
  return value.map((candidate) => {
    const record = objectValue(candidate);
    const type = nonemptyString(record.type);
    if (!['dir', 'file', 'submodule', 'symlink'].includes(type)) {
      throw new GitHubProviderError();
    }
    const name = nonemptyString(record.name);
    const path = nonemptyString(record.path, 512);
    if (
      path !== name ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\') ||
      seen.has(path)
    ) {
      throw new GitHubProviderError();
    }
    seen.add(path);
    const size = record.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new GitHubProviderError();
    }
    return {
      name,
      path,
      sha: gitSha(record.sha),
      size,
      type: type as RepositoryRootEntry['type'],
    };
  });
}

function parseRepositoryFile(value: unknown): InspectedRepositoryFile {
  const record = objectValue(value);
  if (
    record.type !== 'file' ||
    record.encoding !== 'base64' ||
    typeof record.content !== 'string'
  ) {
    throw new GitHubProviderError();
  }
  const size = record.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new GitHubProviderError();
  }
  const encoded = record.content.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new GitHubProviderError();
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength !== size) throw new GitHubProviderError();
  return { content: bytes.toString('utf8'), sha: gitSha(record.sha) };
}

export class GitHubApiClient implements GitHubInstallationGateway, GitHubRepositoryAccessGateway, GitHubExecutionProfileGateway {
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

  async createInstallationAccessToken(input: {
    installationId: number;
    repositoryId: number;
  }): Promise<{ accessToken: string; repository: InstallationRepositoryMetadata }> {
    const jwt = createGitHubAppJwt(
      this.configuration.clientId,
      this.privateKey,
      this.now(),
    );
    const result = objectValue(
      await this.apiJson(`/app/installations/${input.installationId}/access_tokens`, {
        body: JSON.stringify({
          permissions: { contents: 'read', metadata: 'read' },
          repository_ids: [input.repositoryId],
        }),
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );
    const accessToken = nonemptyString(result.token, 2_048);
    let repository: InstallationRepositoryMetadata;
    try {
      if (!Array.isArray(result.repositories) || result.repositories.length !== 1) {
        throw new GitHubProviderError();
      }
      repository = parseInstallationRepository(result.repositories[0]);
      if (repository.id !== input.repositoryId) throw new GitHubProviderError();
    } catch {
      try {
        await this.revokeInstallationAccessToken(accessToken);
      } catch {
        // Provider expiry remains the fallback when immediate revocation fails.
      }
      throw new GitHubProviderError();
    }
    return {
      accessToken,
      repository,
    };
  }

  async getRepositoryMetadata(
    accessToken: string,
    owner: string,
    repository: string,
  ): Promise<InstallationRepositoryMetadata> {
    return parseInstallationRepository(
      await this.apiJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ),
    );
  }

  async resolveBranchCommit(input: {
    accessToken: string;
    branch: string;
    owner: string;
    repository: string;
  }): Promise<string> {
    const result = objectValue(
      await this.apiJson(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/ref/${encodeURIComponent(`heads/${input.branch}`)}`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      ),
    );
    const object = objectValue(result.object);
    if (object.type !== 'commit') throw new GitHubProviderError();
    return gitSha(object.sha);
  }

  async getRepositoryRoot(input: {
    accessToken: string;
    owner: string;
    ref: string;
    repository: string;
  }): Promise<RepositoryRootEntry[]> {
    return parseRootEntries(
      await this.apiJson(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents?ref=${encodeURIComponent(input.ref)}`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
      ),
    );
  }

  async getRepositoryFile(input: {
    accessToken: string;
    owner: string;
    path: 'package-lock.json' | 'package.json';
    ref: string;
    repository: string;
  }): Promise<InspectedRepositoryFile | null> {
    const response = await this.request(
      `${API_BASE_URL}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${input.path}?ref=${encodeURIComponent(input.ref)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.accessToken}`,
          'X-GitHub-Api-Version': API_VERSION,
        },
      },
    );
    if (response.status === 404) return null;
    return parseRepositoryFile(await readBoundedJson(response));
  }

  async revokeInstallationAccessToken(accessToken: string): Promise<void> {
    const response = await this.request(`${API_BASE_URL}/installation/token`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
      method: 'DELETE',
    });
    if (response.status !== 204) throw new GitHubProviderError();
  }

  async downloadRepositoryArchive(input: {
    accessToken: string;
    owner: string;
    ref: string;
    repository: string;
  }): Promise<Buffer> {
    const response = await this.request(
      `${API_BASE_URL}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/tarball/${encodeURIComponent(input.ref)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.accessToken}`,
          'X-GitHub-Api-Version': API_VERSION,
        },
      },
      'manual',
    );
    if (response.status !== 302) throw new GitHubProviderError();
    const location = response.headers.get('location');
    if (!location) throw new GitHubProviderError();
    let archiveUrl: URL;
    try {
      archiveUrl = new URL(location);
    } catch {
      throw new GitHubProviderError();
    }
    if (
      archiveUrl.protocol !== 'https:' ||
      archiveUrl.hostname !== 'codeload.github.com' ||
      archiveUrl.username ||
      archiveUrl.password ||
      archiveUrl.hash
    ) {
      throw new GitHubProviderError();
    }
    return readBoundedBuffer(await this.request(archiveUrl.toString(), {}), MAX_ARCHIVE_BYTES);
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

  private async request(
    url: string,
    init: RequestInit,
    redirect: RequestRedirect = 'error',
  ): Promise<Response> {
    try {
      return await this.fetchImplementation(url, {
        ...init,
        headers: {
          'User-Agent': 'Vigilo',
          ...init.headers,
        },
        redirect,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubProviderError();
    }
  }
}
