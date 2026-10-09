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
  repairRunAttempt,
  user,
  workspace,
} from '../db/schema.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { GeminiInvestigationProvider } from '../lib/ai-investigations/gemini-provider.ts';
import { MODEL_INSTRUCTIONS, MODEL_TOOLS, CONCLUSION_SCHEMA, buildInitialInput } from '../lib/ai-investigations/protocol.ts';
import { AI_CANDIDATE_PROPOSAL_INSTRUCTIONS, AI_CANDIDATE_PROPOSAL_TOOLS, AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA, buildAiCandidateProposalInput } from '../lib/ai-candidate-generations/protocol.ts';
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

async function addOperationGrant(value: Awaited<ReturnType<typeof seeded>>, scope: ExternalExecutionScope, overrides: Partial<typeof scopeLimits>) {
  const limits = { ...scopeLimits, ...overrides };
  await value.context.database.insert(executionBudgetGrant).values({
    id: randomUUID(), version: 1, scope: 'operation', workspaceId: scope.workspaceId,
    repairRunId: scope.repairRunId, githubRepositoryId: scope.githubRepositoryId, baseCommitSha: scope.baseCommitSha,
    operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId,
    maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts,
    maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens, maxSandboxIdentities: limits.sandboxIdentities,
    maxSandboxRuntimeMs: limits.sandboxRuntimeMs, sandboxResourceClass: limits.sandboxResourceClass,
    maxVerificationAttempts: limits.verificationAttempts,
    maxRepairLoopIterations: limits.repairLoopIterations, maxConcurrentExternalOperations: 0,
    expiresAt: new Date('2026-09-24T10:00:00.000Z'), authorizedBy: 'test-operator', createdAt: value.now,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId: scope.workspaceId,
      repairRunId: scope.repairRunId ?? null, githubRepositoryId: scope.githubRepositoryId ?? null, baseCommitSha: scope.baseCommitSha ?? null,
      operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId ?? null,
      acceptancePurpose: null, limits, expiresAt: '2026-09-24T10:00:00.000Z', authorizedBy: 'test-operator' }),
  });
}

test('M7.7: fixed 2+3 grants deny request six across changed execution IDs without refund or supplemental authority', async (t) => {
  const value = await seeded({ runBound: true, limits: { logicalRequests: 2, providerAttempts: 2, inputTokens: 12_288, outputTokens: 5_000 },
    accountLimits: { logicalRequests: 8, providerAttempts: 197, inputTokens: 32_768, outputTokens: 23_000,
      sandboxIdentities: 2, sandboxRuntimeMs: 1_200_000, verificationAttempts: 1, repairLoopIterations: 1 } });
  t.after(() => value.context.client.close());
  const generationScope: ExternalExecutionScope = { ...value.scope, operationCategory: 'gemini_candidate_generation' };
  await addOperationGrant(value, generationScope, { logicalRequests: 3, providerAttempts: 3, inputTokens: 20_480, outputTokens: 18_000 });
  for (const operationCategory of ['sandbox_baseline', 'sandbox_verification', 'repair_loop_iteration'] as const) {
    const scope: ExternalExecutionScope = { ...value.scope, operationCategory, providerId: operationCategory === 'repair_loop_iteration' ? 'vigilo' : 'vercel' };
    delete scope.modelId;
    await addOperationGrant(value, scope, { logicalRequests: 1, providerAttempts: operationCategory === 'repair_loop_iteration' ? 0 : 96,
      inputTokens: 0, outputTokens: 0, sandboxIdentities: operationCategory === 'repair_loop_iteration' ? 0 : 1,
      sandboxRuntimeMs: operationCategory === 'repair_loop_iteration' ? 0 : 600_000,
      verificationAttempts: operationCategory === 'sandbox_verification' ? 1 : 0,
      repairLoopIterations: operationCategory === 'repair_loop_iteration' ? 1 : 0,
      ...(operationCategory === 'repair_loop_iteration' ? {} : { sandboxResourceClass: 'vcpu_1' as const }) });
  }
  let calls = 0; const inputBytes: number[] = [];
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => assert.fail('Gemini must use its explicitly injected fake client') });
  const provider = new GeminiInvestigationProvider('test-only-not-real-gemini-key', 'gemini-3.1-flash-lite', {
    create: async (request, options) => {
      calls += 1; inputBytes.push(Buffer.byteLength(JSON.stringify(request), 'utf8'));
      assert.deepEqual(options?.retries, { strategy: 'none' }); assert.equal(request.store, false);
      return { status: 'completed', steps: [], output_text: '{}' } as never;
    },
  }, authority);
  const facts = { objective: 'Restore the failing required test.', baseCommitSha: value.scope.baseCommitSha!,
    profile: { runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', testRunner: 'node-test', commands: ['ci', 'test'] },
    baseline: { id: randomUUID(), executionOutcome: 'customer_baseline_failure', overallOutcome: 'failed' },
    context: { maxOperations: 40, maxCumulativeBytes: 1_048_576, maxGenerationContextBytes: 131_072 } };
  const session = (scope: ExternalExecutionScope) => provider.createSession(scope.operationCategory === 'gemini_investigation' ? {
    instructions: MODEL_INSTRUCTIONS, initialInput: buildInitialInput(facts), tools: MODEL_TOOLS, conclusionSchema: CONCLUSION_SCHEMA,
    maxOutputTokens: 2_500, externalExecutionScope: scope,
  } : {
    instructions: AI_CANDIDATE_PROPOSAL_INSTRUCTIONS, initialInput: buildAiCandidateProposalInput({ ...facts,
      conclusion: { status: 'diagnosis_found', summary: 'Required test fails.', suspectedFiles: [], confidence: 'low' }, protocolVersion: 4 }),
    tools: AI_CANDIDATE_PROPOSAL_TOOLS, conclusionSchema: AI_CANDIDATE_PROPOSAL_PROVIDER_SCHEMA, maxOutputTokens: 6_000, externalExecutionScope: scope,
  });
  for (const scope of [value.scope, value.scope, generationScope, generationScope, generationScope]) {
    await session(scope).next({ signal: new AbortController().signal });
  }
  for (const scope of [value.scope, generationScope]) await assert.rejects(session(scope).next({ signal: new AbortController().signal }), /execution_budget_exhausted/);
  assert.equal(calls, 5);
  const reservations = await value.context.database.select().from(externalExecutionReservation);
  assert.equal(reservations.length, 5); assert.equal(new Set(reservations.map((row) => row.operationKey)).size, 5);
  assert.deepEqual(reservations.map((row) => row.reservedInputTokens), inputBytes);
  assert.ok(inputBytes.slice(0, 2).every((bytes) => bytes <= 4_096));
  assert.ok(inputBytes.slice(2).every((bytes) => bytes <= 6_144));
  t.diagnostic(`Serialized UTF-8 input bytes (not tokenizer counts): investigation ${inputBytes.slice(0, 2).join('+')}; generation ${inputBytes.slice(2).join('+')}`);
  assert.equal((await value.context.database.select().from(executionBudgetGrant)).length, 6);
});

