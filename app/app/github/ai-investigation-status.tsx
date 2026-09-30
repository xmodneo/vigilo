'use client';

import { PendingSubmitButton } from '../pending-submit-button.tsx';
import { presentError, presentWorkflowStatus } from '../../../lib/presentation/policy.ts';
import { DurableLiveMessage, useDurablePolling } from './durable-polling.tsx';

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

export interface AiCandidateGenerationSummary {
  id: string;
  aiInvestigationId: string;
  executionOrdinal: number;
  investigationId: string;
  state: 'created' | 'queued' | 'generating' | 'frozen' | 'abstained' | 'failed' | 'cancelled';
  revision: string;
  provider: string;
  model: string;
  repairCandidateId: string | null;
  completionReason: 'proposal_ready' | 'insufficient_evidence' | null;
  usage: { inputTokens: number; outputTokens: number; toolCallCount: number; modelTurnCount: number };
  failureCode: string | null;
}

const active = new Set(['created', 'queued', 'investigating']);
const candidateActive = new Set(['created', 'queued', 'generating']);

function ExistingAiInvestigation({
  initialValue,
  investigationId,
  startRequestId,
  initialCandidateGeneration,
  candidateGenerationRequestId,
  suppressCandidateActions,
  actionAvailable,
}: {
  initialValue: AiInvestigationSummary;
  investigationId: string;
  startRequestId: string;
  initialCandidateGeneration: AiCandidateGenerationSummary | null;
  candidateGenerationRequestId: string;
  suppressCandidateActions: boolean;
  actionAvailable: boolean;
}) {
  const { value, liveMessage } = useDurablePolling({
    initialValue,
    isActive: (state) => active.has(state),
    resourceKey: 'aiInvestigation',
    endpoint: (id) => `/api/ai-investigations/${encodeURIComponent(id)}`,
  });
  const candidatePoll = useDurablePolling({
    initialValue: initialCandidateGeneration,
    isActive: (state) => candidateActive.has(state),
    resourceKey: 'aiCandidateGeneration',
    endpoint: (id) => `/api/ai-candidate-generations/${encodeURIComponent(id)}`,
  });
  const candidateGeneration = candidatePoll.value;
  const diagnosisStatus = active.has(value.state) ? 'diagnosing'
    : value.state === 'completed' && value.conclusion?.status === 'diagnosis_found' ? 'diagnosis_ready'
      : value.state === 'completed' ? 'no_diagnosis' : 'operational_failure';
  const diagnosisPresentation = presentWorkflowStatus(diagnosisStatus);
  return (
    <div aria-busy={active.has(value.state) || Boolean(candidateGeneration && candidateActive.has(candidateGeneration.state))}>
        <dl><div><dt>Execution</dt><dd>{value.executionOrdinal}</dd></div><div><dt>Status</dt><dd>{diagnosisPresentation.label}</dd></div><div><dt>Revision</dt><dd><code>{value.revision.slice(0, 12)}</code></dd></div></dl>
        <p>{diagnosisPresentation.explanation}</p>
        <DurableLiveMessage message={candidatePoll.liveMessage ?? liveMessage} />
        {value.conclusion && <><h4>Diagnosis</h4><p>{value.conclusion.summary}</p><h4>Suspected files</h4>{value.conclusion.suspectedFiles.length ? <ul>{value.conclusion.suspectedFiles.map((file) => <li key={file.path}><code>{file.path}</code>: {file.reason}</li>)}</ul> : <p>None identified.</p>}<h4>Evidence consulted</h4>{value.conclusion.evidence.length ? <ul>{value.conclusion.evidence.map((item) => <li key={item.reference}>{item.kind}: <code>{item.reference.slice(0, 12)}</code></li>)}</ul> : <p>No evidence references retained.</p>}<h4>Proposed approach</h4><p>{value.conclusion.proposedApproach}</p><dl><div><dt>Confidence</dt><dd>{value.conclusion.confidence}</dd></div><div><dt>Tool calls</dt><dd>{value.usage.toolCallCount}</dd></div></dl></>}
        {value.failureCode && <><div className="repository-notice" role="alert">Previous execution {value.executionOrdinal}: {presentError(value.failureCode).message}</div>{actionAvailable && ['failed', 'cancelled'].includes(value.state) && <form action="/api/ai-investigations" method="post"><input type="hidden" name="investigationId" value={investigationId} /><input type="hidden" name="idempotencyKey" value={startRequestId} /><PendingSubmitButton className="primary-action" pendingLabel="Starting investigation…">Retry AI investigation</PendingSubmitButton></form>}</>}
        {!suppressCandidateActions && actionAvailable && value.state === 'completed' && value.conclusion?.status === 'diagnosis_found' && (candidateGeneration ? <><h4>Repair candidate generation</h4><p>{presentWorkflowStatus(candidateGeneration.state === 'frozen' ? 'candidate_frozen' : candidateGeneration.state === 'abstained' ? 'no_repair_proposed' : candidateActive.has(candidateGeneration.state) ? 'generating_repair' : 'operational_failure').label}</p>{candidateGeneration.repairCandidateId && <p>Frozen candidate: <code>{candidateGeneration.repairCandidateId.slice(0, 12)}</code></p>}{candidateGeneration.failureCode && <div className="repository-notice" role="alert">{presentError(candidateGeneration.failureCode).message}</div>}{candidateGeneration.state === 'failed' && <form action="/api/ai-candidate-generations" method="post"><input type="hidden" name="aiInvestigationId" value={value.id} /><input type="hidden" name="idempotencyKey" value={candidateGenerationRequestId} /><PendingSubmitButton className="primary-action" pendingLabel="Generating repair…">Retry candidate generation</PendingSubmitButton></form>}</> : <form action="/api/ai-candidate-generations" method="post"><input type="hidden" name="aiInvestigationId" value={value.id} /><input type="hidden" name="idempotencyKey" value={candidateGenerationRequestId} /><PendingSubmitButton className="primary-action" pendingLabel="Generating repair…">Generate repair candidate</PendingSubmitButton></form>)}
    </div>
  );
}

export function AiInvestigationStatus({ investigationId, initialAiInvestigation, startRequestId, initialAiCandidateGeneration, candidateGenerationRequestId, suppressCandidateActions = false, actionAvailable = false }: { investigationId: string; initialAiInvestigation: AiInvestigationSummary | null; startRequestId: string; initialAiCandidateGeneration: AiCandidateGenerationSummary | null; candidateGenerationRequestId: string; suppressCandidateActions?: boolean; actionAvailable?: boolean }) {
  return (
    <section className="repository-panel" aria-labelledby="ai-investigation-title">
      <p className="eyebrow">Bounded model analysis</p><h3 id="ai-investigation-title">AI Investigation</h3>
      {!initialAiInvestigation ? actionAvailable ? <form action="/api/ai-investigations" method="post"><input type="hidden" name="investigationId" value={investigationId} /><input type="hidden" name="idempotencyKey" value={startRequestId} /><PendingSubmitButton className="primary-action" pendingLabel="Starting investigation…">Start AI investigation</PendingSubmitButton></form> : <p>External execution is unavailable. Existing investigation history remains viewable.</p> : <ExistingAiInvestigation initialValue={initialAiInvestigation} investigationId={investigationId} startRequestId={startRequestId} initialCandidateGeneration={initialAiCandidateGeneration} candidateGenerationRequestId={candidateGenerationRequestId} suppressCandidateActions={suppressCandidateActions} actionAvailable={actionAvailable} />}
    </section>
  );
}
