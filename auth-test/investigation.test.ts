import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import {
  executionProfile,
  githubInstallation,
  investigation,
  investigationContextEntry,
  investigationContextEvent,
  repairIntent,
  repairRun,
  repository,
  repositoryBaseline,
} from '../db/schema.ts';
import { resolveAuthenticatedWorkspace, type AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { computeExecutionProfileIdentity, gitBlobSha as profileBlobSha } from '../lib/execution-profiles/detector.ts';
import type { GitHubAppConfiguration } from '../lib/github-app/types.ts';
import { listPaths, readBaselineSummary, readTextFile, searchText } from '../lib/investigations/context.ts';
import { createInvestigation, getInvestigation, InvestigationError } from '../lib/investigations/flow.ts';
import { createInvestigationHandlers } from '../lib/investigations/handlers.ts';
import { CONTEXT_BUDGET, pathDenied } from '../lib/investigations/policy.ts';
import { prepareTreeEntries } from '../lib/investigations/source.ts';
import type { GitTreeEntry, InvestigationSourceGateway } from '../lib/investigations/types.ts';
import { processInvestigationJob, type InvestigationWorkerDependencies } from '../lib/investigations/worker.ts';
import { normalizeRepairObjective, RepairIntentValidationError } from '../lib/repair-runs/intent.ts';
import {
  parseInvestigationJobPayload,
  type InvestigationJobPayload,
  type InvestigationQueueJob,
  type TransactionalInvestigationQueue,
  type TransactionalRepairQueue,
} from '../lib/repair-runs/queue.ts';
import { getRepairRun, startRepairRun, transitionRepairRun } from '../lib/repair-runs/flow.ts';
import type { BaselineEvidence } from '../lib/repository-baselines/types.ts';
import { commandEvidence } from '../src/fixture-execution.ts';
import { createTestContext, saveGithubUser } from './support.ts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const REPOSITORY_ID = 8101;
const INSTALLATION_ID = 9001;
const OBJECTIVE = 'Inspect how Vigilo represents and executes durable Repair Runs.';
const CONFIGURATION: GitHubAppConfiguration = { appId: 991, appSlug: 'vigilo-test', baseUrl: 'http://localhost:3000', clientId: 'Iv1.test' };
const PACKAGE = '{"name":"app"}';
const LOCK = '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const blobSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

async function authenticated(context: Awaited<ReturnType<typeof createTestContext>>, githubId = randomUUID()): Promise<AuthenticatedWorkspace> {
  const user = await saveGithubUser(context, githubId);
  const login = await context.testAuth.login({ userId: user.id });
  return resolveAuthenticatedWorkspace((headers) => context.auth.api.getSession({ headers }), context.database, login.headers);
}

function profileValues(workspaceId: string, baseCommitSha = COMMIT) {
  const input = {
    baseCommitSha,
    build: { script: 'build' as const, tool: 'npm' as const },
    githubRepositoryId: REPOSITORY_ID,
    install: { operation: 'ci' as const, tool: 'npm' as const },
    installationId: INSTALLATION_ID,
    lockfileType: 'package-lock' as const,
    nodeMajor: 24 as const,
    packageJsonBlobSha: profileBlobSha(PACKAGE),
    packageJsonContentSha256: sha256(PACKAGE),
    packageLockBlobSha: profileBlobSha(LOCK),
    packageLockContentSha256: sha256(LOCK),
    packageManager: 'npm' as const,
    profileVersion: 2 as const,
    runtimeFamily: 'node' as const,
    test: { script: 'test' as const, tool: 'npm' as const },
    testRunner: 'node-test' as const,
    typecheck: { script: 'typecheck' as const, tool: 'npm' as const },
    workspaceId,
  };
  return {
    baseCommitSha, buildScript: 'build', githubRepositoryId: REPOSITORY_ID, installOperation: 'ci', installationId: INSTALLATION_ID,
    lockfileType: 'package-lock', nodeMajor: 24, packageJsonBlobSha: input.packageJsonBlobSha,
    packageJsonContentSha256: input.packageJsonContentSha256, packageLockBlobSha: input.packageLockBlobSha,
    packageLockContentSha256: input.packageLockContentSha256, packageManager: 'npm',
    profileIdentity: computeExecutionProfileIdentity(input), profileVersion: 2, runtimeFamily: 'node', status: 'ready',
    testRunner: 'node-test', testScript: 'test', typecheckScript: 'typecheck', workspaceId,
  } as const;
}

async function seedAuthority(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace) {
  await context.database.insert(githubInstallation).values({ accountLogin: 'xmodneo', accountType: 'User', githubAccountId: 3001, installationId: INSTALLATION_ID, status: 'active', workspaceId: owner.workspace.id });
  await context.database.insert(repository).values({ defaultBranch: 'main', fullName: 'xmodneo/vigilo', githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, isPrivate: false, name: 'vigilo', ownerId: 3001, ownerLogin: 'xmodneo', workspaceId: owner.workspace.id });
  await context.database.insert(executionProfile).values(profileValues(owner.workspace.id));
}

class Queues implements TransactionalRepairQueue, TransactionalInvestigationQueue {
  repair: unknown[] = [];
  investigation: InvestigationJobPayload[] = [];
  async enqueue(_transaction: Parameters<TransactionalRepairQueue['enqueue']>[0], payload: Parameters<TransactionalRepairQueue['enqueue']>[1]) {
    this.repair.push(structuredClone(payload)); return payload.repairRunId;
  }
  async enqueueInvestigation(_transaction: Parameters<TransactionalInvestigationQueue['enqueueInvestigation']>[0], payload: InvestigationJobPayload) {
    this.investigation.push(structuredClone(payload)); return payload.investigationId;
  }
}

function baselineEvidence(owner: AuthenticatedWorkspace, profileIdentity: string, id: string, outcome: BaselineEvidence['overallOutcome'], baseCommitSha = COMMIT): BaselineEvidence {
  const install = commandEvidence(['npm', 'ci'], 1); install.status = 'completed'; install.exitCode = 0;
  const tests = commandEvidence(['npm', 'test'], 1); tests.status = outcome === 'baseline_passed' ? 'completed' : 'failed'; tests.exitCode = outcome === 'baseline_passed' ? 0 : 1;
  return {
    evidenceVersion: 1, runId: id, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID,
    profileIdentity, baseCommitSha, archiveSha256: 'c'.repeat(64),
    sandbox: { name: 'safe-sandbox-name', sessionId: 'safe-session-id', runtime: 'vercel/sandbox/node:24', persistent: false },
    source: { materialized: true, identityBeforeExecution: 'd'.repeat(64), identityAfterExecution: 'd'.repeat(64), unchangedAfterExecution: true },
    credentialsExposure: 'absent', networkPolicyBeforeRepositoryExecution: 'deny-all', install, typecheck: null, build: null, test: tests,
    executionOutcome: outcome, overallOutcome: outcome, cleanup: { stop: 'confirmed', delete: 'confirmed', lookup: 'absent' },
    error: outcome === 'baseline_passed' ? null : { phase: 'test', code: outcome }, startedAt: NOW, completedAt: NOW, durationMs: 0,
  };
}

async function persistBaseline(database: VigiloDatabase, evidence: BaselineEvidence) {
  await database.insert(repositoryBaseline).values({
    id: evidence.runId, workspaceId: evidence.workspaceId, githubRepositoryId: evidence.githubRepositoryId, installationId: evidence.installationId,
    evidenceVersion: 1, profileIdentity: evidence.profileIdentity, baseCommitSha: evidence.baseCommitSha, archiveSha256: evidence.archiveSha256,
    sandboxName: evidence.sandbox.name, sandboxSessionId: evidence.sandbox.sessionId, sourceIdentityBefore: evidence.source.identityBeforeExecution,
    sourceIdentityAfter: evidence.source.identityAfterExecution, sourceUnchanged: evidence.source.unchangedAfterExecution, credentialsExposure: evidence.credentialsExposure,
    networkPolicy: evidence.networkPolicyBeforeRepositoryExecution, installStatus: evidence.install.status, installExitCode: evidence.install.exitCode,
    installTimedOut: evidence.install.timedOut, testStatus: evidence.test.status, testExitCode: evidence.test.exitCode, testTimedOut: evidence.test.timedOut,
    executionOutcome: evidence.executionOutcome, overallOutcome: evidence.overallOutcome, cleanupStop: evidence.cleanup.stop, cleanupDelete: evidence.cleanup.delete,
    cleanupLookup: evidence.cleanup.lookup, errorPhase: evidence.error?.phase ?? null, errorCode: evidence.error?.code ?? null,
    startedAt: evidence.startedAt, completedAt: evidence.completedAt, durationMs: evidence.durationMs,
  });
}

async function eligible(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace, outcome: BaselineEvidence['overallOutcome'] = 'baseline_passed') {
  const queues = new Queues();
  const run = await startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queues, { clock: () => NOW });
  await transitionRepairRun(context.database, owner.workspace.id, run.id, 'created', 'baseline_running', NOW, { eventId: randomUUID() });
  const evidence = baselineEvidence(owner, run.identity.profileIdentity, randomUUID(), outcome, run.identity.baseCommitSha);
  await persistBaseline(context.database, evidence);
  await transitionRepairRun(context.database, owner.workspace.id, run.id, 'baseline_running', 'ready_for_investigation', NOW, { baselineId: evidence.runId, eventId: randomUUID() });
  return { queues, run: (await getRepairRun(context.database, owner, run.id))!, evidence };
}

