import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { readDatabaseEnvironment } from '../lib/auth/environment.ts';
import { MIGRATION_MANIFEST, validateMigrationFiles, validateMigrationLedger } from '../lib/operations/migrations.ts';
import { writeOperationalLog } from '../lib/operations/logging.ts';

const MIGRATION_LOCK = 482_933_812_341;

async function readLedger(client: ReturnType<typeof postgres>) {
  const [exists] = await client<{ table: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations')::text as table`;
  if (!exists?.table) return [];
  return client<{ hash: string; createdAt: string }[]>`
    select hash, created_at::text as "createdAt"
    from drizzle.__drizzle_migrations
    order by created_at, id
  `;
}

async function main() {
  const { databaseUrl } = readDatabaseEnvironment();
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  let locked = false;

  try {
    await validateMigrationFiles(fileURLToPath(new URL('..', import.meta.url)));
    const [lock] = await client<{ acquired: boolean }[]>`select pg_try_advisory_lock(${MIGRATION_LOCK}) as acquired`;
    if (!lock?.acquired) throw new Error('migration_lock_unavailable');
    locked = true;
    validateMigrationLedger(await readLedger(client));
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    if (validateMigrationLedger(await readLedger(client)) !== 'complete') throw new Error('migration_ledger_incomplete');
    if ((await readLedger(client)).length !== MIGRATION_MANIFEST.length) throw new Error('migration_ledger_unexpected');
    process.stdout.write('Database migrations applied.\n');
  } finally {
    try {
      if (locked) await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    } finally {
      await client.end();
    }
  }
}

main().catch((error: unknown) => {
  writeOperationalLog({ level: 'error', event: 'migration_failed', service: 'vigilo-migrator', failureCode: error instanceof Error ? error.message.replace(/[^a-z_]/g, '_').slice(0, 64) : 'migration_failed' });
  process.stderr.write('Database migration failed.\n');
  process.exitCode = 1;
});