for (const source of ['investigation', 'generation'] as const) test(`M7.7: ${source} ambiguity fences both Gemini categories and survives restart`, async (t) => {
  const category = source === 'investigation' ? 'gemini_investigation' : 'gemini_candidate_generation';
  const value = await seeded({ runBound: true, scope: { operationCategory: category } }); t.after(() => value.context.client.close());
  const otherScope: ExternalExecutionScope = { ...value.scope, operationCategory: category === 'gemini_investigation' ? 'gemini_candidate_generation' : 'gemini_investigation' };
  await addOperationGrant(value, otherScope, {});
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  const ordinal = await permit.beginProviderAttempt(); await permit.finishProviderAttempt(ordinal, 'ambiguous');
  await permit.complete('ambiguous', 'provider_attempt_ambiguous');
  const restarted = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  for (const scope of [value.scope, otherScope]) await assert.rejects(restarted.reserve({ scope, operationKey: randomUUID(), amounts: amount() }), /provider_attempt_ambiguous/);
  assert.equal((await value.context.database.select().from(externalExecutionReservation)).length, 1);
});

test('M7.7: a permit admitted before ambiguity cannot begin transport afterward', async (t) => {
  const value = await seeded({ runBound: true, concurrency: 2 }); t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => { calls += 1; return Response.json({ ok: true }); } });
  const first = await authority.reserve({ scope: value.scope, amounts: amount() });
  const waiting = await authority.reserve({ scope: value.scope, amounts: amount() });
  const ordinal = await first.beginProviderAttempt(); await first.finishProviderAttempt(ordinal, 'ambiguous');
  await assert.rejects(waiting.meteredFetch('https://provider.invalid'), /provider_attempt_ambiguous/);
  assert.equal(calls, 0);
});

