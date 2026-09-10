import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq, sql } from 'drizzle-orm';

import {
  investigation,
  repairCandidate,
  repairCandidateEvent,
  repairCandidateFile,
  repairIntent,
  repairRun,
  repositoryBaseline,
} from '../db/schema.ts';
import { resolveAuthenticatedWorkspace, type AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import type { GitTreeEntry } from '../lib/investigations/types.ts';
import {
  getRepairCandidate,
  proposeRepairCandidate,
  RepairCandidateError,
  selfCheckRepairCandidate,
} from '../lib/repair-candidates/flow.ts';
import { computeCandidateIdentity } from '../lib/repair-candidates/identity.ts';
import { CANDIDATE_LIMITS, CandidatePolicyError, normalizeCandidateProposal } from '../lib/repair-candidates/policy.ts';
import type { CandidateProposal, CandidateSourceGateway, FrozenCandidateFile } from '../lib/repair-candidates/types.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const PROFILE = 'c'.repeat(64);
const REPOSITORY_ID = 8_101;
const INSTALLATION_ID = 9_001;
const CONFIGURATION: GitHubAppConfiguration = { appId: 991, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' };
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const blobSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

async function authenticated(context: Awaited<ReturnType<typeof createTestContext>>, githubId = randomUUID()): Promise<AuthenticatedWorkspace> {
  const user = await saveGithubUser(context, githubId);
  const login = await context.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace((headers) => context.auth.api.getSession({ headers }), context.database, login.headers);
}

async function readyInvestigation(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace, overrides: { commit?: string; state?: string } = {}) {
  const commit = overrides.commit ?? COMMIT;
  const baselineId = randomUUID();
  await context.database.insert(repositoryBaseline).values({
    id: baselineId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID,
    evidenceVersion: 1, profileIdentity: PROFILE, baseCommitSha: commit, archiveSha256: 'd'.repeat(64), sandboxName: 'candidate-test-sandbox',
    sourceIdentityBefore: 'e'.repeat(64), sourceIdentityAfter: 'e'.repeat(64), sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all',
    installStatus: 'completed', installExitCode: 0, installTimedOut: false, testStatus: 'failed', testExitCode: 1, testTimedOut: false,
    executionOutcome: 'test_failed', overallOutcome: 'test_failed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent',
    errorPhase: 'test', errorCode: 'test_failed', startedAt: NOW, completedAt: NOW, durationMs: 1,
  });
  const runId = randomUUID();
  await context.database.insert(repairRun).values({
    id: runId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID,
    profileIdentity: PROFILE, baseCommitSha: commit, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId,
    baselineOutcome: 'test_failed', failureClassification: 'customer_baseline_failure', failureCode: 'test_failed',
    createdAt: NOW, baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW,
  });
  const intentId = randomUUID();
  const objective = 'Fix the controlled free-shipping threshold boundary.';
  await context.database.insert(repairIntent).values({ id: intentId, repairRunId: runId, workspaceId: owner.workspace.id, objective, objectiveHash: sha256(objective), createdAt: NOW });
  const investigationId = randomUUID();
  await context.database.insert(investigation).values({
    id: investigationId, repairRunId: runId, repairIntentId: intentId, workspaceId: owner.workspace.id,
    githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: commit, profileIdentity: PROFILE,
    baselineId, idempotencyKey: randomUUID(), state: overrides.state ?? 'ready', contextBudgetVersion: 1,
    maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50,
    treeSha: overrides.state === 'failed' ? null : TREE, indexedPathCount: 2, excludedPathCount: 0, treeTruncated: false,
    attemptNumber: 1, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
    ...(overrides.state === 'failed' ? { failureCode: 'context_failed' } : {}),
  });
  return { investigationId, runId };
}

class Gateway implements CandidateSourceGateway {
  readonly calls: Array<{ operation: string; value?: string }> = [];
  readonly blobs = new Map<string, Buffer>();
  entries: GitTreeEntry[] = [];
  commit = COMMIT;
  truncated = false;
  appId = CONFIGURATION.appId;
  suspendedAt: string | null = null;
  revokeFails = false;
  add(path: string, content: string | Buffer, mode: GitTreeEntry['mode'] = '100644') {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = blobSha(bytes);
    this.blobs.set(sha, bytes);
    this.entries.push({ path, mode, type: mode === '160000' ? 'commit' : mode === '040000' ? 'tree' : 'blob', sha, size: ['040000', '160000'].includes(mode) ? null : bytes.byteLength });
    return sha;
  }
  async createInstallationAccessToken(input: { installationId: number; repositoryId: number }) { this.calls.push({ operation: 'token', value: `${input.installationId}:${input.repositoryId}` }); return { accessToken: 'candidate-token-sentinel', repository: { id: input.repositoryId, name: 'vigilo', ownerLogin: 'xmodneo' } }; }
  async getCommitTree(input: { commitSha: string }) { this.calls.push({ operation: 'commit', value: input.commitSha }); return { commitSha: this.commit, treeSha: TREE }; }
  async getTree(input: { treeSha: string }) { this.calls.push({ operation: 'tree', value: input.treeSha }); return { entries: this.entries, truncated: this.truncated }; }
  async getBlob(input: { blobSha: string; maxBytes?: number }) { this.calls.push({ operation: 'blob', value: input.blobSha }); const bytes = this.blobs.get(input.blobSha); if (!bytes || bytes.byteLength > (input.maxBytes ?? 65_536)) throw new Error('blob unavailable'); return { bytes, sha: input.blobSha }; }
  async getInstallation(installationId: number) { this.calls.push({ operation: 'installation', value: String(installationId) }); return { appId: this.appId, appSlug: CONFIGURATION.appSlug, id: installationId, suspendedAt: this.suspendedAt }; }
  async revokeInstallationAccessToken(token: string) { assert.equal(token, 'candidate-token-sentinel'); this.calls.push({ operation: 'revoke' }); if (this.revokeFails) throw new Error('controlled revocation failure'); }
}

function proposal(investigationId: string, file: Partial<CandidateProposal['files'][number]> = {}, proposalKey = randomUUID()): CandidateProposal {
  return {
    proposalKey,
    investigationId,
    files: [{ path: 'src/shipping.ts', operation: 'modify', expectedBaseIdentity: 'f'.repeat(40), resultingContent: Buffer.from('export const fixed = true;\n'), ...file }],
  };
}

async function setup() {
  const context = await createTestContext();
  const owner = await authenticated(context);
  const ready = await readyInvestigation(context, owner);
  const gateway = new Gateway();
  const base = 'export const fixed = false;\n';
  const baseSha = gateway.add('src/shipping.ts', base);
  gateway.add('old.txt', 'remove me\n');
  return { context, owner, ready, gateway, base, baseSha };
}

test('valid modify, add, and delete proposals freeze exact bytes as sequential immutable attempts', async (t) => {
  const value = await setup(); t.after(() => value.context.client.close());
  const [investigationBefore] = await value.context.database.select().from(investigation).where(eq(investigation.id, value.ready.investigationId));
  const [runBefore] = await value.context.database.select().from(repairRun).where(eq(repairRun.id, value.ready.runId));
  const modifiedBytes = Buffer.from('export const fixed = true;\r\n');
  const modified = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha, resultingContent: modifiedBytes }), { clock: () => NOW });
  const added = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { path: 'docs/note.txt', operation: 'add', expectedBaseIdentity: null, resultingContent: Buffer.from('new\n') }), { clock: () => NOW });
  const oldSha = value.gateway.entries.find((entry) => entry.path === 'old.txt')!.sha;
  const deleted = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { path: 'old.txt', operation: 'delete', expectedBaseIdentity: oldSha, resultingContent: null }), { clock: () => NOW });
  assert.deepEqual([modified.state, added.state, deleted.state], ['frozen', 'frozen', 'frozen']);
  assert.deepEqual([modified.ordinal, added.ordinal, deleted.ordinal], [1, 2, 3]);
  assert.equal(modified.investigationId, value.ready.investigationId); assert.equal(modified.repairRunId, value.ready.runId);
  assert.equal(modified.githubRepositoryId, REPOSITORY_ID); assert.equal(modified.baseCommitSha, COMMIT); assert.equal(modified.profileIdentity, PROFILE);
  const [stored] = await value.context.database.select().from(repairCandidateFile).where(eq(repairCandidateFile.candidateId, modified.id));
  assert.equal(stored?.resultingContent, modifiedBytes.toString('utf8'));
  assert.deepEqual(Buffer.from(stored!.resultingContent!, 'utf8'), modifiedBytes);
  assert.equal((await selfCheckRepairCandidate(value.context.database, value.owner, modified.id)).candidateIdentity, modified.candidateIdentity);
  assert.equal((await value.context.database.select().from(repairCandidateFile)).length, 3);
  assert.deepEqual(await value.context.database.select().from(investigation).where(eq(investigation.id, value.ready.investigationId)), [investigationBefore]);
  assert.deepEqual(await value.context.database.select().from(repairRun).where(eq(repairRun.id, value.ready.runId)), [runBefore]);
});

