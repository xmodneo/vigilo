import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getAuthDatabase } from '../auth/server.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { GitHubApiClient } from '../github-app/client.ts';
import { readGitHubAppEnvironment, readGitHubAppPrivateKey } from '../github-app/environment.ts';
import { getCurrentRepositoryBaseline } from './flow.ts';
import { createRepositoryBaselineHandlers } from './handlers.ts';

let dependencies: Promise<{ configuration: ReturnType<typeof readGitHubAppEnvironment>; database: ReturnType<typeof getAuthDatabase>; gateway: GitHubApiClient }> | undefined;

async function getDependencies() {
  if (!dependencies) dependencies = (async () => {
    const configuration = readGitHubAppEnvironment();
    return {
      configuration,
      database: getAuthDatabase(),
      gateway: new GitHubApiClient(configuration, await readGitHubAppPrivateKey(configuration.privateKeyPath)),
    };
  })();
  return dependencies;
}

export async function getRepositoryBaselineHandlers() {
  return createRepositoryBaselineHandlers({ ...(await getDependencies()), resolveContext: resolveRequestWorkspace });
}

export async function getRepositoryBaselineForContext(context: AuthenticatedWorkspace) {
  return getCurrentRepositoryBaseline((await getDependencies()).database, context);
}
