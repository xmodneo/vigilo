import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { and, eq } from 'drizzle-orm';

import {
  account, aiCandidateGeneration, aiInvestigation, candidateVerification, candidateVerificationAttempt,
  candidateVerificationEvidence, executionProfile, githubInstallation, investigation, repairCandidate,
  repairCandidateFile, repairIntent, repairLoop, repairLoopEvent, repairLoopIteration, repairRun,
  repository, repositoryBaseline, user, workspace,
} from '../db/schema.ts';
import { startAiCandidateGeneration, AiCandidateGenerationFlowError } from '../lib/ai-candidate-generations/flow.ts';
import { processAiCandidateGenerationJob } from '../lib/ai-candidate-generations/worker.ts';
import type { InvestigationModelProvider, InvestigationModelSession } from '../lib/ai-investigations/types.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { startCandidateVerification, CandidateVerificationError } from '../lib/candidate-verifications/flow.ts';
import { computeCandidateIdentity, sha256 } from '../lib/repair-candidates/identity.ts';
import { getRepairLoop, startRepairLoop } from '../lib/repair-loops/flow.ts';
import { createRepairLoopHandlers } from '../lib/repair-loops/handlers.ts';
import { buildRepairLoopFeedback, REPAIR_LOOP_FEEDBACK_MAX_BYTES, validateStoredRepairLoopFeedback } from '../lib/repair-loops/feedback.ts';
import { canonicalRecord } from '../lib/repair-loops/canonical.ts';
import { processRepairLoopJob } from '../lib/repair-loops/worker.ts';
import type { AiCandidateGenerationJobPayload, CandidateVerificationJobPayload, RepairLoopJobPayload, VigiloTransaction } from '../lib/repair-runs/queue.ts';
import { createTestContext } from './support.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import type { InvestigationSourceGateway } from '../lib/investigations/types.ts';

const NOW = new Date('2031-01-02T03:04:05.000Z');
const COMMIT = 'a'.repeat(40); const PROFILE = 'b'.repeat(64); const TREE = 'c'.repeat(40);
const SOURCE_IDENTITY = 'd'.repeat(64); const REPOSITORY_ID = 51001; const INSTALLATION_ID = 52001;
const PATH = 'src/fix.ts'; const BASE = 'export const value = 1;\n'; const FIX = 'export const value = 2;\n';
const blobSha = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const owner = (workspaceId: string) => ({ workspace: { id: workspaceId } } as unknown as AuthenticatedWorkspace);
const CONFIGURATION: GitHubAppConfiguration = { appId: 7, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'client' };

class Queues {
  generations: AiCandidateGenerationJobPayload[] = [];
  verifications: CandidateVerificationJobPayload[] = [];
  wakes: Array<{ payload: RepairLoopJobPayload; id: string }> = [];
  async enqueueAiCandidateGeneration(_transaction: VigiloTransaction, payload: AiCandidateGenerationJobPayload) { this.generations.push(structuredClone(payload)); return payload.proposalGenerationId; }
  async enqueueVerification(_transaction: VigiloTransaction, payload: CandidateVerificationJobPayload) { this.verifications.push(structuredClone(payload)); return payload.verificationId; }
  async enqueueRepairLoop(_transaction: VigiloTransaction, payload: RepairLoopJobPayload, wakeJobId: string) { this.wakes.push({ payload: structuredClone(payload), id: wakeJobId }); return wakeJobId; }
}

class UnusedGateway implements InvestigationSourceGateway {
  async createInstallationAccessToken(): Promise<never> { throw new Error('unexpected_source_access'); }
  async getCommitTree(): Promise<never> { throw new Error('unexpected_source_access'); }
  async getTree(): Promise<never> { throw new Error('unexpected_source_access'); }
  async getBlob(): Promise<never> { throw new Error('unexpected_source_access'); }
  async getInstallation(): Promise<never> { throw new Error('unexpected_source_access'); }
  async revokeInstallationAccessToken(): Promise<void> {}
}

class FeedbackCaptureProvider implements InvestigationModelProvider {
  readonly providerId = 'google'; readonly modelId = 'gemini-3.1-flash-lite';
  input: Record<string, unknown> | null = null;
  createSession(input: Parameters<InvestigationModelProvider['createSession']>[0]): InvestigationModelSession {
    this.input = JSON.parse(input.initialInput) as Record<string, unknown>;
    return { next: async () => ({ toolCalls: [], conclusion: { status: 'insufficient_evidence', files: [] } }) };
  }
}

