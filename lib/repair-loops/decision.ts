import type { RepairLoopObjectiveEvidence } from './objective-contract.ts';

export type RepairLoopState = 'queued' | 'running' | 'verified' | 'abstained' | 'review_required' | 'failed' | 'limit_reached';
export type RepairLoopIterationDecision = 'verified' | 'repairable_failure' | 'abstained' | 'generation_failed' | 'verification_non_repairable' | 'infrastructure_failed' | 'evidence_invalid';

export function decideRepairLoopOutcome(input: {
  iterationOrdinal: number;
  maxIterations: number;
  verificationDisposition: 'trustworthy' | 'integrity_failure' | 'infrastructure_failure';
  objectiveEvidence: RepairLoopObjectiveEvidence;
  regression: boolean;
}): { iterationDecision: RepairLoopIterationDecision; loopState: RepairLoopState; scheduleNext: boolean } {
  if (input.verificationDisposition === 'integrity_failure') return { iterationDecision: 'evidence_invalid', loopState: 'failed', scheduleNext: false };
  if (input.verificationDisposition === 'infrastructure_failure') return { iterationDecision: 'infrastructure_failed', loopState: 'failed', scheduleNext: false };
  if (input.objectiveEvidence === 'not_measured') return { iterationDecision: 'verification_non_repairable', loopState: 'review_required', scheduleNext: false };
  if (input.objectiveEvidence === 'satisfied' && !input.regression) return { iterationDecision: 'verified', loopState: 'verified', scheduleNext: false };
  const scheduleNext = input.iterationOrdinal < input.maxIterations;
  return { iterationDecision: 'repairable_failure', loopState: scheduleNext ? 'running' : 'limit_reached', scheduleNext };
}