test('candidate identity binds exact immutable authority and canonical changed-file facts only', async () => {
  const file = (path: string, content: string): FrozenCandidateFile => ({ path, operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256(content), resultByteLength: Buffer.byteLength(content), resultingContent: content });
  const first = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, files: [file('b.ts', 'b'), file('a.ts', 'a')] });
  const reordered = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, files: [file('a.ts', 'a'), file('b.ts', 'b')] });
  assert.equal(first, reordered);
  assert.notEqual(first, computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, files: [file('a.ts', 'x'), file('b.ts', 'b')] }));
  assert.notEqual(first, computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID + 1, baseCommitSha: COMMIT, profileIdentity: PROFILE, files: [file('a.ts', 'a'), file('b.ts', 'b')] }));
  assert.notEqual(first, computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: 'd'.repeat(40), profileIdentity: PROFILE, files: [file('a.ts', 'a'), file('b.ts', 'b')] }));
  assert.notEqual(first, computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: 'd'.repeat(64), files: [file('a.ts', 'a'), file('b.ts', 'b')] }));
  assert.equal(first, computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity: PROFILE, files: [file('a.ts', 'a'), file('b.ts', 'b')], createdAt: NOW } as Parameters<typeof computeCandidateIdentity>[0]));
});

