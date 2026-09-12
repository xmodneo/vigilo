import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { account, aiInvestigation, aiInvestigationAttempt, aiInvestigationEvent, executionProfile, githubInstallation, investigation, investigationContextEntry, investigationContextEvent, repairCandidate, repairIntent, repairRun, repository, repositoryBaseline, user, workspace } from '../db/schema.ts';
import { GeminiInvestigationProvider } from '../lib/ai-investigations/gemini-provider.ts';
import { AI_LIMITS, type InvestigationModelProvider, type InvestigationModelSession, type InvestigationConclusion, type ModelTurn } from '../lib/ai-investigations/types.ts';
import { getAiInvestigation, startAiInvestigation, AiInvestigationFlowError } from '../lib/ai-investigations/flow.ts';
import { processAiInvestigationJob } from '../lib/ai-investigations/worker.ts';
import { AiAgentError, runAiInvestigation } from '../lib/ai-investigations/runner.ts';
import { createAiInvestigationHandlers } from '../lib/ai-investigations/handlers.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import { readTextFile, searchText } from '../lib/investigations/context.ts';
import type { InvestigationSourceGateway } from '../lib/investigations/types.ts';
import type { AiInvestigationJobPayload, TransactionalAiInvestigationQueue } from '../lib/repair-runs/queue.ts';
import { createTestContext } from './support.ts';

const NOW = new Date();
const COMMIT = 'a'.repeat(40); const PROFILE = 'b'.repeat(64); const TREE = 'c'.repeat(40);
const REPOSITORY_ID = 41001; const INSTALLATION_ID = 42001;
const CONFIGURATION: GitHubAppConfiguration = { appId: 7, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'client' };
const SOURCE = 'export function shipping(subtotal: number) { return subtotal > 5000 ? 0 : 500; }\n';
const blobSha = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function owner(workspaceId: string): AuthenticatedWorkspace { return { workspace: { id: workspaceId } } as unknown as AuthenticatedWorkspace; }

class MemoryQueue implements TransactionalAiInvestigationQueue {
  payloads: AiInvestigationJobPayload[] = [];
  async enqueueAiInvestigation(_transaction: Parameters<TransactionalAiInvestigationQueue['enqueueAiInvestigation']>[0], payload: AiInvestigationJobPayload) { this.payloads.push(structuredClone(payload)); return payload.aiInvestigationId; }
}

class Gateway implements InvestigationSourceGateway {
  calls: string[] = [];
  async createInstallationAccessToken() { this.calls.push('token'); return { accessToken: 'ephemeral-github-token', repository: { id: REPOSITORY_ID, name: 'vigilo', ownerLogin: 'xmodneo' } }; }
  async getCommitTree(): Promise<{ commitSha: string; treeSha: string }> { throw new Error('not available to AI'); }
  async getTree(): Promise<{ entries: []; truncated: boolean }> { throw new Error('not available to AI'); }
  async getBlob(input: { blobSha: string }) { this.calls.push('blob'); assert.equal(input.blobSha, blobSha(SOURCE)); return { bytes: Buffer.from(SOURCE), sha: input.blobSha }; }
  async getInstallation() { this.calls.push('installation'); return { appId: 7, appSlug: 'vigilo-test', id: INSTALLATION_ID, suspendedAt: null }; }
  async revokeInstallationAccessToken(token: string) { assert.equal(token, 'ephemeral-github-token'); this.calls.push('revoke'); }
}

class ScriptedProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  constructor(private readonly status: InvestigationConclusion['status'] = 'diagnosis_found', private readonly failure = false) {}
  createSession(input: Parameters<InvestigationModelProvider['createSession']>[0]): InvestigationModelSession {
    assert.deepEqual(input.tools.map((tool) => tool.name), ['listPaths', 'readTextFile', 'searchText', 'readBaselineSummary']);
    assert.match(input.instructions, /untrusted/i); assert.doesNotMatch(input.initialInput, /ephemeral-github-token|DATABASE_URL|GEMINI_API_KEY/);
    let step = 0; const refs: string[] = [];
    return { next: async ({ toolOutputs }): Promise<ModelTurn> => {
      if (this.failure) throw new Error('transient provider failure');
      if (toolOutputs?.[0]) refs.push(JSON.parse(toolOutputs[0].output).operationReference as string);
      step++;
      if (step === 1) return { toolCalls: [{ callId: 'call-1', name: 'readBaselineSummary', arguments: {} }], conclusion: null, usage: { inputTokens: 10, outputTokens: 2 } };
      if (step === 2) return { toolCalls: [{ callId: 'call-2', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null, usage: { inputTokens: 20, outputTokens: 3 } };
      return { toolCalls: [], conclusion: { status: this.status, summary: this.status === 'diagnosis_found' ? 'The exact threshold is excluded.' : 'The available evidence does not support a diagnosis.', suspectedFiles: this.status === 'diagnosis_found' ? [{ path: 'src/shipping.ts', reason: 'The observed comparison excludes equality.' }] : [], evidence: [{ kind: 'baseline', reference: refs[0] }, { kind: 'file', reference: refs[1] }], proposedApproach: 'Review the threshold comparison without applying changes.', confidence: this.status === 'diagnosis_found' ? 'high' : 'low' }, usage: { inputTokens: 30, outputTokens: 8 } };
    } };
  }
}

class TurnProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  constructor(private readonly turn: (number: number, outputs: Array<{ callId: string; output: string }> | undefined, signal: AbortSignal, finalization: boolean) => Promise<ModelTurn> | ModelTurn) {}
  createSession(): InvestigationModelSession { let number = 0; return { next: async ({ toolOutputs, signal, finalization = false }) => this.turn(++number, toolOutputs, signal, finalization) }; }
}

