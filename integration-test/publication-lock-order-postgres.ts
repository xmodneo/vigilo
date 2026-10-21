import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { computeCandidateIdentity, sha256 } from '../lib/repair-candidates/identity.ts';
import { prepareGitPublication } from '../lib/repair-publications/git-objects.ts';
import { computePreparedPublicationIdentity } from '../lib/repair-publications/identity.ts';
import { processRepairPublicationJobForTest } from '../lib/repair-publications/testing.ts';
import type { RepairPublicationGateway } from '../lib/repair-publications/types.ts';

const configured = new URL(process.env.DATABASE_URL ?? '');
if (configured.hostname !== '127.0.0.1' || configured.port !== '55433' || configured.pathname !== '/vigilo' ||
    process.env.VIGILO_DISPOSABLE_NATIVE_POSTGRES !== 'true') throw new Error('disposable_database_required');
process.env.NODE_TEST_CONTEXT = '1';
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
const id = () => randomUUID();
const COMMIT = 'a'.repeat(40); const HASH = 'b'.repeat(64);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FILE_CONTENT = 'export const fixed = true;\n';

async function run(kind: 'terminal' | 'published'): Promise<void> {
  const name = `vigilo_publication_lock_${id().replaceAll('-', '')}`;
  const url = new URL(configured); url.pathname = `/${name}`;
  await admin.unsafe(`create database "${name}"`);
  const first = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const second = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const third = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const db1 = drizzle(first, { schema }); const db3 = drizzle(third, { schema });
  try {
    await migrate(db1, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const userId = id(); const workspaceId = id(); const publicationId = id(); const candidateId = id();
    const repoId = 1411517943; const installationId = 159763114;
    const upstream = { repairRunId: id(), repairLoopId: id(), decisionId: id(), verificationId: id(),
      evidenceId: id(), baselineId: id(), intentId: id(), investigationId: id() };
    const file = { path: 'fixed.ts', operation: 'add' as const, baseBlobSha: null, baseContentSha256: null,
      resultContentSha256: sha256(FILE_CONTENT), resultByteLength: Buffer.byteLength(FILE_CONTENT), resultingContent: FILE_CONTENT };
    const candidateIdentity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: repoId,
      baseCommitSha: COMMIT, profileIdentity: HASH, files: [file] });
    const prepared = prepareGitPublication({ baseCommitSha: COMMIT, baseTreeSha: EMPTY_TREE,
      candidateIdentity, committedAt: now, files: [file], profileIdentity: HASH, treeEntries: [] });
    await db1.insert(schema.user).values({ id: userId, name: 'Disposable operator', email: `${userId}@test.invalid` });
    await db1.insert(schema.workspace).values({ id: workspaceId, ownerUserId: userId });
    await db1.insert(schema.githubInstallation).values({ installationId, workspaceId, githubAccountId: 1,
      accountLogin: 'fixture', accountType: 'User', status: 'active' });
    await db1.insert(schema.repository).values({ githubRepositoryId: repoId, workspaceId, installationId,
      ownerId: 1, ownerLogin: 'fixture', name: 'public', fullName: 'fixture/public', defaultBranch: 'main',
      isPrivate: false, isSelected: true });
    // Synthetic upstream IDs are intentionally absent. Only fixture insertion
    // bypasses those FKs; every worker transition below uses normal triggers.
    await first`set session_replication_role = replica`;
    try {
      await db1.insert(schema.repairCandidate).values({ id: candidateId, investigationId: upstream.investigationId,
        repairRunId: upstream.repairRunId, workspaceId, githubRepositoryId: repoId, installationId,
        baseCommitSha: COMMIT, profileIdentity: HASH, formatVersion: 1, ordinal: 1, proposalKey: id(),
        proposalIdentity: HASH, state: 'frozen', candidateIdentity, changedFileCount: 1,
        totalResultBytes: file.resultByteLength, createdAt: now, freezingStartedAt: now, completedAt: now, updatedAt: now });
      await db1.insert(schema.repairCandidateFile).values({ candidateId, ...file });
      const base = {
        id: publicationId, version: 1, workspaceId, requestedByUserId: userId,
        repairRunId: upstream.repairRunId, repairLoopId: upstream.repairLoopId,
        humanReviewDecisionId: upstream.decisionId, humanReviewDecisionIdentity: HASH,
        repairCandidateId: candidateId, candidateIdentity, candidateVerificationId: upstream.verificationId,
        verificationEvidenceId: upstream.evidenceId, verificationEvidenceIdentity: HASH,
        githubRepositoryId: repoId, installationId, baselineId: upstream.baselineId,
        baseCommitSha: COMMIT, profileIdentity: HASH, objectiveContractHash: HASH, objectiveEvidenceHash: HASH,
        repairIntentId: upstream.intentId, repairObjective: 'Fix test', repairObjectiveHash: HASH,
        targetBranch: `vigilo/repair/${HASH}`, pullRequestTitle: 'Draft repair',
        pullRequestBody: `<!-- vigilo-publication:v1:${publicationId} -->`,
        pullRequestBodyHash: sha256(`<!-- vigilo-publication:v1:${publicationId} -->`),
        publicationIntentIdentity: HASH, idempotencyKey: id(), createdAt: now, updatedAt: now,
      };
      await db1.insert(schema.repairPublication).values(kind === 'terminal'
        ? { ...base, state: 'queued', checkpoint: 'reserved' }
        : { ...base, state: 'publishing', checkpoint: 'pr_verified', preparingStartedAt: now,
          publishingStartedAt: now, targetBaseBranch: 'main', expectedBaseTreeSha: EMPTY_TREE,
          expectedTreeSha: prepared.treeSha, expectedCommitSha: prepared.commit.sha,
          preparedPublicationIdentity: computePreparedPublicationIdentity({ publicationIntentIdentity: HASH,
            targetBaseBranch: 'main', expectedBaseTreeSha: EMPTY_TREE, expectedTreeSha: prepared.treeSha,
            expectedCommitSha: prepared.commit.sha }), remoteBranchCommitSha: prepared.commit.sha,
          githubPullRequestId: 7001, githubPullRequestNumber: 17, githubPullRequestNodeId: 'PR_node',
          githubPullRequestUrl: 'https://github.com/fixture/public/pull/17' });
    } finally { await first`set session_replication_role = origin`; }
    const authority = {
      humanReviewDecisionId: upstream.decisionId, humanReviewDecisionIdentity: HASH,
      repairRunId: upstream.repairRunId, repairLoopId: upstream.repairLoopId,
      repairLoopIterationId: id(), aiCandidateGenerationId: id(), repairCandidateId: candidateId,
      candidateIdentity, candidateVerificationId: upstream.verificationId,
      verificationEvidenceId: upstream.evidenceId, verificationEvidenceIdentity: HASH,
      reviewSubjectIdentity: HASH, workspaceId, reviewerUserId: userId, githubRepositoryId: repoId,
      installationId, baselineId: upstream.baselineId, baseCommitSha: COMMIT, profileIdentity: HASH,
      objectiveContractHash: HASH, objectiveEvidenceHash: HASH,
    };
    let entered!: () => void; let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    let finalAuthorityReady = false; let resolverCalls = 0; let externalWrites = 0;
    const pullRequest = { id: 7001, number: 17, nodeId: 'PR_node', url: 'https://github.com/fixture/public/pull/17',
      state: 'open' as const, draft: true, title: 'Draft repair', body: `<!-- vigilo-publication:v1:${publicationId} -->`,
      headRef: `vigilo/repair/${HASH}`, headSha: prepared.commit.sha, baseRef: 'main', baseSha: COMMIT,
      repositoryId: repoId };
    const gateway = {
      getInstallation: async () => ({ id: installationId, appId: 1, appSlug: 'vigilo', suspendedAt: null,
        permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' } }),
      createPublicationAccessToken: async () => ({ accessToken: 'synthetic-token', expiresAt: new Date(Date.now() + 60_000),
        repository: { id: repoId, ownerLogin: 'fixture', name: 'public', fullName: 'fixture/public', defaultBranch: 'main', isPrivate: false } }),
      revokeInstallationAccessToken: async () => { finalAuthorityReady = true; },
      getRepositoryMetadata: async () => ({ id: repoId, ownerLogin: 'fixture', name: 'public', fullName: 'fixture/public', defaultBranch: 'main', isPrivate: false }),
      resolveBranchCommit: async () => COMMIT,
      getBranchCommit: async () => prepared.commit.sha,
      getCommit: async (input: { commitSha: string }) => input.commitSha === COMMIT
        ? { sha: COMMIT, treeSha: EMPTY_TREE, parents: ['0'.repeat(40)], message: 'base',
          author: { name: 'Base', email: 'base@test.invalid', date: now.toISOString() },
          committer: { name: 'Base', email: 'base@test.invalid', date: now.toISOString() } }
        : { sha: prepared.commit.sha, treeSha: prepared.treeSha, parents: [COMMIT],
          message: prepared.commit.message, author: { ...prepared.commit.author, date: prepared.commit.committedAt },
          committer: { ...prepared.commit.author, date: prepared.commit.committedAt } },
      getTree: async () => ({ entries: [], truncated: false }),
      getBlob: async () => { throw new Error('unexpected_base_blob'); },
      getPullRequest: async () => pullRequest,
      createBlob: async () => { externalWrites++; throw new Error('unexpected_external_write'); },
      createTree: async () => { externalWrites++; throw new Error('unexpected_external_write'); },
      createCommit: async () => { externalWrites++; throw new Error('unexpected_external_write'); },
      createBranch: async () => { externalWrites++; throw new Error('unexpected_external_write'); },
      createDraftPullRequest: async () => { externalWrites++; throw new Error('unexpected_external_write'); },
      listPullRequests: async () => { externalWrites++; throw new Error('unexpected_external_write'); },
    } as RepairPublicationGateway;
    const resolver = async () => {
      resolverCalls++;
      if ((kind === 'terminal' && resolverCalls === 1) || (kind === 'published' && finalAuthorityReady)) {
        entered(); await releaseGate;
      }
      return kind === 'terminal' ? { ...authority, candidateIdentity: HASH } : authority;
    };
    const job = { id: publicationId, data: { version: 1, publicationId } } as never;
    const dependencies = { database: db1, configuration: { appId: 1, clientId: 'client', appSlug: 'vigilo', baseUrl: 'https://github.com' },
      gateway, logger: { write() {} } } as const;
    const firstProcess = processRepairPublicationJobForTest(job, dependencies, resolver);
    await Promise.race([enteredGate, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('publication_gate_not_reached')), 5_000))]);
    const [pid] = await first<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assert.ok(pid);
    let unlock!: () => void; let locked!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const lockedGate = new Promise<void>((resolve) => { locked = resolve; });
    const parentLock = second.begin(async (tx) => {
      await tx`select id from repair_publication where id = ${publicationId} for update`;
      locked(); await held;
    });
    try {
      await lockedGate;
      release();
      let blocked = false;
      for (let i = 0; i < 150; i++) {
        const [activity] = await admin<{ blockers: number[] }[]>`select pg_blocking_pids(${pid.pid}) as blockers`;
        if (activity?.blockers.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, 'worker must wait on publication parent');
      const attemptProbe = await third.begin(async (tx) => tx`select id from repair_publication_attempt where publication_id = ${publicationId} for update nowait`);
      assert.equal(attemptProbe.length, 1, 'attempt cannot be locked before publication');
      const contender = processRepairPublicationJobForTest(job, { ...dependencies, database: db3 }, resolver);
      unlock();
      assert.equal((await firstProcess).status, 'completed');
      assert.equal((await contender).status, 'completed');
      const publication = await first`select state, checkpoint from repair_publication where id = ${publicationId}`;
      const attempts = await first`select state from repair_publication_attempt where publication_id = ${publicationId}`;
      assert.equal(publication[0]?.state, kind === 'terminal' ? 'failed' : 'published');
      assert.equal(publication[0]?.checkpoint, kind === 'terminal' ? 'reserved' : 'completed');
      assert.deepEqual(attempts.map((row) => row.state), [kind === 'terminal' ? 'failed' : 'succeeded']);
      assert.equal(externalWrites, 0);
      if (kind === 'published') {
        const stale = await third`
          update repair_publication_attempt set state = 'failed', failure_code = 'stale_worker_recovery', completed_at = clock_timestamp()
          where publication_id = ${publicationId} and state = 'active'
          returning id
        `;
        assert.equal(stale.length, 0, 'a stale fence cannot overwrite published completion');
      }
    } finally { unlock(); await parentLock; }
  } finally {
    await Promise.allSettled([first.end({ timeout: 1 }), second.end({ timeout: 1 }), third.end({ timeout: 1 })]);
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database if exists "${name}"`);
  }
}

try {
  await run('terminal');
  await run('published');
  process.stdout.write(JSON.stringify({ nativePublicationLockOrderScenarios: 2, result: 'passed' }) + '\n');
} finally { await admin.end({ timeout: 1 }); }
