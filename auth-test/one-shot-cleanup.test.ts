import assert from 'node:assert/strict';
import test from 'node:test';

import { closeOneShotBusinessClientAndStopHeartbeat } from '../lib/operations/one-shot-cleanup.ts';

test('one-shot business-client close failure leaves execution non-terminal', async () => {
  const states: Array<string | undefined> = [];
  const failures = await closeOneShotBusinessClientAndStopHeartbeat(
    async () => { throw new Error('controlled database close failure'); },
    async (failureCode) => { states.push(failureCode); }, false, true,
  );
  assert.deepEqual(failures, ['database_client_close']);
  assert.deepEqual(states, []);
});

test('unresolved pg-boss ownership prevents one-shot terminal heartbeat', async () => {
  const states: Array<string | undefined> = [];
  const failures = await closeOneShotBusinessClientAndStopHeartbeat(
    async () => {}, async (failureCode) => { states.push(failureCode); }, true, false,
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(states, []);
});

test('one-shot heartbeat is clean only after successful business-client close', async () => {
  const order: string[] = [];
  const failures = await closeOneShotBusinessClientAndStopHeartbeat(
    async () => { order.push('client_closed'); },
    async (failureCode) => { assert.equal(failureCode, undefined); order.push('heartbeat_stopped'); }, false, true,
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(order, ['client_closed', 'heartbeat_stopped']);
});
