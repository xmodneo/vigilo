import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { getCurrentRepositoryBaseline } from './flow.ts';

interface Dependencies {
  database: VigiloDatabase;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
}

export function legacyBaselineExecutionUnavailable(): Response {
  return Response.json(
    { error: 'legacy_baseline_execution_unavailable' },
    { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'private, no-store' } },
  );
}

export function publicBaseline(value: Awaited<ReturnType<typeof getCurrentRepositoryBaseline>>) {
  if (!value) return null;
  return {
    baseRevision: value.baseCommitSha,
    build: value.buildStatus,
    cleanup: value.cleanupStop === 'confirmed' && value.cleanupDelete === 'confirmed' && value.cleanupLookup === 'absent' ? 'confirmed' as const : 'unconfirmed' as const,
    install: value.installStatus,
    networkIsolation: value.networkPolicy === 'deny-all' ? 'confirmed' as const : 'unconfirmed' as const,
    outcome: value.overallOutcome,
    test: value.testStatus,
    typecheck: value.typecheckStatus,
  };
}

export function createRepositoryBaselineHandlers(dependencies: Dependencies) {
  return {
    async current(request: Request) {
      try {
        const context = await dependencies.resolveContext(request.headers);
        return Response.json({ baseline: publicBaseline(await getCurrentRepositoryBaseline(dependencies.database, context)) }, { headers: { 'Cache-Control': 'private, no-store' } });
      } catch (error) {
        return Response.json({ error: error instanceof AccessDeniedError ? 'unauthorized' : 'baseline_unavailable' }, { status: error instanceof AccessDeniedError ? 401 : 502, headers: { 'Cache-Control': 'private, no-store' } });
      }
    },
    async run(_request: Request) {
      return legacyBaselineExecutionUnavailable();
    },
  };
}
