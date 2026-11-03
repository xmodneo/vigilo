import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { ExpiredAiRetirementTarget } from './expired-retirement.ts';

const MAX_FORM_BYTES = 512;
const NO_STORE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'same-origin' };

interface Dependencies {
  baseUrl: string;
  target: ExpiredAiRetirementTarget;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace>;
  retire(context: AuthenticatedWorkspace): Promise<'retired' | 'already_retired'>;
}

async function validConfirmation(request: Request, target: ExpiredAiRetirementTarget): Promise<boolean> {
  if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return false;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_FORM_BYTES)) return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) { await reader.cancel(); return false; }
    chunks.push(value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return [...form.keys()].every((key) => ['repairRunId', 'aiInvestigationId', 'confirmation'].includes(key)) &&
    form.getAll('repairRunId').length === 1 && form.get('repairRunId') === target.repairRunId &&
    form.getAll('aiInvestigationId').length === 1 && form.get('aiInvestigationId') === target.aiInvestigationId &&
    form.getAll('confirmation').length === 1 && form.get('confirmation') === 'retire-expired-unstarted-ai';
}

export function createExpiredAiRetirementHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST' || request.headers.get('origin') !== dependencies.baseUrl ||
        (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin'))
      return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    try {
      const context = await dependencies.resolveContext(request.headers);
      if (context.user.id !== context.workspace.ownerUserId ||
          !await validConfirmation(request, dependencies.target))
        return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
      const result = await dependencies.retire(context);
      return Response.json({ result }, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof AccessDeniedError) return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
      return Response.json({ error: 'expired_ai_retirement_unavailable' }, { status: 409, headers: NO_STORE });
    }
  };
}
