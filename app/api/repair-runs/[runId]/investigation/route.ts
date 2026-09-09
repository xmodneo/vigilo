import { getInvestigationHandlers } from '../../../../../lib/investigations/server';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return (await getInvestigationHandlers()).create(request, runId);
}
