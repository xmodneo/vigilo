import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { eq, sql } from 'drizzle-orm';

import { aiCandidateGeneration, aiInvestigation, candidateVerification, executionBudgetGrant, executionBudgetGrantRevocation, executionProfile, externalExecutionEvent, externalExecutionReservation, githubInstallation, investigation, repairCandidate, repairCandidateFile, repairIntent, repairLoop, repairRun, repairRunAttempt, repairRunEvent, repairRunSourceCheckpoint, repository, repositoryBaseline } from '../db/schema.ts';
import { resolveAuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import { computeExecutionProfileIdentity, gitBlobSha } from '../lib/execution-profiles/detector.ts';
import { buildReviewedStagingPlan, REVIEWED_ACCOUNT_LIMITS, type ReviewedStagingInput } from '../lib/external-execution/reviewed-plan.ts';
import { assertReviewedPlanIntegrity, verifyReviewedAuthoritySet } from '../lib/external-execution/reviewed-plan-integrity.ts';
import { resolveReviewedHandoffAvailability } from '../lib/external-execution/reviewed-handoff-availability.ts';
import { assertReviewedHandoffAuthority } from '../lib/external-execution/reviewed-handoff-authority.ts';
import { lockExternalExecution } from '../lib/external-execution/business-fence.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { computeExecutionGrantIdentity } from '../lib/external-execution/identity.ts';
import { vercelTeamProjectIdentity } from '../lib/external-execution/provider-account.ts';
import { processRepairJob } from '../lib/repair-runs/worker.ts';
import { getRepairRun } from '../lib/repair-runs/flow.ts';
import { startRepairLoop } from '../lib/repair-loops/flow.ts';
import { createRepairLoopHandlers } from '../lib/repair-loops/handlers.ts';
import { createInvestigationHandlers } from '../lib/investigations/handlers.ts';
import { createAiInvestigationHandlers } from '../lib/ai-investigations/handlers.ts';
import { createAiCandidateGenerationHandlers } from '../lib/ai-candidate-generations/handlers.ts';
import { createCandidateVerificationHandlers } from '../lib/candidate-verifications/handlers.ts';
import { computeCandidateIdentity, sha256 as candidateSha256 } from '../lib/repair-candidates/identity.ts';
import { processRepairLoopJob } from '../lib/repair-loops/worker.ts';
import { stageReviewedRepairRun } from '../lib/external-execution/reviewed-staging.ts';
import type { AiCandidateGenerationJobPayload, CandidateVerificationJobPayload, RepairJobPayload, RepairLoopJobPayload, TransactionalReviewedBaselineQueue, VigiloTransaction } from '../lib/repair-runs/queue.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const SHA = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);
const HASH = 'c'.repeat(64);
const PACKAGE = '{"name":"app"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const stageOptions = (input: ReviewedStagingInput) => ({ runtimeReleaseSha: RELEASE, configuredProviderAccounts: input.providerAccounts });

class MemoryQueue implements TransactionalReviewedBaselineQueue {
  readonly jobs: RepairJobPayload[] = [];
  async enqueueReviewedBaseline(_transaction: Parameters<TransactionalReviewedBaselineQueue['enqueueReviewedBaseline']>[0], payload: RepairJobPayload) {
    this.jobs.push(payload);
    return payload.repairRunId;
  }
}

class InertLoopQueues {
  readonly generations: AiCandidateGenerationJobPayload[] = [];
  readonly verifications: CandidateVerificationJobPayload[] = [];
  readonly wakes: Array<{ payload: RepairLoopJobPayload; id: string }> = [];
  async enqueueAiCandidateGeneration(_transaction: VigiloTransaction, payload: AiCandidateGenerationJobPayload) {
    this.generations.push(payload); return payload.proposalGenerationId;
  }
  async enqueueVerification(_transaction: VigiloTransaction, payload: CandidateVerificationJobPayload) {
    this.verifications.push(payload); return payload.verificationId;
  }
  async enqueueRepairLoop(_transaction: VigiloTransaction, payload: RepairLoopJobPayload, wakeJobId: string) {
    this.wakes.push({ payload, id: wakeJobId }); return wakeJobId;
  }
}

async function setup(expiryMs = 60 * 60_000) {
  const context = await createTestContext();
  const user = await saveGithubUser(context, 'reviewed-staging');
  const login = await context.testAuth.login({ userId: user.id });
  const actor = await resolveAuthenticatedWorkspace((headers) => context.auth.api.getSession({ headers }), context.database, login.headers);
  const repositoryId = 1411517943;
  const installationId = 159763114;
  await context.database.insert(githubInstallation).values({ installationId, workspaceId: actor.workspace.id, githubAccountId: 1, accountLogin: 'octo', accountType: 'User', status: 'active' });
  await context.database.insert(repository).values({ githubRepositoryId: repositoryId, workspaceId: actor.workspace.id, installationId, ownerId: 1, ownerLogin: 'octo', name: 'fixture', fullName: 'octo/fixture', isPrivate: false, isSelected: true, defaultBranch: 'main' });
  const profileInput = {
    baseCommitSha: SHA, build: { script: 'build' as const, tool: 'npm' as const }, githubRepositoryId: repositoryId,
    install: { operation: 'ci' as const, tool: 'npm' as const }, installationId,
    lockfileType: 'package-lock' as const, nodeMajor: 24 as const,
    packageJsonBlobSha: gitBlobSha(PACKAGE), packageJsonContentSha256: sha256(PACKAGE),
    packageLockBlobSha: gitBlobSha(LOCK), packageLockContentSha256: sha256(LOCK), packageManager: 'npm' as const,
    profileVersion: 2 as const, runtimeFamily: 'node' as const,
    test: { script: 'test' as const, tool: 'npm' as const }, testRunner: 'node-test' as const,
    typecheck: { script: 'typecheck' as const, tool: 'npm' as const }, workspaceId: actor.workspace.id,
  };
  const profileIdentity = computeExecutionProfileIdentity(profileInput);
  await context.database.insert(executionProfile).values({
    githubRepositoryId: repositoryId, workspaceId: actor.workspace.id, installationId, profileIdentity,
    profileVersion: 2, baseCommitSha: SHA, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock',
    installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'node-test',
    packageJsonBlobSha: profileInput.packageJsonBlobSha, packageJsonContentSha256: profileInput.packageJsonContentSha256,
    packageLockBlobSha: profileInput.packageLockBlobSha, packageLockContentSha256: profileInput.packageLockContentSha256, status: 'ready',
  });
  const input: ReviewedStagingInput = {
    kind: 'm77b_repair_v1', repairRunId: randomUUID(), idempotencyKey: randomUUID(), githubRepositoryId: repositoryId,
    installationId, profileIdentity, baseCommitSha: SHA, authorizedReleaseSha: RELEASE,
    objective: 'Investigate the controlled failing test.', expectedSourceIdentity: HASH,
    expiresAt: new Date(Date.now() + expiryMs).toISOString(),
    providerAccounts: { googleProjectId: 'gen-lang-client-0469095642', vercelTeamId: 'team_dQVJwtsj7JcMXmVUYyFgrCzA', vercelProjectId: 'prj_i6HNc531erDzTtCZZJZqIy7vJ3oM' },
  };
  const queue = new MemoryQueue();
  return { context, actor, input, queue };
}

async function setupReviewedBaseline(expiryMs?: number, legacy = false) {
  const staged = await setup(expiryMs);
  const { context, actor, input, queue } = staged;
  const now = new Date();
  if (legacy) {
    await context.database.insert(repairRun).values({ id: input.repairRunId, workspaceId: actor.workspace.id,
      githubRepositoryId: input.githubRepositoryId, installationId: input.installationId,
      profileIdentity: input.profileIdentity, baseCommitSha: input.baseCommitSha,
      idempotencyKey: input.idempotencyKey, state: 'created', createdAt: now, stateChangedAt: now, updatedAt: now });
    await context.database.insert(repairIntent).values({ id: randomUUID(), repairRunId: input.repairRunId,
      workspaceId: actor.workspace.id, objective: input.objective, objectiveHash: sha256(input.objective), createdAt: now });
  } else {
    const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input, now);
    await stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, queue, { ...stageOptions(input), clock: () => now });
  }
  const baselineId = randomUUID();
  const attemptId = randomUUID();
  await context.database.update(repairRun).set({ state: 'baseline_running', baselineStartedAt: now, stateChangedAt: now, updatedAt: now })
    .where(eq(repairRun.id, input.repairRunId));
  await context.database.insert(repairRunAttempt).values({ id: attemptId, repairRunId: input.repairRunId,
    queueJobId: randomUUID(), attemptNumber: 1, expectedBaselineId: baselineId, ownershipToken: randomUUID(),
    state: 'active', claimedAt: now, heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000) });
  await context.database.insert(repositoryBaseline).values({ id: baselineId, workspaceId: actor.workspace.id,
    githubRepositoryId: input.githubRepositoryId, installationId: input.installationId, evidenceVersion: 1,
    profileIdentity: input.profileIdentity, baseCommitSha: input.baseCommitSha, archiveSha256: '3'.repeat(64),
    sandboxName: 'reviewed-loop-baseline', sourceIdentityBefore: input.expectedSourceIdentity,
    sourceIdentityAfter: input.expectedSourceIdentity, sourceUnchanged: true, credentialsExposure: 'absent',
    networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false,
    typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false,
    buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'failed', testExitCode: 1,
    testTimedOut: false, executionOutcome: 'test_failed', overallOutcome: 'test_failed', cleanupStop: 'confirmed',
    cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'npm_command_failed',
    startedAt: now, completedAt: now, durationMs: 1 });
  await context.database.update(repairRunAttempt).set({ state: 'customer_failed', baselineId, leaseExpiresAt: null,
    finishedAt: now, failureClassification: 'customer_baseline_failure', failureCode: 'test_failed' })
    .where(eq(repairRunAttempt.id, attemptId));
  await context.database.update(repairRun).set({ state: 'ready_for_investigation', baselineId,
    baselineOutcome: 'test_failed', failureClassification: 'customer_baseline_failure', failureCode: 'test_failed',
    completedAt: now, stateChangedAt: now, updatedAt: now }).where(eq(repairRun.id, input.repairRunId));
  if (!legacy) await context.database.update(repairRunSourceCheckpoint).set({ baselineId })
    .where(eq(repairRunSourceCheckpoint.repairRunId, input.repairRunId));
  const [intent] = await context.database.select().from(repairIntent).where(eq(repairIntent.repairRunId, input.repairRunId));
  assert.ok(intent);
  return { ...staged, now, baselineId, intent };
}

