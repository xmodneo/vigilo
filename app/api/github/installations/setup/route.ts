import { getGitHubInstallationHandlers } from '../../../../../lib/github-app/server';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const handlers = await getGitHubInstallationHandlers();
  return handlers.setup(request);
}
