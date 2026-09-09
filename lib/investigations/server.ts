import { resolveRequestWorkspace } from '../auth/resolve-request.ts';
import { readGitHubAppPrivateKey } from '../github-app/environment.ts';
import { GitHubApiClient } from '../github-app/client.ts';
import { getJobPublisherInfrastructure } from '../jobs/server.ts';
import { PgBossInvestigationQueue } from '../repair-runs/queue.ts';
import { getInvestigationForRun } from './flow.ts';
import { createInvestigationHandlers } from './handlers.ts';
import type { AuthenticatedWorkspace } from '../auth/protected-context.ts';

let gateway: Promise<GitHubApiClient> | undefined;

async function dependencies() {
  const infrastructure = await getJobPublisherInfrastructure();
  gateway ??= readGitHubAppPrivateKey(infrastructure.configuration.privateKeyPath).then((key) => new GitHubApiClient(infrastructure.configuration, key));
  return { ...infrastructure, gateway: await gateway, queue: new PgBossInvestigationQueue(infrastructure.boss), resolveContext: resolveRequestWorkspace };
}

export async function getInvestigationHandlers() {
  return createInvestigationHandlers(await dependencies());
}

export async function getInvestigationForContext(context: AuthenticatedWorkspace, repairRunId: string) {
  return getInvestigationForRun((await dependencies()).database, context, repairRunId);
}
