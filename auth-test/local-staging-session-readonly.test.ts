import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { count, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { createAuthOptions } from '../lib/auth/factory.ts';
import { AccessDeniedError, resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { createLocalStagingHandler } from '../lib/external-execution/local-staging-handler.ts';
import { buildReviewedStagingPlan } from '../lib/external-execution/reviewed-plan.ts';
import { normalizeRepairObjective } from '../lib/repair-runs/intent.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const TEST_AUTH_ENVIRONMENT = {
  baseUrl: 'http://localhost:3000',
  githubClientId: 'test-github-client',
  githubClientSecret: 'test-github-secret',
  secret: 'test-only-secret-with-at-least-thirty-two-characters',
} as const;
const WRITE_METHODS = new Set(['create', 'update', 'updateMany', 'delete', 'deleteMany', 'transaction']);

/** Use the exact operator-only option expression, rather than duplicating its configuration in the test. */
function operatorOptions(baseOptions: BetterAuthOptions): BetterAuthOptions {
  const source = readFileSync(join(process.cwd(), 'operations/stage-reviewed-repair-run-web.ts'), 'utf8');
  const match = source.match(/const auth = betterAuth\((\{\s*\.\.\.authOptions,\s*session:\s*\{\s*\.\.\.authOptions\.session,\s*deferSessionRefresh:\s*true\s*\}\s*\})\);/);
  const expression = match?.[1];
  assert.ok(expression, 'the staging operator must enable GET-only session refresh deferral');
  assert.match(source, /auth\.api\.getSession\(\{\s*headers:\s*sessionHeaders,\s*method:\s*'GET'\s*\}\)/);
  // The strict match above permits only this object expression from trusted checked-out source.
  const evaluate = new Function('authOptions', `return (${expression});`) as
    (options: BetterAuthOptions) => BetterAuthOptions;
  return evaluate(baseOptions);
}

/** Record attempted Better Auth adapter writes, including writes that would later fail. */
function observeAuthWrites(options: BetterAuthOptions) {
  const factory = options.database;
  assert.equal(typeof factory, 'function');
  const writes: string[] = [];
  options.database = ((adapterOptions: unknown) => {
    const adapter = (factory as unknown as (value: unknown) => Record<string, unknown>)(adapterOptions);
    return new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !WRITE_METHODS.has(property) || typeof value !== 'function')
          return value;
        return (...args: unknown[]) => {
          writes.push(property);
          return Reflect.apply(value, target, args);
        };
      },
    });
  }) as typeof options.database;
  return writes;
}

