import { getInvestigationHandlers } from '../../../../../lib/investigations/server';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ investigationId: string }> }) {
  const { investigationId } = await context.params;
  return (await getInvestigationHandlers()).baseline(request, investigationId);
}
