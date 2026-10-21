import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { externalExecutionEvent, externalExecutionReservation } from '../db/schema.ts';
import { modelRequestKey, priorModelTransportUnresolved } from '../lib/ai-investigations/model-request-key.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';

function ledger(events: Array<{ reservationId: string; eventType: string; attemptOrdinal: number }>, operationKey: string): VigiloDatabase {
  const reservation = { id: 'reservation-1' };
  return { select: () => ({ from: (table: unknown) => ({ where: async () => table === externalExecutionReservation
    ? [{ ...reservation, operationKey }]
    : table === externalExecutionEvent ? events : [] }) }) } as unknown as VigiloDatabase;
}

test('model request identity is stable per attempt and turn without colliding across turns', () => {
  const attempt = randomUUID();
  assert.equal(modelRequestKey(attempt, 1), modelRequestKey(attempt, 1));
  assert.notEqual(modelRequestKey(attempt, 1), modelRequestKey(attempt, 2));
  assert.notEqual(modelRequestKey(attempt, 1), modelRequestKey(randomUUID(), 1));
  assert.throws(() => modelRequestKey(attempt, 9), /model_request_identity_invalid/);
});

test('reclaimed model attempt fails closed on durable successful, ambiguous, or unresolved transport', async () => {
  const attempt = randomUUID(); const key = modelRequestKey(attempt, 1);
  for (const eventType of ['attempt_succeeded', 'attempt_ambiguous', 'attempt_started']) {
    assert.equal(await priorModelTransportUnresolved(ledger([
      { reservationId: 'reservation-1', eventType, attemptOrdinal: 1 },
    ], key), [attempt]), true);
  }
  assert.equal(await priorModelTransportUnresolved(ledger([
    { reservationId: 'reservation-1', eventType: 'attempt_started', attemptOrdinal: 1 },
    { reservationId: 'reservation-1', eventType: 'attempt_failed', attemptOrdinal: 1 },
  ], key), [attempt]), false);
});