async function setupReviewedContext(expiryMs?: number, legacy = false) {
  const ready = await setupReviewedBaseline(expiryMs, legacy);
  const { context, actor, input, now, baselineId, intent } = ready;
  const investigationId = randomUUID();
  await context.database.insert(investigation).values({ id: investigationId, repairRunId: input.repairRunId,
    repairIntentId: intent.id, workspaceId: actor.workspace.id, githubRepositoryId: input.githubRepositoryId,
    installationId: input.installationId, baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity,
    baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000,
    maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: '4'.repeat(40),
    indexedPathCount: 1, attemptNumber: 1, completedAt: now, updatedAt: now });
  return { ...ready, investigationId };
}

async function setupReviewedAi(expiryMs?: number, legacy = false) {
  const ready = await setupReviewedContext(expiryMs, legacy);
  const { context, actor, input, now, baselineId, investigationId } = ready;
  const aiId = randomUUID();
  await context.database.insert(aiInvestigation).values({ id: aiId, investigationId, executionOrdinal: 1,
    idempotencyKey: randomUUID(), repairRunId: input.repairRunId, baselineId, workspaceId: actor.workspace.id,
    githubRepositoryId: input.githubRepositoryId, installationId: input.installationId,
    baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity, providerId: 'google',
    modelId: 'gemini-3.1-flash-lite', protocolVersion: 1, state: 'completed', queuedAt: now,
    investigationStartedAt: now, completedAt: now, completionReason: 'model_conclusion',
    conclusionStatus: 'diagnosis_found', summary: 'Bounded diagnosis.',
    suspectedFiles: [{ path: 'src/fix.ts', reason: 'Measured test failure.' }],
    evidenceReferences: [{ kind: 'baseline', reference: baselineId }], proposedApproach: 'Repair the test.',
    confidence: 'medium', updatedAt: now });
  return { ...ready, aiId };
}

