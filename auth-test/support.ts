import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { betterAuth } from 'better-auth';
import { testUtils, type TestHelpers } from 'better-auth/plugins';

import * as schema from '../db/schema.ts';
import { createAuthOptions } from '../lib/auth/factory.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';

const TEST_AUTH_ENVIRONMENT = {
  baseUrl: 'http://localhost:3000',
  githubClientId: 'test-github-client',
  githubClientSecret: 'test-github-secret',
  secret: 'test-only-secret-with-at-least-thirty-two-characters',
} as const;

export async function createTestContext() {
  const client = new PGlite();
  await client.waitReady;

  const drizzleDatabase = drizzle(client, { schema });
  await migrate(drizzleDatabase, { migrationsFolder: 'drizzle' });
  const database = drizzleDatabase as unknown as VigiloDatabase;

  const auth = betterAuth({
    ...createAuthOptions(database, TEST_AUTH_ENVIRONMENT),
    // Better Auth 1.7.2's test-only plugin declaration is not compatible with
    // exactOptionalPropertyTypes, even though the runtime plugin is supported.
    plugins: [testUtils() as never],
  });
  const context = await auth.$context;

  return {
    auth,
    client,
    database,
    testAuth: (context as typeof context & { test: TestHelpers }).test,
  };
}

export async function saveGithubUser(
  context: Awaited<ReturnType<typeof createTestContext>>,
  githubUserId: string,
  email = `${githubUserId}@example.test`,
) {
  const now = new Date();
  const user = await context.testAuth.saveUser(
    context.testAuth.createUser({
      email,
      emailVerified: true,
      name: `GitHub user ${githubUserId}`,
    }),
  );

  await context.database.insert(schema.account).values({
    id: randomUUID(),
    accountId: githubUserId,
    issuer: 'local:oauth:github',
    providerId: 'github',
    userId: user.id,
    createdAt: now,
    updatedAt: now,
  });

  return user;
}
