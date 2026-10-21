/** Install cancellation before any asynchronous startup can register consumers. */
export function installWorkerShutdownSignals(controller: AbortController): {
  requested: Promise<void>;
  isGraceful(): boolean;
  dispose(): void;
} {
  let graceful = false;
  let resolveRequested!: () => void;
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve; });
  const stop = () => {
    if (graceful) return;
    graceful = true;
    controller.abort();
    resolveRequested();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    requested,
    isGraceful: () => graceful,
    dispose: () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    },
  };
}
