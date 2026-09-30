import type { HumanReviewResult } from '../../../lib/human-reviews/types.ts';
import { presentError, presentLiveAcceptanceStatus, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { PendingSubmitButton } from '../pending-submit-button.tsx';

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
      <PendingSubmitButton className={decision === 'approved' ? 'primary-action' : 'secondary-action'} pendingLabel={decision === 'approved' ? 'Submitting approval…' : 'Submitting rejection…'}>
        Confirm {decision === 'approved' ? 'approval' : 'rejection'} of this exact candidate
      </PendingSubmitButton>
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
        <div><dt>Human decision</dt><dd>{review.decision ? presentWorkflowStatus(review.decision.decision).label : review.status === 'awaiting_decision' ? 'Awaiting' : 'Not eligible'}</dd></div>
        <div><dt>Independent live acceptance</dt><dd>{presentLiveAcceptanceStatus(review.liveAcceptanceStatus)}</dd></div>
      </dl>

      {review.status === 'ineligible' && (
        <div className="repository-notice" role="status">
          {review.ineligibleReason ? presentError(review.ineligibleReason).message : presentError('human_review_ineligible').message}
        </div>
      )}

      {subject && (
        <>
          <section aria-labelledby="assessment-title">
            <h4 id="assessment-title">What Vigilo believes it fixed</h4>
            <p><strong>AI assessment, not proof.</strong></p>
            {subject.assessment ? <>
              <p>{subject.assessment.summary}</p>
              <p><strong>Proposed approach:</strong> {subject.assessment.proposedApproach}</p>
              <p><strong>Confidence:</strong> {subject.assessment.confidence}</p>
            </> : <p>The historical AI assessment is unavailable; rely on the measured evidence below.</p>}
          </section>
          <section aria-labelledby="candidate-files-title">
          <h4 id="candidate-files-title">What changed</h4>
          {subject.candidate.files.map((file) => (
            <details key={file.path}>
              <summary><code>{file.path}</code> · {file.operation === 'delete' ? 'delete file' : file.operation}</summary>
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
          </section>
          <section aria-labelledby="measured-evidence-title">
            <h4 id="measured-evidence-title">What was measured</h4>
            <dl>
              <div><dt>Baseline result</dt><dd>{subject.baseline ? label(subject.baseline.outcome) : 'Unavailable for this historical view'}</dd></div>
              <div><dt>Fresh install</dt><dd>{phase(subject.verification.phases.install)}</dd></div>
              <div><dt>Fresh typecheck</dt><dd>{phase(subject.verification.phases.typecheck)}</dd></div>
              <div><dt>Fresh build</dt><dd>{phase(subject.verification.phases.build)}</dd></div>
              <div><dt>Fresh tests</dt><dd>{phase(subject.verification.phases.test)}</dd></div>
              <div><dt>Measured objective</dt><dd>Technical objective satisfied</dd></div>
              <div><dt>Objective checks</dt><dd>{subject.objective.evaluatedChecks.map(label).join(', ')}</dd></div>
              <div><dt>Network isolation</dt><dd>{subject.verification.networkIsolation}</dd></div>
              <div><dt>Cleanup</dt><dd>{subject.verification.cleanup}</dd></div>
            </dl>
          </section>
        </>
      )}

      {subject && review.status === 'awaiting_decision' && review.reviewSubjectIdentity && (
        <details>
          <summary>Review decision controls</summary>
          <h4>Decision</h4>
          <p><strong>Approval is immutable.</strong> Approve this exact candidate and its selected verification evidence. Approval does not publish, merge, or deploy it.</p>
          <DecisionForm decision="approved" idempotencyKey={idempotencyKey} repairRunId={review.repairRunId} reviewSubjectIdentity={review.reviewSubjectIdentity} />
          <p><strong>Rejection is immutable.</strong> Rejection is permanent for this candidate. It does not delete historical evidence.</p>
          <DecisionForm decision="rejected" idempotencyKey={idempotencyKey} repairRunId={review.repairRunId} reviewSubjectIdentity={review.reviewSubjectIdentity} />
        </details>
      )}

      {subject && <details>
        <summary>Technical provenance and attempt history</summary>
        <dl>
          <div><dt>Base revision</dt><dd><code>{subject.authority.baseCommitSha}</code></dd></div>
          <div><dt>Profile identity</dt><dd><code>{subject.authority.profileIdentity}</code></dd></div>
          <div><dt>Candidate identity</dt><dd><code>{subject.candidate.identity}</code></dd></div>
          <div><dt>Verification</dt><dd><code>{subject.verification.id}</code></dd></div>
          <div><dt>Evidence</dt><dd><code>{subject.verification.evidenceId}</code></dd></div>
          <div><dt>Review subject identity</dt><dd><code>{review.reviewSubjectIdentity}</code></dd></div>
          <div><dt>Objective contract identity</dt><dd><code>{subject.objective.contractHash}</code></dd></div>
          <div><dt>Objective evidence identity</dt><dd><code>{subject.objective.evidenceHash}</code></dd></div>
        </dl>
        <ol>{review.history.items.map((item) => <li key={`${item.kind}:${item.id}`}>{label(item.kind)} {item.ordinal}: {label(item.state)} · {item.createdAt.toISOString()}</li>)}</ol>
        {review.history.truncated && <p>History display is truncated; the durable audit records remain authoritative.</p>}
      </details>}

      {review.decision && (
        <div className="repository-notice" role="status">
          Immutable decision: {review.decision.decision}. Reviewer <code>{review.decision.reviewerUserId}</code>. Decision identity <code>{review.decision.decisionIdentity}</code>.
        </div>
      )}
      <p>Independent Task 4.3 live acceptance remains pending and is a separate prerequisite for publication.</p>
    </section>
  );
}
