import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { APIError, Sandbox } from '@vercel/sandbox';

import { eq } from 'drizzle-orm';

import {
  executionBudgetGrant,
  executionBudgetGrantRevocation,
  externalExecutionEvent,
  externalExecutionLease,
  externalExecutionReservation,
  repairRun,
  user,
  workspace,
} from '../db/schema.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { computeExecutionGrantIdentity, computeExecutionReservationIdentity } from '../lib/external-execution/identity.ts';
import { ExternalExecutionAuthorityError, type ExternalExecutionAmounts, type ExternalExecutionScope } from '../lib/external-execution/types.ts';
import { createTestContext } from './support.ts';

const scopeLimits: ExternalExecutionAmounts & { maxConcurrentExternalOperations: number } = {
  logicalRequests: 4,
  providerAttempts: 4,
  inputTokens: 20_000,
  outputTokens: 10_000,
  sandboxIdentities: 0,
  sandboxRuntimeMs: 0,
  verificationAttempts: 0,
  repairLoopIterations: 0,
  maxConcurrentExternalOperations: 0,
};

const amount = (overrides: Partial<ExternalExecutionAmounts> = {}): ExternalExecutionAmounts => ({
  logicalRequests: 1, providerAttempts: 1, inputTokens: 100, outputTokens: 100,
  sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0,
  ...overrides,
});

test('review: success after in-flight grant revocation cannot become durable attempt or reservation success', async (t) => {
  const value = await seeded(); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
    await value.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: value.grantId, revokedBy: 'test-operator', reasonCode: 'test', createdAt: value.now });
    return Response.json({ success: true });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  await assert.rejects(permit.meteredFetch('https://provider.invalid'), /execution_authority_missing/);
  await assert.rejects(permit.complete('succeeded'), /execution_authority_missing/);
  const events = await value.context.database.select().from(externalExecutionEvent);
  assert.equal(events.filter((event) => event.eventType === 'attempt_started').length, 1);
  assert.equal(events.filter((event) => ['attempt_succeeded', 'completed'].includes(event.eventType)).length, 0);
  await permit.complete('ambiguous', 'provider_attempt_ambiguous');
});

test('review: installed SDK treats authority denial and every redirect status as terminal, not retryable', async (t) => {
  for (const status of [0, 301, 302, 303, 307, 308]) {
    const value = await seeded({ scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' } });
    try {
      let dispatches = 0; let invocations = 0;
      t.mock.method(globalThis, 'fetch', async () => assert.fail('global refresh'));
      const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (_input, init) => {
        dispatches += 1; assert.equal(init?.redirect, 'manual');
        return new Response('private', { status, headers: { Location: 'https://redirect.invalid/?token=fake-secret' } });
      } });
      const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 3 }) });
      const begin = permit.beginProviderAttempt;
      t.mock.method(permit, 'beginProviderAttempt', async () => { invocations += 1; return begin(); });
      if (status === 0) await value.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: value.grantId, revokedBy: 'test-operator', reasonCode: 'test', createdAt: value.now });
      await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test', name: 'test', resume: false, fetch: permit.meteredFetch }), { message: status === 0 ? 'execution_authority_missing' : 'sandbox_transport_redirect' });
      assert.equal(invocations, 1); assert.equal(dispatches, status === 0 ? 0 : 1);
      const events = await value.context.database.select().from(externalExecutionEvent);
      assert.equal(events.filter((event) => event.eventType === 'attempt_failed').length, status === 0 ? 0 : 1);
      assert.ok(!JSON.stringify(events).includes('fake-secret'));
    } finally { await value.context.client.close(); }
  }
});

