import { createHash } from 'node:crypto';

export const REPAIR_OBJECTIVE_MAX_CHARACTERS = 3_000;
export const REPAIR_OBJECTIVE_MAX_BYTES = 3_072;

export class RepairIntentValidationError extends Error {
  constructor(public readonly code: 'repair_objective_invalid') {
    super(code);
    this.name = 'RepairIntentValidationError';
  }
}

export function normalizeRepairObjective(value: unknown): { objective: string; objectiveHash: string } {
  if (typeof value !== 'string') throw new RepairIntentValidationError('repair_objective_invalid');
  const objective = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC').trim();
  if (!objective || objective.length > REPAIR_OBJECTIVE_MAX_CHARACTERS || Buffer.byteLength(objective, 'utf8') > REPAIR_OBJECTIVE_MAX_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(objective)) {
    throw new RepairIntentValidationError('repair_objective_invalid');
  }
  return { objective, objectiveHash: createHash('sha256').update(objective).digest('hex') };
}