test('proposal policy rejects malformed, duplicate, unsafe, protected, binary, and over-budget changes', () => {
  const id = randomUUID();
  for (const bad of [
    { ...proposal(id), files: [] },
    { ...proposal(id), files: Array.from({ length: CANDIDATE_LIMITS.maxChangedFiles + 1 }, (_, index) => ({ path: `src/${index}.ts`, operation: 'add', expectedBaseIdentity: null, resultingContent: Buffer.from('x') })) },
    proposal(id, { path: '../escape' }), proposal(id, { path: '/absolute' }), proposal(id, { path: '.git/config' }), proposal(id, { path: '.env.local' }), proposal(id, { path: 'keys/private.pem' }),
    proposal(id, { path: 'package.json' }), proposal(id, { path: 'package-lock.json' }),
    ...['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].map((path) => proposal(id, { path, operation: 'add', expectedBaseIdentity: null })),
    proposal(id, { path: '.vigilo/evidence.json', operation: 'add', expectedBaseIdentity: null }),
    proposal(id, { path: 'src/cafe\u0301.ts' }),
    proposal(id, { resultingContent: Buffer.from([0, 1, 2]) }), proposal(id, { resultingContent: Buffer.alloc(CANDIDATE_LIMITS.maxFileBytes + 1, 97) }),
    { ...proposal(id), repositoryId: 999 },
    { ...proposal(id), files: [proposal(id).files[0]!, { ...proposal(id).files[0]!, path: 'SRC/SHIPPING.TS' }] },
    { ...proposal(id), files: [
      { path: 'src/new', operation: 'add', expectedBaseIdentity: null, resultingContent: Buffer.from('file') },
      { path: 'src/new/child.ts', operation: 'add', expectedBaseIdentity: null, resultingContent: Buffer.from('child') },
    ] },
  ]) assert.throws(() => normalizeCandidateProposal(bad), CandidatePolicyError);
  const tooLarge = proposal(id, {}, randomUUID());
  tooLarge.files = Array.from({ length: 5 }, (_, index) => ({ path: `src/${index}.txt`, operation: 'add', expectedBaseIdentity: null, resultingContent: Buffer.alloc(110_000, 97) }));
  assert.throws(() => normalizeCandidateProposal(tooLarge), /change_budget_exceeded/);
});

test('base validation uses the frozen commit and rejects missing, mismatched, existing, linked, executable, no-op, and incomplete evidence', async (t) => {
  const cases: Array<{ expected: string; mutate(value: Awaited<ReturnType<typeof setup>>): CandidateProposal }> = [
    { expected: 'base_file_missing', mutate: (v) => proposal(v.ready.investigationId, { path: 'missing.ts', expectedBaseIdentity: 'f'.repeat(40) }) },
    { expected: 'base_file_missing', mutate: (v) => proposal(v.ready.investigationId, { path: 'missing.ts', operation: 'delete', expectedBaseIdentity: 'f'.repeat(40), resultingContent: null }) },
    { expected: 'base_identity_mismatch', mutate: (v) => proposal(v.ready.investigationId, { expectedBaseIdentity: 'f'.repeat(40) }) },
    { expected: 'add_path_already_exists', mutate: (v) => proposal(v.ready.investigationId, { operation: 'add', expectedBaseIdentity: null }) },
    { expected: 'no_effective_change', mutate: (v) => proposal(v.ready.investigationId, { expectedBaseIdentity: v.baseSha, resultingContent: Buffer.from(v.base) }) },
    { expected: 'unsupported_file_type', mutate: (v) => {
      v.gateway.add('blocked-parent', 'regular file');
      return proposal(v.ready.investigationId, { path: 'blocked-parent/child.ts', operation: 'add', expectedBaseIdentity: null });
    } },
  ];
  for (const item of cases) {
    const value = await setup(); t.after(() => value.context.client.close());
    const rejected = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, item.mutate(value));
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.rejectionCode, item.expected); assert.equal(rejected.candidateIdentity, null);
    assert.equal(value.gateway.calls.at(-1)?.operation, 'revoke');
  }
  for (const mode of ['120000', '160000', '100755'] as const) {
    const value = await setup(); t.after(() => value.context.client.close());
    const path = `linked-${mode}`; const sha = value.gateway.add(path, 'value', mode);
    const rejected = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { path, expectedBaseIdentity: sha }));
    assert.equal(rejected.rejectionCode, 'unsupported_file_type');
  }
  const truncated = await setup(); t.after(() => truncated.context.client.close()); truncated.gateway.truncated = true;
  assert.equal((await proposeRepairCandidate(truncated.context.database, truncated.owner, truncated.gateway, CONFIGURATION, proposal(truncated.ready.investigationId, { expectedBaseIdentity: truncated.baseSha }))).rejectionCode, 'source_evidence_incomplete');
  assert.ok(truncated.gateway.calls.some((call) => call.operation === 'commit' && call.value === COMMIT));
});