function job(id: string) { return { id, name: 'ai-investigation-v1', data: { version: 1, aiInvestigationId: id }, signal: new AbortController().signal } as never; }

async function activateAiInvestigation(context: Awaited<ReturnType<typeof createTestContext>>, aiInvestigationId: string) {
  const attemptId = randomUUID(); const ownershipToken = randomUUID();
  await context.database.update(aiInvestigation).set({ state: 'investigating', investigationStartedAt: NOW, updatedAt: NOW }).where(eq(aiInvestigation.id, aiInvestigationId));
  await context.database.insert(aiInvestigationAttempt).values({ id: attemptId, aiInvestigationId, queueJobId: aiInvestigationId, attemptNumber: 1, ownershipToken, state: 'active', claimedAt: NOW, heartbeatAt: NOW, leaseExpiresAt: new Date(NOW.getTime() + 60_000) });
  return { aiInvestigationId, aiInvestigationAttemptId: attemptId, ownershipToken };
}

async function seedRoot(context: Awaited<ReturnType<typeof createTestContext>>) {
  const userId = randomUUID(); const workspaceId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'Owner', email: `${userId}@test.invalid`, emailVerified: true });
  await context.database.insert(account).values({ id: randomUUID(), issuer: 'local:oauth:github', accountId: '1234', providerId: 'github', userId });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await context.database.insert(githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId, githubAccountId: 1234, accountLogin: 'xmodneo', accountType: 'User', status: 'active' });
  await context.database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 1234, ownerLogin: 'xmodneo', name: 'vigilo', fullName: 'xmodneo/vigilo', defaultBranch: 'main', isPrivate: true });
  await context.database.insert(executionProfile).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity: PROFILE, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), status: 'ready' });
  return { workspaceId, owner: owner(workspaceId) };
}

async function seedReady(context: Awaited<ReturnType<typeof createTestContext>>, workspaceId: string, state: 'ready' | 'failed' = 'ready') {
  const baselineId = randomUUID(); const runId = randomUUID(); const intentId = randomUUID(); const investigationId = randomUUID();
  await context.database.insert(repositoryBaseline).values({ id: baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity: PROFILE, baseCommitSha: COMMIT, archiveSha256: '2'.repeat(64), sandboxName: 'baseline-sandbox', sandboxSessionId: 'baseline-session', sourceIdentityBefore: '3'.repeat(64), sourceIdentityAfter: '3'.repeat(64), sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'failed', testExitCode: 1, testTimedOut: false, executionOutcome: 'baseline_failed', overallOutcome: 'baseline_failed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'baseline_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await context.database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: PROFILE, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: state === 'ready' ? 'ready_for_investigation' : 'infrastructure_failed', baselineId: state === 'ready' ? baselineId : null, baselineOutcome: state === 'ready' ? 'baseline_failed' : null, failureClassification: state === 'ready' ? 'customer_baseline_failure' : 'infrastructure_failure', failureCode: state === 'ready' ? 'baseline_failed' : 'infrastructure_failed', baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  await context.database.insert(repairIntent).values({ id: intentId, repairRunId: runId, workspaceId, objective: 'Fix the controlled free-shipping boundary fixture so a subtotal of exactly 5000 receives free shipping.', objectiveHash: sha256('Fix the controlled free-shipping boundary fixture so a subtotal of exactly 5000 receives free shipping.') });
  await context.database.insert(investigation).values({ id: investigationId, repairRunId: runId, repairIntentId: intentId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId, idempotencyKey: randomUUID(), state: state === 'ready' ? 'ready' : 'failed', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: state === 'ready' ? TREE : null, indexedPathCount: state === 'ready' ? 1 : 0, attemptNumber: 1, failureCode: state === 'ready' ? null : 'context_source_unavailable', completedAt: NOW, updatedAt: NOW });
  if (state === 'ready') await context.database.insert(investigationContextEntry).values({ investigationId, path: 'src/shipping.ts', depth: 2, kind: 'blob', mode: '100644', objectSha: blobSha(SOURCE), sizeBytes: Buffer.byteLength(SOURCE), readable: true });
  return { baselineId, runId, investigationId };
}

test('durable AI investigation flow is idempotent, workspace-scoped, and authority-bound', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const queue = new MemoryQueue();
  const idempotencyKey = randomUUID();
  const [first, repeated] = await Promise.all([startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { clock: () => NOW, idempotencyKey }), startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { clock: () => NOW, idempotencyKey })]);
  assert.equal(repeated.id, first.id); assert.deepEqual(queue.payloads, [{ version: 1, aiInvestigationId: first.id }]); assert.equal(first.revision, COMMIT); assert.equal(first.executionOrdinal, 1);
  assert.equal(await getAiInvestigation(context.database, owner(randomUUID()), first.id), null);
  await context.database.update(repository).set({ defaultBranch: 'moved-main' }).where(eq(repository.githubRepositoryId, REPOSITORY_ID));
  assert.equal((await getAiInvestigation(context.database, root.owner, first.id))?.revision, COMMIT);
  const events = await context.database.select().from(aiInvestigationEvent); assert.deepEqual(events.map((event) => event.toState), ['created', 'queued']);
  await assert.rejects(context.database.update(aiInvestigation).set({ baseCommitSha: 'f'.repeat(40) }).where(eq(aiInvestigation.id, first.id)));
  const failed = await seedReady(context, root.workspaceId, 'failed');
  await assert.rejects(startAiInvestigation(context.database, root.owner, failed.investigationId, queue), (error: unknown) => error instanceof AiInvestigationFlowError && error.code === 'investigation_not_ready');
});

