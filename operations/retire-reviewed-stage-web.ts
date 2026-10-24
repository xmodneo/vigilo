/** Explicitly enabled, loopback-only browser handoff for one historical reviewed retirement. */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { readServerEnvironment } from '../lib/auth/environment.ts';
import { createAuthOptions } from '../lib/auth/factory.ts';
import { AccessDeniedError, resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { createLocalRetirementHandler } from '../lib/external-execution/local-retirement-handler.ts';
import { EXPIRED_REVIEWED_RETIREMENT_TARGET, readHistoricalRetirement, retireExactHistoricalRun } from '../lib/external-execution/local-retirement.ts';

const ORIGIN = 'http://localhost:3001';
export const LOCAL_RETIREMENT_TARGET = EXPIRED_REVIEWED_RETIREMENT_TARGET;
const STOP_DEADLINE_MS = 8_000;
const MAX_BODY_BYTES = 1_024;

function localConfiguration(environment: NodeJS.ProcessEnv, databaseUrl: string, baseUrl: string) {
  return {
    enabled: environment.VIGILO_LOCAL_RETIREMENT_ENABLED === 'true',
    nodeEnv: environment.NODE_ENV,
    baseUrl, databaseUrl,
    releaseSha: environment.VIGILO_RELEASE_SHA,
    operatorOrigin: ORIGIN,
  };
}

async function withDeadline(action: () => Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('local_retirement_cleanup_timeout')), STOP_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function requestBody(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of incoming) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('local_retirement_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function respond(incoming: IncomingMessage, outgoing: ServerResponse,
  handler: ReturnType<typeof createLocalRetirementHandler>): Promise<void> {
  if (incoming.url !== '/' || !['GET', 'POST'].includes(incoming.method ?? '')) {
    outgoing.writeHead(404, { 'Cache-Control': 'no-store' }); outgoing.end(); return;
  }
  let body: Buffer | undefined;
  try { if (incoming.method === 'POST') body = await requestBody(incoming); }
  catch { outgoing.writeHead(413, { 'Cache-Control': 'no-store' }); outgoing.end(); return; }
  const request = new Request(`${ORIGIN}/`, {
    method: incoming.method ?? 'GET',
    headers: incoming.headers as HeadersInit,
    body: body?.toString('utf8') ?? null,
  });
  const response = await handler(request, incoming.socket.remoteAddress);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  const environment = readServerEnvironment();
  const configuration = localConfiguration(process.env, environment.databaseUrl, environment.baseUrl);
  // Duplicate the handler's local guard before any connection or listener is opened.
  const databaseUrl = new URL(environment.databaseUrl);
  if (!configuration.enabled || configuration.nodeEnv !== 'development' ||
      configuration.baseUrl !== 'http://localhost:3000' ||
      !/^[0-9a-f]{40}$/.test(configuration.releaseSha ?? '') ||
      configuration.releaseSha === LOCAL_RETIREMENT_TARGET.authorizedReleaseSha ||
      !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
      databaseUrl.hostname !== '127.0.0.1' || databaseUrl.port !== '55432' || databaseUrl.pathname !== '/vigilo')
    throw new Error('local_retirement_unavailable');

  const client = postgres(environment.databaseUrl, { max: 2, prepare: false });
  const database = drizzle(client, { schema });
  const auth = betterAuth(createAuthOptions(database, environment));
  const handler = createLocalRetirementHandler({
    configuration, target: LOCAL_RETIREMENT_TARGET, csrfSecret: randomBytes(32),
    resolveContext: async (headers) => {
      try {
        return await resolveAuthenticatedWorkspace(
          (sessionHeaders) => auth.api.getSession({ headers: sessionHeaders }),
          database, new Headers({ cookie: headers.get('cookie') ?? '' }),
          { existingWorkspaceOnly: true });
      } catch (error) {
        if (error instanceof AccessDeniedError) return null;
        throw error;
      }
    },
    preview: async (context) => (await readHistoricalRetirement(database, context, LOCAL_RETIREMENT_TARGET)).preview,
    retire: async (context) => {
      const boss = new PgBoss({ connectionString: environment.databaseUrl,
        application_name: 'vigilo-local-reviewed-retirement', max: 1,
        migrate: false, schedule: false, supervise: false, useListenNotify: false });
      let startAttempted = false;
      let result: Awaited<ReturnType<typeof retireExactHistoricalRun>> | undefined;
      let failure: unknown;
      try {
        startAttempted = true;
        await boss.start();
        result = await retireExactHistoricalRun(database, context, boss, LOCAL_RETIREMENT_TARGET);
      } catch (error) { failure = error; }
      if (startAttempted) {
        try { await withDeadline(() => boss.stop({ graceful: true, timeout: 5_000 })); }
        catch { failure = new Error('local_retirement_cleanup_failed'); }
      }
      if (failure) throw failure;
      if (!result) throw new Error('local_retirement_outcome_uncertain');
      return result;
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
      server.listen(3001, 'localhost', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || !['127.0.0.1', '::1'].includes(address.address))
      throw new Error('local_retirement_bind_not_loopback');
    writeSync(1, `${ORIGIN}/\n`);
  } catch {
    server.close();
    await client.end({ timeout: 2 });
    throw new Error('local_retirement_start_failed');
  }
  const shutdown = () => {
    server.close(() => { void client.end({ timeout: 2 }).then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; }); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { writeSync(2, 'local_retirement_unavailable\n'); process.exitCode = 1; });
}