async function seed(context: Awaited<ReturnType<typeof createTestContext>>, measurable = true) {
  const userId = randomUUID(); const workspaceId = randomUUID(); const runId = randomUUID(); const baselineId = randomUUID(); const investigationId = randomUUID(); const aiId = randomUUID();
  await context.database.insert(user).values({ id: userId, name: 'Owner', email: `${userId}@test.invalid`, emailVerified: true });
  await context.database.insert(account).values({ id: randomUUID(), issuer: 'local:oauth:github', accountId: '1234', providerId: 'github', userId });
  await context.database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await context.database.insert(githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId, githubAccountId: 1234, accountLogin: 'owner', accountType: 'User', status: 'active' });
  await context.database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 1234, ownerLogin: 'owner', name: 'repo', fullName: 'owner/repo', defaultBranch: 'main', isPrivate: true });
  await context.database.insert(executionProfile).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity: PROFILE, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'e'.repeat(40), packageJsonContentSha256: 'f'.repeat(64), packageLockBlobSha: '1'.repeat(40), packageLockContentSha256: '2'.repeat(64), status: 'ready' });
  await context.database.insert(repositoryBaseline).values({ id: baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity: PROFILE, baseCommitSha: COMMIT, archiveSha256: '3'.repeat(64), sandboxName: 'baseline-sandbox', sourceIdentityBefore: SOURCE_IDENTITY, sourceIdentityAfter: SOURCE_IDENTITY, sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: measurable ? 'failed' : 'completed', testExitCode: measurable ? 1 : 0, testTimedOut: false, executionOutcome: measurable ? 'test_failed' : 'baseline_passed', overallOutcome: measurable ? 'test_failed' : 'baseline_passed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: measurable ? 'test' : null, errorCode: measurable ? 'npm_command_failed' : null, startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await context.database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: PROFILE, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId, baselineOutcome: measurable ? 'test_failed' : 'baseline_passed', failureClassification: measurable ? 'customer_baseline_failure' : null, failureCode: measurable ? 'test_failed' : null, baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  const intentId = randomUUID(); const objective = 'Repair the measured regression.';
  await context.database.insert(repairIntent).values({ id: intentId, repairRunId: runId, workspaceId, objective, objectiveHash: sha256(objective) });
  await context.database.insert(investigation).values({ id: investigationId, repairRunId: runId, repairIntentId: intentId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: TREE, indexedPathCount: 1, attemptNumber: 1, completedAt: NOW, updatedAt: NOW });
  await context.database.insert(aiInvestigation).values({ id: aiId, investigationId, executionOrdinal: 1, idempotencyKey: randomUUID(), repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 1, state: 'completed', queuedAt: NOW, investigationStartedAt: NOW, completedAt: NOW, completionReason: 'model_conclusion', conclusionStatus: 'diagnosis_found', summary: 'Bounded diagnosis.', suspectedFiles: [{ path: PATH, reason: 'Measured failure.' }], evidenceReferences: [{ kind: 'baseline', reference: randomUUID() }], proposedApproach: 'Repair the check.', confidence: 'medium', updatedAt: NOW });
  return { workspaceId, runId, baselineId, investigationId, aiId, workspaceContext: owner(workspaceId) };
}

async function currentWake(context: Awaited<ReturnType<typeof createTestContext>>, loopId: string) {
  const [row] = await context.database.select().from(repairLoop).where(eq(repairLoop.id, loopId));
  assert.ok(row?.wakeJobId); return row.wakeJobId;
}

async function runWake(context: Awaited<ReturnType<typeof createTestContext>>, loopId: string, queues: Queues) {
  const id = await currentWake(context, loopId);
  return processRepairLoopJob({ id, data: { version: 1, repairLoopId: loopId }, name: 'repair-loop-v1', signal: new AbortController().signal } as never, { database: context.database, queues, clock: () => NOW });
}

async function freezeGeneration(context: Awaited<ReturnType<typeof createTestContext>>, generationId: string, seeded: Awaited<ReturnType<typeof seed>>, ordinal: number, validIdentity = true) {
  const file = { path: PATH, operation: 'modify' as const, baseBlobSha: blobSha(BASE), baseContentSha256: sha256(BASE), resultContentSha256: sha256(FIX), resultByteLength: Buffer.byteLength(FIX), resultingContent: FIX };
  const candidateId = randomUUID(); const computedIdentity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, files: [file] }); const candidateIdentity = validIdentity ? computedIdentity : '9'.repeat(64);
  await context.database.insert(repairCandidate).values({ id: candidateId, investigationId: seeded.investigationId, repairRunId: seeded.runId, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, formatVersion: 1, ordinal, proposalKey: generationId, proposalIdentity: '4'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: Buffer.byteLength(FIX), createdAt: NOW, freezingStartedAt: NOW, updatedAt: NOW });
  await context.database.insert(repairCandidateFile).values({ candidateId, ...file });
  await context.database.update(repairCandidate).set({ state: 'frozen', candidateIdentity, completedAt: NOW, updatedAt: NOW }).where(and(eq(repairCandidate.id, candidateId), eq(repairCandidate.state, 'freezing')));
  await context.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(and(eq(aiCandidateGeneration.id, generationId), eq(aiCandidateGeneration.state, 'queued')));
  await context.database.update(aiCandidateGeneration).set({ state: 'frozen', repairCandidateId: candidateId, completionReason: 'proposal_ready', completedAt: NOW, updatedAt: NOW }).where(and(eq(aiCandidateGeneration.id, generationId), eq(aiCandidateGeneration.state, 'generating')));
  return { candidateId, candidateIdentity };
}

