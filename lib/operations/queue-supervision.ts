import { PgBoss } from 'pg-boss';

import { canonicalRepairQueues } from './queues.ts';

const SUPERVISION_INTERVAL_MS = 60_000;
const MAINTENANCE_STATEMENT_TIMEOUT_MS = 5_000;
const MAINTENANCE_LOCK_TIMEOUT_MS = 2_000;
const MAINTENANCE_SHUTDOWN_DEADLINE_MS = 8_000;

export class QueueSupervisionShutdownError extends Error {
  constructor(readonly code: 'queue_supervision_shutdown_unresolved') { super(code); }
}

/** The separate pool makes PostgreSQL-enforced timeouts maintenance-only. */
export async function createCanonicalRepairSupervisor(
  databaseUrl: string,
  onError: () => void,
  intervalMs = SUPERVISION_INTERVAL_MS,
): Promise<{ stop(): Promise<void>; runNow(): Promise<void> }> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('invalid_supervision_interval');
  const config = {
    application_name: 'vigilo-queue-supervisor',
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: MAINTENANCE_STATEMENT_TIMEOUT_MS,
    lock_timeout: MAINTENANCE_LOCK_TIMEOUT_MS,
    migrate: false,
    schedule: false,
    supervise: false,
    useListenNotify: false,
  } satisfies ConstructorParameters<typeof PgBoss>[0] & { statement_timeout: number; lock_timeout: number };
  const boss = new PgBoss(config);
  try {
    await boss.start();
  } catch {
    try {
      await settleBeforeDeadline(boss.stop({ graceful: true, timeout: 5_000 }));
    } catch {
      throw new QueueSupervisionShutdownError('queue_supervision_shutdown_unresolved');
    }
    throw new Error('queue_supervision_start_failed');
  }
  return startCanonicalRepairSupervision(boss, onError, intervalMs);
}

async function settleBeforeDeadline(pending: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new QueueSupervisionShutdownError('queue_supervision_shutdown_unresolved')),
          MAINTENANCE_SHUTDOWN_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** pg-boss 12.30.0 scopes supervise(name) to that queue, unlike its automatic all-queue pass. */
export async function superviseCanonicalRepairQueues(
  boss: Pick<PgBoss, 'supervise'>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  for (const name of canonicalRepairQueues) {
    if (!shouldContinue()) return;
    await boss.supervise(name);
  }
}

/** Successful stop means the in-flight pass settled and its dedicated pool closed. */
export function startCanonicalRepairSupervision(
  boss: Pick<PgBoss, 'supervise' | 'stop'>,
  onError: () => void,
  intervalMs = SUPERVISION_INTERVAL_MS,
): { stop(): Promise<void>; runNow(): Promise<void> } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('invalid_supervision_interval');
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const running = superviseCanonicalRepairQueues(boss, () => !stopped);
    inFlight = running;
    void running.finally(() => { if (inFlight === running) inFlight = undefined; }).catch(() => undefined);
    return running;
  };
  const timer = setInterval(() => {
    void runNow().catch(() => {
      try { onError(); } catch { /* A reporting failure must not become an unhandled rejection. */ }
    });
  }, intervalMs);
  return {
    runNow,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      const running = inFlight;
      const stopping = Promise.resolve().then(() => boss.stop({ graceful: true, timeout: 5_000 }));
      const settled = Promise.allSettled([running ?? Promise.resolve(), stopping]).then((results) => {
        if (results[1]?.status === 'rejected')
          throw new QueueSupervisionShutdownError('queue_supervision_shutdown_unresolved');
      });
      stopPromise = settleBeforeDeadline(settled);
      return stopPromise;
    },
  };
}
