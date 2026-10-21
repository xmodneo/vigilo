import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readDatabaseEnvironment } from '../lib/auth/environment.ts';
import { GitHubApiClient } from '../lib/github-app/client.ts';
import { readGitHubAppPrivateKey, readGitHubWorkerEnvironment } from '../lib/github-app/environment.ts';
import { PostgresWorkerHeartbeatStore, WorkerHeartbeatLifecycle } from '../lib/operations/worker-heartbeat.ts';
import { readRuntimeRelease } from '../lib/operations/release.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { parseExactBaselineArguments } from '../lib/repair-runs/exact-baseline-job.ts';
import { executeExactBaselineOnce } from '../lib/repair-runs/one-shot-service.ts';
import { createConsoleWorkerLogger } from '../lib/repair-runs/worker.ts';
import { closeOneShotBusinessClientAndStopHeartbeat } from '../lib/operations/one-shot-cleanup.ts';

const BOSS_GRACEFUL_STOP_MS = 5_000;
const CLEANUP_DEADLINE_MS = 8_000;

async function cleanupWithinDeadline(action: () => Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('baseline_one_shot_cleanup_timeout')), CLEANUP_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let client: ReturnType<typeof postgres> | undefined;
  let heartbeatClient: ReturnType<typeof postgres> | undefined;
  let boss: PgBoss | undefined;
  let heartbeat: WorkerHeartbeatLifecycle | undefined;
  let bossLifecycle: 'not_constructed' | 'constructed' | 'start_attempted' | 'started' | 'stop_attempted' | 'stopped' = 'not_constructed';
  let heartbeatStarted = false;
  let primaryFailure: 'boss_start' | 'operation' | undefined;
  const cleanupFailures: string[] = [];
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try { await cleanupWithinDeadline(action); }
    catch { cleanupFailures.push(name); }
  };
  try {
    const request = parseExactBaselineArguments(process.argv.slice(2));
    const runtimeReleaseSha = readRuntimeRelease();
    if (request.releaseSha !== runtimeReleaseSha) throw new Error('exact_job_authority_changed');
    const { databaseUrl } = readDatabaseEnvironment();
    const configuration = readGitHubWorkerEnvironment();
    const key = await readGitHubAppPrivateKey(configuration.privateKeyPath);
    const gateway = new GitHubApiClient(configuration, key);
    client = postgres(databaseUrl, { max: 2, prepare: false, connect_timeout: 5, idle_timeout: 5,
      connection: { statement_timeout: 5_000, lock_timeout: 2_000 } });
    heartbeatClient = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5,
      connection: { statement_timeout: 5_000, lock_timeout: 2_000 } });
    const database = drizzle(client, { schema });
    boss = new PgBoss({ connectionString: databaseUrl, application_name: 'vigilo-baseline-once', max: 2,
      schedule: false, supervise: false, useListenNotify: false });
    bossLifecycle = 'constructed';
    heartbeat = new WorkerHeartbeatLifecycle(new PostgresWorkerHeartbeatStore(heartbeatClient), {
      id: randomUUID(), releaseSha: runtimeReleaseSha, kind: 'baseline-one-shot',
      targetRepairRunId: request.repairRunId, targetJobId: request.jobId,
    });
    bossLifecycle = 'start_attempted';
    await boss.start();
    bossLifecycle = 'started';
    await heartbeat.start();
    heartbeatStarted = true;
    await heartbeat.ready();
    heartbeat.begin();
    const receipt = await executeExactBaselineOnce(database, boss, request, runtimeReleaseSha, {
      configuration, database, gateway, logger: createConsoleWorkerLogger(),
      executionAuthority: new DurableExternalExecutionAuthorizer(database, { runtimeReleaseSha }),
    }, shutdown.signal);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.result !== 'completed' || receipt.repairRunState === 'baseline_running') process.exitCode = 1;
  } catch {
    primaryFailure = bossLifecycle === 'start_attempted' ? 'boss_start' : 'operation';
  } finally {
    shutdown.abort();
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (heartbeatStarted && heartbeat) {
      const activeHeartbeat = heartbeat;
      await cleanup('heartbeat_draining', () => activeHeartbeat.draining());
    }
    if (boss && (bossLifecycle === 'start_attempted' || bossLifecycle === 'started')) {
      const activeBoss = boss;
      bossLifecycle = 'stop_attempted';
      await cleanup('boss_stop', () => activeBoss.stop({ graceful: true, timeout: BOSS_GRACEFUL_STOP_MS }));
      if (!cleanupFailures.includes('boss_stop')) bossLifecycle = 'stopped';
    }
    const activeHeartbeatClient = heartbeatClient;
    const activeClient = client;
    const activeHeartbeat = heartbeat;
    cleanupFailures.push(...await closeOneShotBusinessClientAndStopHeartbeat(
      () => activeClient ? cleanupWithinDeadline(() => activeClient.end({ timeout: 2 })) : Promise.resolve(),
      (failureCode) => heartbeatStarted && activeHeartbeat
        ? cleanupWithinDeadline(() => activeHeartbeat.stopped(failureCode))
        : Promise.resolve(),
      Boolean(primaryFailure || process.exitCode || cleanupFailures.length),
      bossLifecycle === 'not_constructed' || bossLifecycle === 'constructed' || bossLifecycle === 'stopped',
    ));
    if (activeHeartbeatClient) await cleanup('heartbeat_client_close', () => activeHeartbeatClient.end({ timeout: 2 }));
  }
  if (primaryFailure) writeSync(2, `${primaryFailure === 'boss_start' ? 'baseline_one_shot_start_failed' : 'baseline_one_shot_failed'}\n`);
  for (const failure of cleanupFailures) writeSync(2, `baseline_one_shot_cleanup_failed:${failure}\n`);
  if (primaryFailure || cleanupFailures.length) process.exitCode = 1;
  // Only a failed or timed-out cleanup can leave dependency-owned handles alive.
  // This is a local process exit after bounded cleanup, not a database termination.
  if (cleanupFailures.length) process.exit(1);
}

main().catch(() => {
  writeSync(2, 'baseline_one_shot_failed\n');
  process.exitCode = 1;
});
