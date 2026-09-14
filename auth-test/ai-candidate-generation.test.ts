import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import { account, aiCandidateGeneration, aiCandidateGenerationAttempt, aiCandidateGenerationEvent, aiInvestigation, candidateVerification, executionProfile, githubInstallation, investigation, investigationContextEntry, investigationContextEvent, repairCandidate, repairCandidateFile, repairIntent, repairRun, repository, repositoryBaseline, user, workspace } from '../db/schema.ts';
import { startAiInvestigation } from '../lib/ai-investigations/flow.ts';
import { getAiCandidateGenerationForAiInvestigation, startAiCandidateGeneration, AiCandidateGenerationFlowError } from '../lib/ai-candidate-generations/flow.ts';
import { processAiCandidateGenerationJob } from '../lib/ai-candidate-generations/worker.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import type { InvestigationSourceGateway } from '../lib/investigations/types.ts';
import type { TransactionalAiCandidateGenerationQueue, TransactionalAiInvestigationQueue } from '../lib/repair-runs/queue.ts';
import { ModelProviderError, type InvestigationModelProvider, type InvestigationModelSession, type ModelTurn } from '../lib/ai-investigations/types.ts';
import { createTestContext } from './support.ts';

const NOW = new Date('2030-09-12T12:00:00.000Z');
const COMMIT = 'a'.repeat(40); const PROFILE = 'b'.repeat(64); const TREE = 'c'.repeat(40);
const REPOSITORY_ID = 41001; const INSTALLATION_ID = 42001;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const SOURCE_PATH = 'fixtures/free-shipping/src/shipping-cost.ts';
const SOURCE = 'export function shippingCostCents(subtotalCents: number): number {\n  return subtotalCents > 5_000 ? 0 : 500;\n}\n';
const FIXED_SOURCE = 'export function shippingCostCents(subtotalCents: number): number {\n  return subtotalCents >= 5_000 ? 0 : 500;\n}\n';
const LARGE_SOURCE = 'x'.repeat(64 * 1024);
const blobSha = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const CONFIGURATION: GitHubAppConfiguration = { appId: 7, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'client' };
const owner = (workspaceId: string) => ({ workspace: { id: workspaceId } } as unknown as AuthenticatedWorkspace);