async function completeVerification(context: Awaited<ReturnType<typeof createTestContext>>, verificationId: string, candidateId: string, candidateIdentity: string, seeded: Awaited<ReturnType<typeof seed>>, pass: boolean, comparison = pass ? 'previous_baseline_failure_resolved' : 'previous_baseline_failure_still_present') {
  const attemptId = randomUUID(); const evidenceId = randomUUID();
  await context.database.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: NOW, updatedAt: NOW }).where(and(eq(candidateVerification.id, verificationId), eq(candidateVerification.state, 'queued')));
  await context.database.insert(candidateVerificationAttempt).values({ id: attemptId, verificationId, queueJobId: randomUUID(), attemptNumber: 1, expectedEvidenceId: evidenceId, ownershipToken: randomUUID(), state: pass ? 'succeeded' : 'checks_failed', claimedAt: NOW, heartbeatAt: NOW, leaseExpiresAt: null, finishedAt: NOW });
  await context.database.insert(candidateVerificationEvidence).values({ id: evidenceId, verificationId, attemptId, evidenceVersion: 1, candidateId, candidateIdentity, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, baselineId: seeded.baselineId, candidateArtifactIntegrity: 'valid', sandboxName: `verification-${verificationId.slice(0, 8)}`, distinctSandboxConfirmed: true, pristineSourceIdentity: SOURCE_IDENTITY, pristineBaseIntegrity: 'valid', reconstructedSourceIdentity: '5'.repeat(64), candidateReconstruction: 'valid', credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: pass ? 'completed' : 'failed', testExitCode: pass ? 0 : 1, testTimedOut: false, sourceIdentityAfter: '5'.repeat(64), sourceIntegrityUnchanged: true, cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', executionOutcome: pass ? 'checks_passed' : 'test_failed', verificationContract: pass ? 'checks_passed' : 'checks_failed', baselineComparison: comparison, repairObjectiveEvidence: 'not_measured', errorPhase: pass ? null : 'test', errorCode: pass ? null : 'npm_command_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await context.database.update(candidateVerificationAttempt).set({ evidenceId }).where(eq(candidateVerificationAttempt.id, attemptId));
  await context.database.update(candidateVerification).set({ state: 'completed', candidateArtifactIntegrity: 'valid', verificationContract: pass ? 'checks_passed' : 'checks_failed', baselineComparison: comparison, evidenceId, completedAt: NOW, updatedAt: NOW }).where(and(eq(candidateVerification.id, verificationId), eq(candidateVerification.state, 'verifying')));
  return evidenceId;
}

async function createLoop(context: Awaited<ReturnType<typeof createTestContext>>, measurable = true) {
  const seeded = await seed(context, measurable); const queues = new Queues();
  const loop = await startRepairLoop(context.database, seeded.workspaceContext, seeded.runId, queues, { idempotencyKey: randomUUID(), clock: () => NOW });
  return { seeded, queues, loop };
}

test('migration 0019 creates an idempotent loop and preserves immutable append-only authority', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queues = new Queues(); const key = randomUUID();
  const [a, b] = await Promise.all([startRepairLoop(context.database, seeded.workspaceContext, seeded.runId, queues, { idempotencyKey: key, clock: () => NOW }), startRepairLoop(context.database, seeded.workspaceContext, seeded.runId, queues, { idempotencyKey: key, clock: () => NOW })]);
  assert.equal(a.id, b.id); assert.equal((await context.database.select().from(repairLoop)).length, 1); assert.equal((await context.database.select().from(repairLoopIteration)).length, 1); assert.equal((await context.database.select().from(aiCandidateGeneration)).length, 1);
  assert.equal(a.iterations[0]?.objectiveMeasurable, true); assert.equal(a.iterations[0]?.objectiveContractVersion, 'baseline_recovery_v1');
  await assert.rejects(context.database.update(repairLoop).set({ repairRunId: randomUUID() }).where(eq(repairLoop.id, a.id)));
  const [event] = await context.database.select().from(repairLoopEvent).where(eq(repairLoopEvent.repairLoopId, a.id)); assert.ok(event);
  await assert.rejects(context.database.delete(repairLoopEvent).where(eq(repairLoopEvent.id, event!.id)));
});