test('M7.7: cleanup success cannot convert an ambiguous business reservation to succeeded', async (t) => {
  const value = await seeded({ runBound: true }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  const ordinal = await permit.beginProviderAttempt(); await permit.finishProviderAttempt(ordinal, 'ambiguous');
  await permit.complete('succeeded');
  const [lease] = await value.context.database.select().from(externalExecutionLease);
  assert.equal(lease?.state, 'ambiguous');
  await assert.rejects(authority.reserve({ scope: value.scope, amounts: amount() }), /provider_attempt_ambiguous/);
});

test('M7.7 late success: another reservation ambiguity prevents a successful provider attempt outcome', async (t) => {
  const value = await seeded({ runBound: true, concurrency: 2 }); t.after(() => value.context.client.close());
  const generationScope: ExternalExecutionScope = { ...value.scope, operationCategory: 'gemini_candidate_generation' };
  await addOperationGrant(value, generationScope, {});
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const first = await authority.reserve({ scope: value.scope, amounts: amount() });
  const late = await authority.reserve({ scope: generationScope, amounts: amount() });
  const firstOrdinal = await first.beginProviderAttempt();
  const lateOrdinal = await late.beginProviderAttempt();
  await first.finishProviderAttempt(firstOrdinal, 'ambiguous');
  await first.complete('ambiguous', 'provider_attempt_ambiguous');

  await assert.rejects(late.finishProviderAttempt(lateOrdinal, 'succeeded'), /provider_attempt_ambiguous/);
  await late.complete('succeeded');
  const events = await value.context.database.select().from(externalExecutionEvent)
    .where(eq(externalExecutionEvent.reservationId, late.reservationId));
  assert.equal(events.filter((event) => ['attempt_succeeded', 'completed'].includes(event.eventType)).length, 0);
  const [lease] = await value.context.database.select().from(externalExecutionLease)
    .where(eq(externalExecutionLease.reservationId, late.reservationId));
  assert.notEqual(lease?.state, 'succeeded');
});

test('M7.7 late success: another reservation ambiguity prevents completion after an earlier successful attempt', async (t) => {
  const value = await seeded({ runBound: true, concurrency: 2 }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const first = await authority.reserve({ scope: value.scope, amounts: amount() });
  const late = await authority.reserve({ scope: value.scope, amounts: amount() });
  const firstOrdinal = await first.beginProviderAttempt();
  const lateOrdinal = await late.beginProviderAttempt();
  await late.finishProviderAttempt(lateOrdinal, 'succeeded');
  await first.finishProviderAttempt(firstOrdinal, 'ambiguous');
  await first.complete('ambiguous', 'provider_attempt_ambiguous');

  const [completion] = await Promise.allSettled([late.complete('succeeded')]);
  if (completion?.status === 'rejected') assert.match(String(completion.reason), /provider_attempt_ambiguous/);
  const events = await value.context.database.select().from(externalExecutionEvent)
    .where(eq(externalExecutionEvent.reservationId, late.reservationId));
  assert.equal(events.filter((event) => event.eventType === 'attempt_succeeded').length, 1, 'preserve the successful outcome recorded before the fence');
  assert.equal(events.filter((event) => event.eventType === 'completed').length, 0, 'a fenced business reservation must not record trustworthy completion');
  const [lease] = await value.context.database.select().from(externalExecutionLease)
    .where(eq(externalExecutionLease.reservationId, late.reservationId));
  assert.notEqual(lease?.state, 'succeeded');
});

for (const loss of ['expiry', 'revocation', 'terminated'] as const) test(`M7.7 late success: completion after ${loss} cannot convert an earlier successful attempt to reservation success`, async (t) => {
  const value = await seeded({ runBound: true }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, leaseMs: 1_000 });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  const ordinal = await permit.beginProviderAttempt();
  await permit.finishProviderAttempt(ordinal, 'succeeded');
  if (loss === 'expiry') value.now = new Date(value.now.getTime() + 1_001);
  else if (loss === 'revocation') await value.context.database.insert(executionBudgetGrantRevocation).values({
    id: randomUUID(), grantId: value.grantId, reasonCode: 'operator_revoked', revokedBy: 'test-operator', createdAt: value.now,
  });
  else await permit.complete('failed', 'sandbox_cleanup_unresolved');

  await assert.rejects(permit.complete('succeeded'), loss === 'revocation' ? /execution_authority_missing/ : /execution_authority_expired/);
  const events = await value.context.database.select().from(externalExecutionEvent)
    .where(eq(externalExecutionEvent.reservationId, permit.reservationId));
  assert.equal(events.filter((event) => event.eventType === 'completed').length, 0);
  const [lease] = await value.context.database.select().from(externalExecutionLease)
    .where(eq(externalExecutionLease.reservationId, permit.reservationId));
  assert.notEqual(lease?.state, 'succeeded');
});

for (const state of ['expired', 'terminated'] as const) test(`M7.7: unmatched attempt with ${state} ownership durably fences admission`, async (t) => {
  const value = await seeded({ runBound: true }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, leaseMs: 1_000 });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() }); await permit.beginProviderAttempt();
  if (state === 'expired') value.now = new Date(value.now.getTime() + 1_001);
  else await permit.complete('failed');
  const restarted = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  await assert.rejects(restarted.reserve({ scope: value.scope, amounts: amount() }), /provider_attempt_ambiguous/);
});

test('M7.7: a live valid unmatched attempt is in flight, not ambiguous', async (t) => {
  const value = await seeded({ runBound: true, concurrency: 1 }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() }); await permit.beginProviderAttempt();
  await assert.rejects(authority.reserve({ scope: value.scope, amounts: amount() }), /external_concurrency_unavailable/);
});

test('M7.7: simultaneous admissions after ambiguity are both denied without partial reservations', async (t) => {
  const value = await seeded({ runBound: true, concurrency: 2 }); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const first = await authority.reserve({ scope: value.scope, amounts: amount() });
  const ordinal = await first.beginProviderAttempt(); await first.finishProviderAttempt(ordinal, 'ambiguous');
  await first.complete('ambiguous');
  const results = await Promise.allSettled([authority.reserve({ scope: value.scope, amounts: amount() }), authority.reserve({ scope: value.scope, amounts: amount() })]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason instanceof ExternalExecutionAuthorityError && result.reason.code === 'provider_attempt_ambiguous'));
  assert.equal((await value.context.database.select().from(externalExecutionReservation)).length, 1);
});

