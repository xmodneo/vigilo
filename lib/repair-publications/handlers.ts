import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { HumanReviewError } from '../human-reviews/flow.ts';
import type { TransactionalRepairPublicationQueue } from '../repair-runs/queue.ts';
import { createRepairPublication, getRepairPublicationHistory, RepairPublicationError } from './flow.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const MAX_BODY_BYTES = 1_024;

interface Dependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  queue: TransactionalRepairPublicationQueue;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace>;
}

const redirect = (baseUrl: string, path: string) => new Response(null, { status: 303, headers: { ...NO_STORE, Location: new URL(path, baseUrl).toString() } });

async function parseInput(request: Request) {
  const mediaType = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
  const declared = request.headers.get('content-length');
  if (mediaType !== 'application/x-www-form-urlencoded' || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))) throw new RepairPublicationError('publication_invalid_request');
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (reader) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new Error(); } chunks.push(value); }
  } catch { throw new RepairPublicationError('publication_invalid_request'); }
  const form = new URLSearchParams(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  const allowed = ['confirmation', 'decisionIdentity', 'idempotencyKey'];
  if ([...form.keys()].some((key) => !allowed.includes(key)) || allowed.some((key) => form.getAll(key).length !== 1)) throw new RepairPublicationError('publication_invalid_request');
  const confirmation = form.get('confirmation'); const decisionIdentity = form.get('decisionIdentity'); const idempotencyKey = form.get('idempotencyKey');
  if (confirmation !== 'publish_draft' || !decisionIdentity || !HASH.test(decisionIdentity) || !idempotencyKey || !UUID.test(idempotencyKey)) throw new RepairPublicationError('publication_invalid_request');
  return { decisionIdentity, idempotencyKey };
}

export function createRepairPublicationHandlers(dependencies: Dependencies) {
  return {
    async create(request: Request, repairRunId: string): Promise<Response> {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
      try {
        const context = await dependencies.resolveContext(request.headers);
        if (!UUID.test(repairRunId)) throw new RepairPublicationError('publication_not_found');
        const input = await parseInput(request);
        const publication = await createRepairPublication(dependencies.database, context, dependencies.queue, repairRunId, input);
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairRun=${encodeURIComponent(repairRunId)}&publication=${encodeURIComponent(publication.id)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof RepairPublicationError || error instanceof HumanReviewError ? error.code : 'publication_unavailable';
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairRun=${encodeURIComponent(repairRunId)}&error=${encodeURIComponent(code)}`);
      }
    },
    async read(request: Request, repairRunId: string): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        if (!UUID.test(repairRunId)) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
        const result = await getRepairPublicationHistory(dependencies.database, context, repairRunId);
        return Response.json({ publication: result.publication ? { ...result.publication, createdAt: result.publication.createdAt.toISOString(), completedAt: result.publication.completedAt?.toISOString() ?? null } : null, events: result.events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })) }, { headers: NO_STORE });
      } catch (error) {
        return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'publication_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: NO_STORE });
      }
    },
  };
}
