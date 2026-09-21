import { getHumanReviewHandlers } from '../../../../../lib/human-reviews/server.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return getHumanReviewHandlers().decide(request, runId);
}