test('M7.7: an ambiguous lease alone fences every business category, not an unrelated run', async (t) => {
  const value = await seeded({ runBound: true, accountLimits: { providerAttempts: 40, sandboxIdentities: 2, sandboxRuntimeMs: 120_000, verificationAttempts: 1, repairLoopIterations: 1 } });
  t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const first = await authority.reserve({ scope: value.scope, amounts: amount() });
  await first.complete('ambiguous');
  for (const operationCategory of ['gemini_candidate_generation', 'sandbox_baseline', 'sandbox_verification', 'repair_loop_iteration'] as const) {
    const scope: ExternalExecutionScope = { ...value.scope, operationCategory,
      providerId: operationCategory.startsWith('sandbox_') ? 'vercel-sandbox' : operationCategory === 'repair_loop_iteration' ? 'vigilo' : 'google' };
    if (!operationCategory.startsWith('gemini_')) delete scope.modelId;
    const sandbox = operationCategory.startsWith('sandbox_');
    await addOperationGrant(value, scope, { providerAttempts: 10, sandboxIdentities: sandbox ? 1 : 0, sandboxRuntimeMs: sandbox ? 60_000 : 0,
      verificationAttempts: operationCategory === 'sandbox_verification' ? 1 : 0, repairLoopIterations: operationCategory === 'repair_loop_iteration' ? 1 : 0,
      ...(sandbox ? { sandboxResourceClass: 'vcpu_1' as const } : {}) });
    await assert.rejects(authority.reserve({ scope, amounts: sandbox ? sandboxAmounts : amount(),
      ...(sandbox ? { sandbox: sandboxContext } : {}) }), /provider_attempt_ambiguous/);
  }
  const unrelatedScope = { ...value.scope, repairRunId: randomUUID(), githubRepositoryId: 43 };
  await value.context.database.insert(repairRun).values({ id: unrelatedScope.repairRunId, workspaceId: unrelatedScope.workspaceId,
    githubRepositoryId: 43, installationId: 77, profileIdentity: 'b'.repeat(64), baseCommitSha: 'a'.repeat(40),
    idempotencyKey: randomUUID(), state: 'created', stateChangedAt: value.now, updatedAt: value.now });
  await addOperationGrant(value, unrelatedScope, {});
  const unrelated = await authority.reserve({ scope: unrelatedScope, amounts: amount() });
  await unrelated.complete('succeeded');
});

const sandboxContext = { name: 'test', teamId: 'team_test', projectId: 'project_test' };
const sandboxAmounts = amount({ providerAttempts: 10, inputTokens: 0, outputTokens: 0, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' });

const sandboxIdentitySeed = () => seeded({ runBound: true, scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
  limits: { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' },
  accountLimits: { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000 } });

function sandboxMetadata() {
  const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000, status: 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
  return { session, sandbox: { name: 'test', persistent: false, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: session.status }, routes: [] };
}

test('M7.7 late success: pending Sandbox create cannot confirm identity after a Gemini reservation becomes ambiguous', async (t) => {
  const value = await seeded({ runBound: true, concurrency: 2,
    accountLimits: { providerAttempts: 14, sandboxIdentities: 1, sandboxRuntimeMs: 60_000 } });
  t.after(() => value.context.client.close());
  const sandboxScope: ExternalExecutionScope = { ...value.scope, operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' };
  delete sandboxScope.modelId;
  await addOperationGrant(value, sandboxScope, { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' });
  const geminiAuthority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  const gemini = await geminiAuthority.reserve({ scope: value.scope, amounts: amount() });
  const ordinal = await gemini.beginProviderAttempt();
  let calls = 0;
  const sandboxAuthority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
    calls += 1;
    if (calls === 1) {
      await gemini.finishProviderAttempt(ordinal, 'ambiguous');
      await gemini.complete('ambiguous', 'provider_attempt_ambiguous');
    }
    return Response.json(sandboxMetadata());
  } });
  const permit = await sandboxAuthority.reserve({ scope: sandboxScope, amounts: sandboxAmounts, sandbox: sandboxContext });
  const sandbox = await Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false,
    resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
  assert.equal(calls, 1);
  assert.ok(permit.resolveSandboxCreation);
  await assert.rejects(permit.resolveSandboxCreation({ name: sandbox.name, sessionId: sandbox.currentSession().sessionId }), /provider_attempt_ambiguous/);
  const events = await value.context.database.select().from(externalExecutionEvent)
    .where(eq(externalExecutionEvent.reservationId, permit.reservationId));
  assert.equal(events.filter((event) => ['attempt_succeeded', 'completed'].includes(event.eventType)).length, 0);
  await assert.rejects(permit.meteredFetch(`https://vercel.com/api/v2/sandboxes/sessions/test-session/cmd?teamId=${sandboxContext.teamId}`, { method: 'POST' }), /provider_attempt_ambiguous/);
  // The validated late identity is useful only for exact cleanup, never business.
  await permit.meteredFetch(`https://vercel.com/api/v2/sandboxes/sessions/test-session/stop?teamId=${sandboxContext.teamId}`, { method: 'POST' });
  assert.equal(calls, 2, 'only one creation and one exact cleanup dispatch');
  await permit.complete('failed');
  const finalEvents = await value.context.database.select().from(externalExecutionEvent)
    .where(eq(externalExecutionEvent.reservationId, permit.reservationId));
  assert.equal(finalEvents.some((event) => event.attemptOrdinal === 1 && event.eventType === 'attempt_succeeded'), false);
  assert.equal(finalEvents.some((event) => event.eventType === 'completed'), false);
  await assert.rejects(sandboxAuthority.reserve({ scope: sandboxScope, amounts: sandboxAmounts, sandbox: sandboxContext }), /provider_attempt_ambiguous/);
});

test('M7.7 hardening: mutating caller-owned Sandbox binding cannot alter reserved transport capability', async (t) => {
  const value = await sandboxIdentitySeed(); t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (input, init) => {
    calls += 1; const url = new URL(String(input)); assert.equal(url.searchParams.get('teamId'), sandboxContext.teamId);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); assert.equal(body.name, sandboxContext.name); assert.equal(body.projectId, sandboxContext.projectId);
    }
    return Response.json(sandboxMetadata());
  } });
  const binding = { ...sandboxContext };
  const permit = await authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: binding });
  binding.name = 'foreign-resource'; binding.projectId = 'foreign-project'; binding.teamId = 'foreign-team';
  await Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false,
    resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
  assert.ok(permit.resolveSandboxCreation); await permit.resolveSandboxCreation({ name: 'test', sessionId: 'test-session' });
  await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', ...binding, resume: false, fetch: permit.meteredFetch }), /execution_authority_mismatch/);
  assert.equal(calls, 1);
  await Sandbox.get({ token: 'fake-opaque-access-token', ...sandboxContext, resume: false, fetch: permit.meteredFetch });
  assert.equal(calls, 2);
});