test('stale and duplicate wake delivery cannot create duplicate children; manual child actions are rejected', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context); const stale = randomUUID();
  assert.equal((await processRepairLoopJob({ id: stale, data: { version: 1, repairLoopId: loop.id } } as never, { database: context.database, queues })).status, 'completed');
  await Promise.all([runWake(context, loop.id, queues), runWake(context, loop.id, queues)]);
  assert.equal((await context.database.select().from(repairLoopIteration)).length, 1); assert.equal(queues.wakes.length, 2);
  await assert.rejects(startAiCandidateGeneration(context.database, seeded.workspaceContext, seeded.aiId, queues), (error: unknown) => error instanceof AiCandidateGenerationFlowError && error.code === 'candidate_generation_owned_by_repair_loop');
});

test('a delivery that becomes stale after its initial read cannot mutate using successor wake authority', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  const oldWake = await currentWake(context, loop.id); const successorWake = randomUUID();
  const result = await processRepairLoopJob({ id: oldWake, data: { version: 1, repairLoopId: loop.id } } as never, {
    database: context.database, queues, clock: () => NOW,
    afterWakeValidated: async () => { await context.database.update(repairLoop).set({ wakeJobId: successorWake, updatedAt: NOW }).where(eq(repairLoop.id, loop.id)); },
  });
  assert.equal(result.status, 'completed');
  const stored = await getRepairLoop(context.database, seeded.workspaceContext, loop.id);
  assert.equal(stored?.state, 'queued'); assert.equal(await currentWake(context, loop.id), successorWake);
  assert.equal(queues.wakes.length, 1); assert.equal((await context.database.select().from(repairLoopEvent).where(eq(repairLoopEvent.repairLoopId, loop.id))).length, 2);
});

test('an unowned historical verification cannot become the iteration-bound verification', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues); const candidate = await freezeGeneration(context, loop.iterations[0]!.aiCandidateGenerationId, seeded, 1);
  const foreignVerificationId = randomUUID();
  await context.database.insert(candidateVerification).values({ id: foreignVerificationId, candidateId: candidate.candidateId, investigationId: seeded.investigationId, repairRunId: seeded.runId, baselineId: seeded.baselineId, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, candidateIdentity: candidate.candidateIdentity, formatVersion: 1, state: 'queued', createdAt: NOW, queuedAt: NOW, updatedAt: NOW });
  await runWake(context, loop.id, queues);
  const finished = await getRepairLoop(context.database, seeded.workspaceContext, loop.id);
  assert.equal(finished?.state, 'failed'); assert.equal(finished?.failureClassification, 'integrity_failure'); assert.equal(finished?.failureCode, 'verification_provenance_ambiguous');
  assert.equal(finished?.iterations[0]?.candidateVerificationId, null); assert.equal(finished?.iterations[0]?.decision, 'evidence_invalid');
});

test('iteration 1 objective satisfaction verifies and selects the exact triple', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues);
  const generationId = loop.iterations[0]!.aiCandidateGenerationId; const candidate = await freezeGeneration(context, generationId, seeded, 1);
  const otherCandidateId = randomUUID(); const otherProposalKey = randomUUID();
  await context.database.insert(repairCandidate).values({ id: otherCandidateId, investigationId: seeded.investigationId, repairRunId: seeded.runId, workspaceId: seeded.workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, formatVersion: 1, ordinal: 2, proposalKey: otherProposalKey, proposalIdentity: '6'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: Buffer.byteLength(FIX), createdAt: NOW, freezingStartedAt: NOW, updatedAt: NOW });
  await context.database.insert(repairCandidateFile).values({ candidateId: otherCandidateId, path: PATH, operation: 'modify', baseBlobSha: blobSha(BASE), baseContentSha256: sha256(BASE), resultContentSha256: sha256(FIX), resultByteLength: Buffer.byteLength(FIX), resultingContent: FIX });
  await context.database.update(repairCandidate).set({ state: 'frozen', candidateIdentity: candidate.candidateIdentity, completedAt: NOW, updatedAt: NOW }).where(eq(repairCandidate.id, otherCandidateId));
  await assert.rejects(startCandidateVerification(context.database, seeded.workspaceContext, otherCandidateId, queues), (error: unknown) => error instanceof CandidateVerificationError && error.code === 'verification_owned_by_repair_loop');
  await runWake(context, loop.id, queues);
  const [iteration] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)); assert.ok(iteration?.candidateVerificationId);
  await assert.rejects(startCandidateVerification(context.database, seeded.workspaceContext, candidate.candidateId, queues), (error: unknown) => error instanceof CandidateVerificationError && error.code === 'verification_owned_by_repair_loop');
  const evidenceId = await completeVerification(context, iteration!.candidateVerificationId!, candidate.candidateId, candidate.candidateIdentity, seeded, true);
  await runWake(context, loop.id, queues);
  const finished = await getRepairLoop(context.database, seeded.workspaceContext, loop.id);
  assert.equal(finished?.state, 'verified'); assert.equal(finished?.selectedCandidateId, candidate.candidateId); assert.equal(finished?.selectedVerificationId, iteration!.candidateVerificationId); assert.equal(finished?.selectedEvidenceId, evidenceId); assert.equal(finished?.iterations[0]?.objectiveEvidence, 'satisfied');
  await assert.rejects(context.database.update(repairLoopIteration).set({ candidateVerificationId: randomUUID() }).where(eq(repairLoopIteration.id, iteration!.id)));
});

