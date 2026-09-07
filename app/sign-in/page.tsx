import Link from 'next/link';

import { GitHubSignInButton } from './github-sign-in-button';

export default function SignInPage() {
  return (
    <main className="auth-shell">
      <Link className="wordmark" href="/" aria-label="Vigilo home">
        <span className="wordmark-mark" aria-hidden="true">V</span>
        <span>Vigilo</span>
      </Link>
      <section className="auth-card" aria-labelledby="sign-in-title">
        <p className="eyebrow">Private workspace</p>
        <h1 id="sign-in-title">Sign in to Vigilo</h1>
        <p>
          Use your GitHub identity to access your private Vigilo workspace.
          Repository access is configured separately in the next step.
        </p>
        <GitHubSignInButton />
      </section>
    </main>
  );
}
