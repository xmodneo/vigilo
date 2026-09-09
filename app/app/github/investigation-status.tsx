'use client';

import { useEffect, useState } from 'react';

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

function statusLabel(state: InvestigationSummary['state']): string {
  if (state === 'created') return 'Waiting for worker';
  if (state === 'context_preparing') return 'Preparing bounded context';
  return state;
}

export function InvestigationStatus({ initialInvestigation }: { initialInvestigation: InvestigationSummary }) {
  const [investigation, setInvestigation] = useState(initialInvestigation);

  useEffect(() => {
    if (!activeStates.has(investigation.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/investigations/${encodeURIComponent(investigation.id)}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json() as { investigation?: InvestigationSummary };
        if (body.investigation?.id === investigation.id) setInvestigation(body.investigation);
      } catch {
        // Persisted state remains authoritative; a later poll may succeed.
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [investigation.id, investigation.state]);

  return (
    <section className="repository-panel" aria-labelledby="investigation-title">
      <p className="eyebrow">Bounded repository context</p>
      <h3 id="investigation-title">Investigation</h3>
      <dl>
        <div><dt>Status</dt><dd>{statusLabel(investigation.state)}</dd></div>
        <div><dt>Revision</dt><dd><code>{investigation.revision.slice(0, 12)}</code></dd></div>
        <div><dt>Paths indexed</dt><dd>{investigation.indexedPathCount}</dd></div>
        <div><dt>Baseline evidence</dt><dd>{investigation.baselineAvailable ? 'Available' : 'Unavailable'}</dd></div>
        <div><dt>Context budget</dt><dd>{investigation.contextBudget.maxCumulativeBytes.toLocaleString()} bytes across {investigation.contextBudget.maxOperations} operations</dd></div>
      </dl>
      {investigation.treeTruncated && <p className="workspace-next">The repository tree exceeded the bounded context index.</p>}
      {investigation.failureCode && <div className="repository-notice" role="status">Context preparation failed safely: {investigation.failureCode}</div>}
    </section>
  );
}