async function fixture(t: TestContext) {
  // createTestContext uses a fresh in-memory PGlite instance and disposable migrations.
  const context = await createTestContext();
  t.after(() => context.client.close());
  const owner = await saveGithubUser(context, 'readonly-preview-owner');
  const [ownedWorkspace] = await context.database.select().from(schema.workspace)
    .where(eq(schema.workspace.ownerUserId, owner.id)).limit(1);
  assert.ok(ownedWorkspace);
  const ownerLogin = await context.testAuth.login({ userId: owner.id });
  const ownerCookie = ownerLogin.headers.get('cookie');
  assert.ok(ownerCookie);

  const baseOptions = createAuthOptions(context.database, TEST_AUTH_ENVIRONMENT);
  assert.equal(baseOptions.session?.deferSessionRefresh, undefined);
  const writes = observeAuthWrites(baseOptions);
  const scopedOptions = operatorOptions(baseOptions);
  assert.equal(scopedOptions.session?.deferSessionRefresh, true);
  assert.deepEqual(scopedOptions.session?.cookieCache, baseOptions.session?.cookieCache);
  const operatorAuth = betterAuth(scopedOptions);

  const actor = { workspaceId: ownedWorkspace.id, reviewerUserId: owner.id };
  const objective = 'Repair the frozen fixture while preserving its intended behavior and tests.';
  const plan = {
    kind: 'm77b_repair_v1' as const,
    repairRunId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    githubRepositoryId: 1411517943,
    installationId: 159763114,
    profileIdentity: 'a'.repeat(64),
    baseCommitSha: '3575b04ff48cf07f9f52b5b3f8cf529520619307',
    authorizedReleaseSha: 'b'.repeat(40),
    objective,
    expectedSourceIdentity: '6429fda80481a0ad3330ffc233dc449e44c6041762eab2dab88a3a479416f3ea',
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    providerAccounts: {
      googleProjectId: 'gen-lang-client-0469095642',
      vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA',
      vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM',
    },
  };
  const approvedPlanIdentity = buildReviewedStagingPlan(actor, plan).planIdentity;
  let stageCalls = 0;
  const handler = createLocalStagingHandler({
    configuration: {
      enabled: true, nodeEnv: 'development', baseUrl: TEST_AUTH_ENVIRONMENT.baseUrl,
      operatorOrigin: 'http://localhost:3002',
      // Inert configuration string required by localOnly; this test never opens a network connection.
      databaseUrl: 'postgres://test-only@127.0.0.1:55432/vigilo',
      releaseSha: plan.authorizedReleaseSha, providerAccounts: plan.providerAccounts,
      objectiveHash: normalizeRepairObjective(objective).objectiveHash,
    },
    artifact: { actor, plan, approvedPlanIdentity },
    csrfSecret: Buffer.alloc(32, 7),
    resolveContext: async (headers) => {
      try {
        return await resolveAuthenticatedWorkspace(
          (sessionHeaders) => operatorAuth.api.getSession({ headers: sessionHeaders, method: 'GET' }),
          context.database, new Headers({ cookie: headers.get('cookie') ?? '' }),
          { existingWorkspaceOnly: true },
        );
      } catch (error) {
        if (error instanceof AccessDeniedError) return null;
        throw error;
      }
    },
    stage: async () => { stageCalls++; throw new Error('preview_must_not_stage'); },
  });
  const preview = (cookie = '') => handler(new Request('http://localhost:3002/', {
    headers: { host: 'localhost:3002', cookie },
  }), '::1');
  return { context, owner, ownerCookie, writes, baseOptions, handler, preview,
    stageCalls: () => stageCalls, approvedPlanIdentity };
}

test('operator-local Better Auth preview reads an owner session without any auth-adapter write', async (t) => {
  const subject = await fixture(t);
  const response = await subject.preview(subject.ownerCookie);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(subject.approvedPlanIdentity));
  assert.match(body, /&quot;maxLogicalRequests&quot;: 7/);
  assert.match(body, /&quot;maxLogicalRequests&quot;: 6/);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
  assert.equal((await subject.context.database.select({ total: count() }).from(schema.repairRun))[0]?.total, 0);
  assert.equal((await subject.context.database.select({ total: count() }).from(schema.repairRunEvent))[0]?.total, 0);
  assert.equal((await subject.context.database.select({ total: count() }).from(schema.repairRunSourceCheckpoint))[0]?.total, 0);
  assert.equal((await subject.context.database.select({ total: count() }).from(schema.executionBudgetGrant))[0]?.total, 0);
  assert.equal((await subject.context.database.select({ total: count() }).from(schema.externalExecutionReservation))[0]?.total, 0);
});

test('a refresh-eligible owner session is not extended by preview GET', async (t) => {
  const subject = await fixture(t);
  await subject.context.database.update(schema.session)
    .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
    .where(eq(schema.session.userId, subject.owner.id));
  const [before] = await subject.context.database.select().from(schema.session)
    .where(eq(schema.session.userId, subject.owner.id)).limit(1);
  assert.ok(before);
  assert.equal((await subject.preview(subject.ownerCookie)).status, 200);
  const [after] = await subject.context.database.select().from(schema.session)
    .where(eq(schema.session.userId, subject.owner.id)).limit(1);
  assert.deepEqual(after, before);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
});

