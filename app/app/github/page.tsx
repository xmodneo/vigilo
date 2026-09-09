import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AccessDeniedError } from '../../../lib/auth/protected-context';
import { resolveRequestWorkspace } from '../../../lib/auth/resolve-request';
import { findGitHubInstallation } from '../../../lib/github-app/flow';
import { getAuthDatabase } from '../../../lib/auth/server';
import { publicExecutionProfile } from '../../../lib/execution-profiles/handlers';
import { getExecutionProfileForContext } from '../../../lib/execution-profiles/server';
import { getRepositoryOverviewForContext } from '../../../lib/github-repositories/server';
import { publicBaseline } from '../../../lib/repository-baselines/handlers';
import { getRepositoryBaselineForContext } from '../../../lib/repository-baselines/server';
import { GitHubConnectionView } from './github-connection-view';

export default async function GitHubConnectionPage() {
  try {
    const requestHeaders = await headers();
    const context = await resolveRequestWorkspace(requestHeaders);
    const installation = await findGitHubInstallation(
      getAuthDatabase(),
      context.workspace.id,
    );
    let repositories = undefined;
    let repositoryError: 'unavailable' | undefined;
    let selectedRepository = undefined;
    let executionProfile = undefined;
    let baseline = undefined;
    if (installation) {
      try {
        const overview = await getRepositoryOverviewForContext(context);
        repositories = overview.repositories ?? undefined;
        selectedRepository = overview.selected
          ? {
              defaultBranch: overview.selected.defaultBranch,
              fullName: overview.selected.fullName,
              id: overview.selected.githubRepositoryId,
              isPrivate: overview.selected.isPrivate,
            }
          : null;
        executionProfile = overview.selected
          ? publicExecutionProfile(await getExecutionProfileForContext(context))
          : null;
        baseline = overview.selected
          ? publicBaseline(await getRepositoryBaselineForContext(context))
          : null;
      } catch {
        repositoryError = 'unavailable';
      }
    }

    return (
      <GitHubConnectionView
        installation={installation}
        {...(baseline !== undefined ? { baseline } : {})}
        {...(executionProfile !== undefined ? { executionProfile } : {})}
        {...(repositories ? { repositories } : {})}
        {...(repositoryError ? { repositoryError } : {})}
        {...(selectedRepository !== undefined ? { selectedRepository } : {})}
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