class Gateway implements InvestigationSourceGateway {
  readonly calls: Array<{ operation: string; value?: string }> = [];
  readonly blobs = new Map<string, Buffer>();
  entries: GitTreeEntry[] = [];
  providerTruncated = false;
  commit = COMMIT;
  add(path: string, content: string | Buffer, mode: GitTreeEntry['mode'] = '100644') {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = blobSha(bytes); this.blobs.set(sha, bytes);
    this.entries.push({ path, mode, type: mode === '160000' ? 'commit' : 'blob', sha, size: mode === '160000' ? null : bytes.byteLength });
    return sha;
  }
  addTree(path: string) { this.entries.push({ path, mode: '040000', type: 'tree', sha: 'e'.repeat(40), size: null }); }
  async createInstallationAccessToken(input: { installationId: number; repositoryId: number }) {
    this.calls.push({ operation: 'token', value: `${input.installationId}:${input.repositoryId}` });
    return { accessToken: 'never-persist-this-token', repository: { id: input.repositoryId, name: 'vigilo', ownerLogin: 'xmodneo' } };
  }
  async getCommitTree(input: { commitSha: string }) { this.calls.push({ operation: 'commit', value: input.commitSha }); return { commitSha: this.commit, treeSha: TREE }; }
  async getTree(input: { treeSha: string }) { this.calls.push({ operation: 'tree', value: input.treeSha }); return { entries: this.entries, truncated: this.providerTruncated }; }
  async getBlob(input: { blobSha: string }) { this.calls.push({ operation: 'blob', value: input.blobSha }); const bytes = this.blobs.get(input.blobSha); if (!bytes) throw new Error('missing blob'); return { bytes, sha: input.blobSha }; }
  async getInstallation(installationId: number) { this.calls.push({ operation: 'installation', value: String(installationId) }); return { appId: CONFIGURATION.appId, appSlug: CONFIGURATION.appSlug, id: installationId, suspendedAt: null }; }
  async revokeInstallationAccessToken(accessToken: string) { assert.equal(accessToken, 'never-persist-this-token'); this.calls.push({ operation: 'revoke' }); }
}