test('M7.7 hardening: SDK identity cannot be confirmed before dispatch or after a known failed create', async (t) => {
  const value = await sandboxIdentitySeed(); t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
    calls += 1; return Response.json({}, { status: 429 });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext });
  assert.ok(permit.resolveSandboxCreation);
  await assert.rejects(permit.resolveSandboxCreation({ name: 'test', sessionId: 'test-session' }), /execution_authority_mismatch/);
  assert.equal(calls, 0);
  await assert.rejects(Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false,
    resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch }), /sandbox_creation_failed/);
  await assert.rejects(permit.resolveSandboxCreation({ name: 'test', sessionId: 'test-session' }), /sandbox_creation_failed/);
  assert.equal(calls, 1);
  const events = await value.context.database.select().from(externalExecutionEvent);
  assert.equal(events.filter((event) => event.eventType === 'attempt_started').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'attempt_failed').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'attempt_succeeded').length, 0);
});

test('M7.7 hardening: an identity-bearing permit cannot use lookup or business admission as its first request', async (t) => {
  const value = await sandboxIdentitySeed(); t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
    calls += 1; return Response.json(sandboxMetadata());
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext });
  await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', ...sandboxContext, resume: false, fetch: permit.meteredFetch }), /execution_authority_mismatch/);
  await assert.rejects(permit.beginProviderAttempt(), /execution_authority_mismatch/);
  assert.equal(calls, 0);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_started').length, 0);
  await Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false,
    resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
  assert.ok(permit.resolveSandboxCreation); await permit.resolveSandboxCreation({ name: 'test', sessionId: 'test-session' });
  assert.equal(calls, 1);
});

test('M7.7 hardening: create 5xx remains terminal when ambiguity outcome persistence fails', async (t) => {
  const value = await sandboxIdentitySeed(); t.after(() => value.context.client.close());
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
    calls += 1; return Response.json({}, { status: 503 });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext });
  t.mock.method(permit, 'finishProviderAttempt', async () => { throw new Error('simulated outcome persistence unavailable'); });
  const create = () => Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false,
    resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
  await assert.rejects(create(), (error: unknown) => error instanceof ExternalExecutionAuthorityError && error.code === 'provider_attempt_ambiguous');
  assert.equal(calls, 1);
  await assert.rejects(create()); assert.equal(calls, 1);
  const events = await value.context.database.select().from(externalExecutionEvent);
  assert.equal(events.filter((event) => event.eventType === 'attempt_started').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'attempt_ambiguous').length, 0, 'do not fabricate a persisted outcome');
  await permit.complete('failed');
  const [lease] = await value.context.database.select().from(externalExecutionLease);
  assert.equal(lease?.state, 'ambiguous');
  const restarted = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now });
  await assert.rejects(restarted.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext }), /provider_attempt_ambiguous/);
});

for (const failure of ['network', 'timeout', '429', '500', '503', 'redirect', 'malformed'] as const) test(`M7.7: installed SDK create ${failure} dispatches at most once and direct retry cannot bypass`, async (t) => {
  const value = await seeded({ runBound: true, scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
    limits: { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' }, accountLimits: { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000 } });
  t.after(() => value.context.client.close());
  let calls = 0; let globalCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { globalCalls += 1; throw new Error('unmetered fetch'); });
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (input, init) => {
    calls += 1; assert.equal(new URL(String(input)).pathname, '/api/v3/sandboxes'); assert.equal(init?.method, 'POST');
    if (failure === 'network') throw new TypeError('fake network loss');
    if (failure === 'timeout') throw new DOMException('fake timeout', 'TimeoutError');
    if (failure === 'malformed') return Response.json({ sandbox: { name: 'wrong-resource' }, session: {} });
    if (failure === 'redirect') return new Response(null, { status: 307, headers: { Location: 'https://other.invalid' } });
    return Response.json({}, { status: Number(failure), headers: { 'Retry-After': '0' } });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext });
  const create = () => Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false, resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
  await assert.rejects(create());
  assert.ok(permit.resolveSandboxCreation); await permit.resolveSandboxCreation();
  assert.equal(calls, 1); assert.equal(globalCalls, 0);
  await assert.rejects(create()); assert.equal(calls, 1);
  assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_started').length, 1);
});

test('M7.7: two fixed identity grants dispatch no more than two create POSTs', async (t) => {
  const value = await seeded({ runBound: true, scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
    limits: { logicalRequests: 1, providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' },
    accountLimits: { logicalRequests: 2, providerAttempts: 20, sandboxIdentities: 2, sandboxRuntimeMs: 120_000, verificationAttempts: 1 } });
  t.after(() => value.context.client.close());
  const verificationScope: ExternalExecutionScope = { ...value.scope, operationCategory: 'sandbox_verification' };
  await addOperationGrant(value, verificationScope, { logicalRequests: 1, providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, verificationAttempts: 1, sandboxResourceClass: 'vcpu_1' });
  let calls = 0;
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (_input, init) => {
    calls += 1; const name = JSON.parse(String(init?.body)).name;
    const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000, status: 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
    return Response.json({ session, sandbox: { name, persistent: false, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: 'running' }, routes: [] });
  } });
  for (const scope of [value.scope, verificationScope]) {
    const context = { ...sandboxContext, name: scope.operationCategory.replaceAll('_', '-') };
    const permit = await authority.reserve({ scope, amounts: { ...sandboxAmounts, verificationAttempts: scope.operationCategory === 'sandbox_verification' ? 1 : 0 }, sandbox: context });
    const create = () => Sandbox.create({ token: 'fake-opaque-access-token', ...context, image: 'vercel/sandbox/node:24', persistent: false, resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
    await create(); assert.ok(permit.resolveSandboxCreation); await permit.resolveSandboxCreation({ name: context.name, sessionId: 'test-session' });
    await assert.rejects(create()); await permit.complete('succeeded');
  }
  await assert.rejects(authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext }), /execution_budget_exhausted/);
  assert.equal(calls, 2);
});