test('Sandbox transport overrides redirect-follow and consumes 3xx without following or revealing Location', async (t) => {
  const value = await seeded({ scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' } });
  t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'manual');
    return new Response('sensitive-response', { status: 307, headers: { Location: 'https://redirect.invalid/private?token=fake-secret' } });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test', { redirect: 'follow' }), { message: 'sandbox_transport_redirect' });
  assert.equal(calls, 1);
  const events = await value.context.database.select().from(externalExecutionEvent);
  assert.equal(events.filter((event) => event.eventType === 'attempt_failed').length, 1);
  assert.ok(!JSON.stringify(events).includes('fake-secret'));
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test'), /execution_budget_exhausted/);
  assert.equal(calls, 1);
});

for (const failure of ['network', '429', '503'] as const) test(`installed Sandbox SDK ${failure} retries use only the durable injected transport`, async (t) => {
  const value = await seeded({ scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' } });
  t.after(() => value.context.client.close());
  let globalCalls = 0; let rawCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { globalCalls += 1; throw new Error('unmetered transport'); });
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (_input, init) => {
    rawCalls += 1;
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-opaque-access-token');
    if (failure === 'network') throw new TypeError('fake network failure');
    return new Response('{}', { status: Number(failure), headers: { 'Retry-After': '0' } });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 3 }) });
  await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test', name: 'test', resume: false, fetch: permit.meteredFetch }), failure === 'network' ? TypeError : APIError);
  assert.equal(rawCalls, 3); assert.equal(globalCalls, 0);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_started').length, 3);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === (failure === 'network' ? 'attempt_ambiguous' : 'attempt_failed')).length, 3);
});

test('cancelled transport cannot consume or dispatch the next attempt', async (t) => {
  const value = await seeded(); t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => { calls += 1; return new Response(null, { status: 200 }); } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  const signal = AbortSignal.abort();
  await assert.rejects(permit.meteredFetch('https://provider.invalid', { signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).length, 1);
});

test('installed Sandbox create/get/stop/delete retain explicit credentials and the injected metered client', async (t) => {
  const value = await seeded({ scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' } });
  t.after(() => value.context.client.close());
  let globalCalls = 0; const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { globalCalls += 1; throw new Error('unmetered refresh'); });
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (input, init) => {
    const url = new URL(String(input)); requests.push(`${init?.method} ${url.pathname}`);
    assert.equal(init?.redirect, 'manual');
    assert.equal(url.searchParams.get('teamId'), 'team_test');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-opaque-access-token');
    assert.ok(!String(init?.body).includes('fake-opaque-access-token'));
    const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000, status: 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
    const sandbox = { name: 'test', persistent: false, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: 'running' };
    if (url.pathname.endsWith('/stop')) { session.status = 'stopped'; sandbox.status = 'stopped'; }
    return Response.json({ session, sandbox, routes: [] });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 4 }) });
  const credentials = { token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test' };
  await Sandbox.create({ ...credentials, name: 'test', image: 'vercel/sandbox/node:24', fetch: permit.meteredFetch });
  const sandbox = await Sandbox.get({ ...credentials, name: 'test', resume: false, fetch: permit.meteredFetch });
  await sandbox.stop(); await sandbox.delete();
  assert.equal(requests.length, 4); assert.equal(globalCalls, 0);
  assert.deepEqual(requests.map((request) => request.split(' ')[0]), ['POST', 'GET', 'POST', 'DELETE']);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_succeeded').length, 4);
});

test('Sandbox attempt 97 is denied before transport and all 96 prior invocations remain consumed', async (t) => {
  const value = await seeded({ scope: { operationCategory: 'sandbox_verification', providerId: 'vercel-sandbox' }, limits: { providerAttempts: 96 }, accountLimits: { providerAttempts: 96 } });
  t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => { calls += 1; return new Response(null, { status: 404 }); } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 96 }) });
  for (let index = 0; index < 96; index += 1) await permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test');
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test'), /execution_budget_exhausted/);
  assert.equal(calls, 96);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_failed').length, 96);
});

test('installed Sandbox retries cannot dispatch after revocation, cancellation, or lease expiry', async (t) => {
  for (const stop of ['revocation', 'cancellation', 'expiry'] as const) {
    const value = await seeded({ scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' } });
    try {
      const controller = new AbortController(); let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => { throw new Error('unmetered transport'); });
      const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
        calls += 1;
        if (stop === 'revocation') await value.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: value.grantId, revokedBy: 'test-operator', reasonCode: 'test', createdAt: value.now });
        if (stop === 'cancellation') controller.abort();
        if (stop === 'expiry') value.now = new Date(value.now.getTime() + 16 * 60_000);
        return new Response('{}', { status: 503 });
      } });
      const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 3 }) });
      await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test', name: 'test', resume: false, fetch: permit.meteredFetch, signal: controller.signal }));
      assert.equal(calls, 1, stop);
      assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_started').length, 1, stop);
    } finally { await value.context.client.close(); }
  }
});

