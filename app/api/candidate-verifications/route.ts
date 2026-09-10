import { getCandidateVerificationHandlers } from '../../../lib/candidate-verifications/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return (await getCandidateVerificationHandlers()).start(request);
}
