import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { processAiInvestigationJob } from '../lib/ai-investigations/worker.ts';
import { processAiCandidateGenerationJob } from '../lib/ai-candidate-generations/worker.ts';

const configured = new URL(process.env.DATABASE_URL ?? '');
if (configured.hostname !== '127.0.0.1' || configured.port !== '55433' || configured.pathname !== '/vigilo' ||
    process.env.VIGILO_DISPOSABLE_NATIVE_POSTGRES !== 'true') throw new Error('disposable_database_required');
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
const id = () => randomUUID();
const COMMIT = 'a'.repeat(40); const HASH = 'b'.repeat(64);

async function run(kind: 'investigation' | 'generation'): Promise<void> {
  const name = `vigilo_ai_lock_${id().replaceAll('-', '')}`;
  const url = new URL(configured); url.pathname = `/${name}`;
  await admin.unsafe(`create database "${name}"`);
  const first = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const second = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const third = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const db1 = drizzle(first, { schema });
  const db3 = drizzle(third, { schema });
  try {
    await migrate(db1, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    const ownerId = id(); const workspaceId = id(); const repositoryId = 1411517943;
    const installationId = 159763114; const aiId = id(); const generationId = id();
    const upstream = { investigationId: id(), repairRunId: id(), baselineId: id() };
    const now = new Date();
    await db1.insert(schema.user).values({ id: ownerId, name: 'Disposable operator', email: `${ownerId}@test.invalid` });
    await db1.insert(schema.workspace).values({ id: workspaceId, ownerUserId: ownerId });
    await db1.insert(schema.githubInstallation).values({ installationId, workspaceId, githubAccountId: 1,
      accountLogin: 'fixture', accountType: 'User', status: 'active' });
    await db1.insert(schema.repository).values({ githubRepositoryId: repositoryId, workspaceId, installationId,
      ownerId: 1, ownerLogin: 'fixture', name: 'public', fullName: 'fixture/public', defaultBranch: 'main',
      isPrivate: false, isSelected: true });
    // Only this synthetic fixture omits unrelated upstream domain rows. Real
    // completion/reclaim transactions below run with normal FK/trigger behavior.
    await first`set session_replication_role = replica`;
    try {
      await db1.insert(schema.aiInvestigation).values({ id: aiId, investigationId: upstream.investigationId,
        executionOrdinal: 1, idempotencyKey: id(), repairRunId: upstream.repairRunId,
        baselineId: upstream.baselineId, workspaceId, githubRepositoryId: repositoryId, installationId,
        baseCommitSha: COMMIT, profileIdentity: HASH, providerId: 'google', modelId: 'gemini-3.1-flash-lite',
        protocolVersion: 1, state: kind === 'investigation' ? 'queued' : 'completed', queuedAt: now,
        ...(kind === 'generation' ? { investigationStartedAt: now, completedAt: now,
          completionReason: 'budget_exhausted', conclusionStatus: 'diagnosis_found', summary: 'Synthetic fixture.',
          suspectedFiles: [{ path: 'src/test.ts', reason: 'Synthetic.' }], evidenceReferences: [],
          proposedApproach: 'Review.', confidence: 'low' } : {}) });
      if (kind === 'generation') await db1.insert(schema.aiCandidateGeneration).values({
        id: generationId, aiInvestigationId: aiId, investigationId: upstream.investigationId,
        repairRunId: upstream.repairRunId, baselineId: upstream.baselineId, workspaceId,
        githubRepositoryId: repositoryId, installationId, baseCommitSha: COMMIT, profileIdentity: HASH,
        providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 3,
        executionOrdinal: 1, idempotencyKey: id(), state: 'queued', queuedAt: now,
      });
    } finally { await first`set session_replication_role = origin`; }
    const subjectId = kind === 'investigation' ? aiId : generationId;
    const parentTable = kind === 'investigation' ? 'ai_investigation' : 'ai_candidate_generation';
    const attemptTable = kind === 'investigation' ? 'ai_investigation_attempt' : 'ai_candidate_generation_attempt';
    const job = kind === 'investigation'
      ? { id: subjectId, data: { version: 1, aiInvestigationId: subjectId }, signal: new AbortController().signal }
      : { id: subjectId, data: { version: 1, proposalGenerationId: subjectId }, signal: new AbortController().signal };
    let entered!: () => void; let releaseExecution!: () => void;
    const executing = new Promise<void>((resolve) => { entered = resolve; });
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let providerCalls = 0;
    const common = { gateway: {} as never, configuration: {} as never,
      createProvider: () => { providerCalls++; return { providerId: 'google', modelId: 'gemini-3.1-flash-lite' } as never; } };
    const executeFirst = kind === 'investigation'
      ? processAiInvestigationJob(job as never, { ...common, database: db1,
        executor: (async () => { entered(); await executionGate; return { completionReason: 'budget_exhausted',
          conclusion: { status: 'insufficient_evidence', summary: 'Synthetic conclusion.', suspectedFiles: [],
            evidence: [], proposedApproach: 'Review.', confidence: 'low' },
          usage: { inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 1 } }; }) as never })
      : processAiCandidateGenerationJob(job as never, { ...common, database: db1,
        executor: (async () => { entered(); await executionGate; return { result: { status: 'insufficient_evidence' },
          usage: { inputTokens: 0, outputTokens: 0, toolCallCount: 0, modelTurnCount: 1 } }; }) as never });
    await Promise.race([executing, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ai_executor_not_reached')), 5_000))]);
    // Query the dedicated first pool before completion starts; it has max=1.
    const [pid] = await first<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assert.ok(pid);
    let releaseParent!: () => void; let parentLocked!: () => void;
    const parentHeld = new Promise<void>((resolve) => { releaseParent = resolve; });
    const locked = new Promise<void>((resolve) => { parentLocked = resolve; });
    const parentLock = second.begin(async (tx) => {
      await tx.unsafe(`select id from ${parentTable} where id = $1 for update`, [subjectId]);
      parentLocked(); await parentHeld;
    });
    try {
      await locked;
      releaseExecution();
      let blocked = false;
      for (let i = 0; i < 150; i++) {
        const [activity] = await admin<{ blockers: number[] }[]>`select pg_blocking_pids(${pid.pid}) as blockers`;
        if (activity?.blockers.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, 'completion must wait on the parent row');
      // Old attempt-first completion fails this NOWAIT probe with 55P03.
      const probe = await third.begin(async (tx) => tx.unsafe(`select id from ${attemptTable} where ${kind === 'investigation' ? 'ai_investigation_id' : 'generation_id'} = $1 for update nowait`, [subjectId]));
      assert.equal(probe.length, 1, 'completion may not hold the attempt while waiting for its parent');
      const contender = kind === 'investigation'
        ? processAiInvestigationJob(job as never, { ...common, database: db3, executor: (async () => { throw new Error('duplicate_provider_call'); }) as never })
        : processAiCandidateGenerationJob(job as never, { ...common, database: db3, executor: (async () => { throw new Error('duplicate_provider_call'); }) as never });
      releaseParent();
      assert.equal((await executeFirst).status, 'completed');
      assert.equal((await contender).status, 'completed');
      assert.equal(providerCalls, 1);
      const attempts = await first.unsafe(`select state from ${attemptTable} where ${kind === 'investigation' ? 'ai_investigation_id' : 'generation_id'} = $1`, [subjectId]);
      assert.deepEqual(attempts.map((row) => row.state), ['succeeded']);
      const parent = await first.unsafe(`select state from ${parentTable} where id = $1`, [subjectId]);
      assert.equal(parent[0]?.state, kind === 'investigation' ? 'completed' : 'abstained');
    } finally { releaseParent(); await parentLock; }
    // Confirm no creation of a second durable provider attempt.
    if (kind === 'investigation') assert.equal((await db1.select().from(schema.aiInvestigationAttempt).where(eq(schema.aiInvestigationAttempt.aiInvestigationId, aiId))).length, 1);
    else assert.equal((await db1.select().from(schema.aiCandidateGenerationAttempt).where(eq(schema.aiCandidateGenerationAttempt.generationId, generationId))).length, 1);
  } finally {
    await Promise.allSettled([first.end({ timeout: 1 }), second.end({ timeout: 1 }), third.end({ timeout: 1 })]);
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database if exists "${name}"`);
  }
}

try {
  await run('investigation');
  await run('generation');
  process.stdout.write(JSON.stringify({ nativeAiLockOrderScenarios: 2, result: 'passed' }) + '\n');
} finally { await admin.end({ timeout: 1 }); }
