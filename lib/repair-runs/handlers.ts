import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { BaselineAuthorityError } from '../repository-baselines/authority.ts';
import type { GitHubBaselineGateway } from '../repository-baselines/types.ts';
import { getRepairRun, RepairRunError, startRepairRun } from './flow.ts';
import type { RepairRunResult } from './types.ts';

interface Dependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: GitHubBaselineGateway;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
  start?: typeof startRepairRun;
}

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = IDEMPOTENCY_KEY;
const noStore = { 'Cache-Control': 'private, no-store' };

function redirect(baseUrl: string, path: string) {
  return new Response(null, { status: 303, headers: { ...noStore, Location: new URL(path, baseUrl).toString() } });
}

export function publicRepairRun(value: RepairRunResult | null) {
  if (!value) return null;
  return {
    id: value.id,
    state: value.state,
    repositoryId: value.identity.githubRepositoryId,
    revision: value.identity.baseCommitSha,
    profileIdentity: value.identity.profileIdentity,
    baseline: value.baselineId ? {
      evidenceId: value.baselineId,
      outcome: value.baselineOutcome,
    } : null,
    failure: value.failureClassification ? {
      classification: value.failureClassification,
      code: value.failureCode,
    } : null,
    createdAt: value.createdAt.toISOString(),
    baselineStartedAt: value.baselineStartedAt?.toISOString() ?? null,
    completedAt: value.completedAt?.toISOString() ?? null,
    stateChangedAt: value.stateChangedAt.toISOString(),
  };
}

async function parseStartIntent(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!contentType.startsWith('application/x-www-form-urlencoded') || !Number.isSafeInteger(contentLength) || contentLength > 2_048) {
    throw new RepairRunError('invalid_idempotency_key');
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new RepairRunError('invalid_idempotency_key');
  }
  if ([...form.keys()].some((key) => key !== 'idempotencyKey') || form.getAll('idempotencyKey').length !== 1) {
    throw new RepairRunError('invalid_idempotency_key');
  }
  const value = form.get('idempotencyKey');
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw new RepairRunError('invalid_idempotency_key');
  return value;
}

export function createRepairRunHandlers(dependencies: Dependencies) {
  return {
    async start(request: Request) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      }
      try {
        const context = await dependencies.resolveContext(request.headers);
        const idempotencyKey = await parseStartIntent(request);
        const run = await (dependencies.start ?? startRepairRun)(dependencies.database, context, dependencies.gateway, dependencies.configuration, idempotencyKey, { cancellation: request.signal });
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairRun=${encodeURIComponent(run.id)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof BaselineAuthorityError || error instanceof RepairRunError ? error.code : 'repair_run_unavailable';
        return redirect(dependencies.configuration.baseUrl, `/app/github?error=${encodeURIComponent(code)}`);
      }
    },
    async read(request: Request, runId: string) {
      try {
        const context = await dependencies.resolveContext(request.headers);
        if (!RUN_ID.test(runId)) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        const run = await getRepairRun(dependencies.database, context, runId);
        if (!run) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        return Response.json({ repairRun: publicRepairRun(run) }, { headers: noStore });
      } catch (error) {
        return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'repair_run_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: noStore });
      }
    },
  };
}
