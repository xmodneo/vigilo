/** The deadline covers the entire drain, not only pg-boss's final stop call. */
export const GENERAL_WORKER_SHUTDOWN_DEADLINE_MS = 130_000;

export class GeneralWorkerShutdownError extends Error {
  readonly code = 'general_worker_shutdown_unresolved';
  constructor() { super('general_worker_shutdown_unresolved'); }
}

type ShutdownDependencies = {
  heartbeat?: { draining(): Promise<void>; stopped(failureCode?: string): Promise<void> } | undefined;
  supervisor?: { stop(): Promise<void> } | undefined;
  boss?: {
    offWork(queue: string, options: { id: string; wait: true }): Promise<unknown>;
    stop(options: { graceful: true; timeout: number }): Promise<unknown>;
  } | undefined;
  workers: ReadonlyArray<{ id: string; queue: string }>;
  /** Close the work-capable database client before recording execution stopped. */
  closeClients(): Promise<void>;
  closeHeartbeatClient?(): Promise<void>;
  failureCode?: string | undefined;
  deadlineMs?: number;
};

/** A timeout does not cancel handlers. The caller must terminate this process unsuccessfully. */
export async function stopGeneralWorker(dependencies: ShutdownDependencies): Promise<void> {
  const deadlineMs = dependencies.deadlineMs ?? GENERAL_WORKER_SHUTDOWN_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new GeneralWorkerShutdownError();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopping = (async () => {
    // Request all seven consumers to stop polling immediately. No one consumer
    // may prevent the remaining consumers or the supervisor from stopping.
    await Promise.all([
      dependencies.heartbeat?.draining(),
      dependencies.supervisor?.stop(),
      ...dependencies.workers.map((worker) => dependencies.boss?.offWork(worker.queue, { id: worker.id, wait: true })),
    ]);
    if (expired) throw new GeneralWorkerShutdownError();
    await dependencies.boss?.stop({ graceful: true, timeout: 120_000 });
    if (expired) throw new GeneralWorkerShutdownError();
    let cleanupFailed = false;
    try { await dependencies.closeClients(); }
    catch { cleanupFailed = true; }
    if (expired) throw new GeneralWorkerShutdownError();
    // A terminal heartbeat certifies settled execution ownership, not closure
    // of its own status-only connection or successful OS process exit.
    if (!cleanupFailed) {
      try { await dependencies.heartbeat?.stopped(dependencies.failureCode); }
      catch { cleanupFailed = true; }
    }
    if (expired) throw new GeneralWorkerShutdownError();
    try { await dependencies.closeHeartbeatClient?.(); }
    catch { cleanupFailed = true; }
    if (cleanupFailed || expired) throw new GeneralWorkerShutdownError();
  })();
  try {
    await Promise.race([
      stopping,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new GeneralWorkerShutdownError()); }, deadlineMs);
      }),
    ]);
  } catch {
    // A rejected stop or unresolved consumer leaves ownership ambiguous.
    throw new GeneralWorkerShutdownError();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
