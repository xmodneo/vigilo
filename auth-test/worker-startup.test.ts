import assert from 'node:assert/strict';
import test from 'node:test';

import { installWorkerShutdownSignals } from '../lib/operations/worker-startup.ts';

test('SIGTERM during partially registered startup cancels before another consumer', async () => {
  const shutdown = new AbortController();
  const signals = installWorkerShutdownSignals(shutdown);
  const registered: string[] = [];
  try {
    const firstRegistration = async () => {
      registered.push('first');
      process.emit('SIGTERM');
      await Promise.resolve();
    };
    await firstRegistration();
    if (!shutdown.signal.aborted) registered.push('second');
    await signals.requested;
    assert.equal(signals.isGraceful(), true);
    assert.deepEqual(registered, ['first']);
  } finally {
    signals.dispose();
  }
});
