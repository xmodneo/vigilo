import type { AuthEnvironment } from './factory.ts';

export interface ServerEnvironment extends AuthEnvironment {
  databaseUrl: string;
}

function requireValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`missing_required_environment:${name}`);
  }
  return value;
}

export function readServerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ServerEnvironment {
  const baseUrl = requireValue(environment, 'BETTER_AUTH_URL');
  const parsedBaseUrl = new URL(baseUrl);
  const isLocalDevelopment =
    parsedBaseUrl.protocol === 'http:' &&
    (parsedBaseUrl.hostname === 'localhost' || parsedBaseUrl.hostname === '127.0.0.1');

  if (parsedBaseUrl.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error('invalid_environment:BETTER_AUTH_URL');
  }

  const secret = requireValue(environment, 'BETTER_AUTH_SECRET');
  if (secret.length < 32) {
    throw new Error('invalid_environment:BETTER_AUTH_SECRET');
  }

  const databaseUrl = requireValue(environment, 'DATABASE_URL');
  const databaseProtocol = new URL(databaseUrl).protocol;
  if (databaseProtocol !== 'postgres:' && databaseProtocol !== 'postgresql:') {
    throw new Error('invalid_environment:DATABASE_URL');
  }

  return {
    baseUrl: parsedBaseUrl.origin,
    databaseUrl,
    githubClientId: requireValue(environment, 'GITHUB_CLIENT_ID'),
    githubClientSecret: requireValue(environment, 'GITHUB_CLIENT_SECRET'),
    secret,
  };
}
