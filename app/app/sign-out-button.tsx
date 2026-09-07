'use client';

import { useState } from 'react';

import { authClient } from '../../lib/auth-client';

export function SignOutButton() {
  const [isPending, setIsPending] = useState(false);

  async function signOut() {
    setIsPending(true);
    await authClient.signOut({
      fetchOptions: {
        onError: () => setIsPending(false),
        onSuccess: () => window.location.assign('/'),
      },
    });
  }

  return (
    <button className="secondary-action" type="button" onClick={signOut} disabled={isPending}>
      {isPending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
