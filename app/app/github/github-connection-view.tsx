import { RepairRunStatus, type RepairRunSummary } from './repair-run-status.tsx';
import { InvestigationStatus, type InvestigationSummary } from './investigation-status.tsx';

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

const unsupportedReasons: Record<string, string> = {
  ambiguous_test_runner: 'Multiple test runners were detected.',
  conflicting_lockfiles: 'Competing package-manager lockfiles were found.',
  invalid_package_lock: 'package-lock.json could not be validated.',
  invalid_script_graph: 'The test script delegation graph is unsafe or ambiguous.',
  malformed_package_json: 'package.json could not be validated.',
  missing_package_json: 'A root package.json is required.',
  missing_package_lock: 'A committed root package-lock.json is required.',
  missing_test_script: 'A root test script is required.',
  unsupported_monorepo: 'Workspaces and monorepo layouts are not supported in V1.',
  unsupported_node_version: 'The repository must support Node.js 24.',
  unsupported_package_manager: 'The repository must use npm.',
  unsupported_test_runner: 'Use Node test, Vitest, or Jest for V1.',
};

function npmEntrypoint(script: string): string {
  return script === 'test' ? 'npm test' : `npm run ${script}`;
}

export interface GitHubConnectionViewProps {
  baseline?: BaselineSummary | null;
  executionProfile?: ExecutionProfileSummary | null;
  installation: InstallationSummary | null;
  investigation?: InvestigationSummary | null;
  investigationRequestId?: string;
  repositories?: RepositorySummary[];
  repairRequestId: string;
  repairRun?: RepairRunSummary | null;
  repositoryError?: 'unavailable';
  selectedRepository?: RepositorySummary | null;
  workspaceId: string;
}

export function GitHubConnectionView({
  baseline = null,
  executionProfile = null,
  installation,
  investigation = null,
  investigationRequestId,
  repositories,
  repairRequestId,
  repairRun = null,
  repositoryError,
  selectedRepository = null,
  workspaceId,
}: GitHubConnectionViewProps) {
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
                Repository access could not be verified. Try again before making a selection.
              </div>
            ) : selectedRepository ? (
              <section className="repository-panel" aria-labelledby="selected-repository-title">
                <p className="eyebrow">Connected repository</p>
                <h2 id="selected-repository-title">{selectedRepository.fullName}</h2>
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
                      {executionProfile?.status === 'ready'
                        ? 'Ready'
                        : executionProfile?.status === 'unsupported'
                          ? 'Unsupported'
                          : 'Not configured yet'}
                    </dd>
                  </div>
                </dl>
                {executionProfile?.status === 'ready' && (
                  <>
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
                    {(!repairRun || !['created', 'baseline_running'].includes(repairRun.state)) && (
                      <form className="repair-intent-form" action="/api/repair-runs" method="post">
                        <input type="hidden" name="idempotencyKey" value={repairRequestId} />
                        <label htmlFor="repair-objective">Repair objective</label>
                        <textarea id="repair-objective" name="objective" required maxLength={3000} rows={4} placeholder="Describe the software behavior that needs investigation." />
                        <button className="primary-action" type="submit">Start repair</button>
                      </form>
                    )}
                    {repairRun && <RepairRunStatus initialRun={repairRun} />}
                    {repairRun?.repairObjective && investigationRequestId && ['ready_for_investigation', 'baseline_failed'].includes(repairRun.state) && !investigation && (
                      <form action={`/api/repair-runs/${encodeURIComponent(repairRun.id)}/investigation`} method="post">
                        <input type="hidden" name="idempotencyKey" value={investigationRequestId} />
                        <button className="primary-action" type="submit">Prepare investigation</button>
                      </form>
                    )}
                    {investigation && <InvestigationStatus initialInvestigation={investigation} />}
                    {baseline && (
                      <section className="repository-panel" aria-labelledby="baseline-title">
                        <p className="eyebrow">Execution evidence</p>
                        <h3 id="baseline-title">Baseline</h3>
                        <dl>
                          <div><dt>Revision</dt><dd><code>{baseline.baseRevision.slice(0, 12)}</code></dd></div>
                          <div><dt>Install</dt><dd>{baseline.install}</dd></div>
                          <div><dt>Typecheck</dt><dd>{baseline.typecheck ?? 'Not configured'}</dd></div>
                          <div><dt>Build</dt><dd>{baseline.build ?? 'Not configured'}</dd></div>
                          <div><dt>Tests</dt><dd>{baseline.test}</dd></div>
                          <div><dt>Network isolation</dt><dd>{baseline.networkIsolation}</dd></div>
                          <div><dt>Cleanup</dt><dd>{baseline.cleanup}</dd></div>
                          <div><dt>Outcome</dt><dd>{baseline.outcome}</dd></div>
                        </dl>
                      </section>
                    )}
                  </>
                )}
                {executionProfile?.status === 'unsupported' && (
                  <div className="repository-notice" role="status">
                    {unsupportedReasons[executionProfile.reason ?? ''] ?? 'The repository does not meet the V1 execution contract.'}
                  </div>
                )}
                <form action="/api/github/repositories/profile" method="post">
                  <button className="primary-action" type="submit">
                    {executionProfile ? 'Recompute execution profile' : 'Detect execution profile'}
                  </button>
                </form>
                <form action="/api/github/repositories/authorize" method="post">
                  <button className="secondary-action" type="submit">
                    Refresh repository access
                  </button>
                </form>
              </section>
            ) : repositories === undefined ? (
              <section className="repository-panel" aria-labelledby="repository-access-title">
                <p className="eyebrow">Repository access</p>
                <h2 id="repository-access-title">Choose a repository</h2>
                <p className="workspace-next">
                  Authorize the GitHub App briefly to load repositories where you have write access.
                </p>
                <form action="/api/github/repositories/authorize" method="post">
                  <button className="primary-action" type="submit">
                    Load repositories
                  </button>
                </form>
              </section>
            ) : (
              <section className="repository-panel" aria-labelledby="repository-list-title">
                <p className="eyebrow">Repository access</p>
                <h2 id="repository-list-title">Select a repository</h2>
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
                            {repository.isPrivate ? 'Private' : 'Public'} · {repository.defaultBranch ?? 'No default branch'}
                          </span>
                        </div>
                        <form action="/api/github/repositories" method="post">
                          <input type="hidden" name="repositoryId" value={repository.id} />
                          <button className="secondary-action" type="submit">Select</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        ) : (
          <form action="/api/github/installations" method="post">
            <button className="primary-action" type="submit">Connect GitHub</button>
          </form>
        )}
        {!installation && <p className="workspace-next">Repository selection follows installation.</p>}
      </section>
    </main>
  );
}
