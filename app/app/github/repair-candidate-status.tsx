import { CandidateVerificationStatus, type CandidateVerificationSummary } from './candidate-verification-status.tsx';

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

export function RepairCandidateStatus({ candidate, verification }: { candidate: RepairCandidateSummary | null; verification?: CandidateVerificationSummary | null }) {
  return (
    <section className="repository-panel" aria-labelledby="repair-candidate-title">
      <p className="eyebrow">Exact changed-file artifact</p>
      <h3 id="repair-candidate-title">Repair Candidate</h3>
      {!candidate ? <p className="workspace-next">No repair candidate yet.</p> : (
        <dl>
          <div><dt>Attempt</dt><dd>{candidate.ordinal}</dd></div>
          <div><dt>Status</dt><dd>{candidate.state}</dd></div>
          <div><dt>Files changed</dt><dd>{candidate.changedFileCount}</dd></div>
          <div><dt>Candidate</dt><dd><code>{candidate.candidateIdentity?.slice(0, 12) ?? 'Unavailable'}</code></dd></div>
        </dl>
      )}
      {candidate?.state === 'frozen' && !verification && (
        <form action="/api/candidate-verifications" method="post">
          <input type="hidden" name="candidateId" value={candidate.id} />
          <button className="primary-action" type="submit">Verify candidate</button>
        </form>
      )}
      {verification && <CandidateVerificationStatus initialVerification={verification} />}
    </section>
  );
}
