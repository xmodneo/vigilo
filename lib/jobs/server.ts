import { readServerEnvironment } from '../auth/environment.ts';
import { getAuthDatabase } from '../auth/server.ts';
import { readGitHubAppEnvironment } from '../github-app/environment.ts';
import { createRepairBoss } from '../repair-runs/queue.ts';

let infrastructure: Promise<{
  configuration: ReturnType<typeof readGitHubAppEnvironment>;
  database: ReturnType<typeof getAuthDatabase>;
  boss: Awaited<ReturnType<typeof createRepairBoss>>;
}> | undefined;

export function getJobPublisherInfrastructure() {
  if (!infrastructure) infrastructure = (async () => ({
    configuration: readGitHubAppEnvironment(),
    database: getAuthDatabase(),
    boss: await createRepairBoss(readServerEnvironment().databaseUrl, 'publisher'),
  }))();
  return infrastructure;
}
