'use client';

import { useEffect, useState } from 'react';

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
const label = (value: string | null) => value ? value.replaceAll('_', ' ') : 'Pending';
const artifactLabel = (value: CandidateVerificationSummary['artifactIntegrity']) => value === 'valid' ? 'Passed' : value === 'invalid' ? 'Failed' : 'Pending';
const checksLabel = (value: CandidateVerificationSummary['regressionChecks']) => value === 'checks_passed' ? 'Passed' : value === 'checks_failed' ? 'Failed' : label(value);

export function CandidateVerificationStatus({ initialVerification }: { initialVerification: CandidateVerificationSummary }) {
  const [verification, setVerification] = useState(initialVerification);
  useEffect(() => {
    if (!active.has(verification.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/candidate-verifications/${encodeURIComponent(verification.id)}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json() as { candidateVerification?: CandidateVerificationSummary };
        if (body.candidateVerification?.id === verification.id) setVerification(body.candidateVerification);
      } catch {
        // PostgreSQL remains authoritative; a later poll can recover the view.
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [verification.id, verification.state]);

  return (
    <section className="repository-panel" aria-labelledby="candidate-verification-title">
      <p className="eyebrow">Fresh sandbox evidence</p>
      <h3 id="candidate-verification-title">Candidate verification</h3>
      <dl>
        <div><dt>Status</dt><dd>{label(verification.state)}</dd></div>
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
      {verification.failureCode && <div className="repository-notice" role="status">Verification stopped safely: {verification.failureCode}</div>}
      {!active.has(verification.state) && (
        <form action="/api/candidate-verifications" method="post">
          <input type="hidden" name="candidateId" value={verification.candidateId} />
          <input type="hidden" name="intent" value="reverify" />
          <button className="secondary-action" type="submit">Verify candidate again</button>
        </form>
      )}
    </section>
  );
}
