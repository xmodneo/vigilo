import { getRepositoryBaselineHandlers } from '../../../../../lib/repository-baselines/server.ts';
import { legacyBaselineExecutionUnavailable } from '../../../../../lib/repository-baselines/handlers.ts';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function GET(request: Request) {
  return (await getRepositoryBaselineHandlers()).current(request);
}

export function POST(_request: Request) {
  return legacyBaselineExecutionUnavailable();
}
