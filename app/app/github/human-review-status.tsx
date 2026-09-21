import type { HumanReviewResult } from '../../../lib/human-reviews/types.ts';

const ineligibleMessages: Record<string, string> = {
  repair_loop_not_verified: 'No terminal verified Repair Loop artifact is available for approval.',
  objective_not_measured: 'The technical objective was not measured and cannot be approved.',
  candidate_invalid: 'The frozen candidate failed its deterministic identity self-check.',
  verification_not_passed: 'The exact selected verification did not pass the required checks.',
  evidence_invalid: 'The selected verification evidence is incomplete, untrusted, or inconsistent.',
  authority_mismatch: 'The selected artifacts do not share one exact authority chain.',
  active_conflict: 'Another candidate generation or verification is still active for this Repair Run.',
};

const label = (value: string) => value.replaceAll('_', ' ');
const phase = (value: { status: string | null; exitCode: number | null; timedOut: boolean | null }) =>
  `${value.status ?? 'not configured'}${value.exitCode === null ? '' : ` (exit ${value.exitCode})`}${value.timedOut ? ' · timed out' : ''}`;

function DecisionForm({
  decision,
  idempotencyKey,
  repairRunId,
  reviewSubjectIdentity,
}: {
  decision: 'approved' | 'rejected';
  idempotencyKey: string;
  repairRunId: string;
  reviewSubjectIdentity: string;
}) {
  return (
    <form action={`/api/repair-runs/${encodeURIComponent(repairRunId)}/human-review-decisions`} method="post">
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="reviewSubjectIdentity" value={reviewSubjectIdentity} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <button className={decision === 'approved' ? 'primary-action' : 'secondary-action'} type="submit">
        Confirm {decision === 'approved' ? 'approval' : 'rejection'} of this exact candidate
      </button>
    </form>
  );
}

export function HumanReviewStatus({ review, idempotencyKey }: { review: HumanReviewResult; idempotencyKey: string }) {
  const subject = review.subject;
  return (
    <section className="repository-panel" aria-labelledby="human-review-title">
      <p className="eyebrow">Immutable human authority</p>
      <h3 id="human-review-title">Human Review &amp; Approval</h3>
      <dl>
        <div><dt>Candidate</dt><dd>{subject ? 'Candidate frozen' : 'Unavailable'}</dd></div>
        <div><dt>Verification</dt><dd>{subject ? 'Verification passed' : 'Not eligible'}</dd></div>
        <div><dt>Technical objective</dt><dd>{subject ? 'Technical objective satisfied' : 'Not established'}</dd></div>
        <div><dt>Human decision</dt><dd>{review.decision ? label(review.decision.decision) : review.status === 'awaiting_decision' ? 'Awaiting' : 'Not eligible'}</dd></div>
        <div><dt>Task 4.3 live acceptance</dt><dd>Pending</dd></div>
      </dl>

      {review.status === 'ineligible' && (
        <div className="repository-notice" role="status">
          {ineligibleMessages[review.ineligibleReason ?? ''] ?? 'This Repair Run is not eligible for human approval.'}
        </div>
      )}

      {subject && (
        <>
          <dl>
            <div><dt>Base revision</dt><dd><code>{subject.authority.baseCommitSha}</code></dd></div>
            <div><dt>Profile identity</dt><dd><code>{subject.authority.profileIdentity}</code></dd></div>
            <div><dt>Candidate identity</dt><dd><code>{subject.candidate.identity}</code></dd></div>
            <div><dt>Verification</dt><dd><code>{subject.verification.id}</code></dd></div>
            <div><dt>Evidence</dt><dd><code>{subject.verification.evidenceId}</code></dd></div>
            <div><dt>Review subject identity</dt><dd><code>{review.reviewSubjectIdentity}</code></dd></div>
            <div><dt>Objective contract identity</dt><dd><code>{subject.objective.contractHash}</code></dd></div>
            <div><dt>Objective evidence identity</dt><dd><code>{subject.objective.evidenceHash}</code></dd></div>
            <div><dt>Objective checks</dt><dd>{subject.objective.evaluatedChecks.map(label).join(', ')}</dd></div>
            <div><dt>Install result</dt><dd>{phase(subject.verification.phases.install)}</dd></div>
            <div><dt>Typecheck result</dt><dd>{phase(subject.verification.phases.typecheck)}</dd></div>
            <div><dt>Build result</dt><dd>{phase(subject.verification.phases.build)}</dd></div>
            <div><dt>Test result</dt><dd>{phase(subject.verification.phases.test)}</dd></div>
            <div><dt>Network isolation</dt><dd>{subject.verification.networkIsolation}</dd></div>
            <div><dt>Cleanup</dt><dd>{subject.verification.cleanup}</dd></div>
          </dl>
          <h4>Exact frozen candidate files</h4>
          {subject.candidate.files.map((file) => (
            <details key={file.path}>
              <summary><code>{file.path}</code> · {file.operation}</summary>
              <dl>
                <div><dt>Result SHA-256</dt><dd>{file.resultContentSha256 ? <code>{file.resultContentSha256}</code> : 'Deleted'}</dd></div>
                <div><dt>Result bytes</dt><dd>{file.resultByteLength}</dd></div>
                {file.baseBlobSha && <div><dt>Base blob</dt><dd><code>{file.baseBlobSha}</code></dd></div>}
                {file.baseContentSha256 && <div><dt>Base content SHA-256</dt><dd><code>{file.baseContentSha256}</code></dd></div>}
                {!file.baseBlobSha && <div><dt>Original base</dt><dd>Path absent at the frozen base revision.</dd></div>}
              </dl>
              {file.resultingContent !== null ? <pre><code>{file.resultingContent}</code></pre> : <p>File deleted.</p>}
            </details>
          ))}
          <h4>Attempt history</h4>
          <ol>
            {review.history.items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                {label(item.kind)} {item.ordinal}: {label(item.state)}{item.failureCode ? ` (${item.failureCode})` : ''} · {item.createdAt.toISOString()}
              </li>
            ))}
          </ol>
          {review.history.truncated && <p>History display is truncated; the durable audit records remain authoritative.</p>}
        </>
      )}

      {review.status === 'awaiting_decision' && review.reviewSubjectIdentity && (
        <details>
          <summary>Review decision controls</summary>
          <p>Confirm only after reviewing the exact immutable candidate and selected verification evidence above. Approval does not publish, create a pull request, or perform a GitHub write.</p>
          <DecisionForm decision="approved" idempotencyKey={idempotencyKey} repairRunId={review.repairRunId} reviewSubjectIdentity={review.reviewSubjectIdentity} />
          <DecisionForm decision="rejected" idempotencyKey={idempotencyKey} repairRunId={review.repairRunId} reviewSubjectIdentity={review.reviewSubjectIdentity} />
        </details>
      )}

      {review.decision && (
        <div className="repository-notice" role="status">
          Immutable decision: {review.decision.decision}. Reviewer <code>{review.decision.reviewerUserId}</code>. Decision identity <code>{review.decision.decisionIdentity}</code>.
        </div>
      )}
      <p>Task 4.3 live acceptance remains pending and is an independent prerequisite for any future release operation.</p>
    </section>
  );
}
