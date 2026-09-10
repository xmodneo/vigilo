import { getCandidateVerificationHandlers } from '../../../../lib/candidate-verifications/server';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ verificationId: string }> }) {
  const { verificationId } = await context.params;
  return (await getCandidateVerificationHandlers()).read(request, verificationId);
}