test('terminal failure creates one race-safe historical rerun with a fresh attempt budget', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const queue = new MemoryQueue();
  const first = await startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { idempotencyKey: randomUUID(), clock: () => NOW });
  for (let number = 1; number <= 3; number++) await processAiInvestigationJob(job(first.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider('diagnosis_found', true), clock: () => new Date(NOW.getTime() + number) });
  const historicalBefore = await getAiInvestigation(context.database, root.owner, first.id);
  const attemptsBefore = await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, first.id));
  const countsBefore = { runs: (await context.database.select().from(repairRun)).length, baselines: (await context.database.select().from(repositoryBaseline)).length, investigations: (await context.database.select().from(investigation)).length };

  const retryKey = randomUUID();
  const [retry, duplicate] = await Promise.all([
    startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { idempotencyKey: retryKey, clock: () => new Date(NOW.getTime() + 10) }),
    startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { idempotencyKey: retryKey, clock: () => new Date(NOW.getTime() + 10) }),
  ]);
  assert.equal(duplicate.id, retry.id); assert.notEqual(retry.id, first.id); assert.equal(retry.executionOrdinal, 2);
  assert.equal((await startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { idempotencyKey: randomUUID() })).id, retry.id);
  assert.equal(queue.payloads.length, 2);

  const storedRetry = (await context.database.select().from(aiInvestigation).where(eq(aiInvestigation.id, retry.id)))[0]!;
  await assert.rejects(context.database.insert(aiInvestigation).values({ ...storedRetry, id: randomUUID(), idempotencyKey: randomUUID(), executionOrdinal: 3, state: 'created', queuedAt: null, createdAt: new Date(NOW.getTime() + 11), updatedAt: new Date(NOW.getTime() + 11) }));
  assert.deepEqual(await getAiInvestigation(context.database, root.owner, first.id), historicalBefore);
  assert.deepEqual(await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, first.id)), attemptsBefore);
  assert.deepEqual({ runs: (await context.database.select().from(repairRun)).length, baselines: (await context.database.select().from(repositoryBaseline)).length, investigations: (await context.database.select().from(investigation)).length }, countsBefore);

  assert.equal((await processAiInvestigationJob(job(retry.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), clock: () => new Date(NOW.getTime() + 12) })).status, 'completed');
  const retryAttempts = await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, retry.id));
  assert.deepEqual(retryAttempts.map((attempt) => attempt.attemptNumber), [1]);
  const queueCount = queue.payloads.length;
  const completedResult = await startAiInvestigation(context.database, root.owner, seeded.investigationId, queue, { idempotencyKey: randomUUID() });
  assert.equal(completedResult.id, retry.id); assert.equal(queue.payloads.length, queueCount);
});

test('rerun fails closed on invalid authority and cannot borrow old evidence or reset context budgets', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);

  await t.test('invalid parent authority', async () => {
    const seeded = await seedReady(context, root.workspaceId); const first = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    for (let number = 1; number <= 3; number++) await processAiInvestigationJob(job(first.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider('diagnosis_found', true), clock: () => new Date(NOW.getTime() + number) });
    await context.database.delete(executionProfile).where(and(eq(executionProfile.workspaceId, root.workspaceId), eq(executionProfile.githubRepositoryId, REPOSITORY_ID)));
    await assert.rejects(startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue(), { idempotencyKey: randomUUID() }), (error: unknown) => error instanceof AiInvestigationFlowError && error.code === 'investigation_not_ready');
  });

  await t.test('old evidence and cumulative budget', async () => {
    await context.database.insert(executionProfile).values({ githubRepositoryId: REPOSITORY_ID, workspaceId: root.workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity: PROFILE, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), status: 'ready' });
    const seeded = await seedReady(context, root.workspaceId); const first = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    for (let number = 1; number <= 3; number++) await processAiInvestigationJob(job(first.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider('diagnosis_found', true), clock: () => new Date(NOW.getTime() + number) });
    const oldReference = randomUUID();
    await context.database.insert(investigationContextEvent).values(Array.from({ length: 50 }, (_, index) => ({ id: index === 0 ? oldReference : randomUUID(), investigationId: seeded.investigationId, aiInvestigationId: first.id, workspaceId: root.workspaceId, operation: 'list_paths', status: 'completed', resultCount: 0, resultBytes: 0, budgetBytes: 0, completedAt: NOW })));
    const second = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue(), { idempotencyKey: randomUUID() });
    const borrowing = new TurnProvider(() => ({ toolCalls: [], conclusion: { status: 'diagnosis_found', summary: 'Unsupported claim.', suspectedFiles: [{ path: 'src/shipping.ts', reason: 'Old evidence.' }], evidence: [{ kind: 'file', reference: oldReference }], proposedApproach: 'Review.', confidence: 'low' } }));
    assert.equal((await processAiInvestigationJob(job(second.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => borrowing, clock: () => NOW })).status, 'completed');
    assert.equal((await getAiInvestigation(context.database, root.owner, second.id))?.failureCode, 'fabricated_evidence_reference');
    const thirdKey = randomUUID();
    const third = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue(), { idempotencyKey: thirdKey });
    const outcome = await processAiInvestigationJob(job(third.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), clock: () => new Date(NOW.getTime() + 4) });
    assert.equal(outcome.status, 'completed'); assert.equal((await getAiInvestigation(context.database, root.owner, third.id))?.failureCode, 'model_limit_exceeded');
    const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.investigationId, seeded.investigationId));
    assert.equal(events.length, 50); assert.ok(events.every((event) => event.aiInvestigationId === first.id));
    assert.equal((await context.database.select().from(repairCandidate)).length, 0);
  });
});

