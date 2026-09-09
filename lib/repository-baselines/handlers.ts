import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import { BaselineAuthorityError } from './authority.ts';
import { executeSelectedRepositoryBaseline, getCurrentRepositoryBaseline, RepositoryBaselineError } from './flow.ts';
import type { GitHubBaselineGateway } from './types.ts';

interface Dependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: GitHubBaselineGateway;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
  execute?: typeof executeSelectedRepositoryBaseline;
}

function redirect(baseUrl: string, path: string) {
  return new Response(null, { status: 303, headers: { 'Cache-Control': 'private, no-store', Location: new URL(path, baseUrl).toString() } });
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
    async run(request: Request) {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
        return Response.json({ error: 'forbidden' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
      }
      try {
        const context = await dependencies.resolveContext(request.headers);
        const result = await (dependencies.execute ?? executeSelectedRepositoryBaseline)(dependencies.database, context, dependencies.gateway, dependencies.configuration, { cancellation: request.signal });
        return redirect(dependencies.configuration.baseUrl, `/app/github?baseline=${encodeURIComponent(result.overallOutcome)}`);
      } catch (error) {
        if (error instanceof AccessDeniedError) return redirect(dependencies.configuration.baseUrl, '/sign-in');
        const code = error instanceof BaselineAuthorityError ? error.code : error instanceof RepositoryBaselineError ? error.code : 'baseline_unavailable';
        return redirect(dependencies.configuration.baseUrl, `/app/github?error=${encodeURIComponent(code)}`);
      }
    },
  };
}