function queueJob(id: string, data: unknown = { version: 1, investigationId: id }): InvestigationQueueJob {
  return { id, name: 'investigation-context-v1', data, signal: new AbortController().signal } as InvestigationQueueJob;
}

function workerDependencies(database: VigiloDatabase, gateway: Gateway, override: Partial<InvestigationWorkerDependencies> = {}): InvestigationWorkerDependencies {
  return { configuration: CONFIGURATION, database, gateway, logger: { write() {} }, clock: () => NOW, ...override };
}

async function prepared(context: Awaited<ReturnType<typeof createTestContext>>, owner: AuthenticatedWorkspace, gateway = new Gateway()) {
  const ready = await eligible(context, owner);
  const value = await createInvestigation(context.database, owner, ready.run.id, randomUUID(), ready.queues, { clock: () => NOW });
  const result = await processInvestigationJob(queueJob(value.id), workerDependencies(context.database, gateway));
  assert.equal(result.status, 'completed');
  return { ...ready, investigation: (await getInvestigation(context.database, owner, value.id))!, gateway };
}

test('repair objective normalization is bounded, durable, immutable, and never supplies authority', async (t) => {
  assert.deepEqual(normalizeRepairObjective('  repair\r\nthis  '), { objective: 'repair\nthis', objectiveHash: sha256('repair\nthis') });
  for (const invalid of ['', '   ', 'x'.repeat(3_001), '💥'.repeat(769), 'bad\u0000intent']) assert.throws(() => normalizeRepairObjective(invalid), RepairIntentValidationError);
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const injected = `Inspect repositoryId=999 commit=${'f'.repeat(40)} profile=${'e'.repeat(64)}`;
  const queues = new Queues(); const run = await startRepairRun(context.database, owner, randomUUID(), injected, queues, { clock: () => NOW });
  assert.equal(run.identity.githubRepositoryId, REPOSITORY_ID); assert.equal(run.identity.baseCommitSha, COMMIT); assert.equal(run.repairObjective, injected);
  await assert.rejects(startRepairRun(context.database, owner, run.id, 'different objective', queues), /repair_intent_conflict/);
  const [stored] = await context.database.select().from(repairIntent).where(eq(repairIntent.repairRunId, run.id));
  await transitionRepairRun(context.database, owner.workspace.id, run.id, 'created', 'baseline_running', NOW, { eventId: randomUUID() });
  assert.equal((await context.database.select().from(repairIntent).where(eq(repairIntent.id, stored!.id)))[0]?.objective, injected);
});

