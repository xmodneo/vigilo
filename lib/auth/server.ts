import { betterAuth } from 'better-auth';

import { getDatabase } from '../db/server.ts';
import { createAuthOptions } from './factory.ts';
import { readServerEnvironment } from './environment.ts';

export type VigiloAuth = ReturnType<typeof betterAuth>;

let auth: VigiloAuth | undefined;

export function getAuth(): VigiloAuth {
  if (!auth) {
    const environment = readServerEnvironment();
    const database = getDatabase(environment.databaseUrl);
    auth = betterAuth(createAuthOptions(database, environment));
  }

  return auth;
}

export function getAuthDatabase() {
  const environment = readServerEnvironment();
  return getDatabase(environment.databaseUrl);
}
