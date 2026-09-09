import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';
import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { getAuthDatabase } from '../auth/server.ts';
import { readServerEnvironment } from '../auth/environment.ts';
import { readGitHubAppEnvironment } from '../github-app/environment.ts';
import { getLatestRepairRun } from './flow.ts';
import { createRepairRunHandlers } from './handlers.ts';
import { createRepairBoss, PgBossRepairQueue } from './queue.ts';

let dependencies: Promise<{
  configuration: ReturnType<typeof readGitHubAppEnvironment>;
  database: ReturnType<typeof getAuthDatabase>;
  queue: PgBossRepairQueue;
}> | undefined;

async function getDependencies() {
  if (!dependencies) dependencies = (async () => {
    const configuration = readGitHubAppEnvironment();
    const boss = await createRepairBoss(readServerEnvironment().databaseUrl, 'publisher');
    return {
      configuration,
      database: getAuthDatabase(),
      queue: new PgBossRepairQueue(boss),
    };
  })();
  return dependencies;
}

export async function getRepairRunHandlers() {
  return createRepairRunHandlers({ ...(await getDependencies()), resolveContext: resolveRequestWorkspace });
}

export async function getLatestRepairRunForContext(context: AuthenticatedWorkspace, githubRepositoryId: number) {
  return getLatestRepairRun((await getDependencies()).database, context, githubRepositoryId);
}
