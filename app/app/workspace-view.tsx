import { SignOutButton } from './sign-out-button';

export interface WorkspaceViewProps {
  githubUserId: string;
  user: {
    email: string;
    name: string;
  };
  workspaceId: string;
}

export function WorkspaceView({ githubUserId, user, workspaceId }: WorkspaceViewProps) {
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <a className="wordmark" href="/" aria-label="Vigilo home">
          <span className="wordmark-mark" aria-hidden="true">V</span>
          <span>Vigilo</span>
        </a>
        <SignOutButton />
      </header>

      <section className="workspace-card" aria-labelledby="workspace-title">
        <p className="eyebrow">Private workspace</p>
        <h1 id="workspace-title">Welcome, {user.name}</h1>
        <dl>
          <div>
            <dt>GitHub identity</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>GitHub user ID</dt>
            <dd>{githubUserId}</dd>
          </div>
          <div>
            <dt>Vigilo workspace</dt>
            <dd>{workspaceId}</dd>
          </div>
        </dl>
        <p className="workspace-next">Repository connection comes next.</p>
      </section>
    </main>
  );
}
