'use client';

import { presentError, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { DurableLiveMessage, useDurablePolling } from './durable-polling.tsx';

export interface RepairLoopSummary {
  id: string;
  repairRunId: string;
  investigationId: string;
  state: 'queued' | 'running' | 'verified' | 'abstained' | 'review_required' | 'failed' | 'limit_reached';
  maxIterations: 2;
  selectedCandidateId: string | null;
  selectedVerificationId: string | null;
  selectedEvidenceId: string | null;
  failureClassification: string | null;
  failureCode: string | null;
  iterations: Array<{
    id: string; ordinal: number; aiCandidateGenerationId: string; candidateVerificationId: string | null;
    objectiveContractVersion: 'baseline_recovery_v1'; objectiveMeasurable: boolean;
    objectiveEvidence: 'satisfied' | 'failed' | 'not_measured' | null;
    decision: string | null; failureCode: string | null;
  }>;
}

const active = new Set(['queued', 'running']);
const label = (value: string | null) => value ? `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('_', ' ')}` : 'Pending';

export function RepairLoopStatus({ initialLoop }: { initialLoop: RepairLoopSummary }) {
  const { value: loop, liveMessage } = useDurablePolling({
    initialValue: initialLoop,
    isActive: (state) => active.has(state),
    resourceKey: 'repairLoop',
    endpoint: (id) => `/api/repair-loops/${encodeURIComponent(id)}`,
  });
  const status = active.has(loop.state) ? 'generating_repair'
    : loop.state === 'verified' ? 'verified_ready_for_review'
      : loop.state === 'review_required' ? 'review_required'
        : loop.state === 'abstained' ? 'no_repair_proposed'
          : loop.state === 'limit_reached' ? 'attempt_limit_reached' : 'operational_failure';
  const presentation = presentWorkflowStatus(status);
  return (
    <section className="repository-panel" aria-labelledby="repair-loop-title" aria-busy={active.has(loop.state)}>
      <p className="eyebrow">Deterministic bounded orchestration</p>
      <h3 id="repair-loop-title">Repair Loop</h3>
      <dl>
        <div><dt>Status</dt><dd>{presentation.label}</dd></div>
        <div><dt>Iteration</dt><dd>{Math.max(1, loop.iterations.length)} / {loop.maxIterations}</dd></div>
        <div><dt>Technical objective</dt><dd>Baseline recovery v1</dd></div>
      </dl>
      <p>{presentation.explanation}</p>
      <DurableLiveMessage message={liveMessage} />
      {loop.iterations.map((iteration) => <div key={iteration.id} className="repository-notice">
        Iteration {iteration.ordinal}: generation <code>{iteration.aiCandidateGenerationId.slice(0, 12)}</code>; verification {iteration.candidateVerificationId ? <code>{iteration.candidateVerificationId.slice(0, 12)}</code> : 'pending'}; objective {label(iteration.objectiveEvidence)}; decision {label(iteration.decision)}.
      </div>)}
      {loop.selectedCandidateId && <p>Selected candidate: <code>{loop.selectedCandidateId.slice(0, 12)}</code></p>}
      {loop.failureCode && <div className="repository-notice" role="alert">{presentError(loop.failureCode).message}</div>}
      {loop.state === 'review_required' && <div className="repository-notice" role="status">The frozen baseline did not provide a measurable failing check. The technical objective is unmeasured, so this result is not eligible for human approval.</div>}
      {loop.state === 'limit_reached' && <div className="repository-notice" role="status">The two-iteration limit was reached.</div>}
    </section>
  );
}