test('M7.7: ambiguous create preserves exact bounded lookup/stop/delete but never business execution or foreign-resource access', async (t) => {
  const value = await seeded({ runBound: true, scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
    limits: { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' },
    accountLimits: { providerAttempts: 10, sandboxIdentities: 1, sandboxRuntimeMs: 60_000 } });
  t.after(() => value.context.client.close());
  const requests: string[] = [];
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (input, init) => {
    const url = new URL(String(input)); requests.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === '/api/v3/sandboxes' && init?.method === 'POST') throw new TypeError('lost create response');
    const stopped = url.pathname.endsWith('/stop');
    const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000, status: stopped ? 'stopped' : 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
    return Response.json({ session, sandbox: { name: 'test', persistent: false, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: session.status }, routes: [] });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext });
  const credentials = { token: 'fake-opaque-access-token', ...sandboxContext };
  await assert.rejects(Sandbox.create({ ...credentials, image: 'vercel/sandbox/node:24', persistent: false, resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch }));
  assert.ok(permit.resolveSandboxCreation); await permit.resolveSandboxCreation();
  const sandbox = await Sandbox.get({ ...credentials, resume: false, fetch: permit.meteredFetch });
  await sandbox.stop(); await sandbox.delete();
  const count = requests.length;
  for (const [method, path] of [
    ['POST', '/api/v3/sandboxes'], ['POST', '/api/v2/sandboxes/test/sessions'],
    ['POST', '/api/v2/sandboxes/test-session/cmd'], ['POST', '/api/v2/sandboxes/test-session/fs/upload'],
    ['PATCH', '/api/v2/sandboxes/test-session'], ['DELETE', '/api/v2/sandboxes/foreign-resource'],
    ['GET', '/api/v2/sandboxes/foreign-resource'],
  ] as const) await assert.rejects(permit.meteredFetch(`https://vercel.com${path}?teamId=team_test`, { method }));
  assert.equal(requests.length, count);
  assert.equal(requests.filter((request) => request === 'POST /api/v3/sandboxes').length, 1);
  await permit.complete('succeeded');
  const [lease] = await value.context.database.select().from(externalExecutionLease);
  assert.equal(lease?.state, 'ambiguous');
  await assert.rejects(authority.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext }), /provider_attempt_ambiguous/);
});

