import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { AiCandidateGenerationFlowError, getAiCandidateGeneration, startAiCandidateGeneration } from './flow.ts';
import type { TransactionalAiCandidateGenerationQueue } from '../repair-runs/queue.ts';
import type { AiCandidateGenerationResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

export function publicAiCandidateGeneration(value: AiCandidateGenerationResult | null) {
  if (!value) return null;
  return { id: value.id, aiInvestigationId: value.aiInvestigationId, executionOrdinal: value.executionOrdinal, investigationId: value.investigationId, state: value.state, revision: value.revision, provider: value.providerId, model: value.modelId, protocolVersion: value.protocolVersion, repairCandidateId: value.repairCandidateId, completionReason: value.completionReason, usage: value.usage, failureCode: value.failureCode, createdAt: value.createdAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null };
}

interface Dependencies { database: VigiloDatabase; configuration: GitHubAppConfiguration; queue: TransactionalAiCandidateGenerationQueue; resolveContext(headers: Headers): Promise<AuthenticatedWorkspace> }

export function createAiCandidateGenerationHandlers(dependencies: Dependencies) {
  return {
    async start(request: Request) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const context = await dependencies.resolveContext(request.headers); const type = request.headers.get('content-type') ?? ''; const declaredLength = request.headers.get('content-length');
        if (!type.startsWith('application/x-www-form-urlencoded') || (declaredLength !== null && (!Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > 512))) throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
        const rawBody = await request.text(); if (Buffer.byteLength(rawBody, 'utf8') > 512) throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
        const form = new URLSearchParams(rawBody);
        if ([...form.keys()].some((key) => !['aiInvestigationId', 'idempotencyKey'].includes(key)) || form.getAll('aiInvestigationId').length !== 1 || form.getAll('idempotencyKey').length !== 1) throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
        const aiInvestigationId = form.get('aiInvestigationId'); const idempotencyKey = form.get('idempotencyKey');
        if (!aiInvestigationId || !idempotencyKey || !UUID.test(aiInvestigationId) || !UUID.test(idempotencyKey)) throw new AiCandidateGenerationFlowError('candidate_generation_not_eligible');
        const value = await startAiCandidateGeneration(dependencies.database, context, aiInvestigationId, dependencies.queue, { idempotencyKey });
        return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(`/app/github?aiCandidateGeneration=${encodeURIComponent(value.id)}`, dependencies.configuration.baseUrl).toString() } });
      } catch (error) {
        if (error instanceof AccessDeniedError) return new Response(null, { status: 303, headers: { ...noStore, Location: new URL('/sign-in', dependencies.configuration.baseUrl).toString() } });
        const code = error instanceof AiCandidateGenerationFlowError ? error.code : 'ai_candidate_generation_unavailable';
        return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(`/app/github?error=${encodeURIComponent(code)}`, dependencies.configuration.baseUrl).toString() } });
      }
    },
    async read(request: Request, id: string) {
      try {
        if (!UUID.test(id)) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        const value = await getAiCandidateGeneration(dependencies.database, await dependencies.resolveContext(request.headers), id);
        return value ? Response.json({ aiCandidateGeneration: publicAiCandidateGeneration(value) }, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
      } catch (error) { return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'ai_candidate_generation_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: noStore }); }
    },
  };
}