test('moving main is irrelevant and installation/source loss fail closed after token cleanup', async (t) => {
  const value = await setup(); t.after(() => value.context.client.close());
  const frozen = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha }));
  assert.equal(frozen.baseCommitSha, COMMIT); assert.ok(value.gateway.calls.some((call) => call.operation === 'commit' && call.value === COMMIT));
  const suspended = await setup(); t.after(() => suspended.context.client.close()); suspended.gateway.suspendedAt = NOW.toISOString();
  const rejected = await proposeRepairCandidate(suspended.context.database, suspended.owner, suspended.gateway, CONFIGURATION, proposal(suspended.ready.investigationId, { expectedBaseIdentity: suspended.baseSha }));
  assert.equal(rejected.rejectionCode, 'installation_unavailable'); assert.equal(suspended.gateway.calls.some((call) => call.operation === 'token'), false);

  const revocation = await setup(); t.after(() => revocation.context.client.close()); revocation.gateway.revokeFails = true;
  const unsafe = await proposeRepairCandidate(revocation.context.database, revocation.owner, revocation.gateway, CONFIGURATION, proposal(revocation.ready.investigationId, { expectedBaseIdentity: revocation.baseSha }));
  assert.equal(unsafe.state, 'rejected'); assert.equal(unsafe.rejectionCode, 'infrastructure_failed');
  assert.equal((await revocation.context.database.select().from(repairCandidateFile)).length, 0);
});