async function setupReviewedLoopReplay(expiryMs?: number) {
  const ready = await setupReviewedAi(expiryMs);
  const { context, actor, input, now } = ready;
  const loopQueues = new InertLoopQueues();
  const loop = await startRepairLoop(context.database, actor, input.repairRunId, loopQueues, { clock: () => now, runtimeReleaseSha: RELEASE });
  const wake = async (releaseSha = RELEASE, at = now) => {
    const [current] = await context.database.select().from(repairLoop).where(eq(repairLoop.id, loop.id));
    assert.ok(current?.wakeJobId);
    const runtimeContext = { runtimeReleaseSha: releaseSha };
    return processRepairLoopJob({ id: current.wakeJobId, data: { version: 1, repairLoopId: loop.id } } as never, {
      database: context.database, queues: loopQueues, clock: () => at, ...runtimeContext,
      executionAuthority: new DurableExternalExecutionAuthorizer(context.database, { clock: () => at, runtimeReleaseSha: releaseSha }),
    });
  };
  assert.equal((await wake()).status, 'completed');
  assert.equal((await context.database.select().from(externalExecutionReservation)).length, 1);
  assert.equal(loopQueues.wakes.length, 2);
  return { ...ready, loop, loopQueues, wake };
}

const localConfig = { baseUrl: 'http://localhost:3000' } as never;
const post = (path: string, fields: Record<string, string>) => new Request(`http://localhost:3000${path}`, {
  method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

async function reviewedHandoffCase(phase: 'context' | 'investigation' | 'loop' | 'generation' | 'verification', expiryMs?: number, legacy = false) {
  const ready = phase === 'context' ? await setupReviewedBaseline(expiryMs, legacy)
    : phase === 'investigation' ? await setupReviewedContext(expiryMs, legacy) : await setupReviewedAi(expiryMs, legacy);
  const { context, actor, input } = ready;
  const actorRef = { current: actor };
  const jobs: string[] = [];
  const enqueue = async (_transaction: unknown, payload: { investigationId?: string; aiInvestigationId?: string; proposalGenerationId?: string; verificationId?: string }) => {
    const id = payload.investigationId ?? payload.aiInvestigationId ?? payload.proposalGenerationId ?? payload.verificationId;
    assert.ok(id); jobs.push(id); return id;
  };
  let candidateId = '';
  if (phase === 'verification') {
    const source = ready as Awaited<ReturnType<typeof setupReviewedAi>>;
    candidateId = randomUUID();
    const base = 'export const fixed = false;\n';
    const resultingContent = 'export const fixed = true;\n';
    const blobSha = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0${value}`).digest('hex');
    const file = { path: 'src/fix.ts', operation: 'modify' as const, baseBlobSha: blobSha(base),
      baseContentSha256: candidateSha256(base), resultContentSha256: candidateSha256(resultingContent),
      resultByteLength: Buffer.byteLength(resultingContent), resultingContent };
    const identity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: input.githubRepositoryId,
      baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity, files: [file] });
    await context.database.insert(repairCandidate).values({ id: candidateId, investigationId: source.investigationId,
      repairRunId: input.repairRunId, workspaceId: actor.workspace.id, githubRepositoryId: input.githubRepositoryId,
      installationId: input.installationId, baseCommitSha: input.baseCommitSha, profileIdentity: input.profileIdentity,
      formatVersion: 1, ordinal: 1, proposalKey: randomUUID(), proposalIdentity: '3'.repeat(64),
      state: 'freezing', changedFileCount: 1, totalResultBytes: file.resultByteLength,
      createdAt: source.now, freezingStartedAt: source.now, updatedAt: source.now });
    await context.database.insert(repairCandidateFile).values({ candidateId, ...file });
    await context.database.update(repairCandidate).set({ state: 'frozen', candidateIdentity: identity,
      completedAt: source.now, updatedAt: source.now }).where(eq(repairCandidate.id, candidateId));
  }
  const idempotencyKey = randomUUID();
  const handlers = phase === 'context'
    ? createInvestigationHandlers({ database: context.database, configuration: localConfig, gateway: {} as never,
      queue: { enqueueInvestigation: enqueue } as never, resolveContext: async () => actorRef.current })
    : phase === 'investigation'
      ? createAiInvestigationHandlers({ database: context.database, configuration: localConfig,
        queue: { enqueueAiInvestigation: enqueue } as never, resolveContext: async () => actorRef.current })
      : phase === 'loop'
        ? createRepairLoopHandlers({ database: context.database, configuration: localConfig,
          queues: new InertLoopQueues(), resolveContext: async () => actorRef.current })
        : phase === 'generation'
          ? createAiCandidateGenerationHandlers({ database: context.database, configuration: localConfig,
            queue: { enqueueAiCandidateGeneration: enqueue } as never, resolveContext: async () => actorRef.current })
          : createCandidateVerificationHandlers({ database: context.database, configuration: localConfig,
            queue: { enqueueVerification: enqueue } as never, resolveContext: async () => actorRef.current });
  const request = () => phase === 'context' ? post(`/api/repair-runs/${input.repairRunId}/investigation`, { idempotencyKey })
    : phase === 'investigation' ? post('/api/ai-investigations', { investigationId: (ready as Awaited<ReturnType<typeof setupReviewedContext>>).investigationId, idempotencyKey })
    : phase === 'loop' ? post('/api/repair-loops', { repairRunId: input.repairRunId, idempotencyKey })
    : phase === 'generation' ? post('/api/ai-candidate-generations', { aiInvestigationId: (ready as Awaited<ReturnType<typeof setupReviewedAi>>).aiId, idempotencyKey })
    : post('/api/candidate-verifications', { candidateId });
  const submit = (requestValue: Request) => phase === 'context'
    ? (handlers as ReturnType<typeof createInvestigationHandlers>).create(requestValue, input.repairRunId)
    : (handlers as { start(request: Request): Promise<Response> }).start(requestValue);
  const countRows = async () => phase === 'context' ? (await context.database.select().from(investigation)).length
    : phase === 'investigation' ? (await context.database.select().from(aiInvestigation)).length
    : phase === 'loop' ? (await context.database.select().from(repairLoop)).length
    : phase === 'generation' ? (await context.database.select().from(aiCandidateGeneration)).length
    : (await context.database.select().from(candidateVerification)).length;
  return { context, actor, actorRef, input, jobs, submit, request, countRows };
}

test('each direct owner POST needs current reviewed authority before enqueuing, without general-worker readiness', async (t) => {
  const previous = process.env.VIGILO_RELEASE_SHA;
  process.env.VIGILO_RELEASE_SHA = RELEASE;
  t.after(() => { if (previous === undefined) delete process.env.VIGILO_RELEASE_SHA; else process.env.VIGILO_RELEASE_SHA = previous; });
  for (const phase of ['context', 'investigation', 'loop', 'generation', 'verification'] as const) {
    await t.test(phase, async (t) => {
      const valid = await reviewedHandoffCase(phase); t.after(() => valid.context.client.close());
      const [currentAccount] = await valid.context.database.select().from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.scope, 'account')).limit(1);
      assert.ok(currentAccount);
      await valid.context.database.insert(executionBudgetGrant).values({ ...currentAccount,
        id: randomUUID(), grantIdentity: 'f'.repeat(64), authorizedBy: 'expired-historical-operator',
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      const before = await valid.countRows();
      const first = await valid.submit(valid.request());
      assert.equal(first.status, 303); assert.doesNotMatch(first.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await valid.countRows(), before + 1);
      const repeated = await valid.submit(valid.request());
      assert.equal(repeated.status, 303); assert.equal(await valid.countRows(), before + 1);

      const legacy = await reviewedHandoffCase(phase, undefined, true); t.after(() => legacy.context.client.close());
      assert.ok(await getRepairRun(legacy.context.database, legacy.actor, legacy.input.repairRunId));
      const legacyBefore = await legacy.countRows();
      const legacyResponse = await legacy.submit(legacy.request());
      assert.equal(legacyResponse.status, 303);
      assert.match(legacyResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await legacy.countRows(), legacyBefore);
      assert.equal(legacy.jobs.length, 0);

      const exhausted = await reviewedHandoffCase(phase); t.after(() => exhausted.context.client.close());
      if (phase === 'context') {
        const firstContext = await exhausted.submit(exhausted.request());
        assert.doesNotMatch(firstContext.headers.get('location') ?? '', /[?&]error=/);
      }
      const [parentContext] = await exhausted.context.database.select({ id: investigation.id })
        .from(investigation).where(eq(investigation.repairRunId, exhausted.input.repairRunId)).limit(1);
      assert.ok(parentContext);
      const [baseline] = await exhausted.context.database.select({ id: repositoryBaseline.id })
        .from(repositoryBaseline).where(eq(repositoryBaseline.githubRepositoryId, exhausted.input.githubRepositoryId)).limit(1);
      assert.ok(baseline);
      const existingAi = await exhausted.context.database.select({ id: aiInvestigation.id }).from(aiInvestigation)
        .where(eq(aiInvestigation.repairRunId, exhausted.input.repairRunId));
      const now = new Date();
      await exhausted.context.database.insert(aiInvestigation).values({
        id: randomUUID(), investigationId: parentContext.id, executionOrdinal: existingAi.length + 1,
        idempotencyKey: randomUUID(), repairRunId: exhausted.input.repairRunId, baselineId: baseline.id,
        workspaceId: exhausted.actor.workspace.id, githubRepositoryId: exhausted.input.githubRepositoryId,
        installationId: exhausted.input.installationId, baseCommitSha: exhausted.input.baseCommitSha,
        profileIdentity: exhausted.input.profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite',
        protocolVersion: 1, state: 'failed', queuedAt: now, completedAt: now,
        failureCode: 'execution_budget_exhausted',
      });
      const exhaustedBefore = await exhausted.countRows();
      const jobsBefore = exhausted.jobs.length;
      const exhaustedRequest = phase === 'context'
        ? post(`/api/repair-runs/${exhausted.input.repairRunId}/investigation`, { idempotencyKey: randomUUID() })
        : exhausted.request();
      const exhaustedResponse = await exhausted.submit(exhaustedRequest);
      assert.equal(exhaustedResponse.status, 303);
      if (phase !== 'context') assert.match(exhaustedResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await exhausted.countRows(), exhaustedBefore);
      assert.equal(exhausted.jobs.length, jobsBefore);

      const revoked = await reviewedHandoffCase(phase); t.after(() => revoked.context.client.close());
      const [grant] = await revoked.context.database.select({ id: executionBudgetGrant.id }).from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.operationCategory, 'gemini_investigation')).limit(1);
      assert.ok(grant);
      await revoked.context.database.insert(executionBudgetGrantRevocation).values({
        id: randomUUID(), grantId: grant.id, reasonCode: 'operator_revoked', revokedBy: revoked.actor.user.id,
      });
      const rejectedBefore = await revoked.countRows();
      const rejected = await revoked.submit(revoked.request());
      assert.equal(rejected.status, 303); assert.match(rejected.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await revoked.countRows(), rejectedBefore);
      assert.equal(revoked.jobs.length, 0);

      const wrongRelease = await reviewedHandoffCase(phase); t.after(() => wrongRelease.context.client.close());
      const wrongBefore = await wrongRelease.countRows();
      process.env.VIGILO_RELEASE_SHA = 'd'.repeat(40);
      try {
        const denied = await wrongRelease.submit(wrongRelease.request());
        assert.match(denied.headers.get('location') ?? '', /[?&]error=/);
      } finally { process.env.VIGILO_RELEASE_SHA = RELEASE; }
      assert.equal(await wrongRelease.countRows(), wrongBefore);
      assert.equal(wrongRelease.jobs.length, 0);

      const expired = await reviewedHandoffCase(phase, 2_000); t.after(() => expired.context.client.close());
      const expiresAt = new Date(expired.input.expiresAt).getTime();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 30)));
      const expiredBefore = await expired.countRows();
      const denied = await expired.submit(expired.request());
      assert.match(denied.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await expired.countRows(), expiredBefore);
      assert.equal(expired.jobs.length, 0);

      const foreign = await reviewedHandoffCase(phase); t.after(() => foreign.context.client.close());
      foreign.actorRef.current = { ...foreign.actor, workspace: { ...foreign.actor.workspace, id: randomUUID() } };
      const foreignBefore = await foreign.countRows();
      const foreignResponse = await foreign.submit(foreign.request());
      assert.match(foreignResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await foreign.countRows(), foreignBefore);
      assert.equal(foreign.jobs.length, 0);
      foreign.actorRef.current = { ...foreign.actor, user: { ...foreign.actor.user, id: randomUUID() } };
      const nonOwnerResponse = await foreign.submit(foreign.request());
      assert.match(nonOwnerResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await foreign.countRows(), foreignBefore);

      const extra = await reviewedHandoffCase(phase); t.after(() => extra.context.client.close());
      const [operation] = await extra.context.database.select().from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.operationCategory, 'gemini_investigation')).limit(1);
      assert.ok(operation);
      await extra.context.database.insert(executionBudgetGrant).values({ ...operation,
        id: randomUUID(), grantIdentity: 'f'.repeat(64),
      });
      const extraBefore = await extra.countRows();
      const extraResponse = await extra.submit(extra.request());
      assert.match(extraResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await extra.countRows(), extraBefore);
      assert.equal(extra.jobs.length, 0);

      const missing = await reviewedHandoffCase(phase); t.after(() => missing.context.client.close());
      const [missingGrant] = await missing.context.database.select({ id: executionBudgetGrant.id }).from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.operationCategory, 'gemini_investigation')).limit(1);
      assert.ok(missingGrant);
      // Simulate corruption only in this disposable database; production guards stay intact.
      await missing.context.database.execute(sql`DROP TRIGGER execution_budget_grant_mutation_guard ON execution_budget_grant`);
      await missing.context.database.delete(executionBudgetGrant).where(eq(executionBudgetGrant.id, missingGrant.id));
      const missingBefore = await missing.countRows();
      const missingResponse = await missing.submit(missing.request());
      assert.match(missingResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await missing.countRows(), missingBefore);
      assert.equal(missing.jobs.length, 0);

      const missingAccount = await reviewedHandoffCase(phase); t.after(() => missingAccount.context.client.close());
      const [accountGrant] = await missingAccount.context.database.select({ id: executionBudgetGrant.id }).from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.scope, 'account')).limit(1);
      assert.ok(accountGrant);
      await missingAccount.context.database.execute(sql`DROP TRIGGER execution_budget_grant_mutation_guard ON execution_budget_grant`);
      await missingAccount.context.database.delete(executionBudgetGrant).where(eq(executionBudgetGrant.id, accountGrant.id));
      const missingAccountBefore = await missingAccount.countRows();
      const missingAccountResponse = await missingAccount.submit(missingAccount.request());
      assert.match(missingAccountResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await missingAccount.countRows(), missingAccountBefore);
      assert.equal(missingAccount.jobs.length, 0);

      const missingPlan = await reviewedHandoffCase(phase); t.after(() => missingPlan.context.client.close());
      await missingPlan.context.database.execute(sql`DROP TRIGGER repair_run_source_checkpoint_guard ON repair_run_source_checkpoint`);
      await missingPlan.context.database.delete(repairRunSourceCheckpoint)
        .where(eq(repairRunSourceCheckpoint.repairRunId, missingPlan.input.repairRunId));
      const missingPlanBefore = await missingPlan.countRows();
      const missingPlanResponse = await missingPlan.submit(missingPlan.request());
      assert.match(missingPlanResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await missingPlan.countRows(), missingPlanBefore);

      const missingPair = await reviewedHandoffCase(phase); t.after(() => missingPair.context.client.close());
      await missingPair.context.database.execute(sql`DROP TRIGGER repair_run_source_checkpoint_guard ON repair_run_source_checkpoint`);
      await missingPair.context.database.execute(sql`DROP TRIGGER execution_budget_grant_mutation_guard ON execution_budget_grant`);
      await missingPair.context.database.delete(repairRunSourceCheckpoint)
        .where(eq(repairRunSourceCheckpoint.repairRunId, missingPair.input.repairRunId));
      const [accountToRemove] = await missingPair.context.database.select({ id: executionBudgetGrant.id }).from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.scope, 'account')).limit(1);
      assert.ok(accountToRemove);
      await missingPair.context.database.delete(executionBudgetGrant).where(eq(executionBudgetGrant.id, accountToRemove.id));
      const missingPairBefore = await missingPair.countRows();
      const missingPairResponse = await missingPair.submit(missingPair.request());
      assert.match(missingPairResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await missingPair.countRows(), missingPairBefore);

      const alteredPlan = await reviewedHandoffCase(phase); t.after(() => alteredPlan.context.client.close());
      await alteredPlan.context.database.execute(sql`DROP TRIGGER repair_run_source_checkpoint_guard ON repair_run_source_checkpoint`);
      await alteredPlan.context.database.update(repairRunSourceCheckpoint).set({ planIdentity: 'f'.repeat(64) })
        .where(eq(repairRunSourceCheckpoint.repairRunId, alteredPlan.input.repairRunId));
      const alteredPlanBefore = await alteredPlan.countRows();
      const alteredPlanResponse = await alteredPlan.submit(alteredPlan.request());
      assert.match(alteredPlanResponse.headers.get('location') ?? '', /[?&]error=/);
      assert.equal(await alteredPlan.countRows(), alteredPlanBefore);
    });
  }
});

test('reviewed handoff rechecks PostgreSQL time after admission lock wait', async (t) => {
  const ready = await setupReviewedBaseline(2_000);
  t.after(() => ready.context.client.close());
  await ready.context.database.transaction(async (transaction) => {
    await lockExternalExecution(transaction);
    const expiry = new Date(ready.input.expiresAt).getTime();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry - Date.now() + 30)));
    await assert.rejects(assertReviewedHandoffAuthority(transaction, ready.actor, ready.input.repairRunId, RELEASE),
      /execution_authority_mismatch/);
  });
  assert.equal((await ready.context.database.select().from(investigation)).length, 0);
});

test('combined checkpoint, account, and fingerprint grant loss cannot downgrade a reviewed context POST', async (t) => {
  const previous = process.env.VIGILO_RELEASE_SHA;
  process.env.VIGILO_RELEASE_SHA = RELEASE;
  t.after(() => { if (previous === undefined) delete process.env.VIGILO_RELEASE_SHA; else process.env.VIGILO_RELEASE_SHA = previous; });
  const target = await reviewedHandoffCase('context');
  t.after(() => target.context.client.close());
  // Corruption is possible only in this disposable database after disabling its guards.
  await target.context.database.execute(sql`DROP TRIGGER repair_run_source_checkpoint_guard ON repair_run_source_checkpoint`);
  await target.context.database.execute(sql`DROP TRIGGER execution_budget_grant_mutation_guard ON execution_budget_grant`);
  await target.context.database.delete(repairRunSourceCheckpoint)
    .where(eq(repairRunSourceCheckpoint.repairRunId, target.input.repairRunId));
  const grants = await target.context.database.select({ id: executionBudgetGrant.id, scope: executionBudgetGrant.scope,
    category: executionBudgetGrant.operationCategory }).from(executionBudgetGrant);
  for (const grant of grants.filter((row) => row.scope === 'account' || row.category === 'repair_loop_iteration')) {
    await target.context.database.delete(executionBudgetGrant).where(eq(executionBudgetGrant.id, grant.id));
  }
  const beforeEvents = (await target.context.database.select().from(repairRunEvent)).length;
  const response = await target.submit(target.request());
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') ?? '', /[?&]error=/);
  assert.equal(await target.countRows(), 0);
  assert.equal((await target.context.database.select().from(repairRunEvent)).length, beforeEvents);
  assert.equal(target.jobs.length, 0);
});

test('reviewed staging atomically creates the exact plan and replays without duplicates', async (t) => {
  const { context, actor, input, queue } = await setup();
  t.after(() => context.client.close());
  const identity = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input).planIdentity;
  const first = await stageReviewedRepairRun(context.database, actor, input, identity, queue, stageOptions(input));
  const second = await stageReviewedRepairRun(context.database, actor, input, identity, queue, stageOptions(input));
  assert.deepEqual(second, first);
  assert.equal(queue.jobs.length, 1);
  const runs = await context.database.select().from(repairRun);
  const intents = await context.database.select().from(repairIntent);
  const checkpoints = await context.database.select().from(repairRunSourceCheckpoint);
  const grants = await context.database.select().from(executionBudgetGrant);
  assert.equal(runs.length, 1);
  assert.equal(intents.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.state, 'pending');
  assert.equal(checkpoints[0]?.observedSourceIdentity, null);
  assert.equal(checkpoints[0]?.planIdentity, identity);
  assert.equal(grants.filter((grant) => grant.scope === 'account').length, 1);
  assert.equal(grants.filter((grant) => grant.scope === 'operation').length, 5);
  assert.equal(grants.every((grant) => grant.version === 2), true);
  assert.equal(runs[0]?.id, input.repairRunId);
});

test('reviewed staging rejects a wrong approved plan before durable writes', async (t) => {
  const { context, actor, input, queue } = await setup();
  t.after(() => context.client.close());
  await assert.rejects(stageReviewedRepairRun(context.database, actor, input, 'f'.repeat(64), queue, stageOptions(input)), /reviewed_plan_mismatch/);
  assert.equal((await context.database.select().from(repairRun)).length, 0);
  assert.equal((await context.database.select().from(executionBudgetGrant)).length, 0);
  assert.equal(queue.jobs.length, 0);
});

test('reviewed plan guard rejects missing, extra, replaced, revoked, expired, and mismatched authority', async (t) => {
  const { context, actor, input, queue } = await setup();
  t.after(() => context.client.close());
  const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input);
  await stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, queue, stageOptions(input));
  assert.equal(await assertReviewedPlanIntegrity(context.database, input.repairRunId, RELEASE), true);
  const [run] = await context.database.select().from(repairRun);
  const [intent] = await context.database.select().from(repairIntent);
  const [checkpoint] = await context.database.select().from(repairRunSourceCheckpoint);
  const grants = await context.database.select().from(executionBudgetGrant);
  const operationGrants = grants.filter((grant) => grant.scope === 'operation');
  const accountGrants = grants.filter((grant) => grant.scope === 'account');
  assert.ok(run && intent && checkpoint);
  const base = { run, intent, checkpoint, operationGrants, accountGrants, revokedGrantIds: new Set<string>(), runtimeReleaseSha: RELEASE, now: new Date() };
  verifyReviewedAuthoritySet(base);
  verifyReviewedAuthoritySet({ ...base, accountGrants: [...accountGrants, {
    ...accountGrants[0]!, id: randomUUID(), authorizedBy: 'historical-operator', expiresAt: new Date('2020-01-01T00:00:00.000Z'),
  }] });
  const missing = operationGrants.slice(1);
  const extra = [...operationGrants, { ...operationGrants[0]!, id: randomUUID() }];
  const replacement = [{ ...operationGrants[0]!, id: randomUUID(), grantIdentity: 'f'.repeat(64) }, ...operationGrants.slice(1)];
  for (const changed of [
    { operationGrants: missing }, { operationGrants: extra }, { operationGrants: replacement },
    { revokedGrantIds: new Set([operationGrants[0]!.id]) }, { revokedGrantIds: new Set([accountGrants[0]!.id]) },
    { runtimeReleaseSha: 'd'.repeat(40) }, { now: new Date(input.expiresAt) },
    { checkpoint: { ...checkpoint, planIdentity: 'f'.repeat(64) } },
    { checkpoint: { ...checkpoint, expectedSourceIdentity: 'e'.repeat(64) } },
    { intent: { ...intent, objective: 'A changed objective.' } },
    { accountGrants: [{ ...accountGrants[0]!, maxLogicalRequests: 9 }] },
    { accountGrants: [...accountGrants, { ...accountGrants[0]!, id: randomUUID() }] },
  ]) assert.throws(() => verifyReviewedAuthoritySet({ ...base, ...changed }), /execution_authority_mismatch/);
});

test('per-run reviewed handoff ignores general-worker readiness and rejects stale current authority', async (t) => {
  const { context, actor, input } = await setupReviewedLoopReplay();
  t.after(() => context.client.close());
  const subject = { workspaceId: actor.workspace.id, ownerUserId: actor.user.id, repairRunId: input.repairRunId,
    githubRepositoryId: input.githubRepositoryId, runtimeReleaseSha: RELEASE };
  assert.equal(await resolveReviewedHandoffAvailability(context.database, subject), 'eligible');
  assert.equal(await resolveReviewedHandoffAvailability(context.database, { ...subject, runtimeReleaseSha: 'd'.repeat(40) }), 'ineligible');
  assert.equal(await resolveReviewedHandoffAvailability(context.database, { ...subject, githubRepositoryId: 42 }), 'ineligible');
  assert.equal(await resolveReviewedHandoffAvailability(context.database, { ...subject, ownerUserId: 'wrong-owner' }), 'ineligible');
  const [grant] = await context.database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.operationCategory, 'gemini_investigation'));
  assert.ok(grant);
  await context.database.insert(executionBudgetGrantRevocation).values({
    id: randomUUID(), grantId: grant.id, reasonCode: 'operator_revoked', revokedBy: actor.user.id,
  });
  assert.equal(await resolveReviewedHandoffAvailability(context.database, subject), 'ineligible');
});

test('reviewed staging rolls back every row when queue handoff fails', async (t) => {
  const { context, actor, input } = await setup();
  t.after(() => context.client.close());
  const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input);
  const badQueue: TransactionalReviewedBaselineQueue = { enqueueReviewedBaseline: async () => { throw new Error('injected_job_failure'); } };
  await assert.rejects(stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, badQueue, stageOptions(input)), /injected_job_failure/);
  for (const table of [repairRun, repairIntent, repairRunSourceCheckpoint, executionBudgetGrant] as const)
    assert.equal((await context.database.select().from(table)).length, 0);
});

test('reviewed staging rolls back after each run, checkpoint, account, and operation phase', async (t) => {
  for (const failAt of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { context, actor, input, queue } = await setup();
    t.after(() => context.client.close());
    const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input);
    let calls = 0;
    await assert.rejects(stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, queue, {
      ...stageOptions(input), randomId: () => { calls += 1; if (calls === failAt) throw new Error('injected_phase_failure'); return randomUUID(); },
    }), /injected_phase_failure/);
    assert.equal((await context.database.select().from(repairRun)).length, 0, `run rollback at phase ${failAt}`);
    assert.equal((await context.database.select().from(repairIntent)).length, 0, `intent rollback at phase ${failAt}`);
    assert.equal((await context.database.select().from(repairRunSourceCheckpoint)).length, 0, `checkpoint rollback at phase ${failAt}`);
    assert.equal((await context.database.select().from(executionBudgetGrant)).length, 0, `grant rollback at phase ${failAt}`);
    assert.equal(queue.jobs.length, 0);
  }
});

test('reviewed staging conflicts on same key with different plan and on competing active run', async (t) => {
  const { context, actor, input, queue } = await setup();
  t.after(() => context.client.close());
  const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input);
  await stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, queue, stageOptions(input));
  const changed = { ...input, repairRunId: randomUUID() };
  const changedPlan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, changed);
  await assert.rejects(stageReviewedRepairRun(context.database, actor, changed, changedPlan.planIdentity, queue, stageOptions(input)), /reviewed_staging_conflict/);
  const another = { ...input, repairRunId: randomUUID(), idempotencyKey: randomUUID() };
  const anotherPlan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, another);
  await assert.rejects(stageReviewedRepairRun(context.database, actor, another, anotherPlan.planIdentity, queue, stageOptions(input)), /reviewed_staging_conflict/);
  assert.equal((await context.database.select().from(repairRun)).length, 1);
});

test('supplemental durable grant blocks reservation before any provider transport', async (t) => {
  const { context, actor, input, queue } = await setup();
  t.after(() => context.client.close());
  const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input);
  await stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, queue, stageOptions(input));
  const [baseline] = await context.database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.operationCategory, 'sandbox_baseline'));
  assert.ok(baseline);
  const limits = { logicalRequests: baseline.maxLogicalRequests, providerAttempts: baseline.maxProviderAttempts,
    inputTokens: baseline.maxInputTokens, outputTokens: baseline.maxOutputTokens,
    sandboxIdentities: baseline.maxSandboxIdentities, sandboxRuntimeMs: baseline.maxSandboxRuntimeMs,
    sandboxResourceClass: 'vcpu_1' as const, verificationAttempts: baseline.maxVerificationAttempts,
    repairLoopIterations: baseline.maxRepairLoopIterations, maxConcurrentExternalOperations: baseline.maxConcurrentExternalOperations };
  const authorizedBy = 'supplemental-operator';
  await context.database.insert(executionBudgetGrant).values({ ...baseline, id: randomUUID(), authorizedBy,
    grantIdentity: computeExecutionGrantIdentity({ version: 2, scope: 'operation', workspaceId: baseline.workspaceId,
      repairRunId: baseline.repairRunId, githubRepositoryId: baseline.githubRepositoryId,
      baseCommitSha: baseline.baseCommitSha, operationCategory: 'sandbox_baseline', providerId: 'vercel',
      modelId: null, acceptancePurpose: null, limits, expiresAt: baseline.expiresAt.toISOString(), authorizedBy,
      authorizedReleaseSha: RELEASE, authorizedProviderAccountIdentity: baseline.authorizedProviderAccountIdentity }) });
  let transports = 0;
  const authority = new DurableExternalExecutionAuthorizer(context.database, {
    runtimeReleaseSha: RELEASE, fetch: async () => { transports += 1; return Response.json({ ok: true }); },
  });
  await assert.rejects(authority.reserve({
    scope: { workspaceId: actor.workspace.id, repairRunId: input.repairRunId, githubRepositoryId: input.githubRepositoryId,
      baseCommitSha: input.baseCommitSha, operationCategory: 'sandbox_baseline', providerId: 'vercel' },
    amounts: { logicalRequests: 1, providerAttempts: 1, inputTokens: 0, outputTokens: 0, sandboxIdentities: 1,
      sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1', verificationAttempts: 0, repairLoopIterations: 0 },
    providerAccountIdentity: vercelTeamProjectIdentity(input.providerAccounts.vercelTeamId, input.providerAccounts.vercelProjectId),
    sandbox: { name: 'controlled-test', teamId: input.providerAccounts.vercelTeamId, projectId: input.providerAccounts.vercelProjectId },
  }), /execution_authority_mismatch/);
  assert.equal(transports, 0);
  assert.equal((await context.database.select().from(externalExecutionReservation)).length, 0);
  let baselineCalls = 0;
  const job = { id: input.repairRunId, name: 'repair-baseline-v1',
    data: { version: 1, repairRunId: input.repairRunId }, signal: new AbortController().signal,
    expireInSeconds: 720, heartbeatSeconds: 60 } as never;
  const dependencies = {
    database: context.database, configuration: { appId: 991, appSlug: 'test', clientId: 'Iv1.test', baseUrl: 'http://localhost:3000' },
    gateway: {} as never, logger: { write: () => {} }, runtimeReleaseSha: RELEASE,
    baselineExecutor: (async () => { baselineCalls += 1; throw new Error('must_not_execute'); }) as never,
  };
  const broadOutcome = await processRepairJob(job, dependencies);
  assert.equal(broadOutcome.status, 'deadletter');
  assert.equal(baselineCalls, 0);
  assert.equal((await context.database.select().from(repairRunAttempt)).length, 0);
  const outcome = await processRepairJob(job, { ...dependencies,
    reviewedOneShot: { repairRunId: input.repairRunId, planIdentity: plan.planIdentity } });
  assert.equal(outcome.status, 'completed');
  assert.equal(baselineCalls, 0);
  const [failedRun] = await context.database.select().from(repairRun).where(eq(repairRun.id, input.repairRunId));
  assert.equal(failedRun?.failureCode, 'execution_authority_mismatch');
});

test('a supplemental account inserted after reservation blocks the provider-attempt boundary', async (t) => {
  const { context, actor, input, queue } = await setup();
  t.after(() => context.client.close());
  const plan = buildReviewedStagingPlan({ workspaceId: actor.workspace.id, reviewerUserId: actor.user.id }, input);
  await stageReviewedRepairRun(context.database, actor, input, plan.planIdentity, queue, stageOptions(input));
  let transports = 0;
  const authority = new DurableExternalExecutionAuthorizer(context.database, {
    runtimeReleaseSha: RELEASE, fetch: async () => { transports += 1; return Response.json({ ok: true }); },
  });
  const permit = await authority.reserve({
    scope: { workspaceId: actor.workspace.id, repairRunId: input.repairRunId, githubRepositoryId: input.githubRepositoryId,
      baseCommitSha: input.baseCommitSha, operationCategory: 'sandbox_baseline', providerId: 'vercel' },
    amounts: { logicalRequests: 1, providerAttempts: 1, inputTokens: 0, outputTokens: 0, sandboxIdentities: 1,
      sandboxRuntimeMs: 60_000, sandboxResourceClass: 'vcpu_1', verificationAttempts: 0, repairLoopIterations: 0 },
    providerAccountIdentity: vercelTeamProjectIdentity(input.providerAccounts.vercelTeamId, input.providerAccounts.vercelProjectId),
    sandbox: { name: 'controlled-test', teamId: input.providerAccounts.vercelTeamId, projectId: input.providerAccounts.vercelProjectId },
  });
  const authorizedBy = 'supplemental-operator';
  await context.database.insert(executionBudgetGrant).values({ ...plan.accountGrant, id: randomUUID(), authorizedBy,
    grantIdentity: computeExecutionGrantIdentity({ version: 2, scope: 'account', workspaceId: null,
      repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null,
      providerId: null, modelId: null, acceptancePurpose: null, limits: REVIEWED_ACCOUNT_LIMITS,
      expiresAt: input.expiresAt, authorizedBy, authorizedReleaseSha: null, authorizedProviderAccountIdentity: null }) });
  await assert.rejects(permit.meteredFetch(`https://vercel.com/api/v3/sandboxes?teamId=${input.providerAccounts.vercelTeamId}`, {
    method: 'POST', body: JSON.stringify({ name: 'controlled-test', projectId: input.providerAccounts.vercelProjectId,
      image: 'vercel/sandbox/node:24', persistent: false, timeout: 60_000, resources: { vcpus: 1 } }),
  }), /execution_authority_mismatch/);
  assert.equal(transports, 0);
});

