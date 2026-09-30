import { RepairRunStatus, type RepairRunSummary } from './repair-run-status.tsx';
import { InvestigationStatus, type InvestigationSummary } from './investigation-status.tsx';
import { RepairCandidateStatus, type RepairCandidateSummary } from './repair-candidate-status.tsx';
import type { CandidateVerificationSummary } from './candidate-verification-status.tsx';
import { AiInvestigationStatus, type AiCandidateGenerationSummary, type AiInvestigationSummary } from './ai-investigation-status.tsx';
import { RepairLoopStatus, type RepairLoopSummary } from './repair-loop-status.tsx';
import { HumanReviewStatus } from './human-review-status.tsx';
import type { HumanReviewResult } from '../../../lib/human-reviews/types.ts';
import { RepairPublicationStatus } from './repair-publication-status.tsx';
import type { RepairPublicationResult } from '../../../lib/repair-publications/types.ts';
import { PendingSubmitButton } from '../pending-submit-button.tsx';
import {
  presentError,
  presentExecutionAvailability,
  presentRepositoryEligibility,
  type ExecutionAvailabilityStatus,
} from '../../../lib/presentation/policy.ts';

type RepairPublicationHistory = {
  publication: RepairPublicationResult | null;
  events: Array<{ id: string; eventType: string; checkpoint: string; toState: string; failureCode: string | null; createdAt: Date }>;
};

interface InstallationSummary {
  accountLogin: string;
  accountType: string;
  installationId: number;
  status: string;
}

interface RepositorySummary {
  defaultBranch: string | null;
  fullName: string;
  id: number;
  isPrivate: boolean;
}

type ExecutionProfileSummary =
  | {
      baseRevision: string;
      build: { script: 'build'; tool: 'npm' } | null;
      install: { operation: 'ci'; tool: 'npm' };
      nodeMajor: number | null;
      packageManager: string | null;
      profileIdentity: string | null;
      profileVersion: number;
      runtimeFamily: string | null;
      status: 'ready';
      test: { script: 'test'; tool: 'npm' };
      testRunner: string | null;
      typecheck: { script: 'typecheck'; tool: 'npm' } | null;
    }
  | {
      baseRevision: string;
      profileVersion: number;
      reason: string | null;
      status: 'unsupported';
    };

interface BaselineSummary {
  baseRevision: string;
  build: string | null;
  cleanup: 'confirmed' | 'unconfirmed';
  install: string;
  networkIsolation: 'confirmed' | 'unconfirmed';
  outcome: string;
  test: string;
  typecheck: string | null;
}

function npmEntrypoint(script: string): string {
  return script === 'test' ? 'npm test' : `npm run ${script}`;
}

function evidenceLabel(value: string | null): string {
  if (!value) return 'Not configured';
  if (value === 'completed' || value === 'baseline_passed') return 'Passed';
  if (['failed', 'baseline_failed', 'typecheck_failed', 'build_failed', 'test_failed'].includes(value)) return 'Failed';
  if (value === 'not_run') return 'Not run';
  return 'Unavailable';
}

const restartableRepairRunStates = new Set<RepairRunSummary['state']>([
  'ready_for_investigation',
  'baseline_failed',
  'infrastructure_failed',
  'cancelled',
]);

export interface GitHubConnectionViewProps {
  aiInvestigation?: AiInvestigationSummary | null;
  aiInvestigationRequestId?: string;
  aiCandidateGeneration?: AiCandidateGenerationSummary | null;
  aiCandidateGenerationRequestId?: string;
  baseline?: BaselineSummary | null;
  executionProfile?: ExecutionProfileSummary | null;
  executionAvailability?: ExecutionAvailabilityStatus;
  installation: InstallationSummary | null;
  investigation?: InvestigationSummary | null;
  investigationRequestId?: string;
  repairCandidate?: RepairCandidateSummary | null;
  candidateVerification?: CandidateVerificationSummary | null;
  repositories?: RepositorySummary[];
  repairRequestId: string;
  repairRun?: RepairRunSummary | null;
  repairLoop?: RepairLoopSummary | null;
  repairLoopRequestId?: string;
  humanReview?: HumanReviewResult | null;
  humanReviewRequestId?: string;
  repairPublication?: RepairPublicationHistory | null;
  repairPublicationRequestId?: string;
  repositoryError?: 'unavailable';
  workflowError?: 'unavailable';
  noticeCode?: string;
  selectedRepository?: RepositorySummary | null;
  workspaceId: string;
}