test('worker runs only audited context tools and persists a schema-valid conclusion and safe usage', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const queue = new MemoryQueue(); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, queue); const gateway = new Gateway();
  const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway, configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), clock: () => NOW });
  assert.equal(output.status, 'completed'); const stored = await getAiInvestigation(context.database, root.owner, ai.id); assert.equal(stored?.state, 'completed'); assert.equal(stored?.conclusion?.status, 'diagnosis_found'); assert.deepEqual(stored?.usage, { inputTokens: 60, outputTokens: 13, toolCallCount: 2, modelTurnCount: 3 });
  const audit = await context.database.select().from(investigationContextEvent); assert.equal(audit.length, 2); assert.ok(audit.every((event) => event.aiInvestigationId === ai.id)); assert.deepEqual(audit.map((event) => event.operation), ['read_baseline_summary', 'read_text_file']);
  const unrelated = await seedReady(context, root.workspaceId); const unrelatedAi = await startAiInvestigation(context.database, root.owner, unrelated.investigationId, new MemoryQueue());
  await context.database.update(aiInvestigation).set({ state: 'investigating', investigationStartedAt: NOW, updatedAt: NOW }).where(eq(aiInvestigation.id, unrelatedAi.id));
  await assert.rejects(readTextFile(context.database, root.owner, gateway, CONFIGURATION, seeded.investigationId, randomUUID(), 'src/shipping.ts', { aiInvestigationId: unrelatedAi.id }), /invalid_context_request/);
  assert.deepEqual(gateway.calls, ['installation', 'token', 'blob', 'revoke']); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
  const persisted = JSON.stringify(await context.database.select().from(aiInvestigation)); assert.doesNotMatch(persisted, /ephemeral-github-token|GEMINI_API_KEY|DATABASE_URL|return subtotal|transient-signature/);
  await assert.rejects(context.database.update(aiInvestigation).set({ summary: 'mutated' }).where(eq(aiInvestigation.id, ai.id)));
  await assert.rejects(context.database.delete(aiInvestigationEvent).where(eq(aiInvestigationEvent.aiInvestigationId, ai.id)));
});

test('duplicate delivery has one owner and stale ownership cannot finalize', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
  let entered!: () => void; let release!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor = async () => { entered(); await gate; return { completionReason: 'model_conclusion' as const, conclusion: { status: 'insufficient_evidence' as const, summary: 'Safe.', suspectedFiles: [], evidence: [], proposedApproach: 'Review.', confidence: 'low' as const }, usage: { inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 1 } }; };
  const dependencies = { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: executor as never, clock: () => NOW };
  const first = processAiInvestigationJob(job(ai.id), dependencies); await started;
  assert.deepEqual((await processAiInvestigationJob(job(ai.id), dependencies)).output, { code: 'active_ai_investigation_attempt' });
  const [attempt] = await context.database.select().from(aiInvestigationAttempt); await context.database.update(aiInvestigationAttempt).set({ ownershipToken: randomUUID() }).where(eq(aiInvestigationAttempt.id, attempt!.id)); release();
  assert.deepEqual((await first).output, { code: 'ai_investigation_ownership_lost' }); assert.equal((await getAiInvestigation(context.database, root.owner, ai.id))?.state, 'investigating');
});

test('an expired worker lease cannot finalize its AI investigation', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
  let entered!: () => void; let release!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  let clockNow = NOW;
  const executor = async () => { entered(); await gate; return { completionReason: 'budget_exhausted' as const, conclusion: { status: 'insufficient_evidence' as const, summary: 'Safe.', suspectedFiles: [], evidence: [], proposedApproach: 'Review.', confidence: 'low' as const }, usage: { inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 1 } }; };
  const execution = processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: executor as never, clock: () => clockNow });
  await started; clockNow = new Date(NOW.getTime() + (5 * 60_000)); release();
  assert.deepEqual((await execution).output, { code: 'ai_investigation_ownership_lost' });
  assert.equal((await getAiInvestigation(context.database, root.owner, ai.id))?.state, 'investigating');
  const [attempt] = await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, ai.id));
  assert.equal(attempt?.state, 'active'); assert.ok(attempt?.leaseExpiresAt && attempt.leaseExpiresAt < clockNow);
});

test('stale AI attempt ownership cannot invoke or account context tools', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
  const audit = await activateAiInvestigation(context, ai.id);
  const gateway = new Gateway();
  await context.database.update(aiInvestigationAttempt).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(aiInvestigationAttempt.id, audit.aiInvestigationAttemptId));
  await assert.rejects(readTextFile(context.database, root.owner, gateway, CONFIGURATION, seeded.investigationId, randomUUID(), 'src/shipping.ts', audit as never), /invalid_context_request/);
  await context.database.update(aiInvestigationAttempt).set({ leaseExpiresAt: new Date(Date.now() + 60_000), ownershipToken: randomUUID() }).where(eq(aiInvestigationAttempt.id, audit.aiInvestigationAttemptId));
  await assert.rejects(readTextFile(context.database, root.owner, gateway, CONFIGURATION, seeded.investigationId, randomUUID(), 'src/shipping.ts', audit as never), /invalid_context_request/);
  assert.deepEqual(gateway.calls, []);
  assert.equal((await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiInvestigationId, ai.id))).length, 0);
  let providerRequests = 0;
  const provider = new TurnProvider(() => { providerRequests += 1; return { toolCalls: [], conclusion: null }; });
  await assert.rejects(runAiInvestigation(context.database, gateway, CONFIGURATION, provider, { ...audit, investigationId: seeded.investigationId, workspaceId: root.workspaceId, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId: seeded.baselineId }), (error: unknown) => error instanceof AiAgentError && error.code === 'ai_investigation_ownership_lost');
  assert.equal(providerRequests, 0);
});