test('repair-loop replay accepts an unchanged complete reviewed plan', async (t) => {
  const { context, loop, loopQueues, wake } = await setupReviewedLoopReplay();
  t.after(() => context.client.close());
  assert.equal((await wake()).status, 'completed');
  const [stored] = await context.database.select().from(repairLoop).where(eq(repairLoop.id, loop.id));
  assert.equal(stored?.state, 'running');
  assert.equal(loopQueues.wakes.length, 3);
  assert.equal(loopQueues.verifications.length, 0);
  assert.equal((await context.database.select().from(externalExecutionReservation)).length, 1);
});

test('repair-loop replay rejects a supplemental operation grant before scheduling downstream work', async (t) => {
  const { context, input, loop, loopQueues, wake } = await setupReviewedLoopReplay();
  t.after(() => context.client.close());
  const [original] = await context.database.select().from(executionBudgetGrant)
    .where(eq(executionBudgetGrant.operationCategory, 'repair_loop_iteration'));
  assert.ok(original);
  const authorizedBy = 'supplemental-operator';
  await context.database.insert(executionBudgetGrant).values({ ...original, id: randomUUID(), authorizedBy,
    grantIdentity: computeExecutionGrantIdentity({ version: 2, scope: 'operation',
      workspaceId: original.workspaceId, repairRunId: original.repairRunId,
      githubRepositoryId: original.githubRepositoryId, baseCommitSha: original.baseCommitSha,
      operationCategory: 'repair_loop_iteration', providerId: 'vigilo', modelId: null, acceptancePurpose: null,
      limits: { logicalRequests: original.maxLogicalRequests, providerAttempts: original.maxProviderAttempts,
        inputTokens: original.maxInputTokens, outputTokens: original.maxOutputTokens,
        sandboxIdentities: original.maxSandboxIdentities, sandboxRuntimeMs: original.maxSandboxRuntimeMs,
        verificationAttempts: original.maxVerificationAttempts, repairLoopIterations: original.maxRepairLoopIterations,
        maxConcurrentExternalOperations: original.maxConcurrentExternalOperations },
      expiresAt: original.expiresAt.toISOString(), authorizedBy, authorizedReleaseSha: RELEASE,
      authorizedProviderAccountIdentity: null }) });
  assert.equal((await wake()).status, 'completed');
  const [stored] = await context.database.select().from(repairLoop).where(eq(repairLoop.id, loop.id));
  assert.equal(stored?.state, 'failed');
  assert.equal(stored?.failureCode, 'execution_authority_mismatch');
  assert.equal(loopQueues.wakes.length, 2);
  assert.equal(loopQueues.verifications.length, 0);
  assert.equal((await context.database.select().from(externalExecutionReservation)).length, 1);
  assert.equal((await context.database.select().from(externalExecutionEvent)
    .where(eq(externalExecutionEvent.eventType, 'attempt_started'))).length, 0);
  assert.equal(input.repairRunId, stored?.repairRunId);
});

