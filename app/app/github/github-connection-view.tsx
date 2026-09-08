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

export interface GitHubConnectionViewProps {
  installation: InstallationSummary | null;
  repositories?: RepositorySummary[];
  repositoryError?: 'unavailable';
  selectedRepository?: RepositorySummary | null;
  workspaceId: string;
}

export function GitHubConnectionView({
  installation,
  repositories,
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
                    <dd>Not configured yet</dd>
                  </div>
                </dl>
                <button className="primary-action" type="button" disabled>
                  Continue
                </button>
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
