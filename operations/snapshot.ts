import postgres from 'postgres';

import { readDatabaseEnvironment } from '../lib/auth/environment.ts';
import { collectOperationalSnapshot } from '../lib/operations/snapshot.ts';

const client = postgres(readDatabaseEnvironment().databaseUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 5,
  idle_timeout: 5,
  connection: { statement_timeout: 5_000, lock_timeout: 1_000 },
});
try {
  process.stdout.write(`${JSON.stringify({ capturedAt: new Date().toISOString(), metrics: await collectOperationalSnapshot(client) })}\n`);
} finally {
  await client.end();
}
