import { canonicalRecord } from './canonical.ts';
import type { RepairLoopObjectiveEvidence } from './objective-contract.ts';

export const REPAIR_LOOP_FEEDBACK_VERSION = 1 as const;
export const REPAIR_LOOP_FEEDBACK_MAX_BYTES = 16 * 1024;

export interface RepairLoopFeedback {
  version: typeof REPAIR_LOOP_FEEDBACK_VERSION;
  provenance: {
    previousIterationId: string;
    generationId: string;
    candidateId: string;
    candidateIdentity: string;
    verificationId: string;
    evidenceId: string;
  };
  previousCandidate: {
    files: Array<{ path: string; operation: 'add' | 'modify' | 'delete' }>;
  };
  verification: {
    contract: string;
    baselineComparison: string;
    objectiveEvidence: RepairLoopObjectiveEvidence;
    phases: {
      install: { status: string; exitCode: number | null; timedOut: boolean };
      typecheck: { status: string | null; exitCode: number | null; timedOut: boolean | null };
      build: { status: string | null; exitCode: number | null; timedOut: boolean | null };
      test: { status: string; exitCode: number | null; timedOut: boolean };
    };
    safeFailure: { phase: string | null; code: string | null };
  };
  priorDiagnosis: { summary: string; proposedApproach: string; confidence: string };
  boundaries: {
    repositoryValues: 'UNTRUSTED_REPOSITORY_DATA';
    modelValues: 'UNTRUSTED_MODEL_DATA';
    completeReplacementAgainstOriginalBase: true;
  };
}

export function buildRepairLoopFeedback(input: RepairLoopFeedback): { snapshot: RepairLoopFeedback; canonical: string; hash: string; bytes: number } {
  const files = [...input.previousCandidate.files].sort((a, b) => a.path.localeCompare(b.path));
  if (files.length < 1 || files.length > 4 || files.some((file) => !['add', 'modify', 'delete'].includes(file.operation) || file.path.length < 1 || file.path.length > 240)) throw new Error('invalid_repair_loop_feedback');
  const value: RepairLoopFeedback = { ...input, previousCandidate: { files } };
  const canonical = canonicalRecord(value, REPAIR_LOOP_FEEDBACK_MAX_BYTES);
  return { snapshot: canonical.snapshot as RepairLoopFeedback, canonical: canonical.canonical, hash: canonical.hash, bytes: canonical.bytes };
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function phase(value: unknown, optionalStatus = false): boolean {
  if (!exact(value, ['status', 'exitCode', 'timedOut'])) return false;
  return (typeof value.status === 'string' || (optionalStatus && value.status === null)) &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    (typeof value.timedOut === 'boolean' || (optionalStatus && value.timedOut === null));
}

export function validateStoredRepairLoopFeedback(value: unknown, hash: string | null, bytes: number | null): RepairLoopFeedback {
  const canonical = canonicalRecord(value, REPAIR_LOOP_FEEDBACK_MAX_BYTES);
  if (canonical.hash !== hash || canonical.bytes !== bytes) throw new Error('repair_loop_feedback_invalid');
  const record = canonical.snapshot;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!exact(record, ['version', 'provenance', 'previousCandidate', 'verification', 'priorDiagnosis', 'boundaries']) || record.version !== 1 ||
      !exact(record.provenance, ['previousIterationId', 'generationId', 'candidateId', 'candidateIdentity', 'verificationId', 'evidenceId']) ||
      ![record.provenance.previousIterationId, record.provenance.generationId, record.provenance.candidateId, record.provenance.verificationId, record.provenance.evidenceId].every((item) => typeof item === 'string' && uuid.test(item)) || typeof record.provenance.candidateIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(record.provenance.candidateIdentity) ||
      !exact(record.previousCandidate, ['files']) || !Array.isArray(record.previousCandidate.files) || record.previousCandidate.files.length < 1 || record.previousCandidate.files.length > 4 || record.previousCandidate.files.some((file) => !exact(file, ['path', 'operation']) || typeof file.path !== 'string' || file.path.length < 1 || file.path.length > 240 || !['add', 'modify', 'delete'].includes(String(file.operation))) ||
      !exact(record.verification, ['contract', 'baselineComparison', 'objectiveEvidence', 'phases', 'safeFailure']) || typeof record.verification.contract !== 'string' || typeof record.verification.baselineComparison !== 'string' || !['satisfied', 'failed', 'not_measured'].includes(String(record.verification.objectiveEvidence)) ||
      !exact(record.verification.phases, ['install', 'typecheck', 'build', 'test']) || !phase(record.verification.phases.install) || !phase(record.verification.phases.typecheck, true) || !phase(record.verification.phases.build, true) || !phase(record.verification.phases.test) ||
      !exact(record.verification.safeFailure, ['phase', 'code']) || (record.verification.safeFailure.phase !== null && typeof record.verification.safeFailure.phase !== 'string') || (record.verification.safeFailure.code !== null && (typeof record.verification.safeFailure.code !== 'string' || !/^[a-z_]{1,64}$/.test(record.verification.safeFailure.code))) ||
      !exact(record.priorDiagnosis, ['summary', 'proposedApproach', 'confidence']) || typeof record.priorDiagnosis.summary !== 'string' || record.priorDiagnosis.summary.length < 1 || record.priorDiagnosis.summary.length > 1200 || typeof record.priorDiagnosis.proposedApproach !== 'string' || record.priorDiagnosis.proposedApproach.length < 1 || record.priorDiagnosis.proposedApproach.length > 1600 || !['low', 'medium', 'high'].includes(String(record.priorDiagnosis.confidence)) ||
      !exact(record.boundaries, ['repositoryValues', 'modelValues', 'completeReplacementAgainstOriginalBase']) || record.boundaries.repositoryValues !== 'UNTRUSTED_REPOSITORY_DATA' || record.boundaries.modelValues !== 'UNTRUSTED_MODEL_DATA' || record.boundaries.completeReplacementAgainstOriginalBase !== true) throw new Error('repair_loop_feedback_invalid');
  return record as unknown as RepairLoopFeedback;
}
