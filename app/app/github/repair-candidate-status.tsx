import { CandidateVerificationStatus, type CandidateVerificationSummary } from './candidate-verification-status.tsx';
import { PendingSubmitButton } from '../pending-submit-button.tsx';
import { presentWorkflowStatus } from '../../../lib/presentation/policy.ts';

export interface RepairCandidateSummary {
  id: string;
  investigationId: string;
  ordinal: number;
  state: 'freezing' | 'frozen' | 'rejected';
  candidateIdentity: string | null;
  changedFileCount: number;
  totalResultBytes: number;
  rejectionCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export function RepairCandidateStatus({ candidate, verification, workflowOwned = false, actionAvailable = false }: { candidate: RepairCandidateSummary | null; verification?: CandidateVerificationSummary | null; workflowOwned?: boolean; actionAvailable?: boolean }) {
  const candidatePresentation = candidate?.state === 'frozen'
    ? presentWorkflowStatus('candidate_frozen')
    : candidate?.state === 'rejected' ? presentWorkflowStatus('no_repair_proposed')
      : candidate?.state === 'freezing' ? presentWorkflowStatus('generating_repair')
        : presentWorkflowStatus('operational_failure');
  return (
    <section className="repository-panel" aria-labelledby="repair-candidate-title">
      <p className="eyebrow">Exact changed-file artifact</p>
      <h3 id="repair-candidate-title">Repair Candidate</h3>
      {!candidate ? <p className="workspace-next">No repair candidate yet.</p> : (
        <dl>
          <div><dt>Attempt</dt><dd>{candidate.ordinal}</dd></div>
          <div><dt>Status</dt><dd>{candidatePresentation.label}</dd></div>
          <div><dt>Files changed</dt><dd>{candidate.changedFileCount}</dd></div>
          <div><dt>Candidate</dt><dd><code>{candidate.candidateIdentity?.slice(0, 12) ?? 'Unavailable'}</code></dd></div>
        </dl>
      )}
      {!workflowOwned && actionAvailable && candidate?.state === 'frozen' && !verification && (
        <form action="/api/candidate-verifications" method="post">
          <input type="hidden" name="candidateId" value={candidate.id} />
          <PendingSubmitButton className="primary-action" pendingLabel="Starting verification…">Verify candidate</PendingSubmitButton>
        </form>
      )}
      {verification && <CandidateVerificationStatus initialVerification={verification} allowReverify={!workflowOwned} />}
    </section>
  );
}
