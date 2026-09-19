'use client';

import { useEffect, useState } from 'react';

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
const label = (value: string | null) => value ? value.replaceAll('_', ' ') : 'Pending';

export function RepairLoopStatus({ initialLoop }: { initialLoop: RepairLoopSummary }) {
  const [loop, setLoop] = useState(initialLoop);
  useEffect(() => {
    if (!active.has(loop.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/repair-loops/${encodeURIComponent(loop.id)}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json() as { repairLoop?: RepairLoopSummary };
        if (body.repairLoop?.id === loop.id) setLoop(body.repairLoop);
      } catch { /* Durable loop state remains authoritative. */ }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [loop.id, loop.state]);
  return (
    <section className="repository-panel" aria-labelledby="repair-loop-title">
      <p className="eyebrow">Deterministic bounded orchestration</p>
      <h3 id="repair-loop-title">Repair Loop</h3>
      <dl>
        <div><dt>Status</dt><dd>{label(loop.state)}</dd></div>
        <div><dt>Iteration</dt><dd>{Math.max(1, loop.iterations.length)} / {loop.maxIterations}</dd></div>
        <div><dt>Technical objective</dt><dd>Baseline recovery v1</dd></div>
      </dl>
      {loop.iterations.map((iteration) => <div key={iteration.id} className="repository-notice">
        Iteration {iteration.ordinal}: generation <code>{iteration.aiCandidateGenerationId.slice(0, 12)}</code>; verification {iteration.candidateVerificationId ? <code>{iteration.candidateVerificationId.slice(0, 12)}</code> : 'pending'}; objective {label(iteration.objectiveEvidence)}; decision {label(iteration.decision)}.
      </div>)}
      {loop.selectedCandidateId && <p>Selected candidate: <code>{loop.selectedCandidateId.slice(0, 12)}</code></p>}
      {loop.failureCode && <div className="repository-notice" role="status">Loop stopped safely: {loop.failureCode}</div>}
      {loop.state === 'review_required' && <div className="repository-notice" role="status">The frozen baseline did not provide a measurable failing check. Human review is required.</div>}
      {loop.state === 'limit_reached' && <div className="repository-notice" role="status">The two-iteration limit was reached.</div>}
    </section>
  );
}
