import { getGitHubRepositoryHandlers } from '../../../../../lib/github-repositories/server';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return (await getGitHubRepositoryHandlers()).current(request);
}