async function seeded(options: { scope?: Partial<ExternalExecutionScope>; concurrency?: number; expiresAt?: Date; limits?: Partial<typeof scopeLimits>; accountLimits?: Partial<typeof scopeLimits>; malformedOperationIdentity?: boolean } = {}) {
  const context = await createTestContext();
  const now = new Date('2026-09-23T10:00:00.000Z');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'operator', email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
  const scope: ExternalExecutionScope = { workspaceId, operationCategory: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite', ...options.scope };
  if (scope.operationCategory === 'sandbox_baseline') delete scope.modelId;
  const expiresAt = options.expiresAt ?? new Date('2026-09-24T10:00:00.000Z');
  const limits = { ...scopeLimits, ...options.limits };
  const accountId = randomUUID();
  const accountLimits = { ...scopeLimits, ...options.accountLimits, maxConcurrentExternalOperations: options.concurrency ?? 1 };
  await context.database.insert(executionBudgetGrant).values({
    id: accountId, version: 1, scope: 'account', maxLogicalRequests: accountLimits.logicalRequests,
    maxProviderAttempts: accountLimits.providerAttempts, maxInputTokens: accountLimits.inputTokens,
    maxOutputTokens: accountLimits.outputTokens, maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0,
    maxVerificationAttempts: 0, maxRepairLoopIterations: 0,
    maxConcurrentExternalOperations: accountLimits.maxConcurrentExternalOperations,
    expiresAt, authorizedBy: 'test-operator',
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null, acceptancePurpose: null, limits: accountLimits, expiresAt: expiresAt.toISOString(), authorizedBy: 'test-operator' }),
    createdAt: now,
  });
  const grantId = randomUUID();
  await context.database.insert(executionBudgetGrant).values({
    id: grantId, version: 1, scope: 'operation', workspaceId, operationCategory: scope.operationCategory,
    providerId: scope.providerId, modelId: scope.modelId,
    maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts,
    maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
    maxSandboxIdentities: limits.sandboxIdentities, maxSandboxRuntimeMs: limits.sandboxRuntimeMs,
    maxVerificationAttempts: limits.verificationAttempts, maxRepairLoopIterations: limits.repairLoopIterations,
    maxConcurrentExternalOperations: 0, expiresAt, authorizedBy: 'test-operator',
    grantIdentity: options.malformedOperationIdentity ? 'f'.repeat(64) : computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId ?? null, acceptancePurpose: null, limits, expiresAt: expiresAt.toISOString(), authorizedBy: 'test-operator' }),
    createdAt: now,
  });
  return { context, now, scope, grantId, accountId };
}