class AiQueue implements TransactionalAiInvestigationQueue { async enqueueAiInvestigation(_transaction: never, payload: { version: 1; aiInvestigationId: string }) { return payload.aiInvestigationId; } }
class CandidateQueue implements TransactionalAiCandidateGenerationQueue { payloads: Array<{ version: 1; proposalGenerationId: string }> = []; async enqueueAiCandidateGeneration(_transaction: never, payload: { version: 1; proposalGenerationId: string }) { this.payloads.push(structuredClone(payload)); return payload.proposalGenerationId; } }
class Gateway implements InvestigationSourceGateway {
  calls: string[] = [];
  async createInstallationAccessToken() { this.calls.push('token'); return { accessToken: 'candidate-token', repository: { id: REPOSITORY_ID, name: 'vigilo', ownerLogin: 'xmodneo' } }; }
  async getCommitTree() { this.calls.push('commit'); return { commitSha: COMMIT, treeSha: TREE }; }
  async getTree() { this.calls.push('tree'); return { entries: [{ path: SOURCE_PATH, mode: '100644' as const, type: 'blob' as const, sha: blobSha(SOURCE), size: Buffer.byteLength(SOURCE) }], truncated: false }; }
  async getBlob(input: { blobSha: string }) { this.calls.push('blob'); assert.equal(input.blobSha, blobSha(SOURCE)); return { bytes: Buffer.from(SOURCE), sha: input.blobSha }; }
  async getInstallation() { this.calls.push('installation'); return { appId: 7, appSlug: 'vigilo-test', id: INSTALLATION_ID, suspendedAt: null }; }
  async revokeInstallationAccessToken() { this.calls.push('revoke'); }
}
class BudgetGateway extends Gateway {
  async getBlob(input: { blobSha: string }) {
    if (input.blobSha === blobSha(LARGE_SOURCE)) return { bytes: Buffer.from(LARGE_SOURCE), sha: input.blobSha };
    return super.getBlob(input);
  }
}
class SourceFailureGateway extends Gateway {
  async getBlob(_input: Parameters<Gateway['getBlob']>[0]): ReturnType<Gateway['getBlob']> { throw new Error('controlled source unavailable'); }
}
class IdentityMismatchGateway extends Gateway {
  async getTree() { this.calls.push('tree'); return { entries: [{ path: SOURCE_PATH, mode: '100644' as const, type: 'blob' as const, sha: 'd'.repeat(40), size: Buffer.byteLength(SOURCE) }], truncated: false }; }
}
class EphemeralTokenGateway extends Gateway {
  readonly minted: string[] = [];
  readonly revoked = new Set<string>();
  readonly used: string[] = [];
  async createInstallationAccessToken() {
    const accessToken = `ephemeral-${this.minted.length + 1}`;
    this.minted.push(accessToken);
    return { accessToken, repository: { id: REPOSITORY_ID, name: 'vigilo', ownerLogin: 'xmodneo' } };
  }
  async getBlob(input: Parameters<Gateway['getBlob']>[0]) {
    const accessToken = (input as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string') throw new Error('missing token');
    assert.ok(!this.revoked.has(accessToken));
    this.used.push(accessToken);
    assert.equal(input.blobSha, blobSha(SOURCE));
    return { bytes: Buffer.from(SOURCE), sha: input.blobSha };
  }
  async revokeInstallationAccessToken(...args: string[]) { const accessToken = args[0]; if (typeof accessToken !== 'string') throw new Error('missing token'); this.revoked.add(accessToken); }
}
class ProposalProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  finalizationCalls = 0;
  createSession(input: Parameters<InvestigationModelProvider['createSession']>[0]): InvestigationModelSession {
    assert.deepEqual(input.tools.map((tool) => tool.name), ['listPaths', 'readTextFile', 'searchText', 'readBaselineSummary']); assert.match(input.instructions, /no shell/i); assert.doesNotMatch(input.initialInput, /candidate-token|GEMINI_API_KEY/);
    let turn = 0;
    return { next: async ({ finalization }): Promise<ModelTurn> => { if (finalization) this.finalizationCalls += 1; turn += 1; return turn === 1 ? { toolCalls: [{ callId: 'read', name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null } : { toolCalls: [], conclusion: { status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'modify', resultingContent: FIXED_SOURCE }] }, usage: { inputTokens: 10, outputTokens: 20 } }; } };
  }
}
class FinalProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  constructor(private readonly conclusion: unknown) {}
  createSession(): InvestigationModelSession { return { next: async (): Promise<ModelTurn> => ({ toolCalls: [], conclusion: this.conclusion }) }; }
}
class ReadThenFinalProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  constructor(private readonly conclusion: unknown) {}
  createSession(): InvestigationModelSession {
    let turn = 0;
    return { next: async (): Promise<ModelTurn> => {
      turn += 1;
      return turn === 1
        ? { toolCalls: [{ callId: 'read-before-proposal', name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null }
        : { toolCalls: [], conclusion: this.conclusion };
    } };
  }
}
class ReservedFinalizationProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  finalizationCalls = 0; entries = 0;
  constructor(private readonly final: ModelTurn = { toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } }) {}
  createSession(input: Parameters<InvestigationModelProvider['createSession']>[0]): InvestigationModelSession {
    assert.deepEqual(input.tools.map((tool) => tool.name), ['listPaths', 'readTextFile', 'searchText', 'readBaselineSummary']);
    return { next: async ({ finalization }): Promise<ModelTurn> => {
      this.entries += 1;
      if (finalization) { this.finalizationCalls += 1; return this.final; }
      const ordinal = this.entries;
      return ordinal === 1 ? { toolCalls: [{ callId: `call-${ordinal}`, name: 'listPaths', arguments: {} }], conclusion: null } : { toolCalls: [{ callId: `call-${ordinal}`, name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null };
    } };
  }
}
class FailingProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  createSession(): InvestigationModelSession { return { next: async () => { throw new ModelProviderError('provider_infrastructure_failed'); } }; }
}
class ListThenFailProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  createSession(): InvestigationModelSession {
    let entries = 0;
    return { next: async (): Promise<ModelTurn> => {
      entries += 1;
      if (entries === 1) return { toolCalls: [{ callId: 'first-list', name: 'listPaths', arguments: {} }], conclusion: null };
      throw new ModelProviderError('provider_infrastructure_failed');
    } };
  }
}
class RepeatedListProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  finalizationCalls = 0;
  createSession(): InvestigationModelSession {
    let entries = 0;
    return { next: async ({ finalization }): Promise<ModelTurn> => {
      entries += 1;
      if (finalization) { this.finalizationCalls += 1; return { toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } }; }
      if (entries === 1) return { toolCalls: [{ callId: 'repeated-list', name: 'listPaths', arguments: {} }], conclusion: null };
      return { toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } };
    } };
  }
}
class SourceFailureProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  entries = 0;
  createSession(): InvestigationModelSession {
    return { next: async (): Promise<ModelTurn> => {
      this.entries += 1;
      return { toolCalls: [{ callId: 'source-failure', name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null };
    } };
  }
}
class MissingPathProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  entries = 0;
  createSession(): InvestigationModelSession {
    return { next: async ({ toolOutputs }): Promise<ModelTurn> => {
      this.entries += 1;
      if (this.entries === 1) return { toolCalls: [{ callId: 'missing-path', name: 'readTextFile', arguments: { path: 'src/missing.ts' } }], conclusion: null };
      assert.equal(toolOutputs?.length, 1);
      assert.match(toolOutputs?.[0]?.output ?? '', /path_not_found/);
      return { toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } };
    } };
  }
}
class SequentialReadProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  entries = 0;
  createSession(): InvestigationModelSession {
    return { next: async (): Promise<ModelTurn> => {
      this.entries += 1;
      if (this.entries <= 2) return { toolCalls: [{ callId: `sequential-${this.entries}`, name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null };
      return { toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } };
    } };
  }
}
class StaleProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  constructor(private readonly database: Awaited<ReturnType<typeof createTestContext>>['database']) {}
  createSession(): InvestigationModelSession { return { next: async () => { await this.database.update(aiCandidateGenerationAttempt).set({ leaseExpiresAt: new Date(0) }).where(eq(aiCandidateGenerationAttempt.state, 'active')); return { toolCalls: [{ callId: 'stale', name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null }; } }; }
}
class BudgetExhaustionProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  finalizationCalls = 0;
  createSession(): InvestigationModelSession {
    let calls = 0;
    return { next: async ({ finalization }): Promise<ModelTurn> => {
      if (finalization) { this.finalizationCalls += 1; return { toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } }; }
      calls += 1; return { toolCalls: [{ callId: `budget-${calls}`, name: 'readTextFile', arguments: { path: 'src/large.ts' } }], conclusion: null };
    } };
  }
}

