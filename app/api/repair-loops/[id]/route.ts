import { getRepairLoopHandlers } from '../../../../lib/repair-loops/server.ts';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return (await getRepairLoopHandlers()).read(request, (await context.params).id); }
