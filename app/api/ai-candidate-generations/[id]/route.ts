import { getAiCandidateGenerationHandlers } from '../../../../lib/ai-candidate-generations/server.ts';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return (await getAiCandidateGenerationHandlers()).read(request, (await context.params).id); }