async function seed(context: Awaited<ReturnType<typeof createTestContext>>, status: 'diagnosis_found' | 'insufficient_evidence' | 'objective_not_reproduced' = 'diagnosis_found') {
  const userId = randomUUID(); const workspaceId = randomUUID(); const workspaceContext = owner(workspaceId);
  await context.database.insert(user).values({ id: userId, name: 'Owner', email: `${userId}@test.invalid`, emailVerified: true });
  await context.database.insert(account).values({ id: randomUUID(), issuer: 'local:oauth:github', accountId: '1234', providerId: 'github', userId });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await context.database.insert(githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId, githubAccountId: 1234, accountLogin: 'xmodneo', accountType: 'User', status: 'active' });
  await context.database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 1234, ownerLogin: 'xmodneo', name: 'vigilo', fullName: 'xmodneo/vigilo', defaultBranch: 'main', isPrivate: true });
  await context.database.insert(executionProfile).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity: PROFILE, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), status: 'ready' });
  const baselineId = randomUUID(); const runId = randomUUID(); const intentId = randomUUID(); const investigationId = randomUUID();
  await context.database.insert(repositoryBaseline).values({ id: baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity: PROFILE, baseCommitSha: COMMIT, archiveSha256: '2'.repeat(64), sandboxName: 'baseline-sandbox', sandboxSessionId: 'baseline-session', sourceIdentityBefore: '3'.repeat(64), sourceIdentityAfter: '3'.repeat(64), sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'failed', testExitCode: 1, testTimedOut: false, executionOutcome: 'baseline_failed', overallOutcome: 'baseline_failed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'baseline_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await context.database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: PROFILE, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId, baselineOutcome: 'baseline_failed', failureClassification: 'customer_baseline_failure', failureCode: 'baseline_failed', baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  const objective = 'Fix the controlled free-shipping boundary.';
  await context.database.insert(repairIntent).values({ id: intentId, repairRunId: runId, workspaceId, objective, objectiveHash: sha256(objective) });
  await context.database.insert(investigation).values({ id: investigationId, repairRunId: runId, repairIntentId: intentId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: TREE, indexedPathCount: 1, attemptNumber: 1, completedAt: NOW, updatedAt: NOW });
  await context.database.insert(investigationContextEntry).values({ investigationId, path: SOURCE_PATH, depth: 4, kind: 'blob', mode: '100644', objectSha: blobSha(SOURCE), sizeBytes: Buffer.byteLength(SOURCE), readable: true });
  const ai = await startAiInvestigation(context.database, workspaceContext, investigationId, new AiQueue(), { clock: () => NOW });
  await context.database.update(aiInvestigation).set({ state: 'investigating', investigationStartedAt: NOW, updatedAt: NOW }).where(eq(aiInvestigation.id, ai.id));
  await context.database.update(aiInvestigation).set({ state: 'completed', completionReason: 'model_conclusion', conclusionStatus: status, summary: 'Structured bounded diagnosis.', suspectedFiles: status === 'diagnosis_found' ? [{ path: SOURCE_PATH, reason: 'Observed boundary.' }] : [], evidenceReferences: [{ kind: 'baseline', reference: randomUUID() }], proposedApproach: 'Change the boundary.', confidence: 'medium', completedAt: NOW, updatedAt: NOW }).where(eq(aiInvestigation.id, ai.id));
  return { aiId: ai.id, investigationId, workspaceContext };
}

test('only completed diagnosis_found AI executions can queue one immutable candidate generation', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queue = new CandidateQueue(); const key = randomUUID();
  const [first, repeated] = await Promise.all([startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: key, clock: () => NOW }), startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: key, clock: () => NOW })]);
  assert.equal(first.id, repeated.id); assert.equal(first.state, 'queued'); assert.equal(first.revision, COMMIT); assert.equal(first.protocolVersion, 3); assert.deepEqual(queue.payloads, [{ version: 1, proposalGenerationId: first.id }]);
  const events = await context.database.select().from(aiCandidateGenerationEvent).where(eq(aiCandidateGenerationEvent.generationId, first.id)); assert.deepEqual(events.map((event) => event.toState), ['created', 'queued']);
  await assert.rejects(context.database.update(aiCandidateGeneration).set({ baseCommitSha: 'f'.repeat(40) }).where(eq(aiCandidateGeneration.id, first.id)));
  await assert.rejects(context.database.update(aiCandidateGeneration).set({ executionOrdinal: 2 }).where(eq(aiCandidateGeneration.id, first.id)));
  assert.equal((await context.database.select().from(aiCandidateGeneration).where(and(eq(aiCandidateGeneration.aiInvestigationId, seeded.aiId), eq(aiCandidateGeneration.investigationId, seeded.investigationId)))).length, 1);
});