test('repairable iteration 1 schedules one protocol-v4 replacement with canonical immediate-predecessor feedback', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues); const firstGeneration = loop.iterations[0]!.aiCandidateGenerationId; const firstCandidate = await freezeGeneration(context, firstGeneration, seeded, 1);
  await runWake(context, loop.id, queues); const [first] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id));
  await completeVerification(context, first!.candidateVerificationId!, firstCandidate.candidateId, firstCandidate.candidateIdentity, seeded, false);
  await Promise.all([runWake(context, loop.id, queues), runWake(context, loop.id, queues)]);
  const iterations = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(repairLoopIteration.ordinal);
  assert.equal(iterations.length, 2); assert.equal(iterations[0]?.decision, 'repairable_failure'); assert.equal(iterations[1]?.previousIterationId, iterations[0]?.id); assert.equal(iterations[1]?.feedbackVerificationId, iterations[0]?.candidateVerificationId); assert.ok((iterations[1]?.feedbackBytes ?? 0) <= REPAIR_LOOP_FEEDBACK_MAX_BYTES);
  const [secondGeneration] = await context.database.select().from(aiCandidateGeneration).where(eq(aiCandidateGeneration.id, iterations[1]!.aiCandidateGenerationId)); assert.equal(secondGeneration?.protocolVersion, 4); assert.equal(secondGeneration?.baseCommitSha, COMMIT);
  const secondCandidate = await freezeGeneration(context, secondGeneration!.id, seeded, 2); await runWake(context, loop.id, queues);
  const [second] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.id, iterations[1]!.id)); await completeVerification(context, second!.candidateVerificationId!, secondCandidate.candidateId, secondCandidate.candidateIdentity, seeded, false); await runWake(context, loop.id, queues);
  assert.equal((await getRepairLoop(context.database, seeded.workspaceContext, loop.id))?.state, 'limit_reached'); assert.equal((await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id))).length, 2);
});

test('protocol-v4 execution receives only the exact canonical immediate-predecessor feedback', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues); const firstCandidate = await freezeGeneration(context, loop.iterations[0]!.aiCandidateGenerationId, seeded, 1); await runWake(context, loop.id, queues);
  let iterations = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(repairLoopIteration.ordinal);
  const firstEvidenceId = await completeVerification(context, iterations[0]!.candidateVerificationId!, firstCandidate.candidateId, firstCandidate.candidateIdentity, seeded, false); await runWake(context, loop.id, queues);
  iterations = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(repairLoopIteration.ordinal);
  const provider = new FeedbackCaptureProvider(); const generationId = iterations[1]!.aiCandidateGenerationId;
  const result = await processAiCandidateGenerationJob({ id: generationId, name: 'ai-candidate-generation-v1', data: { version: 1, proposalGenerationId: generationId }, signal: new AbortController().signal } as never, { database: context.database, gateway: new UnusedGateway(), configuration: CONFIGURATION, createProvider: () => provider, clock: () => NOW });
  assert.equal(result.status, 'completed'); assert.equal(provider.input?.protocol, 4);
  const feedback = provider.input?.untrustedVerificationFeedback as { boundary?: string; value?: { provenance?: Record<string, unknown>; previousCandidate?: Record<string, unknown> } };
  assert.equal(feedback.boundary, 'UNTRUSTED_MIXED_DATA'); assert.equal(feedback.value?.provenance?.previousIterationId, iterations[0]!.id);
  assert.equal(feedback.value?.provenance?.candidateId, firstCandidate.candidateId); assert.equal(feedback.value?.provenance?.verificationId, iterations[0]!.candidateVerificationId);
  assert.equal(feedback.value?.provenance?.evidenceId, firstEvidenceId); assert.deepEqual(feedback.value?.previousCandidate, { files: [{ operation: 'modify', path: PATH }] });
  assert.doesNotMatch(JSON.stringify(feedback), /resultingContent|stdout|stderr|token|sandbox-/i);
});