test('idempotent repair starts require the same immutable objective and historic runs remain readable', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const queues = new Queues(); const key = randomUUID();
  const first = await startRepairRun(context.database, owner, key, OBJECTIVE, queues);
  assert.equal((await startRepairRun(context.database, owner, key, OBJECTIVE, queues)).id, first.id);
  await assert.rejects(startRepairRun(context.database, owner, key, 'A different request', queues), /repair_intent_conflict/);
  await transitionRepairRun(context.database, owner.workspace.id, first.id, 'created', 'cancelled', NOW, { eventId: randomUUID(), failureCode: 'cancelled_before_execution' });
  const historicId = randomUUID();
  await context.database.insert(repairRun).values({ id: historicId, workspaceId: owner.workspace.id, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity: profileValues(owner.workspace.id).profileIdentity, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'created' });
  const historic = await getRepairRun(context.database, owner, historicId);
  assert.equal(historic?.repairObjective, null); assert.equal(historic?.repairObjectiveHash, null);
});

test('investigation eligibility accepts trustworthy customer failures and blocks infrastructure failures', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const customer = await eligible(context, owner, 'test_failed');
  assert.equal(customer.run.state, 'ready_for_investigation'); assert.equal(customer.run.baselineOutcome, 'test_failed');
  assert.ok(await createInvestigation(context.database, owner, customer.run.id, randomUUID(), customer.queues));
  await context.database.update(executionProfile).set(profileValues(owner.workspace.id, 'f'.repeat(40))).where(eq(executionProfile.githubRepositoryId, REPOSITORY_ID));
  const queues = new Queues(); const blocked = await startRepairRun(context.database, owner, randomUUID(), OBJECTIVE, queues);
  await transitionRepairRun(context.database, owner.workspace.id, blocked.id, 'created', 'baseline_running', NOW, { eventId: randomUUID() });
  await transitionRepairRun(context.database, owner.workspace.id, blocked.id, 'baseline_running', 'infrastructure_failed', NOW, { eventId: randomUUID(), failureCode: 'installation_failed' });
  await assert.rejects(createInvestigation(context.database, owner, blocked.id, randomUUID(), queues), (error: unknown) => error instanceof InvestigationError && error.code === 'repair_run_not_eligible');
});

