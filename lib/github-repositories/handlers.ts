import { AccessDeniedError, type AuthenticatedWorkspace } from '../auth/protected-context.ts';
import type { VigiloDatabase } from '../db/types.ts';
import type { GitHubAppConfiguration } from '../github-app/types.ts';
import {
  beginRepositoryAuthorization,
  completeRepositoryAuthorization,
  getRepositoryOverview,
  hasRepositoryAccessAttempt,
  RepositoryAccessError,
} from './flow.ts';
import type { GitHubRepositoryAccessGateway } from './types.ts';

interface HandlerDependencies {
  configuration: GitHubAppConfiguration;
  database: VigiloDatabase;
  gateway: GitHubRepositoryAccessGateway;
  now?: () => Date;
  randomToken?: () => string;
  resolveContext: (headers: Headers) => Promise<AuthenticatedWorkspace>;
}

function json(value: object, status = 200): Response {
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

function externalRedirect(url: string): Response {
  return new Response(null, {
    headers: { 'Cache-Control': 'private, no-store', Location: url },
    status: 303,
  });
}

function publicRepository(value: {
  defaultBranch: string | null;
  fullName: string;
  githubRepositoryId?: number;
  id?: number;
  isPrivate: boolean;
  name: string;
  ownerLogin: string;
}) {
  return {
    defaultBranch: value.defaultBranch,
    fullName: value.fullName,
    id: value.id ?? value.githubRepositoryId,
    isPrivate: value.isPrivate,
    name: value.name,
    ownerLogin: value.ownerLogin,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof AccessDeniedError) return json({ error: 'unauthorized' }, 401);
  if (error instanceof RepositoryAccessError) {
    const status = error.code === 'repository_not_eligible' ? 403
      : error.code === 'invalid_repository' || error.code === 'invalid_callback' ? 400
      : error.code === 'installation_required' || error.code === 'repository_conflict' ? 409
      : 502;
    return json({ error: error.code }, status);
  }
  return json({ error: 'repository_access_unavailable' }, 502);
}

async function repositoryIdFrom(request: Request): Promise<unknown> {
  try {
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (!Number.isFinite(declaredLength) || declaredLength > 256) throw new Error();
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 256) throw new Error();
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/json')) {
      return (JSON.parse(text) as Record<string, unknown>).repositoryId;
    }
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
      return new URLSearchParams(text).get('repositoryId');
    }
  } catch {
    throw new RepositoryAccessError('invalid_repository');
  }
  throw new RepositoryAccessError('invalid_repository');
}

export function createGitHubRepositoryHandlers(dependencies: HandlerDependencies) {
  const now = () => dependencies.now?.() ?? new Date();
  const flowOptions = () => ({
    now: now(),
    ...(dependencies.randomToken ? { randomToken: dependencies.randomToken } : {}),
  });

  async function start(
    request: Request,
    input: { operation: 'list' } | { operation: 'select'; repositoryId: unknown },
  ): Promise<Response> {
    if (request.headers.get('origin') !== dependencies.configuration.baseUrl) {
      return json({ error: 'forbidden' }, 403);
    }
    try {
      const context = await dependencies.resolveContext(request.headers);
      const result = await beginRepositoryAuthorization(
        dependencies.database,
        context,
        dependencies.configuration,
        input,
        flowOptions(),
      );
      return externalRedirect(result.redirectUrl);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    async authorize(request: Request): Promise<Response> {
      return start(request, { operation: 'list' });
    },

    async callback(request: Request): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        const url = new URL(request.url);
        const result = await completeRepositoryAuthorization(
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
        return redirect(
          dependencies.configuration.baseUrl,
          result === 'selected'
            ? '/app/github?repository=connected'
            : '/app/github?repositories=loaded',
        );
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return redirect(dependencies.configuration.baseUrl, '/sign-in');
        }
        return redirect(
          dependencies.configuration.baseUrl,
          '/app/github?error=repository_access_failed',
        );
      }
    },

    async current(request: Request): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        const overview = await getRepositoryOverview(dependencies.database, context, now());
        return json({
          repository: overview.selected ? publicRepository(overview.selected) : null,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async list(request: Request): Promise<Response> {
      try {
        const context = await dependencies.resolveContext(request.headers);
        const overview = await getRepositoryOverview(dependencies.database, context, now());
        return json({
          repositories: overview.repositories?.map(publicRepository) ?? null,
          selected: overview.selected ? publicRepository(overview.selected) : null,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async matchesCallback(request: Request): Promise<boolean> {
      const state = new URL(request.url).searchParams.get('state') ?? '';
      return hasRepositoryAccessAttempt(dependencies.database, state, now());
    },

    async select(request: Request): Promise<Response> {
      try {
        return await start(request, {
          operation: 'select',
          repositoryId: await repositoryIdFrom(request),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
