import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getAuthDatabase } from '../auth/server.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { GitHubApiClient } from '../github-app/client.ts';
import {
  readGitHubAppEnvironment,
  readGitHubAppPrivateKey,
} from '../github-app/environment.ts';
import { getCurrentExecutionProfile } from './flow.ts';
import { createExecutionProfileHandlers } from './handlers.ts';

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

export async function getExecutionProfileHandlers() {
  return createExecutionProfileHandlers({
    ...(await getDependencies()),
    resolveContext: resolveRequestWorkspace,
  });
}

export async function getExecutionProfileForContext(context: AuthenticatedWorkspace) {
  const values = await getDependencies();
  return getCurrentExecutionProfile(values.database, context);
}
