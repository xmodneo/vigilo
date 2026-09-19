import { getRepairLoopHandlers } from '../../../lib/repair-loops/server.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) { return (await getRepairLoopHandlers()).start(request); }