test('investigation creation freezes run authority, is idempotent, workspace-scoped, and enqueues only its ID', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const other = await authenticated(context); const ready = await eligible(context, owner); const key = randomUUID();
  const [first, duplicate] = await Promise.all([
    createInvestigation(context.database, owner, ready.run.id, key, ready.queues),
    createInvestigation(context.database, owner, ready.run.id, key, ready.queues),
  ]);
  assert.equal(first.id, duplicate.id); assert.deepEqual(ready.queues.investigation, [{ version: 1, investigationId: first.id }]);
  assert.deepEqual({ repository: first.githubRepositoryId, installation: first.installationId, commit: first.baseCommitSha, profile: first.profileIdentity, baseline: first.baselineId }, { repository: REPOSITORY_ID, installation: INSTALLATION_ID, commit: COMMIT, profile: ready.run.identity.profileIdentity, baseline: ready.evidence.runId });
  await context.database.update(repository).set({ defaultBranch: 'moved' }).where(eq(repository.githubRepositoryId, REPOSITORY_ID));
  assert.equal((await getInvestigation(context.database, owner, first.id))?.baseCommitSha, COMMIT);
  assert.equal(await getInvestigation(context.database, other, first.id), null);
  assert.deepEqual(parseInvestigationJobPayload({ version: 1, investigationId: first.id }), { version: 1, investigationId: first.id });
  for (const payload of [{ version: 1, investigationId: first.id, commit: COMMIT }, { version: 2, investigationId: first.id }, {}]) assert.throws(() => parseInvestigationJobPayload(payload), /invalid_investigation_job_payload/);
});

test('tree preparation is exact-revision, bounded, excludes denied paths, and never follows links', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const gateway = new Gateway(); gateway.add('README.md', '# Vigilo'); gateway.add('.env.local', 'SECRET=value'); gateway.add('private.pem', 'PRIVATE KEY');
  gateway.add('linked', 'target', '120000'); gateway.add('module', Buffer.alloc(0), '160000'); gateway.addTree('src');
  const value = await prepared(context, owner, gateway);
  assert.equal(value.investigation.state, 'ready'); assert.equal(value.investigation.baseCommitSha, COMMIT);
  assert.deepEqual(gateway.calls.filter((call) => call.operation === 'commit').map((call) => call.value), [COMMIT]);
  assert.equal(gateway.calls.filter((call) => call.operation === 'revoke').length, 1);
  const entries = await context.database.select().from(investigationContextEntry).where(eq(investigationContextEntry.investigationId, value.investigation.id));
  assert.deepEqual(entries.map((entry) => [entry.path, entry.kind, entry.readable]).sort(), [['README.md', 'blob', true], ['linked', 'symlink', false], ['module', 'submodule', false], ['src', 'tree', false]]);
  assert.equal(value.investigation.excludedPathCount, 2); assert.equal(value.investigation.treeTruncated, false);
  assert.equal((await processInvestigationJob(queueJob(value.investigation.id), workerDependencies(context.database, gateway))).status, 'completed');
  assert.equal(gateway.calls.filter((call) => call.operation === 'token').length, 1);
  const many = Array.from({ length: CONTEXT_BUDGET.maxTreeEntries + 1 }, (_, index): GitTreeEntry => ({ path: `src/f${String(index).padStart(4, '0')}.ts`, mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 1 }));
  const capped = prepareTreeEntries(many, false); assert.equal(capped.entries.length, CONTEXT_BUDGET.maxTreeEntries); assert.equal(capped.truncated, true);
  assert.throws(() => prepareTreeEntries([{ path: '../escape', mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 1 }], false), /source_tree_invalid/);
});