test('a trustworthy verification without measurable baseline failures stops for review', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context, false);
  await runWake(context, loop.id, queues); const candidate = await freezeGeneration(context, loop.iterations[0]!.aiCandidateGenerationId, seeded, 1); await runWake(context, loop.id, queues);
  const [iteration] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id));
  await completeVerification(context, iteration!.candidateVerificationId!, candidate.candidateId, candidate.candidateIdentity, seeded, true); await runWake(context, loop.id, queues);
  const finished = await getRepairLoop(context.database, seeded.workspaceContext, loop.id); assert.equal(finished?.state, 'review_required'); assert.equal(finished?.iterations.length, 1); assert.equal(finished?.iterations[0]?.objectiveEvidence, 'not_measured');
});

test('objective satisfaction with a trustworthy regression schedules iteration 2', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues); const candidate = await freezeGeneration(context, loop.iterations[0]!.aiCandidateGenerationId, seeded, 1); await runWake(context, loop.id, queues);
  const [iteration] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)); await completeVerification(context, iteration!.candidateVerificationId!, candidate.candidateId, candidate.candidateIdentity, seeded, true, 'regression_detected'); await runWake(context, loop.id, queues);
  const stored = await getRepairLoop(context.database, seeded.workspaceContext, loop.id); assert.equal(stored?.state, 'running'); assert.equal(stored?.iterations[0]?.objectiveEvidence, 'satisfied'); assert.equal(stored?.iterations[0]?.decision, 'repairable_failure'); assert.equal(stored?.iterations.length, 2);
});

test('iteration 2 may satisfy the objective and select only its exact evidence triple', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues); const firstCandidate = await freezeGeneration(context, loop.iterations[0]!.aiCandidateGenerationId, seeded, 1); await runWake(context, loop.id, queues);
  let iterations = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(repairLoopIteration.ordinal); await completeVerification(context, iterations[0]!.candidateVerificationId!, firstCandidate.candidateId, firstCandidate.candidateIdentity, seeded, false); await runWake(context, loop.id, queues);
  iterations = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(repairLoopIteration.ordinal); const secondCandidate = await freezeGeneration(context, iterations[1]!.aiCandidateGenerationId, seeded, 2); await runWake(context, loop.id, queues);
  iterations = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)).orderBy(repairLoopIteration.ordinal); const evidenceId = await completeVerification(context, iterations[1]!.candidateVerificationId!, secondCandidate.candidateId, secondCandidate.candidateIdentity, seeded, true); await runWake(context, loop.id, queues);
  const finished = await getRepairLoop(context.database, seeded.workspaceContext, loop.id); assert.equal(finished?.state, 'verified'); assert.equal(finished?.selectedCandidateId, secondCandidate.candidateId); assert.equal(finished?.selectedVerificationId, iterations[1]!.candidateVerificationId); assert.equal(finished?.selectedEvidenceId, evidenceId); assert.notEqual(finished?.selectedCandidateId, firstCandidate.candidateId);
});

test('restart-style reconciliation resumes after verification creation and evidence persistence', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  await runWake(context, loop.id, queues); const candidate = await freezeGeneration(context, loop.iterations[0]!.aiCandidateGenerationId, seeded, 1);
  const creationWake = await currentWake(context, loop.id); const crashed = await processRepairLoopJob({ id: creationWake, data: { version: 1, repairLoopId: loop.id } } as never, { database: context.database, queues, clock: () => NOW, afterVerificationCreated: async () => { throw new Error('simulated_process_loss'); } });
  assert.equal(crashed.status, 'failed'); assert.equal((await context.database.select().from(candidateVerification)).length, 1);
  await runWake(context, loop.id, queues); const [iteration] = await context.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, loop.id)); await completeVerification(context, iteration!.candidateVerificationId!, candidate.candidateId, candidate.candidateIdentity, seeded, true);
  const evidenceWake = await currentWake(context, loop.id); const evidenceCrash = await processRepairLoopJob({ id: evidenceWake, data: { version: 1, repairLoopId: loop.id } } as never, { database: context.database, queues, clock: () => NOW, afterEvidenceObserved: async () => { throw new Error('simulated_process_loss'); } });
  assert.equal(evidenceCrash.status, 'failed'); assert.equal((await getRepairLoop(context.database, seeded.workspaceContext, loop.id))?.state, 'running');
  assert.equal((await processRepairLoopJob({ id: evidenceWake, data: { version: 1, repairLoopId: loop.id } } as never, { database: context.database, queues, clock: () => NOW })).status, 'completed'); assert.equal((await getRepairLoop(context.database, seeded.workspaceContext, loop.id))?.state, 'verified');
});

