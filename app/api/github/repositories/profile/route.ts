import { getExecutionProfileHandlers } from '../../../../../lib/execution-profiles/server';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return (await getExecutionProfileHandlers()).current(request);
}

export async function POST(request: Request): Promise<Response> {
  return (await getExecutionProfileHandlers()).detect(request);
}
