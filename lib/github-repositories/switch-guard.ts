import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import {
  aiCandidateGeneration,
  aiCandidateGenerationAttempt,
  aiInvestigation,
  aiInvestigationAttempt,
  candidateVerification,
  candidateVerificationAttempt,
  executionBudgetGrant,
  executionBudgetGrantRevocation,
  externalExecutionEvent,
  externalExecutionLease,
  externalExecutionReservation,
  investigation,
  repairLoop,
  repairPublication,
  repairPublicationAttempt,
  repairRun,
  repairRunAttempt,
} from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';

// Called only while the global external-execution and workspace locks are held.
// Parked ready_for_investigation runs and completed evidence are deliberately
// excluded: retaining them must not make repository switching impossible.
export async function hasRepositorySwitchConflict(
  database: VigiloDatabase,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  for (const [table, states] of [
    [repairRun, ['created', 'baseline_running']],
    [investigation, ['created', 'context_preparing']],
    [aiInvestigation, ['created', 'queued', 'investigating']],
    [aiCandidateGeneration, ['created', 'queued', 'generating']],
    [candidateVerification, ['created', 'queued', 'verifying']],
    [repairLoop, ['queued', 'running']],
    [repairPublication, ['queued', 'preparing', 'publishing']],
  ] as const) {
    const [active] = await database.select({ id: table.id }).from(table).where(and(
      eq(table.workspaceId, workspaceId), inArray(table.state, states),
    )).limit(1);
    if (active) return true;
  }

  const activeAttempts = [
    database.select({ id: repairRunAttempt.id }).from(repairRunAttempt)
      .innerJoin(repairRun, eq(repairRun.id, repairRunAttempt.repairRunId))
      .where(and(eq(repairRun.workspaceId, workspaceId), eq(repairRunAttempt.state, 'active'))).limit(1),
    database.select({ id: aiInvestigationAttempt.id }).from(aiInvestigationAttempt)
      .innerJoin(aiInvestigation, eq(aiInvestigation.id, aiInvestigationAttempt.aiInvestigationId))
      .where(and(eq(aiInvestigation.workspaceId, workspaceId), eq(aiInvestigationAttempt.state, 'active'))).limit(1),
    database.select({ id: aiCandidateGenerationAttempt.id }).from(aiCandidateGenerationAttempt)
      .innerJoin(aiCandidateGeneration, eq(aiCandidateGeneration.id, aiCandidateGenerationAttempt.generationId))
      .where(and(eq(aiCandidateGeneration.workspaceId, workspaceId), eq(aiCandidateGenerationAttempt.state, 'active'))).limit(1),
    database.select({ id: candidateVerificationAttempt.id }).from(candidateVerificationAttempt)
      .innerJoin(candidateVerification, eq(candidateVerification.id, candidateVerificationAttempt.verificationId))
      .where(and(eq(candidateVerification.workspaceId, workspaceId), eq(candidateVerificationAttempt.state, 'active'))).limit(1),
    database.select({ id: repairPublicationAttempt.id }).from(repairPublicationAttempt)
      .innerJoin(repairPublication, eq(repairPublication.id, repairPublicationAttempt.publicationId))
      .where(and(eq(repairPublication.workspaceId, workspaceId), eq(repairPublicationAttempt.state, 'active'))).limit(1),
  ];
  for (const query of activeAttempts) if ((await query).length) return true;

  const [grant] = await database.select({ id: executionBudgetGrant.id })
    .from(executionBudgetGrant)
    .leftJoin(executionBudgetGrantRevocation, eq(executionBudgetGrantRevocation.grantId, executionBudgetGrant.id))
    .where(and(
      eq(executionBudgetGrant.workspaceId, workspaceId),
      inArray(executionBudgetGrant.scope, ['operation', 'one_shot']),
      gt(executionBudgetGrant.expiresAt, now),
      isNull(executionBudgetGrantRevocation.id),
    )).limit(1);
  if (grant) return true;

  const [reservation] = await database.select({ id: externalExecutionReservation.id })
    .from(externalExecutionReservation)
    .leftJoin(externalExecutionLease, eq(externalExecutionLease.reservationId, externalExecutionReservation.id))
    .where(and(
      eq(externalExecutionReservation.workspaceId, workspaceId),
      sql`(${externalExecutionLease.reservationId} is null or ${externalExecutionLease.state} in ('active', 'ambiguous'))`,
    )).limit(1);
  if (reservation) return true;

  const [unfinishedAttempt] = await database.select({ id: externalExecutionEvent.id })
    .from(externalExecutionEvent)
    .innerJoin(externalExecutionReservation, eq(externalExecutionReservation.id, externalExecutionEvent.reservationId))
    .where(and(
      eq(externalExecutionReservation.workspaceId, workspaceId),
      eq(externalExecutionEvent.eventType, 'attempt_started'),
      sql`not exists (
        select 1 from external_execution_event outcome
        where outcome.reservation_id = ${externalExecutionEvent.reservationId}
          and outcome.attempt_ordinal = ${externalExecutionEvent.attemptOrdinal}
          and outcome.event_type in ('attempt_succeeded', 'attempt_failed', 'attempt_ambiguous')
      )`,
    )).limit(1);
  return Boolean(unfinishedAttempt);
}