test('provider failures retry at most three times and valid low-evidence conclusions do not retry', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);
  const failedSeed = await seedReady(context, root.workspaceId); const failedAi = await startAiInvestigation(context.database, root.owner, failedSeed.investigationId, new MemoryQueue());
  for (let number = 1; number <= 3; number++) assert.equal((await processAiInvestigationJob(job(failedAi.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider('diagnosis_found', true), clock: () => new Date(NOW.getTime() + number) })).status, number < 3 ? 'failed' : 'completed');
  assert.equal((await getAiInvestigation(context.database, root.owner, failedAi.id))?.state, 'failed'); assert.equal((await context.database.select().from(aiInvestigationAttempt)).length, 3);
  for (const status of ['insufficient_evidence', 'objective_not_reproduced'] as const) await t.test(status, async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    assert.equal((await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(status), clock: () => NOW })).status, 'completed');
    assert.equal((await getAiInvestigation(context.database, root.owner, ai.id))?.conclusion?.status, status);
  });
});

test('daily Gemini quota exhaustion fails once without repository or mutation capabilities', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);
  const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue()); const gateway = new Gateway();
  const rawMarker = 'provider-secret-response-marker';
  const client = { create: async () => { throw { status: 429, message: `generate_content_free_tier_requests GenerateRequestsPerDayPerProjectPerModel-FreeTier ${rawMarker}`, body: rawMarker }; } };
  const provider = new GeminiInvestigationProvider('test-secret-value-with-adequate-length', 'gemini-3.1-flash-lite', client as never);
  const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway, configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
  assert.equal(output.status, 'completed');
  const stored = await getAiInvestigation(context.database, root.owner, ai.id); assert.equal(stored?.state, 'failed'); assert.equal(stored?.failureCode, 'provider_quota_exhausted');
  const attempts = await context.database.select().from(aiInvestigationAttempt); assert.equal(attempts.length, 1); assert.equal(attempts[0]?.state, 'exhausted'); assert.equal(attempts[0]?.failureCode, 'provider_quota_exhausted');
  assert.equal((await context.database.select().from(investigationContextEvent)).length, 0); assert.equal((await context.database.select().from(repairCandidate)).length, 0); assert.deepEqual(gateway.calls, []);
  const persistedFailureRecords = {
    investigations: await context.database.select().from(aiInvestigation),
    attempts: await context.database.select().from(aiInvestigationAttempt),
    events: await context.database.select().from(aiInvestigationEvent),
  };
  assert.doesNotMatch(JSON.stringify(persistedFailureRecords), new RegExp(rawMarker));
  const executionSource = `${readFileSync('lib/ai-investigations/runner.ts', 'utf8')}\n${readFileSync('lib/ai-investigations/worker.ts', 'utf8')}`;
  assert.doesNotMatch(executionSource, /@vercel\/sandbox|createCandidate|freezeCandidate|createBranch|createCommit|createPullRequest/);
});

test('short-lived provider rate limits remain bounded by three worker attempts', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);
  const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
  const executor = async () => { throw new AiAgentError('provider_rate_limited', 7_000); };
  for (let number = 1; number <= 3; number++) {
    const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: executor as never, clock: () => new Date(NOW.getTime() + number) });
    assert.equal(output.status, number < 3 ? 'failed' : 'completed');
  }
  const attempts = await context.database.select().from(aiInvestigationAttempt); assert.equal(attempts.length, 3); assert.deepEqual(attempts.map((attempt) => attempt.failureCode), ['provider_rate_limited', 'provider_rate_limited', 'provider_rate_limited']);
  assert.equal((await getAiInvestigation(context.database, root.owner, ai.id))?.failureCode, 'provider_rate_limited');

  const untrustedSeed = await seedReady(context, root.workspaceId); const untrusted = await startAiInvestigation(context.database, root.owner, untrustedSeed.investigationId, new MemoryQueue());
  assert.equal((await processAiInvestigationJob(job(untrusted.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: (async () => { throw new AiAgentError('provider_rate_limited'); }) as never, clock: () => NOW })).status, 'completed');
  assert.equal((await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, untrusted.id))).length, 1);

  const excessiveSeed = await seedReady(context, root.workspaceId); const excessive = await startAiInvestigation(context.database, root.owner, excessiveSeed.investigationId, new MemoryQueue());
  assert.equal((await processAiInvestigationJob(job(excessive.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: (async () => { throw new AiAgentError('provider_rate_limited', 61_000); }) as never, clock: () => NOW })).status, 'completed');
  assert.equal((await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, excessive.id))).length, 1);
});