test('a new explicit intent after a failed generation creates the next immutable execution ordinal', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queue = new CandidateQueue();
  const first = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: randomUUID(), clock: () => NOW });
  await context.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.id));
  await context.database.update(aiCandidateGeneration).set({ state: 'failed', failureCode: 'model_limit_exceeded', completedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.id));
  const retried = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: randomUUID(), clock: () => new Date(NOW.getTime() + 1) });
  assert.notEqual(retried.id, first.id); assert.equal(first.executionOrdinal, 1); assert.equal(retried.executionOrdinal, 2); assert.equal(queue.payloads.length, 2);
  const rows = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, seeded.aiId)); assert.equal(rows.length, 2); assert.equal(rows.find((row) => row.id === first.id)?.state, 'failed');
});

test('the AI investigation summary resolves the latest immutable candidate-generation execution', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queue = new CandidateQueue();
  const first = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: randomUUID(), clock: () => NOW });
  await context.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.id));
  await context.database.update(aiCandidateGeneration).set({ state: 'failed', failureCode: 'model_limit_exceeded', completedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.id));
  const latest = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: randomUUID(), clock: () => new Date(NOW.getTime() + 1) });

  const resolved = await getAiCandidateGenerationForAiInvestigation(context.database, seeded.workspaceContext, seeded.aiId);

  assert.equal(resolved?.id, latest.id);
  assert.equal(resolved?.executionOrdinal, 2);
});

test('active generation exclusion is database-backed while an exact start retry is idempotent', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queue = new CandidateQueue(); const key = randomUUID();
  const first = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: key, clock: () => NOW });
  assert.equal((await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: key, clock: () => NOW })).id, first.id);
  await assert.rejects(startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: randomUUID(), clock: () => NOW }), (error: unknown) => error instanceof AiCandidateGenerationFlowError && error.code === 'candidate_generation_active');
  assert.equal((await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, seeded.aiId))).length, 1);
});

