import { and, eq } from 'drizzle-orm';

import { repairRun } from '../../db/schema.ts';
import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { createHumanReviewDecision, getHumanReview, HumanReviewError } from './flow.ts';
import type { HumanReviewDecision } from './identity.ts';

interface Dependencies {
  configuration: { baseUrl: string };
  database: VigiloDatabase;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const MAX_DECISION_BYTES = 1_024;

function redirect(baseUrl: string, path: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, Location: new URL(path, baseUrl).toString() } });
}

async function parseDecision(request: Request): Promise<{
  decision: HumanReviewDecision;
  reviewSubjectIdentity: string;
  idempotencyKey: string;
}> {
  const contentType = request.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  const declaredLength = request.headers.get('content-length');
  if (mediaType !== 'application/x-www-form-urlencoded' ||
      (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_DECISION_BYTES))) {
    throw new HumanReviewError('invalid_decision');
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_DECISION_BYTES) {
        await reader.cancel();
        throw new HumanReviewError('invalid_decision');
      }
      chunks.push(value);
    }
  } catch {
    throw new HumanReviewError('invalid_decision');
  }
  const form = new URLSearchParams(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  const allowed = ['decision', 'reviewSubjectIdentity', 'idempotencyKey'];
  if ([...form.keys()].some((key) => !allowed.includes(key)) || allowed.some((key) => form.getAll(key).length !== 1)) {
    throw new HumanReviewError('invalid_decision');
  }
  const decision = form.get('decision');
  const reviewSubjectIdentity = form.get('reviewSubjectIdentity');
  const idempotencyKey = form.get('idempotencyKey');
  if ((decision !== 'approved' && decision !== 'rejected') || typeof reviewSubjectIdentity !== 'string' || !HASH.test(reviewSubjectIdentity) ||
      typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) throw new HumanReviewError('invalid_decision');
  return { decision, reviewSubjectIdentity, idempotencyKey };
}

export function createHumanReviewHandlers(dependencies: Dependencies) {
  return {
    async read(request: Request, repairRunId: string): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        if (!UUID.test(repairRunId)) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
        const [owned] = await dependencies.database.select({ id: repairRun.id }).from(repairRun).where(and(eq(repairRun.id, repairRunId), eq(repairRun.workspaceId, context.workspace.id))).limit(1);
        if (!owned) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
        const review = await getHumanReview(dependencies.database, context, repairRunId);
        return Response.json({ humanReview: review }, { headers: NO_STORE });
      } catch (error) {
        if (error instanceof AccessDeniedError) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
        return Response.json({ error: 'human_review_unavailable' }, { status: 502, headers: NO_STORE });
      }
    },
    async decide(request: Request, repairRunId: string): Promise<Response> {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
      }
      try {
        const context = await dependencies.resolveContext(request.headers);
        if (!UUID.test(repairRunId)) throw new HumanReviewError('human_review_not_found');
        const input = await parseDecision(request);
        const decision = await createHumanReviewDecision(dependencies.database, context, repairRunId, input);
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairRun=${encodeURIComponent(repairRunId)}&humanReview=${encodeURIComponent(decision.id)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof HumanReviewError ? error.code : 'human_review_unavailable';
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairRun=${encodeURIComponent(repairRunId)}&error=${encodeURIComponent(code)}`);
      }
    },
  };
}
