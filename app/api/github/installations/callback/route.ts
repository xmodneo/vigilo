import { getGitHubInstallationHandlers } from '../../../../../lib/github-app/server';
import { getGitHubRepositoryHandlers } from '../../../../../lib/github-repositories/server';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const repositoryHandlers = await getGitHubRepositoryHandlers();
  if (await repositoryHandlers.matchesCallback(request)) {
    return repositoryHandlers.callback(request);
  }
  const handlers = await getGitHubInstallationHandlers();
  return handlers.callback(request);
}