test('concurrent distinct start intents create at most one active execution', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queue = new CandidateQueue();
  const outcomes = await Promise.allSettled([randomUUID(), randomUUID()].map((idempotencyKey) => startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey, clock: () => NOW })));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1); assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'); assert.ok(rejected?.reason instanceof AiCandidateGenerationFlowError); assert.equal(rejected.reason.code, 'candidate_generation_active');
  const rows = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, seeded.aiId)); assert.equal(rows.length, 1); assert.equal(rows[0]?.executionOrdinal, 1);
});

test('abstained terminal executions do not create a general rerun path', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queue = new CandidateQueue(); const first = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { clock: () => NOW });
  await context.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.id));
  await context.database.update(aiCandidateGeneration).set({ state: 'abstained', completionReason: 'insufficient_evidence', completedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.id));
  await assert.rejects(startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queue, { idempotencyKey: randomUUID(), clock: () => new Date(NOW.getTime() + 1) }), /candidate_generation_not_eligible/);
  assert.equal((await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.aiInvestigationId, seeded.aiId))).length, 1);
});

test('model-authored intent is enriched with observed authority and reaches the unchanged Task 3.4 freezer', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const provider = new ProposalProvider();
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  assert.equal(output.status, 'completed'); const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); assert.equal(generation?.state, 'frozen', generation?.failureCode ?? 'unknown'); assert.ok(generation?.repairCandidateId);
  const [candidate] = await context.database.select().from(repairCandidate).where(eq(repairCandidate.id, generation!.repairCandidateId!)); const [file] = await context.database.select().from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, candidate!.id));
  assert.equal(candidate?.state, 'frozen'); assert.equal(file?.path, SOURCE_PATH); assert.equal(file?.baseBlobSha, blobSha(SOURCE)); assert.equal(file?.resultingContent, FIXED_SOURCE); assert.equal((await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id))).length, 1);
  assert.equal((await context.database.select().from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, queued.id)))[0]?.state, 'succeeded'); assert.equal(generation?.toolCallCount, 1); assert.equal(generation?.modelTurnCount, 2); assert.equal(provider.finalizationCalls, 0); assert.equal((await context.database.select().from(candidateVerification)).length, 0);
  assert.doesNotMatch(JSON.stringify(await context.database.select().from(aiCandidateGeneration)), /candidate-token|GEMINI_API_KEY|chain.of.thought/i);
});

test('five tool-bearing rounds transition to a zero-tool finalization and may abstain without a candidate', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const provider = new ReservedFinalizationProvider();
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id));
  assert.equal(output.status, 'completed'); assert.equal(provider.entries, 6); assert.equal(provider.finalizationCalls, 1); assert.equal(generation?.state, 'abstained'); assert.equal(generation?.completionReason, 'insufficient_evidence'); assert.equal(generation?.repairCandidateId, null); assert.equal(generation?.toolCallCount, 5); assert.equal(generation?.modelTurnCount, 6); assert.equal((await context.database.select().from(repairCandidate)).length, 0); assert.equal((await context.database.select().from(candidateVerification)).length, 0);
});

test('canonical free-shipping proposal from reserved finalization reaches the Task 3.4 freezer', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
  const provider = new ReservedFinalizationProvider({ toolCalls: [], conclusion: { status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'modify', resultingContent: FIXED_SOURCE }] } });
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [candidate] = await context.database.select().from(repairCandidate).where(eq(repairCandidate.id, generation!.repairCandidateId!)); const [file] = await context.database.select().from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, candidate!.id));
  assert.equal(output.status, 'completed'); assert.equal(provider.entries, 6); assert.equal(provider.finalizationCalls, 1); assert.equal(generation?.state, 'frozen'); assert.equal(generation?.toolCallCount, 5); assert.equal(generation?.modelTurnCount, 6); assert.equal(candidate?.state, 'frozen'); assert.equal(file?.path, SOURCE_PATH); assert.equal(file?.baseBlobSha, blobSha(SOURCE)); assert.equal(file?.resultingContent, FIXED_SOURCE); assert.equal((await context.database.select().from(candidateVerification)).length, 0);
});

