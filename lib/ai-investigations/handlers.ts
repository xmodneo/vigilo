import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { TransactionalAiInvestigationQueue } from '../repair-runs/queue.ts';
import { AiInvestigationFlowError, getAiInvestigation, startAiInvestigation } from './flow.ts';
import type { AiInvestigationResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

export function publicAiInvestigation(value: AiInvestigationResult | null) {
  if (!value) return null;
  return { id: value.id, investigationId: value.investigationId, executionOrdinal: value.executionOrdinal, state: value.state, revision: value.revision, provider: value.providerId, model: value.modelId, protocolVersion: value.protocolVersion, completionReason: value.completionReason, conclusion: value.conclusion, usage: value.usage, failureCode: value.failureCode, createdAt: value.createdAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null };
}

interface Dependencies { database: VigiloDatabase; configuration: GitHubAppConfiguration; queue: TransactionalAiInvestigationQueue; resolveContext(headers: Headers): Promise<AuthenticatedWorkspace> }

export function createAiInvestigationHandlers(dependencies: Dependencies) {
  return {
    async start(request: Request) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const context = await dependencies.resolveContext(request.headers);
        const type = request.headers.get('content-type') ?? ''; const declaredLength = request.headers.get('content-length');
        if (!type.startsWith('application/x-www-form-urlencoded') || (declaredLength !== null && (!Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > 512))) throw new AiInvestigationFlowError('investigation_not_ready');
        const rawBody = await request.text();
        if (Buffer.byteLength(rawBody, 'utf8') > 512) throw new AiInvestigationFlowError('investigation_not_ready');
        const form = new URLSearchParams(rawBody);
        if ([...form.keys()].some((key) => !['investigationId', 'idempotencyKey'].includes(key)) || form.getAll('investigationId').length !== 1 || form.getAll('idempotencyKey').length !== 1) throw new AiInvestigationFlowError('investigation_not_ready');
        const id = form.get('investigationId'); const idempotencyKey = form.get('idempotencyKey');
        if (id === null || !UUID.test(id) || idempotencyKey === null || !UUID.test(idempotencyKey)) throw new AiInvestigationFlowError('investigation_not_ready');
        const value = await startAiInvestigation(dependencies.database, context, id, dependencies.queue, { idempotencyKey });
        return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(`/app/github?aiInvestigation=${encodeURIComponent(value.id)}`, dependencies.configuration.baseUrl).toString() } });
      } catch (error) {
        if (error instanceof AccessDeniedError) return new Response(null, { status: 303, headers: { ...noStore, Location: new URL('/sign-in', dependencies.configuration.baseUrl).toString() } });
        const code = error instanceof AiInvestigationFlowError ? error.code : 'ai_investigation_unavailable';
        return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(`/app/github?error=${encodeURIComponent(code)}`, dependencies.configuration.baseUrl).toString() } });
      }
    },
    async read(request: Request, id: string) {
      try {
        if (!UUID.test(id)) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        const value = await getAiInvestigation(dependencies.database, await dependencies.resolveContext(request.headers), id);
        return value ? Response.json({ aiInvestigation: publicAiInvestigation(value) }, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
      } catch (error) { return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'ai_investigation_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: noStore }); }
    },
  };
}
