import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { fromDrizzle, PgBoss, type DrizzleTransactionLike } from 'pg-boss';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('missing_required_environment:DATABASE_URL');

const queueName = `vigilo-transaction-probe-${randomUUID()}`;
const committedId = randomUUID();
const rolledBackId = randomUUID();
const client = postgres(databaseUrl, { max: 2, prepare: false });
const database = drizzle(client);
const boss = new PgBoss({ application_name: 'vigilo-transaction-probe', connectionString: databaseUrl, schedule: false, supervise: false, useListenNotify: false });

let committed = false;
let rolledBack = false;

try {
  await boss.start();
  await boss.createQueue(queueName, { policy: 'standard' });
  await database.transaction(async (transaction) => {
    const id = await boss.send(queueName, { version: 1, repairRunId: committedId }, {
      db: fromDrizzle(transaction as unknown as DrizzleTransactionLike, sql),
      id: committedId,
    });
    if (id !== committedId) throw new Error('commit_probe_not_scheduled');
  });
  committed = (await boss.getJobById(queueName, committedId))?.id === committedId;

  try {
    await database.transaction(async (transaction) => {
      const id = await boss.send(queueName, { version: 1, repairRunId: rolledBackId }, {
        db: fromDrizzle(transaction as unknown as DrizzleTransactionLike, sql),
        id: rolledBackId,
      });
      if (id !== rolledBackId) throw new Error('rollback_probe_not_scheduled');
      throw new Error('intentional_transaction_rollback');
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'intentional_transaction_rollback') throw error;
  }
  rolledBack = await boss.getJobById(queueName, rolledBackId) === null;
  if (!committed || !rolledBack) throw new Error('transaction_probe_failed');
  process.stdout.write(`${JSON.stringify({ pgBossVersion: '12.30.0', committedJobVisible: committed, rolledBackJobAbsent: rolledBack, result: 'passed' })}\n`);
} finally {
  try { await boss.deleteAllJobs(queueName); } catch { /* Queue may not have been created. */ }
  try { await boss.deleteQueue(queueName); } catch { /* Queue may not have been created. */ }
  await boss.stop({ graceful: false });
  await client.end();
}
