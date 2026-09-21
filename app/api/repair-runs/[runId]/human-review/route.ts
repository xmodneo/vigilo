import { getHumanReviewHandlers } from '../../../../../lib/human-reviews/server.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return getHumanReviewHandlers().read(request, runId);
}
