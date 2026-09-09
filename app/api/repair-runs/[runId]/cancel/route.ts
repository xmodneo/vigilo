import { getRepairRunHandlers } from '../../../../../lib/repair-runs/server';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return (await getRepairRunHandlers()).cancel(request, runId);
}
