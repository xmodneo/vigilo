'use client';

import { useEffect, useState } from 'react';

export interface RepairRunSummary {
  id: string;
  state: 'created' | 'baseline_running' | 'ready_for_investigation' | 'baseline_failed' | 'infrastructure_failed' | 'cancelled';
  repositoryId: number;
  revision: string;
  profileIdentity: string;
  baseline: { evidenceId: string; outcome: string | null } | null;
  failure: { classification: string; code: string | null } | null;
  repairObjective?: string | null;
  createdAt: string;
  baselineStartedAt: string | null;
  completedAt: string | null;
  stateChangedAt: string;
}

const activeStates = new Set<RepairRunSummary['state']>(['created', 'baseline_running']);

function statusLabel(run: RepairRunSummary): string {
  if (run.state === 'created') return 'Waiting for worker';
  if (run.state === 'baseline_running') return 'Running baseline';
  return run.state.replaceAll('_', ' ');
}

export function RepairRunStatus({ initialRun }: { initialRun: RepairRunSummary }) {
  const [run, setRun] = useState(initialRun);

  useEffect(() => {
    if (!activeStates.has(run.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/repair-runs/${encodeURIComponent(run.id)}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json() as { repairRun?: RepairRunSummary };
        if (body.repairRun?.id === run.id) setRun(body.repairRun);
      } catch {
        // Persisted state remains authoritative; a later poll may succeed.
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [run.id, run.state]);

  return (
    <section className="repository-panel" aria-labelledby="repair-run-title">
      <p className="eyebrow">Durable workflow</p>
      <h3 id="repair-run-title">Repair Run</h3>
      <dl>
        <div><dt>Run</dt><dd><code>{run.id}</code></dd></div>
        <div><dt>Repair objective</dt><dd>{run.repairObjective ?? 'Unavailable for historical run'}</dd></div>
        <div><dt>Revision</dt><dd><code>{run.revision.slice(0, 12)}</code></dd></div>
        <div><dt>Baseline</dt><dd>{run.baseline?.outcome === 'baseline_passed' ? 'Passed' : run.baseline ? 'Failed' : 'Pending'}</dd></div>
        <div><dt>Status</dt><dd>{statusLabel(run)}</dd></div>
      </dl>
      {run.state === 'created' && (
        <form action={`/api/repair-runs/${encodeURIComponent(run.id)}/cancel`} method="post">
          <button className="secondary-action" type="submit">Cancel queued run</button>
        </form>
      )}
    </section>
  );
}
