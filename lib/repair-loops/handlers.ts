import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import type { RepairLoopQueues } from './flow.ts';
import { getRepairLoop, RepairLoopFlowError, startRepairLoop } from './flow.ts';
import type { RepairLoopResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noStore = { 'Cache-Control': 'private, no-store' };

export function publicRepairLoop(value: RepairLoopResult | null) {
  if (!value) return null;
  return {
    id: value.id, repairRunId: value.repairRunId, investigationId: value.investigationId,
    state: value.state, maxIterations: value.maxIterations, selectedCandidateId: value.selectedCandidateId,
    selectedVerificationId: value.selectedVerificationId, selectedEvidenceId: value.selectedEvidenceId,
    failureClassification: value.failureClassification, failureCode: value.failureCode,
    iterations: value.iterations.map((iteration) => ({ ...iteration, createdAt: iteration.createdAt.toISOString(), decidedAt: iteration.decidedAt?.toISOString() ?? null })),
    createdAt: value.createdAt.toISOString(), completedAt: value.completedAt?.toISOString() ?? null,
  };
}

interface Dependencies {
  database: VigiloDatabase;
  configuration: GitHubAppConfiguration;
  queues: RepairLoopQueues;
  resolveContext(headers: Headers): Promise<AuthenticatedWorkspace>;
}

const redirect = (baseUrl: string, path: string) => new Response(null, { status: 303, headers: { ...noStore, Location: new URL(path, baseUrl).toString() } });

export function createRepairLoopHandlers(dependencies: Dependencies) {
  return {
    async start(request: Request) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      try {
        const context = await dependencies.resolveContext(request.headers);
        const type = request.headers.get('content-type') ?? ''; const declaredLength = Number(request.headers.get('content-length') ?? '0');
        if (!type.startsWith('application/x-www-form-urlencoded') || !Number.isSafeInteger(declaredLength) || declaredLength > 512) throw new RepairLoopFlowError('repair_loop_not_eligible');
        const body = await request.text(); if (Buffer.byteLength(body, 'utf8') > 512) throw new RepairLoopFlowError('repair_loop_not_eligible');
        const form = new URLSearchParams(body);
        if ([...form.keys()].some((key) => !['repairRunId', 'idempotencyKey'].includes(key)) || form.getAll('repairRunId').length !== 1 || form.getAll('idempotencyKey').length !== 1) throw new RepairLoopFlowError('repair_loop_not_eligible');
        const repairRunId = form.get('repairRunId'); const idempotencyKey = form.get('idempotencyKey');
        if (!repairRunId || !idempotencyKey || !UUID.test(repairRunId) || !UUID.test(idempotencyKey)) throw new RepairLoopFlowError('repair_loop_not_eligible');
        const value = await startRepairLoop(dependencies.database, context, repairRunId, dependencies.queues, { idempotencyKey });
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairLoop=${encodeURIComponent(value.id)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof RepairLoopFlowError ? error.code : 'repair_loop_unavailable';
        return redirect(dependencies.configuration.baseUrl, `/app/github?error=${encodeURIComponent(code)}`);
      }
    },
    async read(request: Request, id: string) {
      try {
        const value = await getRepairLoop(dependencies.database, await dependencies.resolveContext(request.headers), id);
        return value ? Response.json({ repairLoop: publicRepairLoop(value) }, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
      } catch (error) { return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'repair_loop_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: noStore }); }
    },
  };
}