test('terminal generation failure and artifact-integrity failure stop closed without iteration 2', async (t) => {
  const firstContext = await createTestContext(); t.after(() => firstContext.client.close()); const first = await createLoop(firstContext); await runWake(firstContext, first.loop.id, first.queues);
  const generationId = first.loop.iterations[0]!.aiCandidateGenerationId;
  await firstContext.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, generationId));
  await firstContext.database.update(aiCandidateGeneration).set({ state: 'failed', failureCode: 'model_protocol_error', completedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, generationId)); await runWake(firstContext, first.loop.id, first.queues);
  const failed = await getRepairLoop(firstContext.database, first.seeded.workspaceContext, first.loop.id); assert.equal(failed?.state, 'failed'); assert.equal(failed?.failureClassification, 'generation_failure'); assert.equal(failed?.iterations[0]?.decision, 'generation_failed'); assert.equal(failed?.iterations.length, 1);

  const secondContext = await createTestContext(); t.after(() => secondContext.client.close()); const second = await createLoop(secondContext); await runWake(secondContext, second.loop.id, second.queues); await freezeGeneration(secondContext, second.loop.iterations[0]!.aiCandidateGenerationId, second.seeded, 1, false); await runWake(secondContext, second.loop.id, second.queues);
  const integrity = await getRepairLoop(secondContext.database, second.seeded.workspaceContext, second.loop.id); assert.equal(integrity?.state, 'failed'); assert.equal(integrity?.failureClassification, 'integrity_failure'); assert.equal(integrity?.iterations[0]?.decision, 'evidence_invalid'); assert.equal(integrity?.iterations.length, 1);
});

test('terminal generation failures retain infrastructure, integrity, and ownership classifications', async (t) => {
  for (const [failureCode, classification] of [
    ['provider_infrastructure_failed', 'infrastructure_failure'],
    ['candidate_generation_authority_mismatch', 'integrity_failure'],
    ['candidate_generation_ownership_lost', 'ownership_failure'],
  ] as const) {
    const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context); await runWake(context, loop.id, queues);
    const generationId = loop.iterations[0]!.aiCandidateGenerationId;
    await context.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, generationId));
    await context.database.update(aiCandidateGeneration).set({ state: 'failed', failureCode, completedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, generationId)); await runWake(context, loop.id, queues);
    const finished = await getRepairLoop(context.database, seeded.workspaceContext, loop.id);
    assert.equal(finished?.state, 'failed'); assert.equal(finished?.failureClassification, classification); assert.equal(finished?.failureCode, failureCode); assert.equal(finished?.iterations.length, 1);
  }
});

test('generation abstention and verification infrastructure exhaustion stop without another iteration', async (t) => {
  const firstContext = await createTestContext(); t.after(() => firstContext.client.close()); const first = await createLoop(firstContext); await runWake(firstContext, first.loop.id, first.queues);
  await firstContext.database.update(aiCandidateGeneration).set({ state: 'generating', generationStartedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.loop.iterations[0]!.aiCandidateGenerationId));
  await firstContext.database.update(aiCandidateGeneration).set({ state: 'abstained', completionReason: 'insufficient_evidence', completedAt: NOW, updatedAt: NOW }).where(eq(aiCandidateGeneration.id, first.loop.iterations[0]!.aiCandidateGenerationId)); await runWake(firstContext, first.loop.id, first.queues);
  assert.equal((await getRepairLoop(firstContext.database, first.seeded.workspaceContext, first.loop.id))?.state, 'abstained');

  const secondContext = await createTestContext(); t.after(() => secondContext.client.close()); const second = await createLoop(secondContext); await runWake(secondContext, second.loop.id, second.queues); const candidate = await freezeGeneration(secondContext, second.loop.iterations[0]!.aiCandidateGenerationId, second.seeded, 1); await runWake(secondContext, second.loop.id, second.queues);
  const [iteration] = await secondContext.database.select().from(repairLoopIteration).where(eq(repairLoopIteration.repairLoopId, second.loop.id));
  await secondContext.database.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: NOW, updatedAt: NOW }).where(eq(candidateVerification.id, iteration!.candidateVerificationId!));
  await secondContext.database.update(candidateVerification).set({ state: 'infrastructure_failed', candidateArtifactIntegrity: 'valid', verificationContract: 'infrastructure_failed', baselineComparison: 'not_comparable', failureCode: 'sandbox_unavailable', completedAt: NOW, updatedAt: NOW }).where(eq(candidateVerification.id, iteration!.candidateVerificationId!)); await runWake(secondContext, second.loop.id, second.queues);
  assert.equal((await getRepairLoop(secondContext.database, second.seeded.workspaceContext, second.loop.id))?.failureClassification, 'infrastructure_failure'); assert.equal((await secondContext.database.select().from(repairLoopIteration)).length, 1);
});

