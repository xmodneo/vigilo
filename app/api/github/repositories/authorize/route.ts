import { getGitHubRepositoryHandlers } from '../../../../../lib/github-repositories/server';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return (await getGitHubRepositoryHandlers()).authorize(request);
}
