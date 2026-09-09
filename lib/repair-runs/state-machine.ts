import type { BaselineOutcome } from '../repository-baselines/types.ts';
import type { RepairRunState, RepairRunTerminalState } from './types.ts';

const ALLOWED_TRANSITIONS: Readonly<Record<RepairRunState, readonly RepairRunState[]>> = {
  created: ['baseline_running', 'cancelled'],
  baseline_running: ['ready_for_investigation', 'baseline_failed', 'infrastructure_failed', 'cancelled'],
  ready_for_investigation: [],
  baseline_failed: [],
  infrastructure_failed: [],
  cancelled: [],
};

export class RepairRunTransitionError extends Error {
  constructor(public readonly from: RepairRunState, public readonly to: RepairRunState) {
    super(`invalid_repair_run_transition:${from}:${to}`);
    this.name = 'RepairRunTransitionError';
  }
}

export function validateTransition(from: RepairRunState, to: RepairRunState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new RepairRunTransitionError(from, to);
  }
}

export function classifyBaselineOutcome(outcome: BaselineOutcome): RepairRunTerminalState {
  switch (outcome) {
    case 'baseline_passed':
    case 'baseline_failed':
    case 'typecheck_failed':
    case 'build_failed':
    case 'test_failed': return 'ready_for_investigation';
    case 'cancelled': return 'cancelled';
    case 'installation_failed':
    case 'timed_out':
    case 'infrastructure_failed':
    case 'cleanup_failed': return 'infrastructure_failed';
  }
}
