'use client';

import { presentError, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { DurableLiveMessage, useDurablePolling } from './durable-polling.tsx';

export interface InvestigationSummary {
  id: string;
  repairRunId: string;
  repairObjective: string;
  state: 'created' | 'context_preparing' | 'ready' | 'failed' | 'cancelled';
  revision: string;
  profileIdentity: string;
  baselineAvailable: boolean;
  treeSha: string | null;
  indexedPathCount: number;
  excludedPathCount: number;
  treeTruncated: boolean;
  contextBudget: { version: 1; maxTreeEntries: 2000; maxFileBytes: 65536; maxCumulativeBytes: 1048576; maxOperations: 50 };
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

const activeStates = new Set<InvestigationSummary['state']>(['created', 'context_preparing']);

export function InvestigationStatus({ initialInvestigation }: { initialInvestigation: InvestigationSummary }) {
  const { value: investigation, liveMessage } = useDurablePolling({
    initialValue: initialInvestigation,
    isActive: (state) => activeStates.has(state),
    resourceKey: 'investigation',
    endpoint: (id) => `/api/investigations/${encodeURIComponent(id)}`,
  });
  const presentation = presentWorkflowStatus(
    investigation.state === 'ready' ? 'context_ready'
      : activeStates.has(investigation.state) ? 'preparing_context'
        : 'operational_failure',
  );

  return (
    <section className="repository-panel" aria-labelledby="investigation-title" aria-busy={activeStates.has(investigation.state)}>
      <p className="eyebrow">Bounded repository context</p>
      <h3 id="investigation-title">Investigation</h3>
      <dl>
        <div><dt>Status</dt><dd>{presentation.label}</dd></div>
        <div><dt>Revision</dt><dd><code>{investigation.revision.slice(0, 12)}</code></dd></div>
        <div><dt>Paths indexed</dt><dd>{investigation.indexedPathCount}</dd></div>
        <div><dt>Baseline evidence</dt><dd>{investigation.baselineAvailable ? 'Available' : 'Unavailable'}</dd></div>
        <div><dt>Context budget</dt><dd>{investigation.contextBudget.maxCumulativeBytes.toLocaleString()} bytes across {investigation.contextBudget.maxOperations} operations</dd></div>
      </dl>
      <p>{presentation.explanation}</p>
      <DurableLiveMessage message={liveMessage} />
      {investigation.treeTruncated && <p className="workspace-next">The repository tree exceeded the bounded context index.</p>}
      {investigation.failureCode && <div className="repository-notice" role="alert">{presentError(investigation.failureCode).message}</div>}
    </section>
  );
}
