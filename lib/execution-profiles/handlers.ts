import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import {
  detectSelectedRepositoryExecutionProfile,
  ExecutionProfileError,
  getCurrentExecutionProfile,
} from './flow.ts';
import type { GitHubExecutionProfileGateway } from './types.ts';

interface HandlerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: GitHubExecutionProfileGateway;
  now?: () => Date;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: { 'Cache-Control': 'private, no-store' },
    status,
  });
}

function redirect(baseUrl: string, path: string): Response {
  return new Response(null, {
    headers: {
      'Cache-Control': 'private, no-store',
      Location: new URL(path, baseUrl).toString(),
    },
    status: 303,
  });
}

export function publicExecutionProfile(
  value: Awaited<ReturnType<typeof getCurrentExecutionProfile>>,
) {
  if (!value) return null;
  if (value.status === 'unsupported') {
    return {
      baseRevision: value.baseCommitSha,
      profileVersion: value.profileVersion,
      reason: value.unsupportedReason,
      status: 'unsupported' as const,
    };
  }
  return {
    baseRevision: value.baseCommitSha,
    build: value.buildScript ? { script: 'build' as const, tool: 'npm' as const } : null,
    install: { operation: 'ci' as const, tool: 'npm' as const },
    nodeMajor: value.nodeMajor,
    packageManager: value.packageManager,
    profileIdentity: value.profileIdentity,
    profileVersion: value.profileVersion,
    runtimeFamily: value.runtimeFamily,
    status: 'ready' as const,
    test: { script: 'test' as const, tool: 'npm' as const },
    testRunner: value.testRunner,
    typecheck: value.typecheckScript
      ? { script: 'typecheck' as const, tool: 'npm' as const }
      : null,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof AccessDeniedError) return json({ error: 'unauthorized' }, 401);
  if (error instanceof ExecutionProfileError) {
    const status = error.code === 'repository_not_selected' ? 409 : 502;
    return json({ error: error.code }, status);
  }
  return json({ error: 'profile_detection_unavailable' }, 502);
}

export function createExecutionProfileHandlers(dependencies: HandlerDependencies) {
  return {
    async current(request: Request): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        return json({
          profile: publicExecutionProfile(
            await getCurrentExecutionProfile(dependencies.database, context),
          ),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async detect(request: Request): Promise<Response> {
      if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
        return json({ error: 'forbidden' }, 403);
      }
      try {
        const context = await dependencies.resolveContext(request.headers);
        const profile = await detectSelectedRepositoryExecutionProfile(
          dependencies.database,
          context,
          dependencies.gateway,
          dependencies.configuration,
          dependencies.now?.() ?? new Date(),
        );
        return redirect(
          dependencies.configuration.baseUrl,
          profile.status === 'ready'
            ? '/app/github?profile=ready'
            : '/app/github?profile=unsupported',
        );
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return redirect(dependencies.configuration.baseUrl, '/sign-in');
        }
        return redirect(
          dependencies.configuration.baseUrl,
          '/app/github?error=profile_detection_failed',
        );
      }
    },
  };
}