test('a tool call from reserved finalization fails closed without another context operation and retains request usage', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const provider = new ReservedFinalizationProvider({ toolCalls: [{ callId: 'forbidden-final-tool', name: 'readTextFile', arguments: { path: SOURCE_PATH } }], conclusion: null });
  await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id));
  assert.equal(provider.finalizationCalls, 1); assert.equal(generation?.state, 'failed'); assert.equal(generation?.failureCode, 'model_limit_exceeded'); assert.equal(generation?.modelTurnCount, 6); assert.equal(events.length, 5); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
});

test('a retry resumes checkpointed provider-request usage without double counting', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const job = { id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never;
  assert.equal((await processAiCandidateGenerationJob(job, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new FailingProvider(), clock: () => new Date(NOW.getTime() + 1) })).status, 'failed');
  let [intermediate] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); assert.equal(intermediate?.state, 'generating'); assert.equal(intermediate?.modelTurnCount, 1);
  assert.equal((await processAiCandidateGenerationJob(job, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ProposalProvider(), clock: () => new Date(NOW.getTime() + 2) })).status, 'completed');
  [intermediate] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); assert.equal(intermediate?.state, 'frozen'); assert.equal(intermediate?.modelTurnCount, 3); assert.equal(intermediate?.toolCallCount, 1);
});

test('provider retries preserve per-tool quotas and reserve finalization for an excess call', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const job = { id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never;
  assert.equal((await processAiCandidateGenerationJob(job, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ListThenFailProvider(), clock: () => new Date(NOW.getTime() + 1) })).status, 'failed');
  const retryProvider = new RepeatedListProvider();
  assert.equal((await processAiCandidateGenerationJob(job, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => retryProvider, clock: () => new Date(NOW.getTime() + 2) })).status, 'completed');
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id));
  assert.equal(generation?.state, 'abstained'); assert.equal(generation?.toolCallCount, 1); assert.equal(generation?.modelTurnCount, 4); assert.equal(retryProvider.finalizationCalls, 1); assert.equal(events.length, 1); assert.equal(events[0]?.operation, 'list_paths');
});

test('authoritative context-source failure is terminal without another provider entry or candidate', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const provider = new SourceFailureProvider();
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new SourceFailureGateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [attempt] = await context.database.select().from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, queued.id)); const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id));
  assert.equal(output.status, 'completed'); assert.equal(provider.entries, 1); assert.equal(generation?.state, 'failed'); assert.equal(generation?.failureCode, 'context_source_unavailable'); assert.equal(attempt?.state, 'exhausted'); assert.equal(events.length, 1); assert.equal(events[0]?.failureCode, 'context_source_unavailable'); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
});

test('safe audited context rejections return to the model without provider retry relabeling', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const provider = new MissingPathProvider();
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [attempt] = await context.database.select().from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, queued.id)); const [event] = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id));
  assert.equal(output.status, 'completed'); assert.equal(provider.entries, 2); assert.equal(generation?.state, 'abstained'); assert.equal(generation?.failureCode, null); assert.equal(attempt?.state, 'succeeded'); assert.equal(event?.status, 'rejected'); assert.equal(event?.failureCode, 'path_not_found'); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
});

test('sequential candidate reads mint and revoke distinct tokens without reusing a revoked token', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const gateway = new EphemeralTokenGateway(); const provider = new SequentialReadProvider();
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway, configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id));
  assert.equal(output.status, 'completed'); assert.equal(generation?.state, 'abstained'); assert.equal(provider.entries, 3); assert.deepEqual(gateway.minted, ['ephemeral-1', 'ephemeral-2']); assert.deepEqual(gateway.used, gateway.minted); assert.deepEqual([...gateway.revoked], gateway.minted); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
});

test('invalid local provider configuration is terminal before model entry or repository tool dispatch', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const gateway = new Gateway();
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway, configuration: CONFIGURATION, createProvider: () => { throw new ModelProviderError('provider_configuration_failed'); }, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [attempt] = await context.database.select().from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, queued.id));
  assert.equal(output.status, 'completed'); assert.equal(generation?.state, 'failed'); assert.equal(generation?.failureCode, 'provider_configuration_failed'); assert.equal(generation?.modelTurnCount, 0); assert.equal(generation?.toolCallCount, 0); assert.equal(attempt?.state, 'exhausted'); assert.deepEqual(gateway.calls, []); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
});

test('a stale worker cannot checkpoint usage after its ownership lease is lost', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new StaleProvider(context.database), clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id));
  assert.equal(output.status, 'failed'); assert.equal(generation?.state, 'generating'); assert.equal(generation?.modelTurnCount, 1); assert.equal(generation?.toolCallCount, 0); assert.equal((await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id))).length, 0);
});

