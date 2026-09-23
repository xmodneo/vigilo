import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getAuthDatabase } from '../auth/server.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { getCurrentRepositoryBaseline } from './flow.ts';
import { createRepositoryBaselineHandlers } from './handlers.ts';

let dependencies: Promise<{ database: ReturnType<typeof getAuthDatabase> }> | undefined;

async function getDependencies() {
  if (!dependencies) dependencies = Promise.resolve({ database: getAuthDatabase() });
  return dependencies;
}

export async function getRepositoryBaselineHandlers() {
  return createRepositoryBaselineHandlers({ ...(await getDependencies()), resolveContext: resolveRequestWorkspace });
}

export async function getRepositoryBaselineForContext(context: AuthenticatedWorkspace) {
  return getCurrentRepositoryBaseline((await getDependencies()).database, context);
}
