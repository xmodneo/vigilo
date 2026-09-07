import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { BetterAuthOptions } from 'better-auth';

import * as schema from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { ensureWorkspaceForUser } from '../workspaces.ts';

export interface AuthEnvironment {
  baseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  secret: string;
}

export function createAuthOptions(
  database: VigiloDatabase,
  environment: AuthEnvironment,
): BetterAuthOptions {
  const origin = new URL(environment.baseUrl).origin;

  return {
    appName: 'Vigilo',
    baseURL: environment.baseUrl,
    secret: environment.secret,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema,
    }),
    socialProviders: {
      github: {
        clientId: environment.githubClientId,
        clientSecret: environment.githubClientSecret,
      },
    },
    disabledPaths: ['/account-info', '/get-access-token', '/refresh-token'],
    account: {
      accountLinking: {
        enabled: false,
      },
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
    },
    session: {
      cookieCache: {
        enabled: false,
      },
    },
    advanced: {
      cookiePrefix: 'vigilo',
      useSecureCookies: origin.startsWith('https://'),
    },
    trustedOrigins: [origin],
    logger: {
      disabled: true,
    },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser) => {
            await ensureWorkspaceForUser(database, createdUser.id);
          },
        },
      },
    },
  };
}
