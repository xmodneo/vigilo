import { getReadinessResult } from '../../../../lib/operations/readiness.ts';

export async function GET(): Promise<Response> {
  const result = await getReadinessResult();
  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
