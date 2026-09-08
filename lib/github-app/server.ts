import { getAuthDatabase } from '../auth/server.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { GitHubApiClient } from './client.ts';
import {
  readGitHubAppEnvironment,
  readGitHubAppPrivateKey,
} from './environment.ts';
import { createGitHubInstallationHandlers } from './handlers.ts';

let handlers: Promise<ReturnType<typeof createGitHubInstallationHandlers>> | undefined;

export function getGitHubInstallationHandlers() {
  if (!handlers) {
    handlers = (async () => {
      const environment = readGitHubAppEnvironment();
      const privateKey = await readGitHubAppPrivateKey(environment.privateKeyPath);
      return createGitHubInstallationHandlers({
        configuration: {
          appId: environment.appId,
          appSlug: environment.appSlug,
          baseUrl: environment.baseUrl,
          clientId: environment.clientId,
        },
        database: getAuthDatabase(),
        gateway: new GitHubApiClient(environment, privateKey),
        resolveContext: resolveRequestWorkspace,
      });
    })();
  }
  return handlers;
}