test('M7.7: restart cleanup derives exact identity from durable attempt and remains bounded after run ambiguity', async (t) => {
  const value = await seeded({ runBound: true, scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
    limits: { logicalRequests: 2, providerAttempts: 20, sandboxIdentities: 1, sandboxRuntimeMs: 120_000, sandboxResourceClass: 'vcpu_1' },
    accountLimits: { logicalRequests: 2, providerAttempts: 20, sandboxIdentities: 1, sandboxRuntimeMs: 120_000 } });
  t.after(() => value.context.client.close());
  const attemptId = randomUUID();
  await value.context.database.insert(repairRunAttempt).values({ id: attemptId, repairRunId: value.scope.repairRunId!,
    queueJobId: randomUUID(), attemptNumber: 1, expectedBaselineId: randomUUID(), ownershipToken: randomUUID(),
    state: 'abandoned', claimedAt: value.now, heartbeatAt: value.now, finishedAt: value.now,
    sandboxName: 'test', sandboxSessionId: 'test-session' });
  let originalCreates = 0;
  const original = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (input, init) => {
    originalCreates += 1; assert.equal(new URL(String(input)).pathname, '/api/v3/sandboxes'); assert.equal(init?.method, 'POST');
    throw new TypeError('fake lost create response');
  } });
  const first = await original.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext });
  await assert.rejects(Sandbox.create({ token: 'fake-opaque-access-token', ...sandboxContext, image: 'vercel/sandbox/node:24', persistent: false,
    resources: { vcpus: 1 }, timeout: 60_000, fetch: first.meteredFetch }), /provider_attempt_ambiguous/);
  assert.equal(originalCreates, 1);
  await first.complete('ambiguous');
  const requests: string[] = [];
  const restarted = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (input, init) => {
    const url = new URL(String(input)); requests.push(`${init?.method} ${url.pathname}`);
    const stopped = url.pathname.endsWith('/stop');
    const session = { id: 'test-session', memory: 2048, vcpus: 1, region: 'test', timeout: 60_000, status: stopped ? 'stopped' : 'running', requestedAt: 1, createdAt: 1, cwd: '/vercel/sandbox', updatedAt: 1 };
    return Response.json({ session, sandbox: { name: 'test', persistent: false, createdAt: 1, updatedAt: 1, currentSessionId: session.id, status: session.status }, routes: [] });
  } });
  const recoveryRequest = { scope: value.scope, amounts: { ...sandboxAmounts, inputTokens: 0, outputTokens: 0, sandboxIdentities: 0 }, sandbox: sandboxContext,
    cleanup: { kind: 'baseline' as const, attemptId } };
  for (const invalid of [
    { ...recoveryRequest, cleanup: { kind: 'baseline' as const, attemptId: randomUUID() } },
    { ...recoveryRequest, sandbox: { ...sandboxContext, name: 'wrong' } },
    { ...recoveryRequest, scope: { ...value.scope, repairRunId: randomUUID() } },
    { ...recoveryRequest, scope: { ...value.scope, workspaceId: randomUUID() } },
    { ...recoveryRequest, amounts: { ...recoveryRequest.amounts, sandboxIdentities: 1 } },
  ]) await assert.rejects(restarted.reserve(invalid), /execution_authority_mismatch/);
  const permit = await restarted.reserve(recoveryRequest);
  const credentials = { token: 'fake-opaque-access-token', ...sandboxContext };
  const sandbox = await Sandbox.get({ ...credentials, resume: false, fetch: permit.meteredFetch });
  await sandbox.stop(); await sandbox.delete();
  assert.equal(requests.length, 3);
  await assert.rejects(Sandbox.create({ ...credentials, image: 'vercel/sandbox/node:24', persistent: false, fetch: permit.meteredFetch }));
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/sessions/test-session/cmd?teamId=team_test', { method: 'POST' }));
  assert.equal(requests.length, 3);
  await permit.complete('succeeded');
  await assert.rejects(restarted.reserve({ scope: value.scope, amounts: sandboxAmounts, sandbox: sandboxContext }), /provider_attempt_ambiguous/);
  await assert.rejects(restarted.reserve(recoveryRequest), /execution_budget_exhausted/);
  assert.equal((await value.context.database.select().from(externalExecutionReservation)).length, 2);
  const [historical] = await value.context.database.select().from(externalExecutionLease).where(eq(externalExecutionLease.reservationId, first.reservationId));
  assert.equal(historical?.state, 'ambiguous');
});

test('review: success after in-flight grant revocation cannot become durable attempt or reservation success', async (t) => {
  const value = await seeded(); t.after(() => value.context.client.close());
  const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async () => {
    await value.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: value.grantId, revokedBy: 'test-operator', reasonCode: 'test', createdAt: value.now });
    return Response.json({ success: true });
  } });
  const permit = await authority.reserve({ scope: value.scope, amounts: amount() });
  await assert.rejects(permit.meteredFetch('https://provider.invalid'), /execution_authority_missing/);
  await permit.complete('succeeded');
  const events = await value.context.database.select().from(externalExecutionEvent);
  assert.equal(events.filter((event) => event.eventType === 'attempt_started').length, 1);
  assert.equal(events.filter((event) => ['attempt_succeeded', 'completed'].includes(event.eventType)).length, 0);
  const [lease] = await value.context.database.select().from(externalExecutionLease);
  assert.equal(lease?.state, 'ambiguous');
});

test('review: installed SDK treats authority denial and every redirect status as terminal, not retryable', async (t) => {
  for (const status of [0, 301, 302, 303, 307, 308]) {
    const value = await seeded({ scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' } });
    try {
      let dispatches = 0;
      t.mock.method(globalThis, 'fetch', async () => assert.fail('global refresh'));
      const authority = new DurableExternalExecutionAuthorizer(value.context.database, { clock: () => value.now, fetch: async (_input, init) => {
        dispatches += 1; assert.equal(init?.redirect, 'manual');
        return new Response('private', { status, headers: { Location: 'https://redirect.invalid/?token=fake-secret' } });
      } });
      const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 3 }), sandbox: sandboxContext });
      if (status === 0) await value.context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: value.grantId, revokedBy: 'test-operator', reasonCode: 'test', createdAt: value.now });
      await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test', name: 'test', resume: false, fetch: permit.meteredFetch }), { message: status === 0 ? 'execution_authority_missing' : 'sandbox_transport_redirect' });
      assert.equal(dispatches, status === 0 ? 0 : 1);
      const events = await value.context.database.select().from(externalExecutionEvent);
      assert.equal(events.filter((event) => event.eventType === 'attempt_started').length, status === 0 ? 0 : 1);
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
  const permit = await authority.reserve({ scope: value.scope, amounts: amount(), sandbox: sandboxContext });
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&resume=false', { redirect: 'follow' }), { message: 'sandbox_transport_redirect' });
  assert.equal(calls, 1);
  const events = await value.context.database.select().from(externalExecutionEvent);
  assert.equal(events.filter((event) => event.eventType === 'attempt_failed').length, 1);
  assert.ok(!JSON.stringify(events).includes('fake-secret'));
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&resume=false'), /execution_budget_exhausted/);
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
  const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 3 }), sandbox: sandboxContext });
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
  const value = await seeded({ runBound: true, scope: { operationCategory: 'sandbox_baseline', providerId: 'vercel-sandbox' },
    limits: { sandboxIdentities: 1, sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1' },
    accountLimits: { sandboxIdentities: 1, sandboxRuntimeMs: 60_000 } });
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
  const permit = await authority.reserve({ scope: value.scope, amounts: { ...sandboxAmounts, providerAttempts: 4 }, sandbox: sandboxContext });
  const credentials = { token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test' };
  await Sandbox.create({ ...credentials, name: 'test', image: 'vercel/sandbox/node:24', persistent: false, resources: { vcpus: 1 }, timeout: 60_000, fetch: permit.meteredFetch });
  assert.ok(permit.resolveSandboxCreation); await permit.resolveSandboxCreation({ name: 'test', sessionId: 'test-session' });
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
  const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 96 }), sandbox: sandboxContext });
  for (let index = 0; index < 96; index += 1) await permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&resume=false');
  await assert.rejects(permit.meteredFetch('https://vercel.com/api/v2/sandboxes/test?teamId=team_test&projectId=project_test&resume=false'), /execution_budget_exhausted/);
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
      const permit = await authority.reserve({ scope: value.scope, amounts: amount({ providerAttempts: 3 }), sandbox: sandboxContext });
      await assert.rejects(Sandbox.get({ token: 'fake-opaque-access-token', teamId: 'team_test', projectId: 'project_test', name: 'test', resume: false, fetch: permit.meteredFetch, signal: controller.signal }));
      assert.equal(calls, 1, stop);
      assert.equal((await value.context.database.select().from(externalExecutionEvent)).filter((event) => event.eventType === 'attempt_started').length, 1, stop);
    } finally { await value.context.client.close(); }
  }
});

