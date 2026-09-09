import { getRepairRunHandlers } from '../../../lib/repair-runs/server';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function POST(request: Request) {
  return (await getRepairRunHandlers()).start(request);
}
