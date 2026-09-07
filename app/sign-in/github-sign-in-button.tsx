'use client';

import { useState } from 'react';

import { authClient } from '../../lib/auth-client';

export function GitHubSignInButton() {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setIsPending(true);
    setError(null);

    const result = await authClient.signIn.social({
      callbackURL: '/app',
      provider: 'github',
    });

    if (result.error) {
      setError('GitHub sign-in could not be started. Please try again.');
      setIsPending(false);
    }
  }

  return (
    <div className="auth-action">
      <button className="primary-action" type="button" onClick={signIn} disabled={isPending}>
        {isPending ? 'Opening GitHub…' : 'Continue with GitHub'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
