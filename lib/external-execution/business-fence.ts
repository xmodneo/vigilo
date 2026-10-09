import { and, eq, inArray } from 'drizzle-orm';

import { aiCandidateGeneration, aiInvestigation, externalExecutionEvent, externalExecutionLease, externalExecutionReservation, externalExecutionSemaphore } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { ExternalExecutionAuthorityError } from './types.ts';

// All admission/outcome transactions take this first. No network I/O belongs in
// this transaction. Grants (sorted by ID) precede lease locks in the authorizer.
export async function lockExternalExecution(database: VigiloDatabase): Promise<void> {
  const [row] = await database.select({ id: externalExecutionSemaphore.id }).from(externalExecutionSemaphore)
    .where(eq(externalExecutionSemaphore.id, 'global')).for('update').limit(1);
  if (!row) throw new ExternalExecutionAuthorityError('execution_authority_missing');
}

export async function assertRunBusinessAllowed(database: VigiloDatabase, scope: { workspaceId: string; repairRunId?: string | null }, now = new Date()): Promise<void> {
  if (!scope.repairRunId) return;
  const reservations = await database.select({ id: externalExecutionReservation.id }).from(externalExecutionReservation)
    .where(and(eq(externalExecutionReservation.workspaceId, scope.workspaceId), eq(externalExecutionReservation.repairRunId, scope.repairRunId)));
  const ids = reservations.map((row) => row.id);
  if (ids.length) {
    const leases = await database.select().from(externalExecutionLease).where(inArray(externalExecutionLease.reservationId, ids));
    const events = await database.select().from(externalExecutionEvent).where(inArray(externalExecutionEvent.reservationId, ids));
    const uncertain = leases.some((lease) => lease.state === 'ambiguous') || events.some((event) => event.eventType === 'attempt_ambiguous')
      || events.some((event) => event.eventType === 'attempt_started'
        && !events.some((outcome) => outcome.reservationId === event.reservationId && outcome.attemptOrdinal === event.attemptOrdinal
          && ['attempt_succeeded', 'attempt_failed', 'attempt_ambiguous'].includes(outcome.eventType))
        && !leases.some((lease) => lease.reservationId === event.reservationId && lease.state === 'active' && lease.leaseExpiresAt > now));
    if (uncertain) throw new ExternalExecutionAuthorityError('provider_attempt_ambiguous');
  }
  // A denied reservation has no reservation row. Preserve terminal exhaustion
  // from the immutable execution history rather than inventing another counter.
  for (const table of [aiInvestigation, aiCandidateGeneration]) {
    const [exhausted] = await database.select({ id: table.id }).from(table).where(and(
      eq(table.workspaceId, scope.workspaceId), eq(table.repairRunId, scope.repairRunId), eq(table.failureCode, 'execution_budget_exhausted'),
    )).limit(1);
    if (exhausted) throw new ExternalExecutionAuthorityError('execution_budget_exhausted');
  }
}
