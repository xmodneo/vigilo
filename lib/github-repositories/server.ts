import { getAuthDatabase } from '../auth/server.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { GitHubApiClient } from '../github-app/client.ts';
import {
  readGitHubAppEnvironment,
  readGitHubAppPrivateKey,
} from '../github-app/environment.ts';
import { getRepositoryOverview } from './flow.ts';
import { createGitHubRepositoryHandlers } from './handlers.ts';

let dependencies: Promise<{
  configuration: ReturnType<typeof readGitHubAppEnvironment>;
  database: ReturnType<typeof getAuthDatabase>;
  gateway: GitHubApiClient;
}> | undefined;

async function getDependencies() {
  if (!dependencies) {
    dependencies = (async () => {
      const configuration = readGitHubAppEnvironment();
      const privateKey = await readGitHubAppPrivateKey(configuration.privateKeyPath);
      return {
        configuration,
        database: getAuthDatabase(),
        gateway: new GitHubApiClient(configuration, privateKey),
      };
    })();
  }
  return dependencies;
}

export async function getGitHubRepositoryHandlers() {
  return createGitHubRepositoryHandlers({
    ...(await getDependencies()),
    resolveContext: resolveRequestWorkspace,
  });
}

export async function getRepositoryOverviewForContext(
  context: AuthenticatedWorkspace,
) {
  const values = await getDependencies();
  return getRepositoryOverview(values.database, context);
}
