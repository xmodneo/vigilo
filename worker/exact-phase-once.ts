import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readDatabaseEnvironment } from '../lib/auth/environment.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { GitHubApiClient } from '../lib/github-app/client.ts';
import { readGitHubAppPrivateKey, readGitHubWorkerEnvironment } from '../lib/github-app/environment.ts';
import { closeOneShotBusinessClientAndStopHeartbeat } from '../lib/operations/one-shot-cleanup.ts';
import { readRuntimeRelease } from '../lib/operations/release.ts';
import { PostgresWorkerHeartbeatStore, WorkerHeartbeatLifecycle } from '../lib/operations/worker-heartbeat.ts';
import { parseExactPhaseArguments } from '../lib/repair-runs/exact-phase-job.ts';
import { executeExactPhaseOnce } from '../lib/repair-runs/exact-phase-service.ts';

const CLEANUP_DEADLINE_MS = 8_000;
const BOSS_GRACEFUL_STOP_MS = 5_000;

async function bounded(action: () => Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('exact_phase_cleanup_timeout')), CLEANUP_DEADLINE_MS);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let client: ReturnType<typeof postgres> | undefined;
  let heartbeatClient: ReturnType<typeof postgres> | undefined;
  let boss: PgBoss | undefined;
  let heartbeat: WorkerHeartbeatLifecycle | undefined;
  let bossLifecycle: 'not_constructed' | 'constructed' | 'start_attempted' | 'started' | 'stopped' = 'not_constructed';
  let heartbeatStarted = false;
  let primaryFailure: 'boss_start' | 'operation' | undefined;
  const cleanupFailures: string[] = [];
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try { await bounded(action); } catch { cleanupFailures.push(name); }
  };
  try {
    const request = parseExactPhaseArguments(process.argv.slice(2));
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
    boss = new PgBoss({ connectionString: databaseUrl, application_name: 'vigilo-exact-phase-once', max: 2,
      schedule: false, supervise: false, useListenNotify: false });
    bossLifecycle = 'constructed';
    const heartbeatId = randomUUID();
    heartbeat = new WorkerHeartbeatLifecycle(new PostgresWorkerHeartbeatStore(heartbeatClient), {
      id: heartbeatId, releaseSha: runtimeReleaseSha, kind: 'exact-phase-one-shot', phase: request.phase,
      targetRepairRunId: request.repairRunId, targetJobId: request.jobId,
    });
    bossLifecycle = 'start_attempted';
    await boss.start();
    bossLifecycle = 'started';
    await heartbeat.start();
    heartbeatStarted = true;
    await heartbeat.ready();
    heartbeat.begin();
    const receipt = await executeExactPhaseOnce(request, {
      database, boss, gateway, configuration, runtimeReleaseSha, workerHeartbeatId: heartbeatId,
      executionAuthority: new DurableExternalExecutionAuthorizer(database, { runtimeReleaseSha }),
    }, shutdown.signal);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.result !== 'completed') process.exitCode = 1;
  } catch {
    primaryFailure = bossLifecycle === 'start_attempted' ? 'boss_start' : 'operation';
  } finally {
    shutdown.abort();
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (heartbeatStarted && heartbeat) {
      const active = heartbeat;
      await cleanup('heartbeat_draining', () => active.draining());
    }
    if (boss && (bossLifecycle === 'start_attempted' || bossLifecycle === 'started')) {
      const active = boss;
      await cleanup('boss_stop', () => active.stop({ graceful: true, timeout: BOSS_GRACEFUL_STOP_MS }));
      if (!cleanupFailures.includes('boss_stop')) bossLifecycle = 'stopped';
    }
    const activeClient = client;
    const activeHeartbeat = heartbeat;
    cleanupFailures.push(...await closeOneShotBusinessClientAndStopHeartbeat(
      () => activeClient ? bounded(() => activeClient.end({ timeout: 2 })) : Promise.resolve(),
      (failureCode) => heartbeatStarted && activeHeartbeat
        ? bounded(() => activeHeartbeat.stopped(failureCode)) : Promise.resolve(),
      Boolean(primaryFailure || process.exitCode || cleanupFailures.length),
      bossLifecycle === 'not_constructed' || bossLifecycle === 'constructed' || bossLifecycle === 'stopped',
    ));
    if (heartbeatClient) {
      const active = heartbeatClient;
      await cleanup('heartbeat_client_close', () => active.end({ timeout: 2 }));
    }
  }
  if (primaryFailure) writeSync(2, `${primaryFailure === 'boss_start' ? 'exact_phase_one_shot_start_failed' : 'exact_phase_one_shot_failed'}\n`);
  for (const failure of cleanupFailures) writeSync(2, `exact_phase_one_shot_cleanup_failed:${failure}\n`);
  if (primaryFailure || cleanupFailures.length) process.exitCode = 1;
  if (cleanupFailures.length) process.exit(1);
}

main().catch(() => {
  writeSync(2, 'exact_phase_one_shot_failed\n');
  process.exitCode = 1;
});