async function seeded(options: { scope?: Partial<ExternalExecutionScope>; runBound?: boolean; concurrency?: number; expiresAt?: Date; limits?: Partial<typeof scopeLimits>; accountLimits?: Partial<typeof scopeLimits>; malformedOperationIdentity?: boolean } = {}) {
  const context = await createTestContext();
  const now = new Date('2026-09-23T10:00:00.000Z');
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'operator', email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
  const scope: ExternalExecutionScope = { workspaceId, operationCategory: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite', ...options.scope };
  if (scope.operationCategory.startsWith('sandbox_')) delete scope.modelId;
  if (options.runBound) {
    scope.repairRunId = randomUUID(); scope.githubRepositoryId = 42; scope.baseCommitSha = 'a'.repeat(40);
    await context.database.insert(repairRun).values({
      id: scope.repairRunId, workspaceId, githubRepositoryId: 42, installationId: 77,
      profileIdentity: 'b'.repeat(64), baseCommitSha: scope.baseCommitSha, idempotencyKey: randomUUID(), state: 'created',
      stateChangedAt: now, updatedAt: now,
    });
  }
  const expiresAt = options.expiresAt ?? new Date('2026-09-24T10:00:00.000Z');
  const limits = { ...scopeLimits, ...options.limits };
  const accountId = randomUUID();
  const accountLimits = { ...scopeLimits, ...options.accountLimits, maxConcurrentExternalOperations: options.concurrency ?? 1 };
  await context.database.insert(executionBudgetGrant).values({
    id: accountId, version: 1, scope: 'account', maxLogicalRequests: accountLimits.logicalRequests,
    maxProviderAttempts: accountLimits.providerAttempts, maxInputTokens: accountLimits.inputTokens,
    maxOutputTokens: accountLimits.outputTokens, maxSandboxIdentities: accountLimits.sandboxIdentities, maxSandboxRuntimeMs: accountLimits.sandboxRuntimeMs,
    maxVerificationAttempts: accountLimits.verificationAttempts, maxRepairLoopIterations: accountLimits.repairLoopIterations,
    maxConcurrentExternalOperations: accountLimits.maxConcurrentExternalOperations,
    expiresAt, authorizedBy: 'test-operator',
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null, acceptancePurpose: null, limits: accountLimits, expiresAt: expiresAt.toISOString(), authorizedBy: 'test-operator' }),
    createdAt: now,
  });
  const grantId = randomUUID();
  await context.database.insert(executionBudgetGrant).values({
    id: grantId, version: 1, scope: 'operation', workspaceId, operationCategory: scope.operationCategory,
    repairRunId: scope.repairRunId, githubRepositoryId: scope.githubRepositoryId, baseCommitSha: scope.baseCommitSha,
    providerId: scope.providerId, modelId: scope.modelId,
    maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts,
    maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
    maxSandboxIdentities: limits.sandboxIdentities, maxSandboxRuntimeMs: limits.sandboxRuntimeMs,
    sandboxResourceClass: limits.sandboxResourceClass,
    maxVerificationAttempts: limits.verificationAttempts, maxRepairLoopIterations: limits.repairLoopIterations,
    maxConcurrentExternalOperations: 0, expiresAt, authorizedBy: 'test-operator',
    grantIdentity: options.malformedOperationIdentity ? 'f'.repeat(64) : computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId, repairRunId: scope.repairRunId ?? null, githubRepositoryId: scope.githubRepositoryId ?? null, baseCommitSha: scope.baseCommitSha ?? null, operationCategory: scope.operationCategory, providerId: scope.providerId, modelId: scope.modelId ?? null, acceptancePurpose: null, limits, expiresAt: expiresAt.toISOString(), authorizedBy: 'test-operator' }),
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
  await permit.complete('succeeded'); // An unresolved on-wire attempt remains ambiguous, never successful.
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