export function GitHubConnectionView({
  aiInvestigation = null,
  aiInvestigationRequestId,
  aiCandidateGeneration = null,
  aiCandidateGenerationRequestId,
  baseline = null,
  executionProfile = null,
  executionAvailability = 'unknown',
  installation,
  investigation = null,
  investigationRequestId,
  repairCandidate = null,
  candidateVerification = null,
  repositories,
  repairRequestId,
  repairRun = null,
  repairLoop = null,
  repairLoopRequestId,
  humanReview = null,
  humanReviewRequestId,
  repairPublication = null,
  repairPublicationRequestId,
  repositoryError,
  workflowError,
  noticeCode,
  selectedRepository = null,
  workspaceId,
}: GitHubConnectionViewProps) {
  const repairLoopActive = repairLoop?.state === 'queued' || repairLoop?.state === 'running';
  const executionPresentation = presentExecutionAvailability(executionAvailability);
  const executionAllowed = executionPresentation.actionAvailable && !selectedRepository?.isPrivate && !workflowError;
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <a className="wordmark" href="/" aria-label="Vigilo home">
          <span className="wordmark-mark" aria-hidden="true">V</span>
          <span>Vigilo</span>
        </a>
        <a className="secondary-action button-link" href="/app">Workspace</a>
      </header>

      <section className="workspace-card" aria-labelledby="github-title">
        <p className="eyebrow">Private workspace</p>
        <h1 id="github-title">GitHub connection</h1>
        <p className={`connection-status ${installation ? 'is-connected' : ''}`}>
          {installation ? 'Connected' : 'Not connected'}
        </p>
        {noticeCode && <div className="repository-notice" role="alert">{presentError(noticeCode).message}</div>}

        {installation ? (
          <>
            <dl>
              <div>
                <dt>Account</dt>
                <dd>{installation.accountLogin} ({installation.accountType})</dd>
              </div>
              <div>
                <dt>Installation</dt>
                <dd>{installation.status}</dd>
              </div>
              <div>
                <dt>Installation ID</dt>
                <dd>{installation.installationId}</dd>
              </div>
              <div>
                <dt>Vigilo workspace</dt>
                <dd>{workspaceId}</dd>
              </div>
            </dl>
            {repositoryError === 'unavailable' ? (
              <div className="repository-notice" role="alert">
                <p>Repository access could not be verified. No execution action is available.</p>
                <a className="secondary-action button-link" href="/app/github">Try again</a>
              </div>
            ) : selectedRepository ? (
              <section className="repository-panel" aria-labelledby="selected-repository-title">
                <p className="eyebrow">Connected repository</p>
                <h2 id="selected-repository-title">{selectedRepository.fullName}</h2>
                {selectedRepository.isPrivate && (
                  <div className="repository-notice" role="alert">
                    {presentRepositoryEligibility('private_unsupported').label}. Vigilo will not inspect source, reserve execution authority, or start repair work for this repository.
                  </div>
                )}
                {workflowError === 'unavailable' && (
                  <div className="repository-notice" role="alert">
                    <p>Repair history could not be loaded safely. No workflow action is available.</p>
                    <a className="secondary-action button-link" href="/app/github">Refresh status</a>
                  </div>
                )}
                <dl>
                  <div>
                    <dt>Visibility</dt>
                    <dd>{selectedRepository.isPrivate ? 'Private' : 'Public'}</dd>
                  </div>
                  <div>
                    <dt>Default branch</dt>
                    <dd>{selectedRepository.defaultBranch ?? 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Execution profile</dt>
                    <dd>
                      {selectedRepository.isPrivate
                        ? presentRepositoryEligibility('private_unsupported').label
                        : executionProfile?.status === 'ready'
                        ? 'Ready'
                        : executionProfile?.status === 'unsupported'
                          ? 'Unsupported'
                          : presentRepositoryEligibility('not_checked').label}
                    </dd>
                  </div>
                </dl>
                {!selectedRepository.isPrivate && executionProfile?.status === 'ready' && (
                  <>
                    <section aria-labelledby="eligibility-title">
                      <h3 id="eligibility-title">Repository eligibility</h3>
                      <p><strong>{presentRepositoryEligibility('eligible_for_inspection').label}</strong></p>
                      <ul>
                        <li>Public repository</li><li>Root <code>package.json</code></li><li>Committed <code>package-lock.json</code></li>
                        <li>npm with Node.js 24 compatibility</li><li>Single-package layout without workspaces or monorepos</li>
                        <li>Supported root test script with safe script delegation</li><li>Optional typecheck and build scripts are used when present</li>
                      </ul>
                    </section>
                    <dl>
                      <div><dt>Runtime</dt><dd>Node.js {executionProfile.nodeMajor}</dd></div>
                      <div><dt>Package manager</dt><dd>{executionProfile.packageManager}</dd></div>
                      <div><dt>Base revision</dt><dd><code>{executionProfile.baseRevision.slice(0, 12)}</code></dd></div>
                      <div><dt>Install</dt><dd>npm ci</dd></div>
                      <div><dt>Typecheck</dt><dd>{executionProfile.typecheck ? npmEntrypoint(executionProfile.typecheck.script) : 'Not configured'}</dd></div>
                      <div><dt>Build</dt><dd>{executionProfile.build ? npmEntrypoint(executionProfile.build.script) : 'Not configured'}</dd></div>
                      <div><dt>Test</dt><dd>{npmEntrypoint(executionProfile.test.script)}</dd></div>
                      <div><dt>Test runner</dt><dd>{executionProfile.testRunner === 'node-test' ? 'Node built-in test runner' : executionProfile.testRunner}</dd></div>
                    </dl>
                    <div className="repository-notice" role="status">
                      <strong>{executionPresentation.label}.</strong> {executionPresentation.explanation}
                    </div>
                    {executionAllowed && (!repairRun || restartableRepairRunStates.has(repairRun.state)) && (
                      <>
                      <p className="data-use-disclosure">During an authorized repair, selected public repository source and your repair objective may be sent to configured AI and sandbox providers. Vigilo may retain the repair objective, frozen candidate contents, verification evidence, and audit history. External execution remains separately server-authorized.</p>
                      <form className="repair-intent-form" action="/api/repair-runs" method="post">
                        <input type="hidden" name="idempotencyKey" value={repairRequestId} />
                        <label htmlFor="repair-objective">Repair objective</label>
                        <textarea id="repair-objective" name="objective" required maxLength={3000} rows={4} placeholder="Example: Checkout should offer free shipping when the order total reaches the documented threshold." />
                        <PendingSubmitButton className="primary-action" pendingLabel="Starting repair…">Start repair</PendingSubmitButton>
                      </form>
                      </>
                    )}
                    {!repairRun && !executionAllowed && <p className="empty-state">Your first repair starts with a specific reproducible objective. Existing history remains viewable while external execution is unavailable.</p>}
                    {repairRun && <RepairRunStatus initialRun={repairRun} />}
                    {repairRun?.repairObjective && investigationRequestId && ['ready_for_investigation', 'baseline_failed'].includes(repairRun.state) && !investigation && (
                      <form action={`/api/repair-runs/${encodeURIComponent(repairRun.id)}/investigation`} method="post">
                        <input type="hidden" name="idempotencyKey" value={investigationRequestId} />
                        <PendingSubmitButton className="primary-action" pendingLabel="Preparing investigation…">Prepare investigation</PendingSubmitButton>
                      </form>
                    )}
                    {investigation && <InvestigationStatus initialInvestigation={investigation} />}
                    {investigation?.state === 'ready' && aiInvestigationRequestId && aiCandidateGenerationRequestId && <AiInvestigationStatus investigationId={investigation.id} initialAiInvestigation={aiInvestigation} startRequestId={aiInvestigationRequestId} initialAiCandidateGeneration={aiCandidateGeneration} candidateGenerationRequestId={aiCandidateGenerationRequestId} suppressCandidateActions={repairLoopActive} actionAvailable={executionAllowed} />}
                    {executionAllowed && aiInvestigation?.state === 'completed' && aiInvestigation.conclusion?.status === 'diagnosis_found' && repairRun && repairLoopRequestId && !repairLoop && (
                      <form action="/api/repair-loops" method="post">
                        <input type="hidden" name="repairRunId" value={repairRun.id} />
                        <input type="hidden" name="idempotencyKey" value={repairLoopRequestId} />
                        <PendingSubmitButton className="primary-action" pendingLabel="Starting bounded repair…">Start bounded repair loop</PendingSubmitButton>
                      </form>
                    )}
                    {repairLoop && <RepairLoopStatus initialLoop={repairLoop} />}
                    {repairLoop && humanReview && humanReviewRequestId && <HumanReviewStatus review={humanReview} idempotencyKey={humanReviewRequestId} />}
                    {repairLoop && humanReview && repairPublicationRequestId && <RepairPublicationStatus review={humanReview} publication={repairPublication?.publication ?? null} events={repairPublication?.events ?? []} idempotencyKey={repairPublicationRequestId} />}
                    {investigation?.state === 'ready' && <RepairCandidateStatus candidate={repairCandidate} verification={candidateVerification} workflowOwned={repairLoopActive} actionAvailable={executionAllowed} />}
                    {baseline && (
                      <section className="repository-panel" aria-labelledby="baseline-title">
                        <p className="eyebrow">Execution evidence</p>
                        <h3 id="baseline-title">Baseline</h3>
                        <dl>
                          <div><dt>Revision</dt><dd><code>{baseline.baseRevision.slice(0, 12)}</code></dd></div>
                          <div><dt>Install</dt><dd>{evidenceLabel(baseline.install)}</dd></div>
                          <div><dt>Typecheck</dt><dd>{evidenceLabel(baseline.typecheck)}</dd></div>
                          <div><dt>Build</dt><dd>{evidenceLabel(baseline.build)}</dd></div>
                          <div><dt>Tests</dt><dd>{evidenceLabel(baseline.test)}</dd></div>
                          <div><dt>Network isolation</dt><dd>{baseline.networkIsolation === 'confirmed' ? 'Confirmed' : 'Unconfirmed'}</dd></div>
                          <div><dt>Cleanup</dt><dd>{baseline.cleanup === 'confirmed' ? 'Confirmed' : 'Unconfirmed'}</dd></div>
                          <div><dt>Outcome</dt><dd>{evidenceLabel(baseline.outcome)}</dd></div>
                        </dl>
                      </section>
                    )}
                  </>
                )}
                {!selectedRepository.isPrivate && executionProfile?.status === 'unsupported' && (
                  <div className="repository-notice" role="status">
                    <strong>{presentRepositoryEligibility('unsupported').label}.</strong> {executionProfile.reason ? presentError(executionProfile.reason).message : 'The repository does not meet the V1 execution contract.'}
                  </div>
                )}
                {!selectedRepository.isPrivate && !workflowError && <form action="/api/github/repositories/profile" method="post">
                  <PendingSubmitButton className="primary-action" pendingLabel="Checking eligibility…">
                    {executionProfile ? 'Check eligibility again' : 'Check eligibility'}
                  </PendingSubmitButton>
                </form>}
                <form action="/api/github/repositories/authorize" method="post">
                  <PendingSubmitButton className="secondary-action" pendingLabel="Refreshing access…">Refresh access</PendingSubmitButton>
                </form>
              </section>
            ) : repositories === undefined ? (
              <section className="repository-panel" aria-labelledby="repository-access-title">
                <p className="eyebrow">Repository access</p>
                <h2 id="repository-access-title">Choose a repository</h2>
                <p className="workspace-next">
                  Authorize the GitHub App briefly to load repositories where you have write access.
                </p>
                <p className="data-use-disclosure">Vigilo currently supports public repositories only. Selecting a repository lets Vigilo inspect its metadata and, when explicitly authorized, read source from an exact revision.</p>
                <form action="/api/github/repositories/authorize" method="post">
                  <PendingSubmitButton className="primary-action" pendingLabel="Loading repositories…">Load repositories</PendingSubmitButton>
                </form>
              </section>
            ) : (
              <section className="repository-panel" aria-labelledby="repository-list-title">
                <p className="eyebrow">Repository access</p>
                <h2 id="repository-list-title">Select a repository</h2>
                <p className="data-use-disclosure">Vigilo currently supports public repositories only. Selecting a repository lets Vigilo inspect its metadata and, when explicitly authorized, read source from an exact revision.</p>
                {repositories.length === 0 ? (
                  <p className="workspace-next">
                    No repositories currently meet both installation and user write-access requirements.
                  </p>
                ) : (
                  <ul className="repository-list">
                    {repositories.map((repository) => (
                      <li key={repository.id}>
                        <div>
                          <strong>{repository.fullName}</strong>
                          <span>
                            {presentRepositoryEligibility(repository.isPrivate ? 'private_unsupported' : 'not_checked').label} · {repository.defaultBranch ?? 'No default branch'}
                          </span>
                        </div>
                        {!repository.isPrivate && <form action="/api/github/repositories" method="post">
                          <input type="hidden" name="repositoryId" value={repository.id} />
                          <PendingSubmitButton className="secondary-action" pendingLabel="Selecting…">Select {repository.fullName}</PendingSubmitButton>
                        </form>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        ) : (
          <form action="/api/github/installations" method="post">
            <PendingSubmitButton className="primary-action" pendingLabel="Connecting…">Connect GitHub</PendingSubmitButton>
          </form>
        )}
        {!installation && <p className="workspace-next">Connect GitHub to list repositories where the installation and your user both have access. Public repositories only.</p>}
      </section>
    </main>
  );
}
