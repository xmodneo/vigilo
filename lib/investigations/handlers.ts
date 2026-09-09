import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { createInvestigation, getInvestigation, InvestigationError } from './flow.ts';
import { InvestigationContextError, listPaths, readBaselineSummary, readTextFile, searchText } from './context.ts';
import type { InvestigationSourceGateway } from './types.ts';
import type { TransactionalInvestigationQueue } from '../repair-runs/queue.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

interface Dependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: InvestigationSourceGateway;
  queue: TransactionalInvestigationQueue;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace>;
}

function redirect(baseUrl: string, path: string) {
  return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(path, baseUrl).toString() } });
}

export function publicInvestigation(value: Awaited<ReturnType<typeof getInvestigation>>) {
  if (!value) return null;
  return {
    id: value.id, repairRunId: value.repairRunId, repairObjective: value.repairObjective,
    state: value.state, revision: value.baseCommitSha, profileIdentity: value.profileIdentity,
    baselineAvailable: Boolean(value.baselineId), treeSha: value.treeSha,
    indexedPathCount: value.indexedPathCount, excludedPathCount: value.excludedPathCount,
    treeTruncated: value.treeTruncated, contextBudget: value.contextBudget,
    failureCode: value.failureCode, createdAt: value.createdAt.toISOString(),
    completedAt: value.completedAt?.toISOString() ?? null, updatedAt: value.updatedAt.toISOString(),
  };
}

async function form(request: Request, fields: readonly string[]): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!contentType.startsWith('application/x-www-form-urlencoded') || !Number.isSafeInteger(length) || length > 2_048) throw new InvestigationContextError('invalid_context_request');
  let value: FormData;
  try { value = await request.formData(); } catch { throw new InvestigationContextError('invalid_context_request'); }
  if ([...value.keys()].some((key) => !fields.includes(key)) || fields.some((key) => value.getAll(key).length !== 1)) throw new InvestigationContextError('invalid_context_request');
  return value;
}

function status(error: unknown): number {
  if (error instanceof AccessDeniedError) return 401;
  if (error instanceof InvestigationContextError) {
    if (['investigation_not_found', 'path_not_found'].includes(error.code)) return 404;
    if (['investigation_not_ready', 'context_operation_replayed', 'context_budget_exhausted'].includes(error.code)) return 409;
    if (['context_source_unavailable', 'content_identity_mismatch'].includes(error.code)) return 502;
    return 422;
  }
  if (error instanceof InvestigationError) return error.code === 'repair_run_not_found' ? 404 : error.code.includes('not_eligible') || error.code.includes('conflict') ? 409 : 422;
  return 502;
}

function code(error: unknown): string {
  return error instanceof AccessDeniedError ? 'unauthorized' : error instanceof InvestigationError || error instanceof InvestigationContextError ? error.code : 'investigation_unavailable';
}

export function createInvestigationHandlers(dependencies: Dependencies) {
  const contextFor = (request: Request) => dependencies.resolveContext(request.headers);
  const sameOrigin = (request: Request) => request.headers.get('origin') === dependencies.configuration.baseUrl;
  return {
    async create(request: Request, repairRunId: string) {
      if (!sameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const context = await contextFor(request);
        const body = await form(request, ['idempotencyKey']);
        const idempotencyKey = body.get('idempotencyKey');
        if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) throw new InvestigationError('invalid_investigation_request');
        const value = await createInvestigation(dependencies.database, context, repairRunId, idempotencyKey, dependencies.queue);
        return redirect(dependencies.configuration.baseUrl, `/app/github?investigation=${encodeURIComponent(value.id)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        return redirect(dependencies.configuration.baseUrl, `/app/github?error=${encodeURIComponent(code(error))}`);
      }
    },
    async read(request: Request, investigationId: string) {
      try {
        const value = await getInvestigation(dependencies.database, await contextFor(request), investigationId);
        if (!value) return Response.json({ error: 'investigation_not_found' }, { status: 404, headers: noStore });
        return Response.json({ investigation: publicInvestigation(value) }, { headers: noStore });
      } catch (error) { return Response.json({ error: code(error) }, { status: status(error), headers: noStore }); }
    },
    async paths(request: Request, investigationId: string) {
      if (!sameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const body = await form(request, ['operationId', 'limit']);
        const operationId = body.get('operationId'); const limit = Number(body.get('limit'));
        if (typeof operationId !== 'string') throw new InvestigationContextError('invalid_context_request');
        return Response.json(await listPaths(dependencies.database, await contextFor(request), investigationId, operationId, limit), { headers: noStore });
      } catch (error) { return Response.json({ error: code(error) }, { status: status(error), headers: noStore }); }
    },
    async file(request: Request, investigationId: string) {
      if (!sameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const body = await form(request, ['operationId', 'path']);
        const operationId = body.get('operationId'); const path = body.get('path');
        if (typeof operationId !== 'string') throw new InvestigationContextError('invalid_context_request');
        return Response.json(await readTextFile(dependencies.database, await contextFor(request), dependencies.gateway, dependencies.configuration, investigationId, operationId, path), { headers: noStore });
      } catch (error) { return Response.json({ error: code(error) }, { status: status(error), headers: noStore }); }
    },
    async search(request: Request, investigationId: string) {
      if (!sameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const body = await form(request, ['operationId', 'query']);
        const operationId = body.get('operationId'); const query = body.get('query');
        if (typeof operationId !== 'string') throw new InvestigationContextError('invalid_context_request');
        return Response.json(await searchText(dependencies.database, await contextFor(request), dependencies.gateway, dependencies.configuration, investigationId, operationId, query), { headers: noStore });
      } catch (error) { return Response.json({ error: code(error) }, { status: status(error), headers: noStore }); }
    },
    async baseline(request: Request, investigationId: string) {
      if (!sameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const body = await form(request, ['operationId']); const operationId = body.get('operationId');
        if (typeof operationId !== 'string') throw new InvestigationContextError('invalid_context_request');
        return Response.json(await readBaselineSummary(dependencies.database, await contextFor(request), investigationId, operationId), { headers: noStore });
      } catch (error) { return Response.json({ error: code(error) }, { status: status(error), headers: noStore }); }
    },
  };
}
