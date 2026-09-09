import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type DrizzleTransactionLike, type Job, type JobWithMetadata } from 'pg-boss';

import type { VigiloDatabase } from '../db/types.ts';

export const REPAIR_BASELINE_QUEUE = 'repair-baseline-v1';
export const REPAIR_JOB_VERSION = 1 as const;
export const REPAIR_JOB_MAX_ATTEMPTS = 3;

export const REPAIR_QUEUE_OPTIONS = {
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  expireInSeconds: 12 * 60,
  heartbeatSeconds: 60,
  retentionSeconds: 7 * 24 * 60 * 60,
  retryBackoff: true,
  retryDelay: 30,
  retryDelayMax: 120,
  retryLimit: 4,
} as const;

export const REPAIR_WORK_OPTIONS = {
  batchSize: 1,
  heartbeatRefreshSeconds: 30,
  includeMetadata: true,
  localConcurrency: 1,
  pollingIntervalSeconds: 2,
} as const;

export interface RepairJobPayload {
  version: typeof REPAIR_JOB_VERSION;
  repairRunId: string;
}

export type RepairQueueJob = JobWithMetadata<unknown> | Job<unknown>;
export type VigiloTransaction = Parameters<Parameters<VigiloDatabase['transaction']>[0]>[0];

export interface TransactionalRepairQueue {
  enqueue(transaction: VigiloTransaction, payload: RepairJobPayload): Promise<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseRepairJobPayload(value: unknown): RepairJobPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_job_payload');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== REPAIR_JOB_VERSION || typeof record.repairRunId !== 'string' || !UUID.test(record.repairRunId)) {
    throw new Error('invalid_job_payload');
  }
  return { version: REPAIR_JOB_VERSION, repairRunId: record.repairRunId };
}

export class PgBossRepairQueue implements TransactionalRepairQueue {
  constructor(private readonly boss: Pick<PgBoss, 'send'>) {}

  async enqueue(transaction: VigiloTransaction, payload: RepairJobPayload): Promise<string> {
    const validated = parseRepairJobPayload(payload);
    const id = await this.boss.send(REPAIR_BASELINE_QUEUE, validated, {
      ...REPAIR_QUEUE_OPTIONS,
      db: fromDrizzle(transaction as unknown as DrizzleTransactionLike, sql),
      id: validated.repairRunId,
    });
    if (id !== validated.repairRunId) throw new Error('repair_job_not_persisted');
    return id;
  }
}

export async function configureRepairQueue(boss: Pick<PgBoss, 'createQueue' | 'updateQueue'>): Promise<void> {
  await boss.createQueue(REPAIR_BASELINE_QUEUE, { policy: 'standard', ...REPAIR_QUEUE_OPTIONS });
  await boss.updateQueue(REPAIR_BASELINE_QUEUE, REPAIR_QUEUE_OPTIONS);
}

export async function createRepairBoss(databaseUrl: string, role: 'publisher' | 'worker'): Promise<PgBoss> {
  const boss = new PgBoss({
    application_name: `vigilo-${role}`,
    connectionString: databaseUrl,
    max: role === 'worker' ? 3 : 2,
    schedule: false,
    supervise: role === 'worker',
    useListenNotify: false,
  });
  await boss.start();
  await configureRepairQueue(boss);
  return boss;
}
