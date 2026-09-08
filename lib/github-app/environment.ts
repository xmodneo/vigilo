import { createPrivateKey } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

import type { GitHubApiConfiguration } from './types.ts';

const MAX_PRIVATE_KEY_BYTES = 64 * 1_024;

export interface GitHubAppEnvironment extends GitHubApiConfiguration {
  privateKeyPath: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || /[\u0000\r\n]/.test(value)) {
    throw new Error('invalid_github_app_configuration');
  }
  return value;
}

export function readGitHubAppEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubAppEnvironment {
  try {
    const appIdText = required(environment, 'GITHUB_APP_ID');
    if (!/^[1-9][0-9]{0,18}$/.test(appIdText)) {
      throw new Error();
    }
    const appId = Number(appIdText);
    if (!Number.isSafeInteger(appId)) {
      throw new Error();
    }

    const appSlug = required(environment, 'GITHUB_APP_SLUG');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(appSlug)) {
      throw new Error();
    }

    const parsedBaseUrl = new URL(required(environment, 'BETTER_AUTH_URL'));
    const localHttp =
      parsedBaseUrl.protocol === 'http:' &&
      (parsedBaseUrl.hostname === 'localhost' ||
        parsedBaseUrl.hostname === '127.0.0.1');
    if (parsedBaseUrl.protocol !== 'https:' && !localHttp) {
      throw new Error();
    }

    return {
      appId,
      appSlug,
      baseUrl: parsedBaseUrl.origin,
      clientId: required(environment, 'GITHUB_APP_CLIENT_ID'),
      clientSecret: required(environment, 'GITHUB_APP_CLIENT_SECRET'),
      privateKeyPath: required(environment, 'GITHUB_APP_PRIVATE_KEY_PATH'),
    };
  } catch {
    throw new Error('invalid_github_app_configuration');
  }
}

export async function readGitHubAppPrivateKey(path: string): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > MAX_PRIVATE_KEY_BYTES ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error();
    }
    const privateKey = await readFile(path, 'utf8');
    const parsed = createPrivateKey(privateKey);
    if (parsed.type !== 'private' || parsed.asymmetricKeyType !== 'rsa') {
      throw new Error();
    }
    return privateKey;
  } catch {
    throw new Error('invalid_github_app_private_key');
  }
}
