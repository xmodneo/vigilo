import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { cancelCreatedRepairRun, getRepairRun, RepairRunError } from './flow.ts';
import type { TransactionalRepairQueue } from './queue.ts';
import type { RepairRunResult } from './types.ts';

interface Dependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  queue: TransactionalRepairQueue;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
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
    repairObjective: value.repairObjective,
    createdAt: value.createdAt.toISOString(),
    baselineStartedAt: value.baselineStartedAt?.toISOString() ?? null,
    completedAt: value.completedAt?.toISOString() ?? null,
    stateChangedAt: value.stateChangedAt.toISOString(),
  };
}

/** The controlled beta accepts new operational runs only through reviewed staging. */
export async function rejectLegacyRepairStart(
  request: Request,
  configuration: GitHubAppConfiguration,
  resolveContext: Dependencies['resolveContext'],
): Promise<Response> {
  if (request.headers.get('origin') !== configuration.baseUrl) {
    return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
  }
  try {
    await resolveContext(request.headers);
    return Response.json({ error: 'reviewed_start_required' }, { status: 410, headers: noStore });
  } catch (error) {
    if (error instanceof AccessDeniedError) return redirect(configuration.baseUrl, '/sign-in');
    return Response.json({ error: 'repair_run_unavailable' }, { status: 502, headers: noStore });
  }
}

export function createRepairRunHandlers(dependencies: Dependencies) {
  return {
    start(request: Request) {
      return rejectLegacyRepairStart(request, dependencies.configuration, dependencies.resolveContext);
    },
    async cancel(request: Request, runId: string) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
      }
      try {
        const context = await dependencies.resolveContext(request.headers);
        if (!RUN_ID.test(runId)) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
        await cancelCreatedRepairRun(dependencies.database, context, runId);
        return redirect(dependencies.configuration.baseUrl, `/app/github?repairRun=${encodeURIComponent(runId)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof RepairRunError ? error.code : 'repair_run_unavailable';
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
