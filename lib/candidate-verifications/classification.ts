import type { BaselineComparison, VerificationContract, VerificationExecutionOutcome } from './types.ts';

const CUSTOMER_BASELINE_FAILURES = new Set(['baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed']);
const COMPARABLE_BASELINE_OUTCOMES = new Set(['baseline_passed', ...CUSTOMER_BASELINE_FAILURES]);

export function trustworthyComparableBaseline(value: {
  evidenceVersion: number;
  credentialsExposure: string;
  networkPolicy: string;
  installStatus: string;
  installExitCode: number | null;
  installTimedOut: boolean;
  executionOutcome: string;
  overallOutcome: string;
  cleanupStop: string;
  cleanupDelete: string;
  cleanupLookup: string;
}): boolean {
  return value.evidenceVersion === 1 && COMPARABLE_BASELINE_OUTCOMES.has(value.overallOutcome) &&
    value.executionOutcome === value.overallOutcome && value.credentialsExposure === 'absent' && value.networkPolicy === 'deny-all' &&
    value.installStatus === 'completed' && value.installExitCode === 0 && !value.installTimedOut &&
    value.cleanupStop === 'confirmed' && value.cleanupDelete === 'confirmed' && value.cleanupLookup === 'absent';
}

export function verificationContractFor(outcome: VerificationExecutionOutcome): VerificationContract {
  if (outcome === 'checks_passed') return 'checks_passed';
  if (['typecheck_failed', 'build_failed', 'test_failed'].includes(outcome)) return 'checks_failed';
  return 'infrastructure_failed';
}

export function compareWithBaseline(input: {
  baselineMatches: boolean;
  baselineOutcome: string;
  verificationContract: VerificationContract;
}): BaselineComparison {
  if (!input.baselineMatches || !['checks_passed', 'checks_failed'].includes(input.verificationContract)) return 'not_comparable';
  if (input.baselineOutcome === 'baseline_passed') {
    return input.verificationContract === 'checks_passed' ? 'no_regression_detected' : 'regression_detected';
  }
  if (CUSTOMER_BASELINE_FAILURES.has(input.baselineOutcome)) {
    return input.verificationContract === 'checks_passed'
      ? 'previous_baseline_failure_resolved'
      : 'previous_baseline_failure_still_present';
  }
  return 'not_comparable';
}
