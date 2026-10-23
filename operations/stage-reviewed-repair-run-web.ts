/** Default-disabled loopback browser handoff for one exact reviewed public-fixture plan. */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readServerEnvironment } from '../lib/auth/environment.ts';
import { createAuthOptions } from '../lib/auth/factory.ts';
import { AccessDeniedError, resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { readLocalStagingArtifact } from '../lib/external-execution/local-staging-artifact.ts';
import { createLocalStagingHandler, validateLocalStagingArtifact, type LocalStagingConfiguration } from '../lib/external-execution/local-staging-handler.ts';
import { stageReviewedRepairRun } from '../lib/external-execution/reviewed-staging.ts';
import { googleProjectIdentity } from '../lib/external-execution/provider-account.ts';
import { sandboxCredentials } from '../lib/external-execution/sandbox-auth.ts';
import { readRuntimeRelease } from '../lib/operations/release.ts';
import { createRepairBoss, PgBossReviewedBaselineQueue } from '../lib/repair-runs/queue.ts';

const ORIGIN = 'http://localhost:3002';
const MAX_BODY_BYTES = 1024;
const STOP_DEADLINE_MS = 8_000;
const APPROVED_OBJECTIVE_HASH = '24113452040b2ec70389f75a919ccafd7551c2ee9eaef1ce4741fb731e4dc2b6';

function localConfiguration(environment: NodeJS.ProcessEnv, databaseUrl: string, baseUrl: string): LocalStagingConfiguration {
  const google = googleProjectIdentity(environment.GEMINI_PROJECT_ID ?? '');
  const vercel = sandboxCredentials(environment);
  return {
    enabled: environment.VIGILO_LOCAL_STAGING_ENABLED === 'true', nodeEnv: environment.NODE_ENV,
    baseUrl, databaseUrl, operatorOrigin: ORIGIN, releaseSha: readRuntimeRelease(environment),
    providerAccounts: { googleProjectId: google.projectId, vercelTeamId: vercel.teamId,
      vercelProjectId: vercel.projectId }, objectiveHash: APPROVED_OBJECTIVE_HASH,
  };
}

async function withDeadline(action: () => Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('local_staging_cleanup_timeout')), STOP_DEADLINE_MS);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

async function requestBody(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of incoming) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('local_staging_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function respond(incoming: IncomingMessage, outgoing: ServerResponse,
  handler: ReturnType<typeof createLocalStagingHandler>): Promise<void> {
  if (incoming.url !== '/' || !['GET', 'POST'].includes(incoming.method ?? '')) {
    outgoing.writeHead(404, { 'Cache-Control': 'no-store' }); outgoing.end(); return;
  }
  let body: Buffer | undefined;
  try { if (incoming.method === 'POST') body = await requestBody(incoming); }
  catch { outgoing.writeHead(413, { 'Cache-Control': 'no-store' }); outgoing.end(); return; }
  const request = new Request(`${ORIGIN}/`, { method: incoming.method ?? 'GET', headers: incoming.headers as HeadersInit,
    body: body?.toString('utf8') ?? null });
  const response = await handler(request, incoming.socket.remoteAddress);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  const environment = readServerEnvironment();
  const configuration = localConfiguration(process.env, environment.databaseUrl, environment.baseUrl);
  let databaseUrl: URL;
  try { databaseUrl = new URL(environment.databaseUrl); } catch { throw new Error('local_staging_unavailable'); }
  // Duplicate the handler's guard before touching either PostgreSQL or a listener.
  if (!configuration.enabled || configuration.nodeEnv !== 'development' ||
      configuration.baseUrl !== 'http://localhost:3000' ||
      !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || databaseUrl.hostname !== '127.0.0.1' ||
      databaseUrl.port !== '55432' || databaseUrl.pathname !== '/vigilo')
    throw new Error('local_staging_unavailable');
  const artifact = readLocalStagingArtifact(process.cwd());
  // A stale, altered, or expired artifact fails before a database client exists.
  validateLocalStagingArtifact(artifact, configuration);
  const client = postgres(environment.databaseUrl, { max: 2, prepare: false });
  const database = drizzle(client, { schema });
  const auth = betterAuth(createAuthOptions(database, environment));
  const handler = createLocalStagingHandler({
    configuration, artifact, csrfSecret: randomBytes(32),
    resolveContext: async (headers) => {
      try {
        return await resolveAuthenticatedWorkspace(
          (sessionHeaders) => auth.api.getSession({ headers: sessionHeaders }), database,
          new Headers({ cookie: headers.get('cookie') ?? '' }), { existingWorkspaceOnly: true });
      } catch (error) {
        if (error instanceof AccessDeniedError) return null;
        throw error;
      }
    },
    stage: async (context, plan, approvedPlanIdentity) => {
      const boss = await createRepairBoss(environment.databaseUrl, 'publisher');
      let receipt: Awaited<ReturnType<typeof stageReviewedRepairRun>> | undefined;
      let failure: unknown;
      try {
        receipt = await stageReviewedRepairRun(database, context, plan, approvedPlanIdentity,
          new PgBossReviewedBaselineQueue(boss), {
            runtimeReleaseSha: readRuntimeRelease(), configuredProviderAccounts: configuration.providerAccounts,
          });
      } catch (error) { failure = error; }
      try { await withDeadline(() => boss.stop({ graceful: true, timeout: 5_000 })); }
      catch { throw new Error('local_staging_cleanup_unresolved'); }
      if (failure) throw failure;
      if (!receipt) throw new Error('local_staging_outcome_uncertain');
      return receipt;
    },
  });
  const server = createServer((incoming, outgoing) => {
    void respond(incoming, outgoing, handler).catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(503, { 'Cache-Control': 'no-store' });
      outgoing.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3002, 'localhost', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || !['127.0.0.1', '::1'].includes(address.address))
      throw new Error('local_staging_bind_not_loopback');
    writeSync(1, `${ORIGIN}/\n`);
  } catch {
    server.close();
    await client.end({ timeout: 2 });
    throw new Error('local_staging_start_failed');
  }
  const shutdown = () => {
    server.close(() => { void client.end({ timeout: 2 }).then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; }); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { writeSync(2, 'local_staging_unavailable\n'); process.exitCode = 1; });
}