test('repair-loop replay rejects a changed runtime release before scheduling downstream work', async (t) => {
  const { context, loop, loopQueues, wake } = await setupReviewedLoopReplay();
  t.after(() => context.client.close());
  assert.equal((await wake('e'.repeat(40))).status, 'completed');
  const [stored] = await context.database.select().from(repairLoop).where(eq(repairLoop.id, loop.id));
  assert.equal(stored?.state, 'failed');
  assert.equal(stored?.failureCode, 'execution_authority_mismatch');
  assert.equal(loopQueues.wakes.length, 2);
  assert.equal(loopQueues.verifications.length, 0);
  assert.equal((await context.database.select().from(externalExecutionReservation)).length, 1);
});

test('repair-loop replay still rejects revoked reviewed grants and expired authority', async (t) => {
  for (const defect of ['revoked', 'expired'] as const) {
    const { context, actor, input, loop, loopQueues, wake } = await setupReviewedLoopReplay(defect === 'expired' ? 20_000 : undefined);
    t.after(() => context.client.close());
    if (defect === 'revoked') {
      const [grant] = await context.database.select().from(executionBudgetGrant)
        .where(eq(executionBudgetGrant.operationCategory, 'repair_loop_iteration'));
      assert.ok(grant);
      await context.database.insert(executionBudgetGrantRevocation).values({ id: randomUUID(), grantId: grant.id,
        reasonCode: 'operator_revoked', revokedBy: actor.user.id });
    }
    if (defect === 'expired') await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Date.parse(input.expiresAt) - Date.now() + 25)));
    assert.equal((await wake(RELEASE)).status, 'completed');
    const [stored] = await context.database.select().from(repairLoop).where(eq(repairLoop.id, loop.id));
    assert.equal(stored?.state, 'failed', defect);
    assert.equal(loopQueues.wakes.length, 2, defect);
    assert.equal(loopQueues.verifications.length, 0, defect);
  }
});
