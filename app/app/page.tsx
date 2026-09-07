import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AccessDeniedError } from '../../lib/auth/protected-context';
import { resolveRequestWorkspace } from '../../lib/auth/resolve-request';
import { WorkspaceView } from './workspace-view';

export default async function AppPage() {
  try {
    const context = await resolveRequestWorkspace(await headers());

    return (
      <WorkspaceView
        githubUserId={context.githubUserId}
        user={context.user}
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