test('bounded context operations read exact blobs, reject unsafe content, search literally, and retain metadata-only audit', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const gateway = new Gateway(); gateway.add('README.md', '# Vigilo\nDurable Repair Runs are exact.'); gateway.add('src/run.ts', 'export const phrase = "Repair Run";'); gateway.add('binary.ts', Buffer.from([0, 1, 2]));
  gateway.add('large.ts', Buffer.alloc(CONTEXT_BUDGET.maxFileBytes + 1, 97)); gateway.add('linked', 'README.md', '120000');
  const value = await prepared(context, owner, gateway); const id = value.investigation.id;
  const listed = await listPaths(context.database, owner, id, randomUUID(), 2); assert.equal(listed.paths.length, 2); assert.equal(listed.truncated, true);
  const read = await readTextFile(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), 'README.md'); assert.match(read.content, /Durable Repair Runs/);
  for (const unsafe of ['../README.md', '/README.md']) await assert.rejects(readTextFile(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), unsafe), /unsafe_path/);
  for (const denied of ['.env', '.env.local', 'private.pem', 'credentials.json']) assert.equal(pathDenied(denied), true);
  await assert.rejects(readTextFile(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), '.env.local'), /path_denied/);
  await assert.rejects(readTextFile(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), 'linked'), /path_not_readable/);
  await assert.rejects(readTextFile(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), 'large.ts'), /path_not_readable/);
  await assert.rejects(readTextFile(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), 'binary.ts'), /binary_file_rejected/);
  const search = await searchText(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), 'Repair Run');
  assert.equal(search.matches.length, 2); assert.ok(search.matches.some((match) => match.path === 'src/run.ts'));
  assert.equal((await searchText(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), '[.*]+')).matches.length, 0);
  await assert.rejects(searchText(context.database, owner, gateway, CONFIGURATION, id, randomUUID(), 'x'.repeat(129)), /query_invalid/);
  const baseline = await readBaselineSummary(context.database, owner, id, randomUUID()); assert.equal(baseline.overallOutcome, 'baseline_passed');
  assert.equal('sandboxName' in baseline, false); assert.equal('stdout' in baseline, false);
  const events = await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.investigationId, id));
  const serialized = JSON.stringify(events); assert.doesNotMatch(serialized, /Durable Repair Runs|never-persist-this-token|SECRET=|PRIVATE KEY/);
  assert.ok(events.some((event) => event.operation === 'read_text_file' && event.requestPath === 'README.md' && event.resultBytes > 0));
  assert.ok(events.some((event) => event.operation === 'search_text' && event.queryHash === sha256('Repair Run') && event.queryBytes === 10));
  assert.ok(events.some((event) => event.status === 'rejected' && event.failureCode === 'path_denied' && event.requestPath === null));
  assert.equal(gateway.calls.filter((call) => call.operation === 'token').length, gateway.calls.filter((call) => call.operation === 'revoke').length);
  const databaseRows = JSON.stringify({ investigations: await context.database.select().from(investigation), events }); assert.doesNotMatch(databaseRows, /never-persist-this-token/);
});

