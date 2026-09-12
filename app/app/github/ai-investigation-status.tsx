'use client';

import { useEffect, useState } from 'react';

export interface AiInvestigationSummary {
  id: string;
  investigationId: string;
  executionOrdinal: number;
  state: 'created' | 'queued' | 'investigating' | 'completed' | 'failed' | 'cancelled';
  revision: string;
  provider: string;
  model: string;
  completionReason: 'model_conclusion' | 'budget_exhausted' | null;
  conclusion: null | { status: 'diagnosis_found' | 'insufficient_evidence' | 'objective_not_reproduced'; summary: string; suspectedFiles: Array<{ path: string; reason: string }>; evidence: Array<{ kind: 'baseline' | 'file' | 'search'; reference: string }>; proposedApproach: string; confidence: 'low' | 'medium' | 'high' };
  usage: { inputTokens: number; outputTokens: number; toolCallCount: number; modelTurnCount: number };
  failureCode: string | null;
}

const active = new Set(['created', 'queued', 'investigating']);
const labels: Record<string, string> = { created: 'Waiting', queued: 'Waiting', investigating: 'Investigating', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
const failureLabels: Record<string, string> = {
  provider_quota_exhausted: 'Provider quota exhausted',
  provider_rate_limited: 'Provider rate limit exhausted',
  provider_infrastructure_failed: 'Provider infrastructure failure',
  provider_configuration_failed: 'Provider configuration failure',
};

export function AiInvestigationStatus({ investigationId, initialAiInvestigation, startRequestId }: { investigationId: string; initialAiInvestigation: AiInvestigationSummary | null; startRequestId: string }) {
  const [value, setValue] = useState(initialAiInvestigation);
  useEffect(() => {
    if (!value || !active.has(value.state)) return;
    const timer = window.setInterval(async () => {
      try { const response = await fetch(`/api/ai-investigations/${encodeURIComponent(value.id)}`, { cache: 'no-store', credentials: 'same-origin' }); if (response.ok) { const body = await response.json() as { aiInvestigation?: AiInvestigationSummary }; if (body.aiInvestigation?.id === value.id) setValue(body.aiInvestigation); } } catch { /* Durable state remains authoritative. */ }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [value]);
  return (
    <section className="repository-panel" aria-labelledby="ai-investigation-title">
      <p className="eyebrow">Bounded model analysis</p><h3 id="ai-investigation-title">AI Investigation</h3>
      {!value ? <form action="/api/ai-investigations" method="post"><input type="hidden" name="investigationId" value={investigationId} /><input type="hidden" name="idempotencyKey" value={startRequestId} /><button className="primary-action" type="submit">Start AI investigation</button></form> : <>
        <dl><div><dt>Execution</dt><dd>{value.executionOrdinal}</dd></div><div><dt>Status</dt><dd>{labels[value.state]}</dd></div><div><dt>Revision</dt><dd><code>{value.revision.slice(0, 12)}</code></dd></div></dl>
        {value.conclusion && <><h4>Diagnosis</h4><p>{value.conclusion.summary}</p><h4>Suspected files</h4>{value.conclusion.suspectedFiles.length ? <ul>{value.conclusion.suspectedFiles.map((file) => <li key={file.path}><code>{file.path}</code>: {file.reason}</li>)}</ul> : <p>None identified.</p>}<h4>Evidence consulted</h4>{value.conclusion.evidence.length ? <ul>{value.conclusion.evidence.map((item) => <li key={item.reference}>{item.kind}: <code>{item.reference.slice(0, 12)}</code></li>)}</ul> : <p>No evidence references retained.</p>}<h4>Proposed approach</h4><p>{value.conclusion.proposedApproach}</p><dl><div><dt>Confidence</dt><dd>{value.conclusion.confidence}</dd></div><div><dt>Tool calls</dt><dd>{value.usage.toolCallCount}</dd></div></dl></>}
        {value.failureCode && <><div className="repository-notice" role="status">Previous execution {value.executionOrdinal}: {failureLabels[value.failureCode] ?? value.failureCode}</div>{['failed', 'cancelled'].includes(value.state) && <form action="/api/ai-investigations" method="post"><input type="hidden" name="investigationId" value={investigationId} /><input type="hidden" name="idempotencyKey" value={startRequestId} /><button className="primary-action" type="submit">Retry AI investigation</button></form>}</>}
      </>}
    </section>
  );
}