test('exact retries and concurrent proposals reuse one candidate while conflicting reuse fails closed', async (t) => {
  const value = await setup(); t.after(() => value.context.client.close());
  const key = randomUUID(); const input = proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha }, key);
  const [first, retry] = await Promise.all([
    proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, input),
    proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, input),
  ]);
  assert.equal(first.id, retry.id); assert.equal((await value.context.database.select().from(repairCandidate)).length, 1);
  assert.equal(value.gateway.calls.filter((call) => call.operation === 'token').length, 1);
  await assert.rejects(proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha, resultingContent: Buffer.from('different\n') }, key)), /proposal_conflict/);
});

test('persisted artifact self-check detects every changed-file and manifest corruption class', async (t) => {
  for (const corruption of ['bytes', 'resultHash', 'path', 'operation', 'baseBlob', 'baseHash', 'byteLength', 'manifest', 'count', 'total'] as const) {
    const value = await setup(); t.after(() => value.context.client.close());
    const frozen = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha, resultingContent: Buffer.from('same-length-output\n') }));
    if (['bytes', 'resultHash', 'path', 'operation', 'baseBlob', 'baseHash', 'byteLength'].includes(corruption)) await value.context.database.execute(sql`drop trigger repair_candidate_file_mutation_guard on repair_candidate_file`);
    else await value.context.database.execute(sql`drop trigger repair_candidate_update_guard on repair_candidate`);
    if (corruption === 'bytes') await value.context.database.update(repairCandidateFile).set({ resultingContent: 'other-text-output!\n' }).where(eq(repairCandidateFile.candidateId, frozen.id));
    if (corruption === 'resultHash') await value.context.database.update(repairCandidateFile).set({ resultContentSha256: '0'.repeat(64) }).where(eq(repairCandidateFile.candidateId, frozen.id));
    if (corruption === 'path') await value.context.database.update(repairCandidateFile).set({ path: 'src/other.ts' }).where(eq(repairCandidateFile.candidateId, frozen.id));
    if (corruption === 'operation') await value.context.database.update(repairCandidateFile).set({ operation: 'add', baseBlobSha: null, baseContentSha256: null }).where(eq(repairCandidateFile.candidateId, frozen.id));
    if (corruption === 'baseBlob') await value.context.database.update(repairCandidateFile).set({ baseBlobSha: '0'.repeat(40) }).where(eq(repairCandidateFile.candidateId, frozen.id));
    if (corruption === 'baseHash') await value.context.database.update(repairCandidateFile).set({ baseContentSha256: '0'.repeat(64) }).where(eq(repairCandidateFile.candidateId, frozen.id));
    if (corruption === 'byteLength') {
      await value.context.database.execute(sql`alter table repair_candidate_file drop constraint repair_candidate_file_facts_check`);
      await value.context.database.update(repairCandidateFile).set({ resultByteLength: 20 }).where(eq(repairCandidateFile.candidateId, frozen.id));
    }
    if (corruption === 'manifest') await value.context.database.update(repairCandidate).set({ candidateIdentity: '0'.repeat(64) }).where(eq(repairCandidate.id, frozen.id));
    if (corruption === 'count') await value.context.database.update(repairCandidate).set({ changedFileCount: 2 }).where(eq(repairCandidate.id, frozen.id));
    if (corruption === 'total') await value.context.database.update(repairCandidate).set({ totalResultBytes: 20 }).where(eq(repairCandidate.id, frozen.id));
    await assert.rejects(selfCheckRepairCandidate(value.context.database, value.owner, frozen.id), RepairCandidateError);
  }
});

