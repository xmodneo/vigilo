import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { readServerEnvironment } from '../lib/auth/environment.ts';

async function main() {
  const { databaseUrl } = readServerEnvironment();
  const client = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    process.stdout.write('Database migrations applied.\n');
  } finally {
    await client.end();
  }
}

main().catch(() => {
  process.stderr.write('Database migration failed.\n');
  process.exitCode = 1;
});
