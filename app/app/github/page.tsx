import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AccessDeniedError } from '../../../lib/auth/protected-context';
import { resolveRequestWorkspace } from '../../../lib/auth/resolve-request';
import { findGitHubInstallation } from '../../../lib/github-app/flow';
import { getAuthDatabase } from '../../../lib/auth/server';
import { GitHubConnectionView } from './github-connection-view';

export default async function GitHubConnectionPage() {
  try {
    const context = await resolveRequestWorkspace(await headers());
    const installation = await findGitHubInstallation(
      getAuthDatabase(),
      context.workspace.id,
    );

    return (
      <GitHubConnectionView
        installation={installation}
        workspaceId={context.workspace.id}
      />
    );
  } catch (error) {
    if (error instanceof AccessDeniedError && error.code === 'unauthorized') {
      redirect('/sign-in');
    }
    throw error;
  }
}