test('database guards make frozen candidate bytes, identity bindings, and audit history immutable', async (t) => {
  const value = await setup(); t.after(() => value.context.client.close());
  const frozen = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha }));
  await assert.rejects(value.context.database.insert(repairCandidateFile).values({ candidateId: frozen.id, path: 'src/extra.ts', operation: 'add', baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256('extra'), resultByteLength: 5, resultingContent: 'extra' }));
  await assert.rejects(value.context.database.update(repairCandidateFile).set({ resultingContent: 'tampered\n' }).where(eq(repairCandidateFile.candidateId, frozen.id)));
  await assert.rejects(value.context.database.delete(repairCandidateFile).where(eq(repairCandidateFile.candidateId, frozen.id)));
  await assert.rejects(value.context.database.update(repairCandidate).set({ profileIdentity: '0'.repeat(64) }).where(eq(repairCandidate.id, frozen.id)));
  await assert.rejects(value.context.database.delete(repairCandidate).where(eq(repairCandidate.id, frozen.id)));
  await assert.rejects(value.context.database.update(repairCandidateEvent).set({ changedFileCount: 2 }).where(eq(repairCandidateEvent.candidateId, frozen.id)));
  await assert.rejects(value.context.database.delete(repairCandidateEvent).where(eq(repairCandidateEvent.candidateId, frozen.id)));
  await assert.rejects(value.context.database.delete(investigation).where(eq(investigation.id, value.ready.investigationId)));
  await assert.rejects(value.context.database.delete(repairRun).where(eq(repairRun.id, value.ready.runId)));
  assert.equal((await selfCheckRepairCandidate(value.context.database, value.owner, frozen.id)).candidateIdentity, frozen.candidateIdentity);
});

test('workspace isolation and investigation eligibility derive all authority server-side', async (t) => {
  const value = await setup(); t.after(() => value.context.client.close());
  const outsider = await authenticated(value.context);
  await assert.rejects(proposeRepairCandidate(value.context.database, outsider, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha })), /investigation_not_eligible/);
  const frozen = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha }));
  assert.equal(await getRepairCandidate(value.context.database, outsider, frozen.id), null);
  await assert.rejects(selfCheckRepairCandidate(value.context.database, outsider, frozen.id), /candidate_not_found/);
});

test('candidate persistence and audit contain bounded artifact bytes and metadata but no credentials or base repository', async (t) => {
  const value = await setup(); t.after(() => value.context.client.close());
  value.gateway.add('unrelated-secret.txt', 'base content that must not be copied');
  const frozen = await proposeRepairCandidate(value.context.database, value.owner, value.gateway, CONFIGURATION, proposal(value.ready.investigationId, { expectedBaseIdentity: value.baseSha }));
  const rows = await value.context.database.select().from(repairCandidateFile);
  const events = await value.context.database.select().from(repairCandidateEvent);
  assert.equal(rows.length, 1); assert.deepEqual(events.map((event) => event.eventType), ['created', 'freeze_started', 'frozen']);
  const persisted = JSON.stringify({ candidates: await value.context.database.select().from(repairCandidate), files: rows, events });
  assert.doesNotMatch(persisted, /candidate-token-sentinel|base content that must not be copied|private.?key/i);
  assert.equal(events.every((event) => !Object.keys(event).some((key) => /content|token|credential/i.test(key))), true);
  assert.equal(frozen.changedFileCount, 1);
});

test('Task 3.4 exposes no browser proposal endpoint, repository execution, GitHub write, or mutable candidate service', async () => {
  const implementation = await Promise.all([
    readFile('lib/repair-candidates/flow.ts', 'utf8'),
    readFile('lib/repair-candidates/policy.ts', 'utf8'),
    readFile('lib/repair-candidates/identity.ts', 'utf8'),
  ]).then((files) => files.join('\n'));
  assert.doesNotMatch(implementation, /node:child_process|\b(?:exec|spawn|eval)\s*\(|npm\s+(?:ci|test|run)|writeFile|appendFile|createTree|createBlob|createCommit|updateRef/);
  assert.doesNotMatch(implementation, /updateFrozenCandidate|editCandidate|verifyCandidate/);
  assert.match(implementation, /getCommitTree/); assert.match(implementation, /getTree/); assert.match(implementation, /getBlob/);
  await assert.rejects(readFile('app/api/repair-candidates/route.ts', 'utf8'));
});
