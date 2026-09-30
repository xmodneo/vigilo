'use client';

import { PendingSubmitButton } from '../pending-submit-button.tsx';
import { presentError, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { DurableLiveMessage, useDurablePolling } from './durable-polling.tsx';

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

function statusKey(run: RepairRunSummary) {
  if (run.state === 'created') return 'queued';
  if (run.state === 'baseline_running') return 'running_baseline';
  if (run.state === 'baseline_failed') return 'baseline_failed';
  if (run.state === 'ready_for_investigation') return 'ready_for_investigation';
  return 'baseline_unavailable';
}

export function RepairRunStatus({ initialRun }: { initialRun: RepairRunSummary }) {
  const { value: run, liveMessage } = useDurablePolling({
    initialValue: initialRun,
    isActive: (state) => activeStates.has(state),
    resourceKey: 'repairRun',
    endpoint: (id) => `/api/repair-runs/${encodeURIComponent(id)}`,
  });
  const presentation = presentWorkflowStatus(statusKey(run));

  return (
    <section className="repository-panel" aria-labelledby="repair-run-title" aria-busy={activeStates.has(run.state)}>
      <p className="eyebrow">Durable workflow</p>
      <h3 id="repair-run-title">Repair Run</h3>
      <dl>
        <div><dt>Run</dt><dd><code>{run.id}</code></dd></div>
        <div><dt>Repair objective</dt><dd>{run.repairObjective ?? 'Unavailable for historical run'}</dd></div>
        <div><dt>Revision</dt><dd><code>{run.revision.slice(0, 12)}</code></dd></div>
        <div><dt>Baseline</dt><dd>{run.baseline?.outcome === 'baseline_passed' ? 'Passed' : run.baseline ? 'Failed' : 'Pending'}</dd></div>
        <div><dt>Status</dt><dd>{presentation.label}</dd></div>
      </dl>
      <p>{presentation.explanation}</p>
      {run.failure?.code && <div className="repository-notice" role="alert">{presentError(run.failure.code).message}</div>}
      <DurableLiveMessage message={liveMessage} />
      {run.state === 'created' && (
        <form action={`/api/repair-runs/${encodeURIComponent(run.id)}/cancel`} method="post">
          <PendingSubmitButton className="secondary-action" pendingLabel="Cancelling…">Cancel queued run</PendingSubmitButton>
        </form>
      )}
    </section>
  );
}
