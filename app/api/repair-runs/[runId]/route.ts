import { getRepairRunHandlers } from '../../../../lib/repair-runs/server';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return (await getRepairRunHandlers()).read(request, runId);
}
