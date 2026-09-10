import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq, sql } from 'drizzle-orm';

import {
  candidateVerification,
  candidateVerificationAttempt,
  candidateVerificationEvidence,
  candidateVerificationEvent,
  executionProfile,
  githubInstallation,
  investigation,
  repairCandidate,
  repairCandidateFile,
  repairIntent,
  repairRun,
  repository,
  repositoryBaseline,
} from '../db/schema.ts';
import { resolveAuthenticatedWorkspace, type AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { compareWithBaseline, trustworthyComparableBaseline, verificationContractFor } from '../lib/candidate-verifications/classification.ts';
import { executeCandidateVerification } from '../lib/candidate-verifications/execution.ts';
import { getCandidateVerification, startCandidateVerification } from '../lib/candidate-verifications/flow.ts';
import { createCandidateVerificationHandlers } from '../lib/candidate-verifications/handlers.ts';
import { expectedCandidateManifest } from '../lib/candidate-verifications/runner.ts';
import type { CandidateVerificationEvidence as VerificationEvidence, CandidateVerificationGateway, FrozenVerificationInput } from '../lib/candidate-verifications/types.ts';
import { processCandidateVerificationJob } from '../lib/candidate-verifications/worker.ts';
import { computeExecutionProfileIdentity } from '../lib/execution-profiles/detector.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import { computeCandidateIdentity, sha256 } from '../lib/repair-candidates/identity.ts';
import type { FrozenCandidateFile } from '../lib/repair-candidates/types.ts';
import { CANDIDATE_VERIFICATION_JOB_VERSION, parseCandidateVerificationJobPayload, type TransactionalCandidateVerificationQueue } from '../lib/repair-runs/queue.ts';
import type { RepairQueueJob } from '../lib/repair-runs/queue.ts';
import type { SourceManifest } from '../lib/repository-baselines/runner.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const REPOSITORY_ID = 81_001;
const INSTALLATION_ID = 91_001;
const CONFIGURATION: GitHubAppConfiguration = { appId: 991, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' };
const PACKAGE_JSON_SHA = 'b'.repeat(40);
const PACKAGE_LOCK_SHA = 'c'.repeat(40);
const PACKAGE_JSON_CONTENT = 'd'.repeat(64);
const PACKAGE_LOCK_CONTENT = 'e'.repeat(64);
const BASE_CONTENT = 'export const fixed = false;\n';
const RESULT_CONTENT = 'export const fixed = true;\n';
const blobSha = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0${value}`).digest('hex');

function profileIdentity(workspaceId: string) {
  return computeExecutionProfileIdentity({
    baseCommitSha: COMMIT, build: { script: 'build', tool: 'npm' }, githubRepositoryId: REPOSITORY_ID,
    install: { operation: 'ci', tool: 'npm' }, installationId: INSTALLATION_ID, lockfileType: 'package-lock', nodeMajor: 24,
    packageJsonBlobSha: PACKAGE_JSON_SHA, packageJsonContentSha256: PACKAGE_JSON_CONTENT,
    packageLockBlobSha: PACKAGE_LOCK_SHA, packageLockContentSha256: PACKAGE_LOCK_CONTENT,
    packageManager: 'npm', profileVersion: 2, runtimeFamily: 'node', test: { script: 'test', tool: 'npm' },
    testRunner: 'vitest', typecheck: { script: 'typecheck', tool: 'npm' }, workspaceId,
  });
}

async function authenticated(context: Awaited<ReturnType<typeof createTestContext>>, id = randomUUID()): Promise<AuthenticatedWorkspace> {
  const user = await saveGithubUser(context, id);
  const login = await context.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace((headers) => context.auth.api.getSession({ headers }), context.database, login.headers);
}

class MemoryQueue implements TransactionalCandidateVerificationQueue {
  payloads: Array<{ version: 1; verificationId: string }> = [];
  async enqueueVerification(_transaction: never, payload: { version: 1; verificationId: string }) { this.payloads.push(payload); return payload.verificationId; }
}

async function seed(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace, baselineOutcome = 'baseline_passed') {
  const profile = profileIdentity(owner.workspace.id);
  await context.database.insert(githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId: owner.workspace.id, githubAccountId: 7, accountLogin: 'owner', accountType: 'User', status: 'active', createdAt: NOW, updatedAt: NOW });
  await context.database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId: owner.workspace.id, installationId: INSTALLATION_ID, ownerId: 7, ownerLogin: 'owner', name: 'repo', fullName: 'owner/repo', defaultBranch: 'main', isPrivate: true, createdAt: NOW, updatedAt: NOW });
  await context.database.insert(executionProfile).values({ githubRepositoryId: REPOSITORY_ID, workspaceId: owner.workspace.id, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity: profile, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: PACKAGE_JSON_SHA, packageJsonContentSha256: PACKAGE_JSON_CONTENT, packageLockBlobSha: PACKAGE_LOCK_SHA, packageLockContentSha256: PACKAGE_LOCK_CONTENT, status: 'ready', createdAt: NOW, updatedAt: NOW });
  const baselineId = randomUUID();
  const passed = baselineOutcome === 'baseline_passed';
  await context.database.insert(repositoryBaseline).values({ id: baselineId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity: profile, baseCommitSha: COMMIT, archiveSha256: 'f'.repeat(64), sandboxName: 'baseline-sandbox', sandboxSessionId: 'baseline-session', sourceIdentityBefore: '1'.repeat(64), sourceIdentityAfter: passed ? '1'.repeat(64) : null, sourceUnchanged: passed ? true : null, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: passed ? 'completed' : 'failed', testExitCode: passed ? 0 : 1, testTimedOut: false, executionOutcome: baselineOutcome, overallOutcome: baselineOutcome, cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: passed ? null : 'test', errorCode: passed ? null : 'npm_command_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  const runId = randomUUID();
  await context.database.insert(repairRun).values({ id: runId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: profile, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId, baselineOutcome, ...(passed ? {} : { failureClassification: 'customer_baseline_failure', failureCode: baselineOutcome }), createdAt: NOW, baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  const intentId = randomUUID();
  await context.database.insert(repairIntent).values({ id: intentId, repairRunId: runId, workspaceId: owner.workspace.id, objective: 'Repair objective', objectiveHash: sha256('Repair objective'), createdAt: NOW });
  const investigationId = randomUUID();
  await context.database.insert(investigation).values({ id: investigationId, repairRunId: runId, repairIntentId: intentId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: profile, baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: '2'.repeat(40), indexedPathCount: 1, excludedPathCount: 0, treeTruncated: false, attemptNumber: 1, completedAt: NOW, createdAt: NOW, updatedAt: NOW });
  const candidateId = randomUUID();
  const file: FrozenCandidateFile = { path: 'src/fix.ts', operation: 'modify', baseBlobSha: blobSha(BASE_CONTENT), baseContentSha256: sha256(BASE_CONTENT), resultContentSha256: sha256(RESULT_CONTENT), resultByteLength: Buffer.byteLength(RESULT_CONTENT), resultingContent: RESULT_CONTENT };
  const identity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: profile, files: [file] });
  await context.database.insert(repairCandidate).values({ id: candidateId, investigationId, repairRunId: runId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: profile, formatVersion: 1, ordinal: 1, proposalKey: randomUUID(), proposalIdentity: '3'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: file.resultByteLength, createdAt: NOW, freezingStartedAt: NOW, updatedAt: NOW });
  await context.database.insert(repairCandidateFile).values({ candidateId, ...file });
  await context.database.update(repairCandidate).set({ state: 'frozen', candidateIdentity: identity, completedAt: NOW, updatedAt: NOW }).where(eq(repairCandidate.id, candidateId));
  return { baselineId, candidateId, candidateIdentity: identity, file, investigationId, profileIdentity: profile, runId };
}

class Gateway implements CandidateVerificationGateway {
  calls: string[] = [];
  async getInstallation(id: number) { this.calls.push(`installation:${id}`); return { id, appId: CONFIGURATION.appId, appSlug: CONFIGURATION.appSlug, suspendedAt: null, account: { id: 7, login: 'owner', type: 'User' as const }, permissions: { contents: 'read' as const, metadata: 'read' as const } }; }
  async createInstallationAccessToken(input: { installationId: number; repositoryId: number }) { this.calls.push(`token:${input.installationId}:${input.repositoryId}`); return { accessToken: 'ephemeral-sentinel', repository: { id: input.repositoryId, ownerId: 7, ownerLogin: 'owner', name: 'repo', fullName: 'owner/repo', defaultBranch: 'main', isPrivate: true } }; }
  async getRepositoryMetadata() { this.calls.push('metadata'); return { id: REPOSITORY_ID, ownerId: 7, ownerLogin: 'owner', name: 'repo', fullName: 'owner/repo', defaultBranch: 'main', isPrivate: true }; }
  async downloadRepositoryArchive(input: { ref: string }) { this.calls.push(`archive:${input.ref}`); return Buffer.from('controlled-archive'); }
  async revokeInstallationAccessToken(token: string) { assert.equal(token, 'ephemeral-sentinel'); this.calls.push('revoke'); }
}

function report(input: FrozenVerificationInput, outcome: VerificationEvidence['executionOutcome'] = 'checks_passed'): VerificationEvidence {
  const contract = verificationContractFor(outcome);
  const command = (status = 'completed') => ({ command: ['npm', 'test'], timeoutMs: 1, status, exitCode: status === 'completed' ? 0 : 1, timedOut: false });
  return { evidenceVersion: 1, verificationId: input.verificationId, attemptId: input.attemptId, evidenceId: input.evidenceId, candidateId: input.candidateId, candidateIdentity: input.candidateIdentity, workspaceId: input.workspaceId, githubRepositoryId: input.githubRepositoryId, installationId: input.installationId, baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity, baselineId: input.baselineId, candidateArtifactIntegrity: 'valid', sandbox: { name: 'fresh-verifier', sessionId: 'fresh-session', runtime: 'vercel/sandbox/node:24', persistent: false }, distinctSandboxConfirmed: true, pristineSourceIdentity: '4'.repeat(64), pristineBaseIntegrity: 'valid', reconstructedSourceIdentity: '5'.repeat(64), candidateReconstruction: 'valid', credentialsExposure: 'absent', networkPolicyBeforeRepositoryExecution: 'deny-all', install: command(), typecheck: command(), build: command(), test: command(contract === 'checks_failed' ? 'failed' : 'completed'), sourceIdentityAfterExecution: '5'.repeat(64), sourceIntegrityUnchanged: true, cleanup: { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' }, executionOutcome: outcome, verificationContract: contract, baselineComparison: compareWithBaseline({ baselineMatches: true, baselineOutcome: input.baselineOutcome, verificationContract: contract }), repairObjectiveEvidence: 'not_measured', error: contract === 'checks_passed' ? null : { phase: 'test', code: 'npm_command_failed' }, startedAt: NOW, completedAt: NOW, durationMs: 1 };
}

const job = (id: string): RepairQueueJob => ({ id, name: 'candidate-verification-v1', data: { version: 1, verificationId: id }, signal: new AbortController().signal, expireInSeconds: 720, heartbeatSeconds: 60 } as RepairQueueJob);
const logger = { write() {} };

test('baseline comparison and contract dimensions remain explicit and never claim semantic repair proof', () => {
  assert.equal(verificationContractFor('checks_passed'), 'checks_passed');
  assert.equal(verificationContractFor('test_failed'), 'checks_failed');
  assert.equal(verificationContractFor('cleanup_failed'), 'infrastructure_failed');
  assert.equal(compareWithBaseline({ baselineMatches: true, baselineOutcome: 'baseline_passed', verificationContract: 'checks_passed' }), 'no_regression_detected');
  assert.equal(compareWithBaseline({ baselineMatches: true, baselineOutcome: 'baseline_passed', verificationContract: 'checks_failed' }), 'regression_detected');
  assert.equal(compareWithBaseline({ baselineMatches: true, baselineOutcome: 'test_failed', verificationContract: 'checks_passed' }), 'previous_baseline_failure_resolved');
  assert.equal(compareWithBaseline({ baselineMatches: true, baselineOutcome: 'test_failed', verificationContract: 'checks_failed' }), 'previous_baseline_failure_still_present');
  assert.equal(compareWithBaseline({ baselineMatches: false, baselineOutcome: 'baseline_passed', verificationContract: 'checks_passed' }), 'not_comparable');
  assert.equal(trustworthyComparableBaseline({ evidenceVersion: 1, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, executionOutcome: 'baseline_passed', overallOutcome: 'baseline_passed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent' }), true);
  assert.equal(trustworthyComparableBaseline({ evidenceVersion: 1, credentialsExposure: 'present', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, executionOutcome: 'baseline_passed', overallOutcome: 'baseline_passed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent' }), false);
});

test('candidate manifest reconstruction supports exact modify, add, and delete and rejects base mismatches', () => {
  const base: SourceManifest = { entries: [
    { path: 'delete.txt', type: 'file', mode: 644, sha256: sha256('delete'), blobSha: blobSha('delete') },
    { path: 'src/fix.ts', type: 'file', mode: 644, sha256: sha256(BASE_CONTENT), blobSha: blobSha(BASE_CONTENT) },
  ], identity: '0'.repeat(64) };
  const files: FrozenCandidateFile[] = [
    { path: 'src/fix.ts', operation: 'modify', baseBlobSha: blobSha(BASE_CONTENT), baseContentSha256: sha256(BASE_CONTENT), resultContentSha256: sha256(RESULT_CONTENT), resultByteLength: Buffer.byteLength(RESULT_CONTENT), resultingContent: RESULT_CONTENT },
    { path: 'added.txt', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256('added'), resultByteLength: 5, resultingContent: 'added' },
    { path: 'delete.txt', operation: 'delete', baseBlobSha: blobSha('delete'), baseContentSha256: sha256('delete'), resultContentSha256: null, resultByteLength: 0, resultingContent: null },
  ];
  const reconstructed = expectedCandidateManifest(base, files);
  assert.deepEqual(reconstructed.entries.map((entry) => entry.path), ['added.txt', 'src/fix.ts']);
  assert.equal(reconstructed.entries[1]?.sha256, sha256(RESULT_CONTENT));
  assert.throws(() => expectedCandidateManifest(base, [{ ...files[0]!, baseContentSha256: '0'.repeat(64) }]));
});

test('only a frozen self-checked candidate queues one durable minimal verification intent idempotently', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const queue = new MemoryQueue();
  const [first, retry] = await Promise.all([startCandidateVerification(context.database, owner, seeded.candidateId, queue), startCandidateVerification(context.database, owner, seeded.candidateId, queue)]);
  assert.equal(first.id, retry.id); assert.equal(queue.payloads.length, 1); assert.deepEqual(Object.keys(queue.payloads[0]!).sort(), ['verificationId', 'version']);
  assert.equal((await context.database.select().from(candidateVerification)).length, 1);
  assert.deepEqual((await context.database.select().from(candidateVerificationEvent)).map((event) => event.toState), ['created', 'queued']);
});

test('non-frozen and corrupted candidates fail before queueing or sandbox execution', async (t) => {
  for (const corruption of ['state', 'bytes', 'hash', 'identity'] as const) {
    const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const queue = new MemoryQueue();
    if (corruption === 'state') { await context.database.execute(sql`drop trigger repair_candidate_update_guard on repair_candidate`); await context.database.update(repairCandidate).set({ state: 'freezing', candidateIdentity: null, completedAt: null }).where(eq(repairCandidate.id, seeded.candidateId)); }
    else if (corruption === 'identity') { await context.database.execute(sql`drop trigger repair_candidate_update_guard on repair_candidate`); await context.database.update(repairCandidate).set({ candidateIdentity: '0'.repeat(64) }).where(eq(repairCandidate.id, seeded.candidateId)); }
    else { await context.database.execute(sql`drop trigger repair_candidate_file_mutation_guard on repair_candidate_file`); await context.database.update(repairCandidateFile).set(corruption === 'bytes' ? { resultingContent: 'x'.repeat(Buffer.byteLength(RESULT_CONTENT)) } : { resultContentSha256: '0'.repeat(64) }).where(eq(repairCandidateFile.candidateId, seeded.candidateId)); }
    await assert.rejects(startCandidateVerification(context.database, owner, seeded.candidateId, queue)); assert.equal(queue.payloads.length, 0);
  }
});

test('verification binds immutable repository, commit, profile, candidate, run, investigation, and baseline authority', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue());
  assert.deepEqual({ repo: verification.githubRepositoryId, commit: verification.baseCommitSha, profile: verification.profileIdentity, candidate: verification.candidateIdentity, run: verification.repairRunId, investigation: verification.investigationId, baseline: verification.baselineId }, { repo: REPOSITORY_ID, commit: COMMIT, profile: seeded.profileIdentity, candidate: seeded.candidateIdentity, run: seeded.runId, investigation: seeded.investigationId, baseline: seeded.baselineId });
});

test('exact-source acquisition uses frozen commit, repository-scoped token, and revokes before sandbox creation', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue()); const gateway = new Gateway();
  let captured!: FrozenVerificationInput;
  await executeCandidateVerification(context.database, gateway, CONFIGURATION, { verificationId: verification.id, attemptId: randomUUID(), evidenceId: randomUUID() }, { runner: async (input) => { captured = input; assert.equal(gateway.calls.at(-1), 'revoke'); return report(input); } });
  assert.deepEqual(gateway.calls, [`installation:${INSTALLATION_ID}`, `token:${INSTALLATION_ID}:${REPOSITORY_ID}`, 'metadata', `archive:${COMMIT}`, 'revoke']);
  assert.equal(captured.baseCommitSha, COMMIT); assert.equal(captured.profile.profileIdentity, seeded.profileIdentity); assert.equal(captured.files[0]?.resultingContent, RESULT_CONTENT);
});

test('missing or untrustworthy baseline evidence fails before source acquisition and cannot become comparable', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); const seeded = await seed(context, owner, 'test_failed');
  await context.database.update(repositoryBaseline).set({ networkPolicy: 'unconfirmed' }).where(eq(repositoryBaseline.id, seeded.baselineId));
  await assert.rejects(startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue()), /verification_authority_mismatch/);

  await context.database.update(repositoryBaseline).set({ networkPolicy: 'deny-all' }).where(eq(repositoryBaseline.id, seeded.baselineId));
  const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue());
  await context.database.update(repositoryBaseline).set({ credentialsExposure: 'present' }).where(eq(repositoryBaseline.id, seeded.baselineId));
  const gateway = new Gateway(); let runnerCalls = 0;
  await assert.rejects(executeCandidateVerification(context.database, gateway, CONFIGURATION, { verificationId: verification.id, attemptId: randomUUID(), evidenceId: randomUUID() }, { runner: async () => { runnerCalls++; throw new Error('must not run'); } }), /verification_authority_mismatch/);
  assert.equal(runnerCalls, 0); assert.equal(gateway.calls.length, 0);
});

test('successful worker execution persists sanitized evidence and completes without mutating the candidate', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue()); const before = await context.database.select().from(repairCandidateFile);
  const executor = async (_db: never, _gateway: never, _config: never, input: { verificationId: string; attemptId: string; evidenceId: string }) => {
    const frozen = { verificationId: input.verificationId, attemptId: input.attemptId, evidenceId: input.evidenceId, candidateId: seeded.candidateId, candidateIdentity: seeded.candidateIdentity, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, baselineId: seeded.baselineId, baselineSandbox: { name: 'baseline-sandbox', sessionId: 'baseline-session' }, baselineOutcome: 'baseline_passed', profile: {} as never, files: [seeded.file], archive: Buffer.alloc(0), archiveSha256: '0'.repeat(64), startedAt: NOW } satisfies FrozenVerificationInput;
    return report(frozen);
  };
  const result = await processCandidateVerificationJob(job(verification.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, executor: executor as never, clock: () => NOW });
  assert.equal(result.status, 'completed'); const stored = await getCandidateVerification(context.database, owner, verification.id);
  assert.equal(stored?.state, 'completed'); assert.equal(stored?.verificationContract, 'checks_passed'); assert.equal(stored?.baselineComparison, 'no_regression_detected'); assert.equal(stored?.repairObjectiveEvidence, 'not_measured');
  assert.deepEqual(await context.database.select().from(repairCandidateFile), before);
  const persisted = JSON.stringify(await context.database.select().from(candidateVerificationEvidence));
  assert.doesNotMatch(persisted, /ephemeral-sentinel|export const fixed|DATABASE_URL|PRIVATE KEY/);
  const [evidence] = await context.database.select().from(candidateVerificationEvidence);
  const [event] = await context.database.select().from(candidateVerificationEvent).where(eq(candidateVerificationEvent.toState, 'completed'));
  assert.ok(evidence); assert.ok(event);
  await assert.rejects(context.database.update(candidateVerification).set({ candidateIdentity: '0'.repeat(64) }).where(eq(candidateVerification.id, verification.id)));
  await assert.rejects(context.database.update(candidateVerificationEvidence).set({ cleanupLookup: 'still_present' }).where(eq(candidateVerificationEvidence.id, evidence.id)));
  await assert.rejects(context.database.delete(candidateVerificationEvent).where(eq(candidateVerificationEvent.id, event.id)));
});

test('customer check failures complete without retry and classify baseline comparison accurately', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue()); let calls = 0;
  const executor = async (_d: never, _g: never, _c: never, input: { verificationId: string; attemptId: string; evidenceId: string }) => { calls++; return report({ ...input, candidateId: seeded.candidateId, candidateIdentity: seeded.candidateIdentity, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, baselineId: seeded.baselineId, baselineSandbox: { name: 'baseline-sandbox', sessionId: null }, baselineOutcome: 'baseline_passed', profile: {} as never, files: [seeded.file], archive: Buffer.alloc(0), archiveSha256: '0'.repeat(64), startedAt: NOW }, 'test_failed'); };
  assert.equal((await processCandidateVerificationJob(job(verification.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, executor: executor as never, clock: () => NOW })).status, 'completed');
  assert.equal(calls, 1); assert.equal((await getCandidateVerification(context.database, owner, verification.id))?.baselineComparison, 'regression_detected');
  assert.equal((await context.database.select().from(candidateVerificationAttempt))[0]?.state, 'checks_failed');
});

test('an explicit re-verification creates new history for the same immutable candidate', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); const seeded = await seed(context, owner);
  const first = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue());
  const executor = async (_d: never, _g: never, _c: never, input: { verificationId: string; attemptId: string; evidenceId: string }) => report({
    ...input, candidateId: seeded.candidateId, candidateIdentity: seeded.candidateIdentity, workspaceId: owner.workspace.id,
    githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT,
    profileIdentity: seeded.profileIdentity, baselineId: seeded.baselineId,
    baselineSandbox: { name: 'baseline-sandbox', sessionId: 'baseline-session' }, baselineOutcome: 'baseline_passed',
    profile: {} as never, files: [seeded.file], archive: Buffer.alloc(0), archiveSha256: '0'.repeat(64), startedAt: NOW,
  }, 'test_failed');
  await processCandidateVerificationJob(job(first.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, executor: executor as never, clock: () => NOW });
  const [oldEvidence] = await context.database.select().from(candidateVerificationEvidence);
  assert.ok(oldEvidence);

  const queue = new MemoryQueue();
  const second = await startCandidateVerification(context.database, owner, seeded.candidateId, queue, {
    reverify: true, clock: () => new Date(NOW.getTime() + 1),
  });
  assert.notEqual(second.id, first.id);
  assert.equal(queue.payloads.length, 1);
  assert.equal((await context.database.select().from(candidateVerification)).length, 2);
  assert.equal((await context.database.select().from(candidateVerificationEvidence)).length, 1);
  assert.equal((await getCandidateVerification(context.database, owner, first.id))?.evidenceId, oldEvidence.id);
});

test('duplicate delivery has one owner and a stale worker cannot persist evidence', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue()); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor = async () => { entered(); await gate; throw new Error('controlled'); };
  const first = processCandidateVerificationJob(job(verification.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, executor: executor as never, clock: () => NOW });
  await started; const duplicate = await processCandidateVerificationJob(job(verification.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, executor: executor as never, clock: () => NOW });
  assert.deepEqual(duplicate.output, { code: 'active_verification_attempt' }); const [attempt] = await context.database.select().from(candidateVerificationAttempt); await context.database.update(candidateVerificationAttempt).set({ ownershipToken: randomUUID() }).where(eq(candidateVerificationAttempt.id, attempt!.id)); release();
  assert.deepEqual((await first).output, { code: 'verification_ownership_lost' }); assert.equal((await context.database.select().from(candidateVerificationEvidence)).length, 0);
});

test('transient infrastructure failure retries at most three times while check failures do not', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue());
  const executor = async () => { throw Object.assign(new Error('controlled'), { code: 'source_unavailable' }); };
  for (let attempt = 1; attempt <= 3; attempt++) assert.equal((await processCandidateVerificationJob(job(verification.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, executor: executor as never, clock: () => new Date(NOW.getTime() + attempt) })).status, attempt < 3 ? 'failed' : 'completed');
  assert.equal((await getCandidateVerification(context.database, owner, verification.id))?.state, 'infrastructure_failed'); assert.equal((await context.database.select().from(candidateVerificationAttempt)).length, 3);
});

test('evidence persisted before process loss is reconciled after lease expiry without rerunning candidate code', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close());
  const owner = await authenticated(context); const seeded = await seed(context, owner);
  const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue());
  let calls = 0;
  const executor = async (_d: never, _g: never, _c: never, identifiers: { verificationId: string; attemptId: string; evidenceId: string }) => {
    calls += 1;
    return report({ ...identifiers, candidateId: seeded.candidateId, candidateIdentity: seeded.candidateIdentity, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: seeded.profileIdentity, baselineId: seeded.baselineId, baselineSandbox: { name: 'baseline-sandbox', sessionId: 'baseline-session' }, baselineOutcome: 'baseline_passed', profile: {} as never, files: [seeded.file], archive: Buffer.alloc(0), archiveSha256: '0'.repeat(64), startedAt: NOW });
  };
  const interrupted = await processCandidateVerificationJob(job(verification.id), {
    configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger,
    executor: executor as never, clock: () => NOW, afterEvidencePersisted: async () => { throw new Error('simulated_process_loss'); },
  });
  assert.deepEqual(interrupted.output, { code: 'verification_reconciliation_pending' });
  const [attempt] = await context.database.select().from(candidateVerificationAttempt);
  assert.ok(attempt);
  await context.database.update(candidateVerificationAttempt).set({ leaseExpiresAt: new Date(NOW.getTime() - 1) }).where(eq(candidateVerificationAttempt.id, attempt.id));
  const reconciled = await processCandidateVerificationJob(job(verification.id), {
    configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger,
    executor: (async () => { throw new Error('must_not_rerun'); }) as never, clock: () => new Date(NOW.getTime() + 1),
  });
  assert.equal(reconciled.status, 'completed');
  assert.equal(calls, 1);
  assert.equal((await getCandidateVerification(context.database, owner, verification.id))?.state, 'completed');
});

test('stale attempt cleanup precedes replacement and unconfirmed cleanup blocks execution', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const seeded = await seed(context, owner); const verification = await startCandidateVerification(context.database, owner, seeded.candidateId, new MemoryQueue());
  await context.database.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: NOW }).where(eq(candidateVerification.id, verification.id));
  await context.database.insert(candidateVerificationAttempt).values({ id: randomUUID(), verificationId: verification.id, queueJobId: verification.id, attemptNumber: 1, expectedEvidenceId: randomUUID(), ownershipToken: randomUUID(), state: 'active', claimedAt: NOW, heartbeatAt: NOW, leaseExpiresAt: new Date(NOW.getTime() - 1), sandboxName: 'orphan-verifier', sandboxSessionId: 'orphan-session' });
  const recovered: string[] = [];
  const first = await processCandidateVerificationJob(job(verification.id), { configuration: CONFIGURATION, database: context.database, gateway: new Gateway(), logger, clock: () => new Date(NOW.getTime() + 1), recover: async (identity) => { recovered.push(`${identity.name}:${identity.sessionId}`); return { stop: 'confirmed', delete: 'confirmed', lookup: 'absent', errors: [] }; } });
  assert.equal(first.status, 'failed'); assert.deepEqual(recovered, ['orphan-verifier:orphan-session']);
  const secondContext = await createTestContext(); t.after(() => secondContext.client.close()); const secondOwner = await authenticated(secondContext); const secondSeed = await seed(secondContext, secondOwner); const secondVerification = await startCandidateVerification(secondContext.database, secondOwner, secondSeed.candidateId, new MemoryQueue());
  await secondContext.database.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: NOW }).where(eq(candidateVerification.id, secondVerification.id));
  await secondContext.database.insert(candidateVerificationAttempt).values({ id: randomUUID(), verificationId: secondVerification.id, queueJobId: secondVerification.id, attemptNumber: 1, expectedEvidenceId: randomUUID(), ownershipToken: randomUUID(), state: 'active', claimedAt: NOW, heartbeatAt: NOW, leaseExpiresAt: new Date(NOW.getTime() - 1), sandboxName: 'unresolved-verifier' });
  let calls = 0;
  const blocked = await processCandidateVerificationJob(job(secondVerification.id), { configuration: CONFIGURATION, database: secondContext.database, gateway: new Gateway(), logger, executor: (async () => { calls++; throw new Error('must not execute'); }) as never, clock: () => new Date(NOW.getTime() + 1), recover: async () => ({ stop: 'failed', delete: 'failed', lookup: 'still_present', errors: [] }) });
  assert.deepEqual(blocked.output, { code: 'orphan_cleanup_unconfirmed' }); assert.equal(calls, 0);
});

test('workspace-scoped API accepts only candidate intent and durable polling survives reload', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); const outsider = await authenticated(context); const seeded = await seed(context, owner); const queue = new MemoryQueue();
  const handlers = createCandidateVerificationHandlers({ configuration: CONFIGURATION, database: context.database, queue, resolveContext: async () => owner });
  const response = await handlers.start(new Request('http://localhost:3000/api/candidate-verifications', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ candidateId: seeded.candidateId }) }));
  assert.equal(response.status, 303); const id = queue.payloads[0]!.verificationId; assert.equal((await handlers.read(new Request('http://localhost'), id)).status, 200);
  const outside = createCandidateVerificationHandlers({ configuration: CONFIGURATION, database: context.database, queue, resolveContext: async () => outsider });
  assert.equal((await outside.read(new Request('http://localhost'), id)).status, 404);
  const forged = await handlers.start(new Request('http://localhost', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ candidateId: seeded.candidateId, command: 'npm run arbitrary' }) })); assert.match(forged.headers.get('location') ?? '', /candidate_not_found/);
});

test('job payload parser rejects browser or queue supplied commands and authority', () => {
  const id = randomUUID(); assert.deepEqual(parseCandidateVerificationJobPayload({ version: CANDIDATE_VERIFICATION_JOB_VERSION, verificationId: id }), { version: 1, verificationId: id });
  for (const value of [{ version: 1, verificationId: id, command: 'npm run arbitrary' }, { version: 1, verificationId: id, baseCommitSha: COMMIT }, { version: 2, verificationId: id }]) assert.throws(() => parseCandidateVerificationJobPayload(value));
});

test('verification implementation contains no AI, Git write, patch authority, shell interpolation, or candidate-byte evidence fields', async () => {
  const sources = await Promise.all(['lib/candidate-verifications/runner.ts', 'lib/candidate-verifications/execution.ts', 'lib/candidate-verifications/worker.ts', 'lib/candidate-verifications/flow.ts'].map((path) => readFile(path, 'utf8'))).then((values) => values.join('\n'));
  assert.doesNotMatch(sources, /createBranch|createCommit|createPullRequest|updateRef|git\s+(?:commit|push|checkout)|openai|anthropic|model\.generate|fixtures\/repairs|\.patch/);
  assert.doesNotMatch(await readFile('db/schema.ts', 'utf8'), /candidate_verification_evidence[\s\S]{0,4000}(resulting_content|source_archive|stdout|stderr|environment)/);
  assert.match(sources, /acquireExactRepositoryArchive/); assert.match(sources, /materializeRepositoryArchive/); assert.match(sources, /REPOSITORY_INSTALL_ARGS/); assert.match(sources, /boundary\.denyAll/);
});