test('external execution authority is zero by default', async () => {
  const context = await createTestContext();
  const authority = new DurableExternalExecutionAuthorizer(context.database);
  await assert.rejects(authority.reserve({ scope: { workspaceId: randomUUID(), operationCategory: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite' }, amounts: amount() }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_missing');
  await context.client.close();
});

test('reservation, raw provider attempt, and completion are durable and append-only', async () => {
  const seededValue = await seeded();
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  const permit = await authority.reserve({ scope: seededValue.scope, amounts: amount() });
  const ordinal = await permit.beginProviderAttempt();
  await permit.finishProviderAttempt(ordinal, 'succeeded', { inputTokens: 12, outputTokens: 3 });
  await assert.rejects(permit.finishProviderAttempt(ordinal, 'failed'));
  await permit.complete('succeeded');
  assert.equal((await seededValue.context.database.select().from(externalExecutionReservation)).length, 1);
  assert.deepEqual((await seededValue.context.database.select({ type: externalExecutionEvent.eventType }).from(externalExecutionEvent)).map((row) => row.type), ['reserved', 'attempt_started', 'attempt_succeeded', 'completed']);
  const [lease] = await seededValue.context.database.select().from(externalExecutionLease);
  assert.equal(lease?.state, 'succeeded');
  await assert.rejects(seededValue.context.database.delete(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, permit.reservationId)));
  await seededValue.context.client.close();
});

test('event audit rows require an existing lease and event-type-compatible facts', async () => {
  const seededValue = await seeded();
  const amounts = amount();
  const operationKey = randomUUID();
  const fence = 999;
  const [reservation] = await seededValue.context.database.insert(externalExecutionReservation).values({
    id: randomUUID(), version: 1, grantId: seededValue.grantId, accountGrantId: seededValue.accountId,
    workspaceId: seededValue.scope.workspaceId, operationCategory: seededValue.scope.operationCategory,
    providerId: seededValue.scope.providerId, modelId: seededValue.scope.modelId, operationKey,
    reservedLogicalRequests: amounts.logicalRequests, reservedProviderAttempts: amounts.providerAttempts,
    reservedInputTokens: amounts.inputTokens, reservedOutputTokens: amounts.outputTokens,
    reservedSandboxIdentities: amounts.sandboxIdentities, reservedSandboxRuntimeMs: amounts.sandboxRuntimeMs,
    reservedVerificationAttempts: amounts.verificationAttempts, reservedRepairLoopIterations: amounts.repairLoopIterations,
    fence, reservationIdentity: computeExecutionReservationIdentity({
      version: 1, grantId: seededValue.grantId, accountGrantId: seededValue.accountId,
      scope: seededValue.scope, amounts, operationKey, fence,
    }), createdAt: seededValue.now,
  }).returning();
  assert.ok(reservation);
  await assert.rejects(seededValue.context.database.insert(externalExecutionEvent).values({
    id: randomUUID(), reservationId: reservation.id, eventType: 'reserved', createdAt: seededValue.now,
  }), (error: unknown) => error instanceof Error && error.cause instanceof Error && error.cause.message.includes('execution_authority_missing'));

  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  const permit = await authority.reserve({ scope: seededValue.scope, amounts });
  await assert.rejects(seededValue.context.database.insert(externalExecutionEvent).values({
    id: randomUUID(), reservationId: permit.reservationId, eventType: 'completed', createdAt: seededValue.now,
  }));
  await assert.rejects(seededValue.context.database.insert(externalExecutionEvent).values({
    id: randomUUID(), reservationId: permit.reservationId, eventType: 'reserved', createdAt: seededValue.now,
  }));
  await assert.rejects(seededValue.context.database.insert(externalExecutionEvent).values({
    id: randomUUID(), reservationId: permit.reservationId, eventType: 'attempt_started', attemptOrdinal: 1,
    inputTokens: 1, createdAt: seededValue.now,
  }));
  await permit.complete('failed', 'execution_authority_mismatch');
  await seededValue.context.client.close();
});

test('revocation or expiry after reservation prevents the next external attempt', async () => {
  const revoked = await seeded();
  const revokedAuthority = new DurableExternalExecutionAuthorizer(revoked.context.database, { clock: () => revoked.now });
  const revokedPermit = await revokedAuthority.reserve({ scope: revoked.scope, amounts: amount() });
  await revoked.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: revoked.grantId, reasonCode: 'operator_revoked', revokedBy: 'test-operator', createdAt: revoked.now });
  await assert.rejects(revokedPermit.beginProviderAttempt(),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_missing');
  await revokedPermit.complete('failed', 'execution_authority_missing');
  await revoked.context.client.close();

  let current = new Date('2026-09-23T10:00:00.000Z');
  const expired = await seeded({ expiresAt: new Date('2026-09-23T10:00:01.000Z') });
  const expiredAuthority = new DurableExternalExecutionAuthorizer(expired.context.database, { clock: () => current });
  const expiredPermit = await expiredAuthority.reserve({ scope: expired.scope, amounts: amount() });
  current = new Date('2026-09-23T10:00:02.000Z');
  await assert.rejects(expiredPermit.beginProviderAttempt(),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_expired');
  await expiredPermit.complete('failed', 'execution_authority_expired');
  await expired.context.client.close();
});

test('grant mismatch, revocation, expiry, and aggregate exhaustion fail closed', async () => {
  const wrong = await seeded({ limits: { logicalRequests: 1 } });
  const authority = new DurableExternalExecutionAuthorizer(wrong.context.database, { clock: () => wrong.now });
  await assert.rejects(authority.reserve({ scope: { ...wrong.scope, providerId: 'other' }, amounts: amount() }), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_mismatch');
  const first = await authority.reserve({ scope: wrong.scope, amounts: amount() });
  await first.complete('succeeded');
  await assert.rejects(authority.reserve({ scope: wrong.scope, amounts: amount() }), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
  await wrong.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: wrong.grantId, reasonCode: 'operator_revoked', revokedBy: 'test-operator', createdAt: wrong.now });
  await assert.rejects(authority.reserve({ scope: wrong.scope, amounts: amount() }), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_missing');
  await wrong.context.client.close();

  const expired = await seeded({ expiresAt: new Date('2026-09-23T09:00:00.000Z') });
  await assert.rejects(new DurableExternalExecutionAuthorizer(expired.context.database, { clock: () => expired.now }).reserve({ scope: expired.scope, amounts: amount() }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_expired');
  await expired.context.client.close();

  const malformed = await seeded({ malformedOperationIdentity: true });
  await assert.rejects(new DurableExternalExecutionAuthorizer(malformed.context.database, { clock: () => malformed.now }).reserve({ scope: malformed.scope, amounts: amount() }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_mismatch');
  await malformed.context.client.close();
});

test('every integer execution-budget dimension is enforced before reservation', async (t) => {
  const cases: Array<{ name: string; limit: Partial<typeof scopeLimits>; requested: Partial<ExternalExecutionAmounts> }> = [
    { name: 'input tokens', limit: { inputTokens: 99 }, requested: { inputTokens: 100 } },
    { name: 'output tokens', limit: { outputTokens: 99 }, requested: { outputTokens: 100 } },
    { name: 'sandbox identities', limit: { sandboxIdentities: 0 }, requested: { sandboxIdentities: 1 } },
    { name: 'sandbox runtime', limit: { sandboxRuntimeMs: 999 }, requested: { sandboxRuntimeMs: 1_000 } },
    { name: 'verification attempts', limit: { verificationAttempts: 0 }, requested: { verificationAttempts: 1 } },
    { name: 'repair-loop iterations', limit: { repairLoopIterations: 0 }, requested: { repairLoopIterations: 1 } },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const seededValue = await seeded({ limits: value.limit });
    const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
    await assert.rejects(authority.reserve({ scope: seededValue.scope, amounts: amount(value.requested) }),
      (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
    assert.equal((await seededValue.context.database.select().from(externalExecutionReservation)).length, 0);
    await seededValue.context.client.close();
  });
});

test('account-wide cumulative budgets bound reservations across operation grants', async () => {
  const seededValue = await seeded({ accountLimits: { logicalRequests: 1 }, limits: { logicalRequests: 4 } });
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  const first = await authority.reserve({ scope: seededValue.scope, amounts: amount() });
  await first.complete('succeeded');
  await assert.rejects(authority.reserve({ scope: seededValue.scope, amounts: amount() }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
  await seededValue.context.client.close();
});

test('one-shot live-acceptance authority binds one run, revision, purpose, and finite operation allowance', async () => {
  const seededValue = await seeded();
  const runId = randomUUID(); const baseCommitSha = 'a'.repeat(40); const repositoryId = 42;
  await seededValue.context.database.insert(repairRun).values({
    id: runId, workspaceId: seededValue.scope.workspaceId, githubRepositoryId: repositoryId, installationId: 77,
    profileIdentity: 'b'.repeat(64), baseCommitSha, idempotencyKey: randomUUID(), state: 'created',
    stateChangedAt: seededValue.now, updatedAt: seededValue.now,
  });
  const limits = { ...scopeLimits, logicalRequests: 1, providerAttempts: 0 };
  const grantId = randomUUID(); const purpose = 'task_4_3_live_acceptance';
  await seededValue.context.database.insert(executionBudgetGrant).values({
    id: grantId, version: 1, scope: 'one_shot', workspaceId: seededValue.scope.workspaceId, repairRunId: runId,
    githubRepositoryId: repositoryId, baseCommitSha, operationCategory: 'release_acceptance_one_shot',
    providerId: 'vigilo', acceptancePurpose: purpose,
    maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts,
    maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
    maxSandboxIdentities: limits.sandboxIdentities, maxSandboxRuntimeMs: limits.sandboxRuntimeMs,
    maxVerificationAttempts: limits.verificationAttempts, maxRepairLoopIterations: limits.repairLoopIterations,
    maxConcurrentExternalOperations: 0, expiresAt: new Date('2026-09-24T10:00:00.000Z'), authorizedBy: 'release-operator',
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'one_shot', workspaceId: seededValue.scope.workspaceId, repairRunId: runId, githubRepositoryId: repositoryId, baseCommitSha, operationCategory: 'release_acceptance_one_shot', providerId: 'vigilo', modelId: null, acceptancePurpose: purpose, limits, expiresAt: '2026-09-24T10:00:00.000Z', authorizedBy: 'release-operator' }),
    createdAt: seededValue.now,
  });
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  const scope: ExternalExecutionScope = { workspaceId: seededValue.scope.workspaceId, repairRunId: runId, githubRepositoryId: repositoryId, baseCommitSha, operationCategory: 'release_acceptance_one_shot', providerId: 'vigilo', acceptancePurpose: purpose };
  await assert.rejects(authority.reserve({ grantId, scope: { ...scope, baseCommitSha: 'c'.repeat(40) }, amounts: amount({ providerAttempts: 0, inputTokens: 0, outputTokens: 0 }) }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_mismatch');
  const permit = await authority.reserve({ grantId, scope, amounts: amount({ providerAttempts: 0, inputTokens: 0, outputTokens: 0 }) });
  await permit.complete('succeeded');
  await assert.rejects(authority.reserve({ grantId, scope, amounts: amount({ providerAttempts: 0, inputTokens: 0, outputTokens: 0 }) }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
  await seededValue.context.client.close();
});

test('a rejected reservation transaction leaves no partial authority records or fence advance', async () => {
  const seededValue = await seeded();
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  await assert.rejects(authority.reserve({ scope: seededValue.scope, amounts: amount({ providerAttempts: -1 }) }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_mismatch');
  assert.equal((await seededValue.context.database.select().from(externalExecutionReservation)).length, 0);
  assert.equal((await seededValue.context.database.select().from(externalExecutionLease)).length, 0);
  assert.equal((await seededValue.context.database.select().from(externalExecutionEvent)).length, 0);
  await seededValue.context.client.close();
});

test('global semaphore fences concurrent queues and stale owners', async () => {
  let now = new Date('2026-09-23T10:00:00.000Z');
  const seededValue = await seeded({ concurrency: 1 });
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => now, leaseMs: 1_000 });
  const first = await authority.reserve({ scope: seededValue.scope, amounts: amount() });
  await assert.rejects(authority.reserve({ scope: seededValue.scope, amounts: amount() }), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'external_concurrency_unavailable');
  now = new Date(now.getTime() + 2_000);
  const successor = await authority.reserve({ scope: seededValue.scope, amounts: amount() });
  assert.ok(successor.fence > first.fence);
  const firstEvents = await seededValue.context.database.select({ type: externalExecutionEvent.eventType })
    .from(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, first.reservationId));
  assert.deepEqual(firstEvents.map(({ type }) => type), ['reserved', 'expired']);
  await assert.rejects(first.assertOwnership(), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_expired');
  await successor.complete('succeeded');
  await seededValue.context.client.close();
});

test('simultaneous reservation contenders cannot exceed account concurrency', async () => {
  const seededValue = await seeded({ concurrency: 1 });
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  const outcomes = await Promise.allSettled([
    authority.reserve({ operationKey: randomUUID(), scope: seededValue.scope, amounts: amount() }),
    authority.reserve({ operationKey: randomUUID(), scope: seededValue.scope, amounts: amount() }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  assert.ok(rejected?.reason instanceof ExternalExecutionAuthorityError);
  assert.equal(rejected.reason.code, 'external_concurrency_unavailable');
  const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof authority.reserve>>> => outcome.status === 'fulfilled');
  await fulfilled?.value.complete('succeeded');
  await seededValue.context.client.close();
});

test('ambiguous transport outcomes consume the reserved provider attempt', async () => {
  const seededValue = await seeded();
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now, fetch: async () => { throw new TypeError('simulated transport loss'); } });
  const permit = await authority.reserve({ scope: seededValue.scope, amounts: amount({ providerAttempts: 1 }) });
  await assert.rejects(permit.meteredFetch('https://provider.invalid'));
  await assert.rejects(permit.beginProviderAttempt(), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
  const events = await seededValue.context.database.select({ type: externalExecutionEvent.eventType }).from(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, permit.reservationId));
  assert.deepEqual(events.map((row) => row.type), ['reserved', 'attempt_started', 'attempt_ambiguous']);
  await permit.complete('ambiguous', 'provider_attempt_ambiguous');
  await seededValue.context.client.close();
});

test('post-response token overage is reported as a stable exhausted-authority failure', async () => {
  const seededValue = await seeded();
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, { clock: () => seededValue.now });
  const permit = await authority.reserve({ scope: seededValue.scope, amounts: amount({ outputTokens: 1 }) });
  const ordinal = await permit.beginProviderAttempt();
  await assert.rejects(permit.finishProviderAttempt(ordinal, 'succeeded', { outputTokens: 2 }),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
  await permit.complete('ambiguous', 'provider_attempt_ambiguous');
  await seededValue.context.client.close();
});

test('a provider response arriving after lease expiry cannot become a successful outcome', async () => {
  let current = new Date('2026-09-23T10:00:00.000Z');
  const seededValue = await seeded();
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, {
    clock: () => current,
    leaseMs: 1_000,
    fetch: async () => {
      current = new Date(current.getTime() + 2_000);
      return new Response('{}', { status: 200 });
    },
  });
  const permit = await authority.reserve({ scope: seededValue.scope, amounts: amount() });
  await assert.rejects(permit.meteredFetch('https://provider.invalid'),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_expired');
  await assert.rejects(permit.complete('succeeded'),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_authority_expired');
  await permit.complete('ambiguous', 'provider_attempt_ambiguous');
  const [lease] = await seededValue.context.database.select().from(externalExecutionLease)
    .where(eq(externalExecutionLease.reservationId, permit.reservationId));
  assert.equal(lease?.state, 'ambiguous');
  const events = await seededValue.context.database.select({ type: externalExecutionEvent.eventType })
    .from(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, permit.reservationId));
  assert.deepEqual(events.map(({ type }) => type), ['reserved', 'attempt_started', 'failed']);
  await seededValue.context.client.close();
});

test('SDK-style hidden retries are metered as raw attempts and cannot exceed the reserved allowance', async () => {
  let rawCalls = 0;
  const seededValue = await seeded();
  const authority = new DurableExternalExecutionAuthorizer(seededValue.context.database, {
    clock: () => seededValue.now,
    fetch: async () => { rawCalls += 1; return new Response(null, { status: 503 }); },
  });
  const permit = await authority.reserve({ scope: seededValue.scope, amounts: amount({ providerAttempts: 3 }) });
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await permit.meteredFetch('https://provider.invalid')).status, 503);
  await assert.rejects(permit.meteredFetch('https://provider.invalid'),
    (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'execution_budget_exhausted');
  assert.equal(rawCalls, 3);
  const outcomes = await seededValue.context.database.select({ type: externalExecutionEvent.eventType })
    .from(externalExecutionEvent).where(eq(externalExecutionEvent.reservationId, permit.reservationId));
  assert.equal(outcomes.filter(({ type }) => type === 'attempt_failed').length, 3);
  await permit.complete('failed', 'execution_budget_exhausted');
  await seededValue.context.client.close();
});
