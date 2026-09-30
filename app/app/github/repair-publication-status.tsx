'use client';

import type { HumanReviewResult } from '../../../lib/human-reviews/types.ts';
import type { RepairPublicationResult } from '../../../lib/repair-publications/types.ts';
import { PendingSubmitButton } from '../pending-submit-button.tsx';
import { presentError, presentLiveAcceptanceStatus, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { DurableLiveMessage, useDurablePolling } from './durable-polling.tsx';

type Event = { id: string; eventType: string; checkpoint: string; toState: string; failureCode: string | null; createdAt: Date };
const activePublicationStates = new Set(['queued', 'preparing', 'publishing']);

function ExistingPublication({ publication, events }: { publication: RepairPublicationResult; events: Event[] }) {
  const { value, liveMessage } = useDurablePolling({
    initialValue: publication,
    isActive: (state) => activePublicationStates.has(state),
    resourceKey: 'publication',
    endpoint: () => `/api/repair-runs/${encodeURIComponent(publication.repairRunId)}/publications`,
  });
  const status = activePublicationStates.has(value.state) ? 'publishing'
    : value.state === 'published' ? 'published'
      : value.state === 'review_required' ? 'publication_reconciliation' : 'operational_failure';
  const presentation = presentWorkflowStatus(status);
  return <div aria-busy={activePublicationStates.has(value.state)}>
    <dl>
      <div><dt>Publication</dt><dd>{presentation.label}</dd></div>
    </dl>
    <p>{presentation.explanation}</p>
    <DurableLiveMessage message={liveMessage} />
    {value.failureCode && <div className="repository-notice" role="alert">{presentError(value.failureCode).message}</div>}
    {value.state === 'published' && value.pullRequest && <p><a className="primary-action button-link" href={value.pullRequest.url} rel="noreferrer">Open draft pull request</a></p>}
    {events.length > 0 && <details><summary>Technical publication history</summary><ol>{events.map((event) => <li key={event.id}>Recorded publication transition at {event.createdAt.toISOString()}</li>)}</ol></details>}
  </div>;
}

export function RepairPublicationStatus({ review, publication, events, idempotencyKey }: { review: HumanReviewResult; publication: RepairPublicationResult | null; events: Event[]; idempotencyKey: string }) {
  const approved = review.decision?.decision === 'approved';
  const gateOpen = publicationGateOpen(review.liveAcceptanceStatus);
  return (
    <section className="repository-panel" aria-labelledby="repair-publication-title">
      <p className="eyebrow">External publication authority</p>
      <h3 id="repair-publication-title">Draft pull request publication</h3>
      <dl>
        <div><dt>Human approval</dt><dd>{approved ? 'Approved' : 'Not approved'}</dd></div>
        <div><dt>Independent live acceptance</dt><dd>{publicationAcceptanceLabel(review.liveAcceptanceStatus)}</dd></div>
      </dl>
      {!gateOpen && <div className="repository-notice" role="status"><strong>Publication unavailable.</strong> {review.liveAcceptanceStatus === 'pending' ? 'Draft publication is unavailable while independent live acceptance remains pending.' : 'Draft publication is unavailable because independent live acceptance is not passed.'}</div>}
      {publication && <ExistingPublication publication={publication} events={events} />}
      {approved && gateOpen && !publication && review.decision && (
        <details>
          <summary>Ready to publish draft PR</summary>
          <p>This separate action would create one Vigilo-owned branch and one draft pull request for the exact approved candidate. It cannot merge or deploy.</p>
          <form action={`/api/repair-runs/${encodeURIComponent(review.repairRunId)}/publications`} method="post">
            <input type="hidden" name="confirmation" value="publish_draft" />
            <input type="hidden" name="decisionIdentity" value={review.decision.decisionIdentity} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <PendingSubmitButton className="primary-action" pendingLabel="Publishing draft PR…">Publish exact candidate as draft PR</PendingSubmitButton>
          </form>
        </details>
      )}
      <p>Publication creates a draft pull request only. No merge, deployment, ready-for-review, or branch-deletion operation is available.</p>
    </section>
  );
}

export function publicationAcceptanceLabel(status: unknown): string {
  return presentLiveAcceptanceStatus(status);
}

export function publicationGateOpen(status: unknown): boolean {
  return status === 'passed';
}