test('AI context-budget exhaustion transitions directly to finalization without another context result', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context);
  await context.database.insert(investigationContextEntry).values({ investigationId: seeded.investigationId, path: 'src/large.ts', depth: 2, kind: 'blob', mode: '100644', objectSha: blobSha(LARGE_SOURCE), sizeBytes: Buffer.byteLength(LARGE_SOURCE), readable: true });
  const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const provider = new BudgetExhaustionProvider();
  await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new BudgetGateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.aiCandidateGenerationId, queued.id));
  assert.equal(provider.finalizationCalls, 1); assert.equal(generation?.state, 'abstained'); assert.equal(generation?.toolCallCount, 3); assert.equal(generation?.modelTurnCount, 4); assert.equal(events.length, 2); assert.equal(events.reduce((sum, event) => sum + event.budgetBytes, 0), 128 * 1024);
});

test('malformed and unread model proposals fail closed before creating a RepairCandidate', async (t) => {
  for (const { conclusion, failureCode } of [
    { conclusion: { files: [{ path: SOURCE_PATH, operation: 'write', resultingContent: 'nope\n' }] }, failureCode: 'schema_mismatch' },
    { conclusion: { status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'write', resultingContent: 'nope\n' }] }, failureCode: 'invalid_operation_shape' },
    { conclusion: { status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'modify', resultingContent: 'nope\n' }] }, failureCode: 'fresh_observation_missing' },
    { conclusion: { status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'delete', resultingContent: null }] }, failureCode: 'fresh_observation_missing' },
    ...['package.json', 'package-lock.json', '../escape.ts', '.env.local', 'src/payload.bin'].map((path) => ({ conclusion: { status: 'proposal_ready', files: [{ path, operation: 'add', resultingContent: 'nope\n' }] }, failureCode: 'invalid_path' })),
  ]) {
    const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
    const result = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new FinalProvider(conclusion), clock: () => new Date(NOW.getTime() + 1) });
    assert.equal(result.status, 'completed'); const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); assert.equal(generation?.state, 'failed'); assert.equal(generation?.failureCode, failureCode); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
  }
});

test('Task 3.4 freezer rejection preserves a safe proposal subtype', async (t) => {
  for (const { provider, rejectionCode } of [
    { provider: new ReadThenFinalProvider({ status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'modify', resultingContent: SOURCE }] }), rejectionCode: 'no_effective_change' },
    { provider: new FinalProvider({ status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'add', resultingContent: FIXED_SOURCE }] }), rejectionCode: 'add_path_already_exists' },
  ]) {
    const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
    const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
    const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [candidate] = await context.database.select().from(repairCandidate).where(eq(repairCandidate.investigationId, seeded.investigationId));
    assert.equal(output.status, 'completed'); assert.equal(generation?.state, 'failed'); assert.equal(generation?.failureCode, 'invalid_operation_shape'); assert.equal(candidate?.state, 'rejected'); assert.equal(candidate?.rejectionCode, rejectionCode); assert.equal((await context.database.select().from(candidateVerification)).length, 0);
  }
});

test('Task 3.4 server-derived base identity rejection is an authority failure', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new IdentityMismatchGateway(), configuration: CONFIGURATION, createProvider: () => new ProposalProvider(), clock: () => new Date(NOW.getTime() + 1) });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [candidate] = await context.database.select().from(repairCandidate).where(eq(repairCandidate.investigationId, seeded.investigationId));
  assert.equal(output.status, 'completed'); assert.equal(generation?.failureCode, 'candidate_generation_authority_mismatch'); assert.equal(candidate?.state, 'rejected'); assert.equal(candidate?.rejectionCode, 'base_identity_mismatch');
});

test('valid add and delete proposals reach the unchanged Task 3.4 freezer', async (t) => {
  for (const provider of [
    new FinalProvider({ status: 'proposal_ready', files: [{ path: 'src/new.ts', operation: 'add', resultingContent: 'export {};\n' }] }),
    new ReadThenFinalProvider({ status: 'proposal_ready', files: [{ path: SOURCE_PATH, operation: 'delete', resultingContent: null }] }),
  ]) {
    const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
    const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => new Date(NOW.getTime() + 1) });
    const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [candidate] = await context.database.select().from(repairCandidate).where(eq(repairCandidate.id, generation!.repairCandidateId!));
    assert.equal(output.status, 'completed'); assert.equal(generation?.state, 'frozen'); assert.equal(candidate?.state, 'frozen'); assert.equal((await context.database.select().from(candidateVerification)).length, 0);
  }
});

