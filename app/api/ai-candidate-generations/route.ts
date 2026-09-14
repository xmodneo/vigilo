import { getAiCandidateGenerationHandlers } from '../../../lib/ai-candidate-generations/server.ts';

export async function POST(request: Request) { return (await getAiCandidateGenerationHandlers()).start(request); }
