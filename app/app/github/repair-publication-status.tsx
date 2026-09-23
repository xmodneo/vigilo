import type { HumanReviewResult } from '../../../lib/human-reviews/types.ts';
import type { RepairPublicationResult } from '../../../lib/repair-publications/types.ts';

type Event = { id: string; eventType: string; checkpoint: string; toState: string; failureCode: string | null; createdAt: Date };

export function RepairPublicationStatus({ review, publication, events, idempotencyKey }: { review: HumanReviewResult; publication: RepairPublicationResult | null; events: Event[]; idempotencyKey: string }) {
  const approved = review.decision?.decision === 'approved';
  const gateOpen = publicationGateOpen(review.liveAcceptanceStatus);
  return (
    <section className="repository-panel" aria-labelledby="repair-publication-title">
      <p className="eyebrow">External publication authority</p>
      <h3 id="repair-publication-title">Draft pull request publication</h3>
      <dl>
        <div><dt>Human approval</dt><dd>{approved ? 'Approved' : 'Not approved'}</dd></div>
        <div><dt>Task 4.3 live acceptance</dt><dd>{publicationAcceptanceLabel(review.liveAcceptanceStatus)}</dd></div>
        <div><dt>Publication</dt><dd>{publication?.state ?? 'Not started'}</dd></div>
        {publication && <div><dt>Checkpoint</dt><dd>{publication.checkpoint}</dd></div>}
      </dl>
      {!gateOpen && <div className="repository-notice" role="status">Publication unavailable: Task 4.3 live acceptance is not passed. Human approval does not open this independent release gate.</div>}
      {publication?.failureCode && <div className="repository-notice" role="alert">Safe publication outcome: {publication.failureCode.replaceAll('_', ' ')}</div>}
      {publication?.pullRequest && <p><a className="primary-action button-link" href={publication.pullRequest.url} rel="noreferrer">Open exact draft pull request</a></p>}
      {publication && events.length > 0 && <details><summary>Publication history</summary><ol>{events.map((event) => <li key={event.id}>{event.eventType.replaceAll('_', ' ')} · {event.checkpoint.replaceAll('_', ' ')} · {event.toState.replaceAll('_', ' ')}{event.failureCode ? ` (${event.failureCode})` : ''}</li>)}</ol></details>}
      {approved && !publication && review.decision && (
        <details>
          <summary>Publish Draft confirmation</summary>
          <p>This separate action would create one Vigilo-owned branch and one draft pull request for the exact approved candidate. It cannot merge or deploy.</p>
          <form action={`/api/repair-runs/${encodeURIComponent(review.repairRunId)}/publications`} method="post">
            <input type="hidden" name="confirmation" value="publish_draft" />
            <input type="hidden" name="decisionIdentity" value={review.decision.decisionIdentity} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <button className="primary-action" type="submit" disabled={!gateOpen}>Publish exact candidate as draft PR</button>
          </form>
        </details>
      )}
      <p>No merge, deployment, ready-for-review, or branch-deletion operation is available.</p>
    </section>
  );
}

export function publicationAcceptanceLabel(status: unknown): string {
  if (status === 'passed') return 'Passed';
  if (status === 'pending') return 'Pending';
  if (status === 'revoked') return 'Revoked';
  if (status === 'failed') return 'Failed';
  return 'Unavailable';
}

export function publicationGateOpen(status: unknown): boolean {
  return status === 'passed';
}
