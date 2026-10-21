import { createHash } from 'node:crypto';

import { inArray } from 'drizzle-orm';

import { externalExecutionEvent, externalExecutionReservation } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';

/** Stable within one AI attempt, distinct across attempts and model turns. */
export function modelRequestKey(attemptId: string, turn: number): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId) ||
      !Number.isSafeInteger(turn) || turn < 1 || turn > 8) throw new Error('model_request_identity_invalid');
  const hex = createHash('sha256').update(`vigilo-ai-request-v1:${attemptId}:${turn}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A prior on-wire result cannot be replayed from a fresh stateless model session. */
export async function priorModelTransportUnresolved(database: VigiloDatabase, attemptIds: readonly string[]): Promise<boolean> {
  if (attemptIds.length === 0) return false;
  const keys = attemptIds.flatMap((id) => Array.from({ length: 8 }, (_, index) => modelRequestKey(id, index + 1)));
  const reservations = await database.select({ id: externalExecutionReservation.id }).from(externalExecutionReservation)
    .where(inArray(externalExecutionReservation.operationKey, keys));
  if (reservations.length === 0) return false;
  const events = await database.select({ reservationId: externalExecutionEvent.reservationId,
    eventType: externalExecutionEvent.eventType, attemptOrdinal: externalExecutionEvent.attemptOrdinal })
    .from(externalExecutionEvent).where(inArray(externalExecutionEvent.reservationId, reservations.map((row) => row.id)));
  return events.some((event) => event.eventType === 'attempt_succeeded' || event.eventType === 'attempt_ambiguous' ||
    (event.eventType === 'attempt_started' && !events.some((outcome) => outcome.reservationId === event.reservationId &&
      outcome.attemptOrdinal === event.attemptOrdinal && outcome.eventType === 'attempt_failed')));
}