test('investigation source boundary contains no repository execution or source mutation capability', async () => {
  const implementation = await Promise.all([
    readFile('lib/investigations/context.ts', 'utf8'),
    readFile('lib/investigations/source.ts', 'utf8'),
    readFile('lib/investigations/worker.ts', 'utf8'),
  ]).then((files) => files.join('\n'));
  assert.doesNotMatch(implementation, /node:child_process|\b(?:exec|spawn|eval)\s*\(|npm\s+(?:ci|test|run)|writeFile|appendFile/);
  assert.match(implementation, /getCommitTree/); assert.match(implementation, /getTree/); assert.match(implementation, /getBlob/);
});

test('search path, byte, match, and cumulative-operation budgets fail closed across retries', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const gateway = new Gateway(); gateway.add('src/matches.ts', Array(40).fill('needle').join('\n'));
  const value = await prepared(context, owner, gateway); const search = await searchText(context.database, owner, gateway, CONFIGURATION, value.investigation.id, randomUUID(), 'needle');
  assert.equal(search.matches.length, CONTEXT_BUDGET.maxSearchMatches); assert.equal(search.truncated, true); assert.equal(search.budgetExhausted, true);
  const fileCountGateway = new Gateway();
  for (let index = 0; index < 55; index += 1) fileCountGateway.add(`src/${String(index).padStart(2, '0')}.ts`, 'haystack');
  const fileCount = await prepared(context, owner, fileCountGateway); const fileCountSearch = await searchText(context.database, owner, fileCountGateway, CONFIGURATION, fileCount.investigation.id, randomUUID(), 'needle');
  assert.equal(fileCountSearch.truncated, true); assert.equal(fileCountGateway.calls.filter((call) => call.operation === 'blob').length, CONTEXT_BUDGET.maxSearchCandidateFiles);
  const byteGateway = new Gateway();
  for (let index = 0; index < 50; index += 1) byteGateway.add(`lib/${String(index).padStart(2, '0')}.ts`, 'x'.repeat(6_000));
  const byteCount = await prepared(context, owner, byteGateway); const byteSearch = await searchText(context.database, owner, byteGateway, CONFIGURATION, byteCount.investigation.id, randomUUID(), 'needle');
  assert.equal(byteSearch.truncated, true); assert.ok(byteSearch.scannedBytes <= CONTEXT_BUDGET.maxSearchBytes); assert.ok(byteSearch.scannedBytes + 6_000 > CONTEXT_BUDGET.maxSearchBytes);
  const operationId = randomUUID(); await listPaths(context.database, owner, value.investigation.id, operationId, 1);
  await assert.rejects(listPaths(context.database, owner, value.investigation.id, operationId, 1), /context_operation_replayed/);
  const used = (await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.investigationId, value.investigation.id))).length;
  for (let count = used; count < CONTEXT_BUDGET.maxOperations; count += 1) await listPaths(context.database, owner, value.investigation.id, randomUUID(), 1);
  await assert.rejects(listPaths(context.database, owner, value.investigation.id, randomUUID(), 1), /context_budget_exhausted/);
});

test('worker retries safely, duplicate delivery is harmless, and binding/fencing changes block persistence', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const ready = await eligible(context, owner); const value = await createInvestigation(context.database, owner, ready.run.id, randomUUID(), ready.queues);
  const wrongRevision = new Gateway(); wrongRevision.commit = 'f'.repeat(40);
  assert.equal((await processInvestigationJob(queueJob(value.id), workerDependencies(context.database, wrongRevision))).status, 'failed');
  assert.equal((await getInvestigation(context.database, owner, value.id))?.state, 'created');
  const good = new Gateway(); good.add('README.md', 'safe');
  assert.equal((await processInvestigationJob(queueJob(value.id), workerDependencies(context.database, good))).status, 'completed');
  assert.equal((await processInvestigationJob(queueJob(value.id), workerDependencies(context.database, good))).status, 'completed');
  assert.equal(good.calls.filter((call) => call.operation === 'token').length, 1);

  await context.database.update(executionProfile).set(profileValues(owner.workspace.id, 'f'.repeat(40))).where(eq(executionProfile.githubRepositoryId, REPOSITORY_ID));
  const second = await eligible(context, owner); const next = await createInvestigation(context.database, owner, second.run.id, randomUUID(), second.queues);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocking = new Gateway(); blocking.commit = 'f'.repeat(40); blocking.add('README.md', 'safe');
  blocking.getTree = async (input) => { entered(); await gate; return Gateway.prototype.getTree.call(blocking, input); };
  const processing = processInvestigationJob(queueJob(next.id), workerDependencies(context.database, blocking)); await started;
  await context.database.update(investigation).set({ ownershipToken: randomUUID() }).where(eq(investigation.id, next.id)); release();
  const result = await processing; assert.equal(result.status, 'failed'); assert.deepEqual(result.output, { code: 'investigation_ownership_lost' });
  assert.equal((await getInvestigation(context.database, owner, next.id))?.state, 'context_preparing');
  assert.equal((await context.database.select().from(investigationContextEntry).where(eq(investigationContextEntry.investigationId, next.id))).length, 0);
  assert.equal((await context.database.select().from(investigationContextEvent).where(eq(investigationContextEvent.investigationId, next.id))).length, 0);
});

