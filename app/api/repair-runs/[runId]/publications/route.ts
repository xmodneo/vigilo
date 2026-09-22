import { getRepairPublicationHandlers } from '../../../../../lib/repair-publications/server.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return (await getRepairPublicationHandlers()).read(request, runId);
}

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return (await getRepairPublicationHandlers()).create(request, runId);
}