test('the adapter observer detects an ordinary Better Auth refresh as a positive control', async (t) => {
  const subject = await fixture(t);
  await subject.context.database.update(schema.session)
    .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
    .where(eq(schema.session.userId, subject.owner.id));
  const ordinaryAuth = betterAuth(subject.baseOptions);
  const session = await ordinaryAuth.api.getSession({
    headers: new Headers({ cookie: subject.ownerCookie }), method: 'GET',
  });
  assert.ok(session);
  assert.ok(subject.writes.includes('update'), 'the observer must see the unprotected refresh UPDATE');
});

test('expired session is denied without Better Auth cleanup DELETE', async (t) => {
  const subject = await fixture(t);
  await subject.context.database.update(schema.session)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.session.userId, subject.owner.id));
  const [before] = await subject.context.database.select().from(schema.session)
    .where(eq(schema.session.userId, subject.owner.id)).limit(1);
  assert.ok(before);
  assert.equal((await subject.preview(subject.ownerCookie)).status, 401);
  const [after] = await subject.context.database.select().from(schema.session)
    .where(eq(schema.session.userId, subject.owner.id)).limit(1);
  assert.deepEqual(after, before);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
});

test('the adapter observer detects ordinary Better Auth expired-session cleanup', async (t) => {
  const subject = await fixture(t);
  await subject.context.database.update(schema.session)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.session.userId, subject.owner.id));
  const ordinaryAuth = betterAuth(subject.baseOptions);
  assert.equal(await ordinaryAuth.api.getSession({
    headers: new Headers({ cookie: subject.ownerCookie }), method: 'GET',
  }), null);
  assert.ok(subject.writes.includes('delete'), 'the observer must see the unprotected cleanup DELETE');
});

test('missing, revoked and tampered cookies cannot authorize owner preview', async (t) => {
  const subject = await fixture(t);
  assert.equal((await subject.preview()).status, 401);
  assert.equal((await subject.preview(subject.ownerCookie.replace(/=[^;]+/, '=tampered'))).status, 401);
  await subject.context.database.delete(schema.session)
    .where(eq(schema.session.userId, subject.owner.id));
  assert.equal((await subject.preview(subject.ownerCookie)).status, 401);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
});

test('other authenticated users cannot preview an owner-bound plan', async (t) => {
  const subject = await fixture(t);
  const other = await saveGithubUser(subject.context, 'readonly-preview-other');
  const otherLogin = await subject.context.testAuth.login({ userId: other.id });
  assert.equal((await subject.preview(otherLogin.headers.get('cookie') ?? '')).status, 403);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
});

test('a different existing workspace cannot satisfy the artifact owner binding', async (t) => {
  const subject = await fixture(t);
  await subject.context.database.delete(schema.workspace)
    .where(eq(schema.workspace.ownerUserId, subject.owner.id));
  await subject.context.database.insert(schema.workspace).values({
    id: randomUUID(), ownerUserId: subject.owner.id,
  });
  assert.equal((await subject.preview(subject.ownerCookie)).status, 403);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
});

test('preview keeps local-host and POST origin/CSRF gates; no POST dispatch occurs', async (t) => {
  const subject = await fixture(t);
  const outside = new Request('http://localhost:3002/', {
    headers: { host: 'attacker.example', cookie: subject.ownerCookie },
  });
  assert.equal((await subject.handler(outside, '::1')).status, 404);
  assert.equal((await subject.handler(new Request('http://localhost:3002/', {
    headers: { host: 'localhost:3002', cookie: subject.ownerCookie },
  }), '203.0.113.10')).status, 404);
  const form = new URLSearchParams({ confirmation: 'stage_exact_reviewed_plan',
    planIdentity: subject.approvedPlanIdentity, csrf: '0'.repeat(64) });
  const post = (origin: string) => subject.handler(new Request('http://localhost:3002/', {
    method: 'POST', headers: { host: 'localhost:3002', origin, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded', cookie: subject.ownerCookie },
    body: form,
  }), '::1');
  assert.equal((await post('https://attacker.example')).status, 403);
  assert.equal((await post('http://localhost:3002')).status, 403);
  assert.deepEqual(subject.writes, []);
  assert.equal(subject.stageCalls(), 0);
});