test('database constraints reject malformed identity, unsafe metadata, and duplicate investigation ownership', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const ready = await eligible(context, owner); const value = await createInvestigation(context.database, owner, ready.run.id, randomUUID(), ready.queues);
  await assert.rejects(context.database.insert(investigation).values({
    id: randomUUID(), repairRunId: ready.run.id, repairIntentId: randomUUID(), workspaceId: owner.workspace.id,
    githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity: ready.run.identity.profileIdentity,
    baselineId: ready.evidence.runId, idempotencyKey: randomUUID(), state: 'created', contextBudgetVersion: 1,
    maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50,
  }));
  await assert.rejects(context.database.insert(investigationContextEntry).values({ investigationId: value.id, path: '../escape', depth: 1, kind: 'blob', mode: '100644', objectSha: 'a'.repeat(40), sizeBytes: 1, readable: true }));
  await assert.rejects(context.database.insert(investigationContextEvent).values({ id: randomUUID(), investigationId: value.id, workspaceId: owner.workspace.id, operation: 'read_text_file', status: 'completed', requestPath: '../escape', resultCount: 1, resultBytes: 100, budgetBytes: 100, completedAt: NOW }));
});

test('protected investigation handlers derive authority server-side and expose no credentials or source metadata', async (t) => {
  const context = await createTestContext(); t.after(() => context.client.close()); const owner = await authenticated(context); await seedAuthority(context, owner);
  const other = await authenticated(context); const ready = await eligible(context, owner); const gateway = new Gateway(); gateway.add('README.md', 'public text');
  let current = owner;
  const handlers = createInvestigationHandlers({ configuration: CONFIGURATION, database: context.database, gateway, queue: ready.queues, resolveContext: async () => current });
  const key = randomUUID();
  const created = await handlers.create(new Request('http://localhost:3000/api/repair-runs/x/investigation', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: key }) }), ready.run.id);
  assert.equal(created.status, 303); const id = ready.queues.investigation[0]?.investigationId; assert.ok(id);
  assert.equal((await handlers.create(new Request('http://localhost:3000/api/repair-runs/x/investigation', { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ idempotencyKey: key, repositoryId: '999', commit: 'f'.repeat(40) }) }), ready.run.id)).status, 303);
  await processInvestigationJob(queueJob(id), workerDependencies(context.database, gateway));
  const read = await handlers.read(new Request(`http://localhost:3000/api/investigations/${id}`), id); const body = JSON.stringify(await read.json());
  assert.equal(read.status, 200); assert.doesNotMatch(body, /never-persist-this-token|private.?key|installationId|githubRepositoryId/i);
  const file = await handlers.file(new Request(`http://localhost:3000/api/investigations/${id}/file`, { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ operationId: randomUUID(), path: 'README.md' }) }), id);
  assert.equal(file.status, 200); assert.doesNotMatch(JSON.stringify(await file.json()), /never-persist-this-token/);
  current = other;
  assert.equal((await handlers.read(new Request(`http://localhost:3000/api/investigations/${id}`), id)).status, 404);
  assert.equal((await handlers.paths(new Request(`http://localhost:3000/api/investigations/${id}/paths`, { method: 'POST', headers: { origin: CONFIGURATION.baseUrl }, body: new URLSearchParams({ operationId: randomUUID(), limit: '10' }) }), id)).status, 404);
});
