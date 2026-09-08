import { getGitHubRepositoryHandlers } from '../../../../lib/github-repositories/server';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return (await getGitHubRepositoryHandlers()).list(request);
}

export async function POST(request: Request): Promise<Response> {
  return (await getGitHubRepositoryHandlers()).select(request);
}