test('Task 3.4 pre-reservation authority failure is terminal and safely classified', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW });
  const output = await processAiCandidateGenerationJob({ id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never, {
    database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new FinalProvider({ status: 'insufficient_evidence', files: [] }), clock: () => new Date(NOW.getTime() + 1),
    executor: (async () => {
      await context.database.update(investigation).set({ state: 'failed', failureCode: 'controlled_test_failure', completedAt: NOW, updatedAt: NOW }).where(eq(investigation.id, seeded.investigationId));
      return { result: { status: 'proposal_ready', proposal: { files: [{ path: 'src/new.ts', operation: 'add', expectedBaseIdentity: null, resultingContent: 'export {};\n' }] } }, usage: { inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 1 } };
    }) as never,
  });
  const [generation] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)); const [attempt] = await context.database.select().from(aiCandidateGenerationAttempt).where(eq(aiCandidateGenerationAttempt.generationId, queued.id));
  assert.equal(output.status, 'completed'); assert.equal(generation?.state, 'failed'); assert.equal(generation?.failureCode, 'candidate_generation_authority_mismatch'); assert.equal(attempt?.state, 'exhausted'); assert.equal((await context.database.select().from(repairCandidate)).length, 0);
});

test('a crash after candidate persistence reconciles without a second provider call', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queued = await startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue(), { clock: () => NOW }); const job = { id: queued.id, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: queued.id }, signal: new AbortController().signal } as never;
  assert.equal((await processAiCandidateGenerationJob(job, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => new ProposalProvider(), afterCandidateFrozen: async () => { throw new Error('simulated crash'); }, clock: () => new Date(NOW.getTime() + 1) })).status, 'failed');
  assert.equal((await context.database.select().from(repairCandidate)).length, 1); let providerCalls = 0;
  assert.equal((await processAiCandidateGenerationJob(job, { database: context.database, gateway: new Gateway(), configuration: CONFIGURATION, createProvider: () => { providerCalls += 1; return new ProposalProvider(); }, clock: () => new Date(NOW.getTime() + 2) })).status, 'completed');
  assert.equal(providerCalls, 0); assert.equal((await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, queued.id)))[0]?.state, 'frozen'); assert.equal((await context.database.select().from(repairCandidate)).length, 1);
});

test('non-diagnosis, terminal failure, and cross-workspace AI executions cannot generate a candidate', async (t) => {
  for (const status of ['insufficient_evidence', 'objective_not_reproduced'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context, status);
    await assert.rejects(startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, new CandidateQueue()), (error: unknown) => error instanceof AiCandidateGenerationFlowError && error.code === 'candidate_generation_not_eligible');
  }
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context);
  const [completed] = await context.database.select().from(aiInvestigation).where(eq(aiInvestigation.id, seeded.aiId)); const failedId = randomUUID();
  await context.database.insert(aiInvestigation).values({ ...completed!, id: failedId, executionOrdinal: 2, idempotencyKey: randomUUID(), state: 'failed', completionReason: null, conclusionStatus: null, summary: null, suspectedFiles: null, evidenceReferences: null, proposedApproach: null, confidence: null, inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 0, failureCode: 'model_protocol_error', investigationStartedAt: null, completedAt: NOW, createdAt: NOW, updatedAt: NOW });
  await assert.rejects(startAiCandidateGeneration(context.database, seeded.workspaceContext, failedId, new CandidateQueue()), /candidate_generation_not_eligible/);
  const activeId = randomUUID();
  await context.database.insert(aiInvestigation).values({ ...completed!, id: activeId, executionOrdinal: 3, idempotencyKey: randomUUID(), state: 'queued', completionReason: null, conclusionStatus: null, summary: null, suspectedFiles: null, evidenceReferences: null, proposedApproach: null, confidence: null, inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 0, failureCode: null, investigationStartedAt: null, completedAt: null, createdAt: NOW, updatedAt: NOW });
  await assert.rejects(startAiCandidateGeneration(context.database, seeded.workspaceContext, activeId, new CandidateQueue()), /candidate_generation_not_eligible/);
  await assert.rejects(startAiCandidateGeneration(context.database, owner(randomUUID()), seeded.aiId, new CandidateQueue()), /candidate_generation_not_eligible/);
});
