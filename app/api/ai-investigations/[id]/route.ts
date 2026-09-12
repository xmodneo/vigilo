import { getAiInvestigationHandlers } from '../../../../lib/ai-investigations/server.ts';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return (await getAiInvestigationHandlers()).read(request, (await context.params).id); }
