interface InstallationSummary {
  accountLogin: string;
  accountType: string;
  installationId: number;
  status: string;
}

export interface GitHubConnectionViewProps {
  installation: InstallationSummary | null;
  workspaceId: string;
}

export function GitHubConnectionView({
  installation,
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
        ) : (
          <form action="/api/github/installations" method="post">
            <button className="primary-action" type="submit">Connect GitHub</button>
          </form>
        )}

        <p className="workspace-next">Repository selection comes next.</p>
      </section>
    </main>
  );
}
