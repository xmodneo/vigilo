'use client';

import { PendingSubmitButton } from '../pending-submit-button.tsx';
import { presentError, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { DurableLiveMessage, useDurablePolling } from './durable-polling.tsx';

export interface CandidateVerificationSummary {
  id: string;
  candidateId: string;
  state: 'created' | 'queued' | 'verifying' | 'completed' | 'infrastructure_failed' | 'cancelled';
  revision: string;
  candidateIdentity: string;
  artifactIntegrity: 'valid' | 'invalid' | null;
  regressionChecks: 'checks_passed' | 'checks_failed' | 'infrastructure_failed' | null;
  baselineComparison: 'no_regression_detected' | 'regression_detected' | 'previous_baseline_failure_resolved' | 'previous_baseline_failure_still_present' | 'not_comparable' | null;
  repairObjectiveEvidence: 'not_measured';
  executionOutcome: 'checks_passed' | 'typecheck_failed' | 'build_failed' | 'test_failed' | 'installation_failed' | 'timed_out' | 'cancelled' | 'infrastructure_failed' | 'cleanup_failed' | 'artifact_invalid' | null;
  failingPhase: 'typecheck' | 'build' | 'test' | null;
  networkIsolation: 'confirmed' | 'unconfirmed';
  cleanup: 'confirmed' | 'unconfirmed';
  evidenceId: string | null;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

const active = new Set<CandidateVerificationSummary['state']>(['created', 'queued', 'verifying']);
const reverifiable = new Set<CandidateVerificationSummary['state']>(['completed', 'infrastructure_failed', 'cancelled']);
const label = (value: string | null) => value ? `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('_', ' ')}` : 'Pending';
const artifactLabel = (value: CandidateVerificationSummary['artifactIntegrity']) => value === 'valid' ? 'Passed' : value === 'invalid' ? 'Failed' : 'Pending';
const checksLabel = (value: CandidateVerificationSummary['regressionChecks']) => value === 'checks_passed' ? 'Passed' : value === 'checks_failed' ? 'Failed' : label(value);

export function CandidateVerificationStatus({ initialVerification, allowReverify = true }: { initialVerification: CandidateVerificationSummary; allowReverify?: boolean }) {
  const { value: verification, liveMessage } = useDurablePolling({
    initialValue: initialVerification,
    isActive: (state) => active.has(state),
    resourceKey: 'candidateVerification',
    endpoint: (id) => `/api/candidate-verifications/${encodeURIComponent(id)}`,
  });
  const status = active.has(verification.state) ? 'verifying'
    : verification.state === 'completed' && verification.regressionChecks === 'checks_passed' ? 'verification_passed'
      : verification.state === 'completed' ? 'repair_failed_verification' : 'operational_failure';
  const presentation = presentWorkflowStatus(status);

  return (
    <section className="repository-panel" aria-labelledby="candidate-verification-title" aria-busy={active.has(verification.state)}>
      <p className="eyebrow">Fresh sandbox evidence</p>
      <h3 id="candidate-verification-title">Candidate verification</h3>
      <dl>
        <div><dt>Status</dt><dd>{presentation.label}</dd></div>
        <div><dt>Artifact integrity</dt><dd>{artifactLabel(verification.artifactIntegrity)}</dd></div>
        <div><dt>Revision</dt><dd><code>{verification.revision.slice(0, 12)}</code></dd></div>
        <div><dt>Regression checks</dt><dd>{checksLabel(verification.regressionChecks)}</dd></div>
        <div><dt>Execution outcome</dt><dd>{label(verification.executionOutcome)}</dd></div>
        {verification.failingPhase && <div><dt>Failing phase</dt><dd>{verification.failingPhase === 'test' ? 'Tests' : label(verification.failingPhase)}</dd></div>}
        <div><dt>Baseline comparison</dt><dd>{label(verification.baselineComparison)}</dd></div>
        <div><dt>Repair objective proof</dt><dd>Not measured by frozen baseline contract</dd></div>
        <div><dt>Network isolation</dt><dd>{label(verification.networkIsolation)}</dd></div>
        <div><dt>Cleanup</dt><dd>{label(verification.cleanup)}</dd></div>
      </dl>
      <p>{presentation.explanation}</p>
      <DurableLiveMessage message={liveMessage} />
      {verification.failureCode && <div className="repository-notice" role="alert">{presentError(verification.failureCode).message}</div>}
      {allowReverify && reverifiable.has(verification.state) && (
        <form action="/api/candidate-verifications" method="post">
          <input type="hidden" name="candidateId" value={verification.candidateId} />
          <input type="hidden" name="intent" value="reverify" />
          <PendingSubmitButton className="secondary-action" pendingLabel="Starting verification…">Verify candidate again</PendingSubmitButton>
        </form>
      )}
    </section>
  );
}
