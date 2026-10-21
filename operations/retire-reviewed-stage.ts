/** Local-only, authenticated operator entrypoint. The protected request is read from stdin. */
import { writeSync } from 'node:fs';

import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readServerEnvironment } from '../lib/auth/environment.ts';
import { createAuthOptions } from '../lib/auth/factory.ts';
import { resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { runReviewedRetirementCommand } from '../lib/external-execution/reviewed-retirement-cli.ts';
import { retireReviewedStagedRun } from '../lib/external-execution/reviewed-retirement.ts';

const BOSS_GRACEFUL_STOP_MS = 5_000;
const CLEANUP_DEADLINE_MS = 8_000;

async function cleanupWithinDeadline(action: () => Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('reviewed_retirement_cleanup_timeout')), CLEANUP_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readProtectedInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 16 * 1024) throw new Error('retirement_invalid');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function main(): Promise<void> {
  let client: ReturnType<typeof postgres> | undefined;
  let boss: PgBoss | undefined;
  let bossLifecycle: 'not_constructed' | 'constructed' | 'start_attempted' | 'started' | 'stop_attempted' | 'stopped' = 'not_constructed';
  let primaryFailure: 'boss_start' | 'operation' | undefined;
  const cleanupFailures: string[] = [];
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try { await cleanupWithinDeadline(action); }
    catch { cleanupFailures.push(name); }
  };
  try {
    if (process.argv.length !== 2) throw new Error('retirement_usage');
    const request = await readProtectedInput();
    const environment = readServerEnvironment();
    client = postgres(environment.databaseUrl, { max: 2, prepare: false });
    const database = drizzle(client, { schema });
    const auth = betterAuth(createAuthOptions(database, environment));
    const activeBoss = new PgBoss({ connectionString: environment.databaseUrl, application_name: 'vigilo-reviewed-retirement',
      max: 1, schedule: false, supervise: false, useListenNotify: false });
    boss = activeBoss;
    bossLifecycle = 'constructed';
    bossLifecycle = 'start_attempted';
    await activeBoss.start();
    bossLifecycle = 'started';
    const receipt = await runReviewedRetirementCommand(request, {
      resolveContext: (cookie) => resolveAuthenticatedWorkspace(
        (headers) => auth.api.getSession({ headers }), database,
        new Headers({ cookie }), { existingWorkspaceOnly: true }),
      retire: (context, retirement) => retireReviewedStagedRun(database, context, retirement, activeBoss),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch {
    primaryFailure = bossLifecycle === 'start_attempted' ? 'boss_start' : 'operation';
  } finally {
    if (boss && (bossLifecycle === 'start_attempted' || bossLifecycle === 'started')) {
      const activeBoss = boss;
      bossLifecycle = 'stop_attempted';
      await cleanup('boss_stop', () => activeBoss.stop({ graceful: true, timeout: BOSS_GRACEFUL_STOP_MS }));
      if (!cleanupFailures.includes('boss_stop')) bossLifecycle = 'stopped';
    }
    if (client) {
      const activeClient = client;
      await cleanup('database_client_close', () => activeClient.end({ timeout: 2 }));
    }
  }
  if (primaryFailure) writeSync(2, `${primaryFailure === 'boss_start' ? 'reviewed_retirement_start_failed' : 'reviewed_retirement_failed'}\n`);
  for (const failure of cleanupFailures) writeSync(2, `reviewed_retirement_cleanup_failed:${failure}\n`);
  if (primaryFailure || cleanupFailures.length) process.exitCode = 1;
  // A failed cleanup can leave dependency-owned handles alive after the deadline.
  if (cleanupFailures.length) process.exit(1);
}

main().catch(() => {
  writeSync(2, 'reviewed_retirement_failed\n');
  process.exitCode = 1;
});
