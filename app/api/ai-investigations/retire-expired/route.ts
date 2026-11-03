import { readDatabaseEnvironment } from '../../../../lib/auth/environment.ts';
import { resolveExistingRequestWorkspace } from '../../../../lib/auth/resolve-request.ts';
import { createExpiredAiRetirementHandler } from '../../../../lib/ai-investigations/expired-retirement-handler.ts';
import { retireExpiredUnstartedAiInvestigation } from '../../../../lib/ai-investigations/expired-retirement.ts';
import { expiredAiRetirementTarget } from '../../../../lib/ai-investigations/expired-target.ts';
import { getJobPublisherInfrastructure } from '../../../../lib/jobs/server.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // This one-target recovery is only exposed by the owner's local development web app.
  const database = new URL(readDatabaseEnvironment().databaseUrl);
  if (process.env.NODE_ENV !== 'development' || process.env.BETTER_AUTH_URL !== 'http://localhost:3000' ||
      database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/vigilo' ||
      request.headers.get('host') !== 'localhost:3000' ||
      new URL(request.url).origin !== 'http://localhost:3000')
    return Response.json({ error: 'forbidden' }, { status: 403 });
  return createExpiredAiRetirementHandler({
    baseUrl: 'http://localhost:3000', target: expiredAiRetirementTarget,
    resolveContext: resolveExistingRequestWorkspace,
    retire: async (actor) => {
      const infrastructure = await getJobPublisherInfrastructure();
      return retireExpiredUnstartedAiInvestigation(
        infrastructure.database, actor, expiredAiRetirementTarget, infrastructure.boss,
      );
    },
  })(request);
}