test('model limits are terminal and recorded retryable limit failures reconcile without model re-entry', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);
  const firstSeed = await seedReady(context, root.workspaceId); const first = await startAiInvestigation(context.database, root.owner, firstSeed.investigationId, new MemoryQueue());
  const limited = async () => { throw new AiAgentError('model_limit_exceeded'); };
  assert.equal((await processAiInvestigationJob(job(first.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: limited as never, clock: () => NOW })).status, 'completed');
  assert.equal((await getAiInvestigation(context.database, root.owner, first.id))?.failureCode, 'model_limit_exceeded');
  const [firstAttempt] = await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, first.id));
  assert.equal(firstAttempt?.state, 'exhausted');

  const secondSeed = await seedReady(context, root.workspaceId); const second = await startAiInvestigation(context.database, root.owner, secondSeed.investigationId, new MemoryQueue());
  await context.database.update(aiInvestigation).set({ state: 'investigating', investigationStartedAt: NOW, updatedAt: NOW }).where(eq(aiInvestigation.id, second.id));
  const attemptId = randomUUID();
  await context.database.insert(aiInvestigationAttempt).values({ id: attemptId, aiInvestigationId: second.id, queueJobId: second.id, attemptNumber: 1, ownershipToken: randomUUID(), state: 'retryable_failed', claimedAt: NOW, heartbeatAt: NOW, leaseExpiresAt: null, finishedAt: NOW, failureCode: 'model_limit_exceeded' });
  let executions = 0;
  const output = await processAiInvestigationJob(job(second.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ScriptedProvider(), executor: (async () => { executions += 1; throw new Error('must_not_run'); }) as never, clock: () => new Date(NOW.getTime() + 1) });
  assert.equal(output.status, 'completed'); assert.equal(executions, 0);
  assert.equal((await getAiInvestigation(context.database, root.owner, second.id))?.failureCode, 'model_limit_exceeded');
  const [preserved] = await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.id, attemptId));
  assert.equal(preserved?.state, 'retryable_failed'); assert.equal(preserved?.failureCode, 'model_limit_exceeded');
});

test('browser handlers require same-origin authentication, accept no authority, and expose no credential', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId); const queue = new MemoryQueue(); const handlers = createAiInvestigationHandlers({ database: context.database, configuration: CONFIGURATION, queue, resolveContext: async () => root.owner });
  const forbidden = await handlers.start(new Request('http://localhost:3000/api/ai-investigations', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ investigationId: seeded.investigationId }) })); assert.equal(forbidden.status, 403);
  const forged = await handlers.start(new Request('http://localhost:3000/api/ai-investigations', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ investigationId: seeded.investigationId, maxOperations: '999' }) })); assert.equal(forged.status, 303); assert.match(forged.headers.get('location')!, /investigation_not_ready/); assert.equal(queue.payloads.length, 0);
  const accepted = await handlers.start(new Request('http://localhost:3000/api/ai-investigations', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ investigationId: seeded.investigationId, idempotencyKey: randomUUID() }) })); assert.equal(accepted.status, 303); const id = queue.payloads[0]!.aiInvestigationId;
  const response = await handlers.read(new Request(`http://localhost:3000/api/ai-investigations/${id}`), id); assert.equal(response.status, 200); const body = await response.text(); assert.doesNotMatch(body, /GEMINI_API_KEY|clientSecret|accessToken|cookie|ephemeral-github-token|transient-signature/);
});

test('agent loop rejects protocol abuse, fabricated evidence, unobserved files, and excessive turns', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);
  const scenarios: Array<[string, (reference: string) => ModelTurn, string]> = [
    ['unknown tool', () => ({ toolCalls: [{ callId: 'x', name: 'shell', arguments: {} }], conclusion: null }), 'model_protocol_error'],
    ['malformed arguments', () => ({ toolCalls: [{ callId: 'x', name: 'readTextFile', arguments: { path: 'src/shipping.ts', limit: 999 } }], conclusion: null }), 'model_protocol_error'],
    ['fabricated evidence', (reference) => ({ toolCalls: [], conclusion: { status: 'diagnosis_found', summary: 'Claim.', suspectedFiles: [{ path: 'src/shipping.ts', reason: 'Guess.' }], evidence: [{ kind: 'file', reference }], proposedApproach: 'Review.', confidence: 'low' } }), 'fabricated_evidence_reference'],
  ];
  for (const [name, makeTurn, code] of scenarios) await t.test(name, async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    const provider = new TurnProvider(() => makeTurn(randomUUID()));
    const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
    assert.equal(output.status, 'completed'); const stored = await getAiInvestigation(context.database, root.owner, ai.id); assert.equal(stored?.state, 'failed'); assert.equal(stored?.failureCode, code);
  });
  await t.test('unobserved suspected file', async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    const audit = await activateAiInvestigation(context, ai.id);
    const provider = new TurnProvider((number, outputs) => number === 1
      ? { toolCalls: [{ callId: 'baseline-call', name: 'readBaselineSummary', arguments: {} }], conclusion: null }
      : { toolCalls: [], conclusion: { status: 'diagnosis_found', summary: 'Claim.', suspectedFiles: [{ path: 'unobserved.ts', reason: 'Guess.' }], evidence: [{ kind: 'baseline', reference: JSON.parse(outputs![0]!.output).operationReference as string }], proposedApproach: 'Review.', confidence: 'low' } });
    await assert.rejects(runAiInvestigation(context.database, new Gateway(), CONFIGURATION, provider, { ...audit, investigationId: seeded.investigationId, workspaceId: root.workspaceId, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId: seeded.baselineId }), (error: unknown) => error instanceof AiAgentError && error.code === 'unobserved_suspected_file');
  });
  await t.test('maximum model turns', async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    const audit = await activateAiInvestigation(context, ai.id);
    const provider = new TurnProvider((number) => ({ toolCalls: [{ callId: `call-${number}`, name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null }));
    await assert.rejects(runAiInvestigation(context.database, new Gateway(), CONFIGURATION, provider, { ...audit, investigationId: seeded.investigationId, workspaceId: root.workspaceId, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId: seeded.baselineId }), (error: unknown) => error instanceof AiAgentError && error.code === 'model_limit_exceeded');
  });
  await t.test('multiple tool calls cannot bypass one-at-a-time policy', async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    const audit = await activateAiInvestigation(context, ai.id);
    const provider = new TurnProvider(() => ({ toolCalls: [
      { callId: 'call-1', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } },
      { callId: 'call-2', name: 'searchText', arguments: { query: 'shipping' } },
    ], conclusion: null }));
    await assert.rejects(runAiInvestigation(context.database, new Gateway(), CONFIGURATION, provider, { ...audit, investigationId: seeded.investigationId, workspaceId: root.workspaceId, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId: seeded.baselineId }), (error: unknown) => error instanceof AiAgentError && error.code === 'model_protocol_error');
  });
});