test('repair-loop reconciliation exhaustion becomes a terminal infrastructure failure', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const { seeded, queues, loop } = await createLoop(context);
  const wakeJobId = await currentWake(context, loop.id);
  const brokenQueues = {
    enqueueAiCandidateGeneration: queues.enqueueAiCandidateGeneration.bind(queues),
    enqueueVerification: queues.enqueueVerification.bind(queues),
    enqueueRepairLoop: async () => { throw new Error('controlled_queue_failure'); },
  };
  const result = await processRepairLoopJob({ id: wakeJobId, data: { version: 1, repairLoopId: loop.id }, retryCount: 4, retryLimit: 4 } as never, { database: context.database, queues: brokenQueues, clock: () => NOW });
  assert.equal(result.status, 'completed');
  const finished = await getRepairLoop(context.database, seeded.workspaceContext, loop.id);
  assert.equal(finished?.state, 'failed'); assert.equal(finished?.failureClassification, 'infrastructure_failure');
  assert.equal(finished?.failureCode, 'repair_loop_reconciliation_exhausted'); assert.equal(finished?.iterations[0]?.decision, 'infrastructure_failed');
});

test('feedback is canonical, path-only, and fails closed above 16 KiB', () => {
  const base = { version: 1 as const, provenance: { previousIterationId: randomUUID(), generationId: randomUUID(), candidateId: randomUUID(), candidateIdentity: PROFILE, verificationId: randomUUID(), evidenceId: randomUUID() }, previousCandidate: { files: [{ path: PATH, operation: 'modify' as const }] }, verification: { contract: 'checks_failed', baselineComparison: 'previous_baseline_failure_still_present', objectiveEvidence: 'failed' as const, phases: { install: { status: 'completed', exitCode: 0, timedOut: false }, typecheck: { status: 'completed', exitCode: 0, timedOut: false }, build: { status: 'completed', exitCode: 0, timedOut: false }, test: { status: 'failed', exitCode: 1, timedOut: false } }, safeFailure: { phase: 'test', code: 'npm_command_failed' } }, priorDiagnosis: { summary: 'summary', proposedApproach: 'approach', confidence: 'medium' }, boundaries: { repositoryValues: 'UNTRUSTED_REPOSITORY_DATA' as const, modelValues: 'UNTRUSTED_MODEL_DATA' as const, completeReplacementAgainstOriginalBase: true as const } };
  const built = buildRepairLoopFeedback(base); assert.ok(built.bytes < REPAIR_LOOP_FEEDBACK_MAX_BYTES); assert.doesNotMatch(built.canonical, /resultingContent|stdout|stderr|token|sandbox-/i);
  assert.deepEqual(validateStoredRepairLoopFeedback(built.snapshot, built.hash, built.bytes), built.snapshot);
  const injected = canonicalRecord({ ...built.snapshot, rawStdout: 'untrusted output' }, REPAIR_LOOP_FEEDBACK_MAX_BYTES); assert.throws(() => validateStoredRepairLoopFeedback(injected.snapshot, injected.hash, injected.bytes), /repair_loop_feedback_invalid/);
  assert.throws(() => buildRepairLoopFeedback({ ...base, priorDiagnosis: { ...base.priorDiagnosis, summary: 'x'.repeat(REPAIR_LOOP_FEEDBACK_MAX_BYTES) } }), /canonical_budget_exceeded/);
});

test('repair-loop handlers accept only run intent, derive authority server-side, and isolate workspaces', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const seeded = await seed(context); const queues = new Queues();
  const handlers = createRepairLoopHandlers({ database: context.database, configuration: CONFIGURATION, queues, resolveContext: async () => seeded.workspaceContext });
  const forged = await handlers.start(new Request('http://localhost:3000/api/repair-loops', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ repairRunId: seeded.runId, idempotencyKey: randomUUID(), candidateId: randomUUID(), ordinal: '2' }) }));
  assert.match(forged.headers.get('location') ?? '', /repair_loop_not_eligible/); assert.equal((await context.database.select().from(repairLoop)).length, 0);
  const accepted = await handlers.start(new Request('http://localhost:3000/api/repair-loops', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ repairRunId: seeded.runId, idempotencyKey: randomUUID() }) }));
  assert.equal(accepted.status, 303); const [stored] = await context.database.select().from(repairLoop); assert.ok(stored); const body = await (await handlers.read(new Request('http://localhost'), stored!.id)).text();
  assert.doesNotMatch(body, /private.?key|access.?token|GEMINI_API_KEY|resultingContent|stdout|stderr/i);
  const foreignHandlers = createRepairLoopHandlers({ database: context.database, configuration: CONFIGURATION, queues, resolveContext: async () => owner(randomUUID()) });
  assert.equal((await foreignHandlers.read(new Request('http://localhost'), stored!.id)).status, 404);
});
