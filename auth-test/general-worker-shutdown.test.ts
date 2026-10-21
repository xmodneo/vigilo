import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { stopGeneralWorker, GeneralWorkerShutdownError } from '../lib/operations/general-worker-shutdown.ts';

test('hung consumer makes the complete shutdown fail closed within its deadline', async () => {
  let stopped = 0;
  let closed = 0;
  const started = Date.now();
  await assert.rejects(stopGeneralWorker({
    heartbeat: { draining: async () => {}, stopped: async () => { stopped++; } },
    supervisor: { stop: async () => {} },
    boss: { offWork: async () => new Promise<void>(() => {}), stop: async () => { throw new Error('must not release active ownership'); } },
    workers: [{ id: 'worker-1', queue: 'repair-baseline-v1' }],
    closeClients: async () => { closed++; },
    deadlineMs: 30,
  }), (error: unknown) => error instanceof GeneralWorkerShutdownError);
  assert.ok(Date.now() - started < 500);
  assert.equal(stopped, 0);
  assert.equal(closed, 0);
});

test('settled consumers close once and heartbeat stops only after ownership settles', async () => {
  const order: string[] = [];
  const action = stopGeneralWorker({
    heartbeat: { draining: async () => { order.push('draining'); }, stopped: async () => { order.push('stopped'); } },
    supervisor: { stop: async () => { order.push('supervisor'); } },
    boss: { offWork: async () => { order.push('offWork'); }, stop: async () => { order.push('bossStop'); } },
    workers: [{ id: 'worker-1', queue: 'repair-baseline-v1' }],
    closeClients: async () => { order.push('clients'); },
    deadlineMs: 1_000,
  });
  await action;
  assert.ok(order.indexOf('offWork') < order.indexOf('bossStop'));
  assert.ok(order.indexOf('bossStop') < order.indexOf('stopped'));
  assert.ok(order.indexOf('clients') < order.indexOf('stopped'));
  assert.equal(order.filter((value) => value === 'clients').length, 1);
});

test('failed business-client close leaves execution non-terminal', async () => {
  const states: Array<string | undefined> = [];
  await assert.rejects(stopGeneralWorker({
    heartbeat: { draining: async () => {}, stopped: async (failureCode) => { states.push(failureCode); } },
    supervisor: { stop: async () => {} },
    boss: { offWork: async () => {}, stop: async () => {} },
    workers: [{ id: 'worker-1', queue: 'repair-baseline-v1' }],
    closeClients: async () => { throw new Error('controlled database close failure'); },
    deadlineMs: 1_000,
  }), (error: unknown) => error instanceof GeneralWorkerShutdownError);
  assert.deepEqual(states, []);
});

test('reporter close failure follows settled execution and fails process shutdown', async () => {
  const order: string[] = [];
  await assert.rejects(stopGeneralWorker({
    heartbeat: { draining: async () => {}, stopped: async () => { order.push('execution_stopped'); } },
    supervisor: { stop: async () => { order.push('supervisor_stopped'); } },
    boss: { offWork: async () => { order.push('consumer_stopped'); }, stop: async () => { order.push('boss_stopped'); } },
    workers: [{ id: 'worker-1', queue: 'repair-baseline-v1' }],
    closeClients: async () => { order.push('work_client_closed'); },
    closeHeartbeatClient: async () => { order.push('reporter_close_failed'); throw new Error('controlled reporter failure'); },
    deadlineMs: 1_000,
  }), (error: unknown) => error instanceof GeneralWorkerShutdownError);
  assert.deepEqual(order, ['supervisor_stopped', 'consumer_stopped', 'boss_stopped', 'work_client_closed', 'execution_stopped', 'reporter_close_failed']);
});

test('hanging reporter close is bounded after execution settles', async () => {
  const states: string[] = [];
  const started = Date.now();
  await assert.rejects(stopGeneralWorker({
    heartbeat: { draining: async () => {}, stopped: async () => { states.push('execution_stopped'); } },
    boss: { offWork: async () => {}, stop: async () => {} },
    workers: [],
    closeClients: async () => {},
    closeHeartbeatClient: async () => new Promise<void>(() => {}),
    deadlineMs: 30,
  }), (error: unknown) => error instanceof GeneralWorkerShutdownError);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(states, ['execution_stopped']);
});

test('production-like subprocess exits non-successfully on SIGTERM with a hung handler', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'auth-test/fixtures/general-worker-shutdown.mjs'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH },
  });
  let output = '';
  let signalled = false;
  const result = new Promise<number | null>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hung_worker_subprocess_timeout')); }, 5_000);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (!signalled && output.includes('ready\n')) { signalled = true; child.kill('SIGTERM'); }
    });
    child.stderr!.resume();
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => { clearTimeout(deadline); resolve(code); });
  });
  assert.equal(await result, 1);
  assert.match(output, /draining/);
  assert.doesNotMatch(output, /stopped|boss_stopped|clients_closed/);
});