test('bounded investigation reserves a tool-free finalization request and finalizes exhausted context', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context); const seeded = await seedReady(context, root.workspaceId);
  assert.deepEqual({ maxModelTurns: AI_LIMITS.maxModelTurns, maxToolBearingTurns: AI_LIMITS.maxToolBearingTurns, reservedFinalizationTurns: AI_LIMITS.reservedFinalizationTurns, maxContextResultBytes: AI_LIMITS.maxContextResultBytes }, { maxModelTurns: 8, maxToolBearingTurns: 6, reservedFinalizationTurns: 1, maxContextResultBytes: 128 * 1024 });

  await t.test('six tool-bearing requests cannot consume the finalization slot', async () => {
    const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    const phases: boolean[] = []; const references: string[] = [];
    const tools: ModelTurn[] = [
      { toolCalls: [{ callId: 'baseline', name: 'readBaselineSummary', arguments: {} }], conclusion: null },
      { toolCalls: [{ callId: 'file-1', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null },
      { toolCalls: [{ callId: 'file-2', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null },
      { toolCalls: [{ callId: 'file-3', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null },
      { toolCalls: [{ callId: 'file-4', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null },
      { toolCalls: [{ callId: 'baseline-2', name: 'readBaselineSummary', arguments: {} }], conclusion: null },
    ];
    const provider = new TurnProvider((number, outputs, _signal, finalization) => {
      phases.push(finalization === true);
      if (outputs?.[0]) references.push(JSON.parse(outputs[0].output).operationReference as string);
      if (!finalization) return tools[number - 1]!;
      return { toolCalls: [], conclusion: { status: 'insufficient_evidence', summary: 'The bounded evidence is inconclusive.', suspectedFiles: [], evidence: [{ kind: 'baseline', reference: references[0]! }], proposedApproach: 'Review the observed baseline and source evidence.', confidence: 'low' } };
    });
    const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
    assert.equal(output.status, 'completed');
    const stored = await getAiInvestigation(context.database, root.owner, ai.id);
    assert.equal(stored?.state, 'completed'); assert.equal(stored?.completionReason, 'budget_exhausted'); assert.equal(stored?.usage.modelTurnCount, 7); assert.equal(stored?.usage.toolCallCount, 6);
    assert.deepEqual(phases, [false, false, false, false, false, false, true]);
  });

  await t.test('an early strict conclusion skips finalization', async () => {
    const seededEarly = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seededEarly.investigationId, new MemoryQueue());
    const phases: boolean[] = []; let reference = '';
    const provider = new TurnProvider((number, outputs, _signal, finalization) => {
      phases.push(finalization === true);
      if (outputs?.[0]) reference = JSON.parse(outputs[0].output).operationReference as string;
      return number === 1
        ? { toolCalls: [{ callId: 'baseline', name: 'readBaselineSummary', arguments: {} }], conclusion: null }
        : { toolCalls: [], conclusion: { status: 'insufficient_evidence', summary: 'The observed baseline is insufficient for a diagnosis.', suspectedFiles: [], evidence: [{ kind: 'baseline', reference }], proposedApproach: 'Review the observed baseline.', confidence: 'low' } };
    });
    await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
    assert.deepEqual(phases, [false, false]); assert.equal((await getAiInvestigation(context.database, root.owner, ai.id))?.completionReason, 'model_conclusion');
  });

  await t.test('AI context exhaustion enters finalization instead of failing the model limit', async () => {
    const seededExhausted = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seededExhausted.investigationId, new MemoryQueue());
    await context.database.insert(investigationContextEvent).values({ id: randomUUID(), investigationId: seededExhausted.investigationId, aiInvestigationId: ai.id, workspaceId: root.workspaceId, operation: 'read_text_file', status: 'completed', resultCount: 1, resultBytes: 128 * 1024, budgetBytes: 128 * 1024, completedAt: NOW });
    let reference = ''; const phases: boolean[] = [];
    const provider = new TurnProvider((number, outputs, _signal, finalization) => {
      phases.push(finalization === true);
      if (outputs?.[0] && number === 2) reference = JSON.parse(outputs[0].output).operationReference as string;
      if (number === 1) return { toolCalls: [{ callId: 'baseline', name: 'readBaselineSummary', arguments: {} }], conclusion: null };
      if (!finalization) return { toolCalls: [{ callId: 'file', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null };
      return { toolCalls: [], conclusion: { status: 'insufficient_evidence', summary: 'The AI-specific context allowance was exhausted.', suspectedFiles: [], evidence: [{ kind: 'baseline', reference }], proposedApproach: 'Review the retained baseline evidence.', confidence: 'low' } };
    });
    const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
    assert.equal(output.status, 'completed');
    const stored = await getAiInvestigation(context.database, root.owner, ai.id);
    assert.equal(stored?.completionReason, 'budget_exhausted'); assert.equal(stored?.failureCode, null); assert.deepEqual(phases, [false, false, true]);
  });

  await t.test('an invalid finalization result fails closed without retrying', async () => {
    const seededInvalid = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seededInvalid.investigationId, new MemoryQueue());
    const provider = new TurnProvider((_number, _outputs, _signal, finalization) => finalization
      ? { toolCalls: [], conclusion: { status: 'invalid' } }
      : { toolCalls: [{ callId: 'baseline', name: 'readBaselineSummary', arguments: {} }], conclusion: null });
    const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
    assert.equal(output.status, 'completed');
    const stored = await getAiInvestigation(context.database, root.owner, ai.id); const attempts = await context.database.select().from(aiInvestigationAttempt).where(eq(aiInvestigationAttempt.aiInvestigationId, ai.id));
    assert.equal(stored?.failureCode, 'model_limit_exceeded'); assert.deepEqual(attempts.map((attempt) => attempt.state), ['exhausted']);
  });

  await t.test('the 128 KiB AI-specific context ceiling cannot be bypassed concurrently', async () => {
    const seededConcurrent = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seededConcurrent.investigationId, new MemoryQueue());
    const audit = await activateAiInvestigation(context, ai.id);
    const source = 'x'.repeat(64 * 1024); const sourceSha = blobSha(source);
    await context.database.update(investigationContextEntry).set({ objectSha: sourceSha, sizeBytes: Buffer.byteLength(source) }).where(and(eq(investigationContextEntry.investigationId, seededConcurrent.investigationId), eq(investigationContextEntry.path, 'src/shipping.ts')));
    const gateway = new Gateway();
    gateway.getBlob = async (input) => ({ bytes: Buffer.from(source), sha: input.blobSha });
    const calls = await Promise.allSettled(Array.from({ length: 3 }, () => readTextFile(context.database, root.owner, gateway, CONFIGURATION, seededConcurrent.investigationId, randomUUID(), 'src/shipping.ts', audit)));
    assert.equal(calls.filter((call) => call.status === 'fulfilled').length, 2);
    assert.equal(calls.filter((call) => call.status === 'rejected' && call.reason instanceof Error && call.reason.message === 'context_budget_exhausted').length, 1);
    const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiInvestigationId, ai.id));
    assert.equal(events.reduce((total, event) => total + event.budgetBytes, 0), 128 * 1024);
  });

  await t.test('search safely truncates to the current AI execution remaining context allowance', async () => {
    const seededSearch = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seededSearch.investigationId, new MemoryQueue());
    const audit = await activateAiInvestigation(context, ai.id);
    const source = `${'x'.repeat((64 * 1024) - 7)}needle\n`; const sourceSha = blobSha(source);
    await context.database.update(investigationContextEntry).set({ objectSha: sourceSha, sizeBytes: Buffer.byteLength(source) }).where(and(eq(investigationContextEntry.investigationId, seededSearch.investigationId), eq(investigationContextEntry.path, 'src/shipping.ts')));
    await context.database.insert(investigationContextEvent).values({ id: randomUUID(), investigationId: seededSearch.investigationId, aiInvestigationId: ai.id, workspaceId: root.workspaceId, operation: 'read_text_file', status: 'completed', resultCount: 1, resultBytes: 64 * 1024, budgetBytes: 64 * 1024, completedAt: NOW });
    const gateway = new Gateway(); gateway.getBlob = async (input) => ({ bytes: Buffer.from(source), sha: input.blobSha });
    const result = await searchText(context.database, root.owner, gateway, CONFIGURATION, seededSearch.investigationId, randomUUID(), 'needle', audit as never);
    assert.equal(result.scannedBytes, 64 * 1024); assert.equal(result.matches.length, 1); assert.equal(result.truncated, false);
    const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiInvestigationId, ai.id));
    assert.equal(events.reduce((total, event) => total + event.budgetBytes, 0), 128 * 1024);
  });
});

