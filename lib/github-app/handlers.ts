import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import {
  beginGitHubInstallation,
  completeGitHubInstallation,
  continueGitHubInstallation,
} from './flow.ts';
import type {
  GitHubAppConfiguration,
  GitHubInstallationGateway,
} from './types.ts';

interface HandlerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: GitHubInstallationGateway;
  now?: () => Date;
  randomToken?: () => string;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
}

function jsonError(error: 'forbidden' | 'unauthorized', status: 401 | 403): Response {
  return Response.json(
    { error },
    { headers: { 'Cache-Control': 'no-store' }, status },
  );
}

function redirect(baseUrl: string, path: string): Response {
  return new Response(null, {
    headers: {
      'Cache-Control': 'no-store',
      Location: new URL(path, baseUrl).toString(),
    },
    status: 303,
  });
}

function externalRedirect(url: string): Response {
  return new Response(null, {
    headers: { 'Cache-Control': 'no-store', Location: url },
    status: 303,
  });
}

export function createGitHubInstallationHandlers(dependencies: HandlerDependencies) {
  const now = () => dependencies.now?.() ?? new Date();
  const flowOptions = () => ({
    now: now(),
    ...(dependencies.randomToken ? { randomToken: dependencies.randomToken } : {}),
  });

  return {
    async start(request: Request): Promise<Response> {
      try {
        if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
          return jsonError('forbidden', 403);
        }
        const context = await dependencies.resolveContext(request.headers);
        const result = await beginGitHubInstallation(
          dependencies.database,
          context,
          dependencies.configuration,
          flowOptions(),
        );
        return externalRedirect(result.redirectUrl);
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return jsonError('unauthorized', 401);
        }
        return Response.json(
          { error: 'connection_failed' },
          { headers: { 'Cache-Control': 'no-store' }, status: 400 },
        );
      }
    },

    async setup(request: Request): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        const url = new URL(request.url);
        const result = await continueGitHubInstallation(
          dependencies.database,
          context,
          dependencies.configuration,
          {
            installationId: url.searchParams.get('installation_id') ?? '',
            setupAction: url.searchParams.get('setup_action'),
            state: url.searchParams.get('state') ?? '',
          },
          flowOptions(),
        );
        return externalRedirect(result.redirectUrl);
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return redirect(dependencies.configuration.baseUrl, '/sign-in');
        }
        return redirect(
          dependencies.configuration.baseUrl,
          '/app/github?error=connection_failed',
        );
      }
    },

    async callback(request: Request): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        const url = new URL(request.url);
        await completeGitHubInstallation(
          dependencies.database,
          context,
          dependencies.gateway,
          dependencies.configuration,
          {
            code: url.searchParams.get('code') ?? '',
            state: url.searchParams.get('state') ?? '',
          },
          { now: now() },
        );
        return redirect(dependencies.configuration.baseUrl, '/app/github?connected=1');
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return redirect(dependencies.configuration.baseUrl, '/sign-in');
        }
        return redirect(
          dependencies.configuration.baseUrl,
          '/app/github?error=connection_failed',
        );
      }
    },
  };
}
