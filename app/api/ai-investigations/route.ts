import { getAiInvestigationHandlers } from '../../../lib/ai-investigations/server.ts';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return (await getAiInvestigationHandlers()).start(request); }