test('agent timeout and exhausted context budget stop safely and honestly', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const root = await seedRoot(context);
  await t.test('overall timeout', async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    const audit = await activateAiInvestigation(context, ai.id);
    const provider = new TurnProvider((_number, _outputs, signal) => new Promise<ModelTurn>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    await assert.rejects(runAiInvestigation(context.database, new Gateway(), CONFIGURATION, provider, { ...audit, investigationId: seeded.investigationId, workspaceId: root.workspaceId, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId: seeded.baselineId }, { timeoutMs: 5 }), (error: unknown) => error instanceof AiAgentError && error.code === 'model_timeout');
  });
  await t.test('context budget exhaustion', async () => {
    const seeded = await seedReady(context, root.workspaceId); const ai = await startAiInvestigation(context.database, root.owner, seeded.investigationId, new MemoryQueue());
    await context.database.insert(investigationContextEvent).values(Array.from({ length: 49 }, () => ({ id: randomUUID(), investigationId: seeded.investigationId, workspaceId: root.workspaceId, operation: 'list_paths', status: 'completed', resultCount: 0, resultBytes: 0, budgetBytes: 0, completedAt: NOW })));
    let reference = '';
    const provider = new TurnProvider((number, outputs, _signal, finalization) => {
      if (outputs?.[0] && number === 2) reference = JSON.parse(outputs[0].output).operationReference as string;
      if (number === 1) return { toolCalls: [{ callId: 'baseline', name: 'readBaselineSummary', arguments: {} }], conclusion: null };
      if (!finalization) return { toolCalls: [{ callId: 'file', name: 'readTextFile', arguments: { path: 'src/shipping.ts' } }], conclusion: null };
      return { toolCalls: [], conclusion: { status: 'insufficient_evidence', summary: 'The parent context budget was exhausted.', suspectedFiles: [], evidence: [{ kind: 'baseline', reference }], proposedApproach: 'Review the retained baseline evidence.', confidence: 'low' } };
    });
    const output = await processAiInvestigationJob(job(ai.id), { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
    assert.equal(output.status, 'completed'); const stored = await getAiInvestigation(context.database, root.owner, ai.id); assert.equal(stored?.completionReason, 'budget_exhausted'); assert.equal(stored?.conclusion?.status, 'insufficient_evidence'); assert.equal(stored?.conclusion?.confidence, 'low');
  });
});
