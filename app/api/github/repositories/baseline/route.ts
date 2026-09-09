import { getRepositoryBaselineHandlers } from '../../../../../lib/repository-baselines/server';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function GET(request: Request) {
  return (await getRepositoryBaselineHandlers()).current(request);
}

export async function POST(request: Request) {
  return (await getRepositoryBaselineHandlers()).run(request);
}
