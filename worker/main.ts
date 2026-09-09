import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readServerEnvironment } from '../lib/auth/environment.ts';
import { GitHubApiClient } from '../lib/github-app/client.ts';
import { readGitHubAppEnvironment, readGitHubAppPrivateKey } from '../lib/github-app/environment.ts';
import {
  createRepairBoss,
  INVESTIGATION_CONTEXT_QUEUE,
  REPAIR_BASELINE_QUEUE,
  REPAIR_WORK_OPTIONS,
} from '../lib/repair-runs/queue.ts';
import { createConsoleWorkerLogger, processRepairJob } from '../lib/repair-runs/worker.ts';
import { repairRun } from '../db/schema.ts';
import { investigation } from '../db/schema.ts';
import { inArray } from 'drizzle-orm';
import { processInvestigationJob } from '../lib/investigations/worker.ts';

async function main(): Promise<void> {
  const environment = readServerEnvironment();
  const configuration = readGitHubAppEnvironment();
  const client = postgres(environment.databaseUrl, { max: 2, prepare: false });
  const database = drizzle(client, { schema });
  const logger = createConsoleWorkerLogger();
  const shutdown = new AbortController();
  let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;
  const workerIds: Array<{ id: string; queue: string }> = [];

  try {
    boss = await createRepairBoss(environment.databaseUrl, 'worker');
    const gateway = new GitHubApiClient(configuration, await readGitHubAppPrivateKey(configuration.privateKeyPath));
    boss.on('error', () => logger.write({ event: 'retry_classified', code: 'queue_operation_failed' }));

    const active = await database.select({ id: repairRun.id }).from(repairRun).where(inArray(repairRun.state, ['created', 'baseline_running']));
    for (const run of active) {
      try { await boss.retry(REPAIR_BASELINE_QUEUE, run.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }
    const activeInvestigations = await database.select({ id: investigation.id }).from(investigation).where(inArray(investigation.state, ['created', 'context_preparing']));
    for (const value of activeInvestigations) {
      try { await boss.retry(INVESTIGATION_CONTEXT_QUEUE, value.id); }
      catch { /* A non-failed canonical job remains owned by pg-boss. */ }
    }

    const workOptions = { ...REPAIR_WORK_OPTIONS, perJobResults: true as const };
    const repairWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(REPAIR_BASELINE_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0];
      if (!job) return [];
      try {
        return [await processRepairJob(job, { configuration, database, gateway, logger, shutdownSignal: shutdown.signal })];
      } catch {
        return [{ id: job.id, status: 'failed' as const, output: { code: 'worker_operation_failed' } }];
      }
    });
    workerIds.push({ id: repairWorkerId, queue: REPAIR_BASELINE_QUEUE });
    const investigationWorkerId = await boss.work<unknown, { code?: string }, typeof workOptions>(INVESTIGATION_CONTEXT_QUEUE, workOptions, async (jobs) => {
      const job = jobs[0];
      if (!job) return [];
      try {
        return [await processInvestigationJob(job, { configuration, database, gateway, logger, shutdownSignal: shutdown.signal })];
      } catch {
        return [{ id: job.id, status: 'failed' as const, output: { code: 'investigation_worker_failed' } }];
      }
    });
    workerIds.push({ id: investigationWorkerId, queue: INVESTIGATION_CONTEXT_QUEUE });

    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    shutdown.abort();
    try {
      if (boss) for (const worker of workerIds) await boss.offWork(worker.queue, { id: worker.id, wait: true });
      if (boss) await boss.stop({ graceful: true, timeout: 120_000 });
    } finally {
      await client.end();
    }
  }
}

main().catch(() => {
  process.stderr.write('Vigilo worker stopped after a safe startup or runtime failure.\n');
  process.exitCode = 1;
});
