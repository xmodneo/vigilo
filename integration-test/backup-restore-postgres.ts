import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from '../db/schema.ts';

import {
  account, aiCandidateGeneration, aiCandidateGenerationAttempt, aiInvestigation,
  candidateVerification, candidateVerificationAttempt, candidateVerificationEvidence,
  executionBudgetGrant, executionProfile, githubInstallation, investigation, releaseAcceptance,
  repairCandidate, repairCandidateFile, repairIntent, repairLoop, repairLoopIteration,
  repairPublication, repairRun, repository, repositoryBaseline, user, workspace,
} from '../db/schema.ts';
import type { AuthenticatedWorkspace } from '../lib/auth/protected-context.ts';
import type { VigiloDatabase } from '../lib/db/types.ts';
import { computeExecutionProfileIdentity } from '../lib/execution-profiles/detector.ts';
import { computeExecutionGrantIdentity, computeReleaseAcceptanceIdentity } from '../lib/external-execution/identity.ts';
import { createHumanReviewDecision, getHumanReview, resolveApprovedHumanReviewAuthority } from '../lib/human-reviews/flow.ts';
import { acceptanceIdentityPayload } from '../lib/release-acceptance/resolver.ts';
import { computeCandidateIdentity, sha256 } from '../lib/repair-candidates/identity.ts';
import { processRepairPublicationJob } from '../lib/repair-publications/worker.ts';
import { reserveApprovedPublicationForTest } from '../lib/repair-publications/testing.ts';
import { canonicalRecord } from '../lib/repair-loops/canonical.ts';
import { deriveBaselineRecoveryContract } from '../lib/repair-loops/objective-contract.ts';
import { createRepairBoss, REPAIR_BASELINE_QUEUE, REPAIR_PUBLICATION_QUEUE } from '../lib/repair-runs/queue.ts';
import { processRepairJob } from '../lib/repair-runs/worker.ts';
import { validateMigrationLedger } from '../lib/operations/migrations.ts';

const configured = process.env.DATABASE_URL;
if (!configured) throw new Error('missing_required_environment:DATABASE_URL');
const configuredUrl = new URL(configured);
if (!['127.0.0.1', 'localhost'].includes(configuredUrl.hostname)) throw new Error('backup_drill_requires_local_postgres');
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(decodeURIComponent(configuredUrl.username)) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(configuredUrl.pathname.slice(1))) throw new Error('backup_drill_database_identity_invalid');

const NOW = new Date('2032-02-03T04:05:06.000Z');
const COMMIT = 'a'.repeat(40); const SOURCE = 'c'.repeat(64);
const REPOSITORY_ID = 71001; const INSTALLATION_ID = 72001;
const FILE_CONTENT = 'export const restored = true;\n';
const sourceName = `vigilo_backup_source_${randomUUID().replaceAll('-', '')}`;
const restoredName = `vigilo_backup_restored_${randomUUID().replaceAll('-', '')}`;
const adminUrl = new URL(configured); adminUrl.pathname = '/postgres';
const sourceUrl = new URL(configured); sourceUrl.pathname = `/${sourceName}`;
const restoredUrl = new URL(configured); restoredUrl.pathname = `/${restoredName}`;
const admin = postgres(adminUrl.toString(), { max: 1, prepare: false });
const scratch = await mkdtemp(join(tmpdir(), 'vigilo-backup-drill-'));
const archivePath = join(scratch, 'vigilo.dump');

async function command(commandName: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(`${commandName}_failed:${code}:${Buffer.concat(errors).toString('utf8').slice(0, 300)}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

async function findDatabaseContainer(): Promise<string> {
  const rows = (await command('docker', ['ps', '--format', '{{.ID}}\t{{.Ports}}'])).toString('utf8').trim().split('\n');
  const port = configuredUrl.port || '5432';
  const matching = rows.filter((row) => row.includes(`:${port}->5432/tcp`));
  if (matching.length !== 1) throw new Error('backup_drill_database_container_ambiguous');
  const id = matching[0]!.split('\t')[0]!;
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('backup_drill_database_container_invalid');
  return id;
}

async function seedRepresentativeState(database: VigiloDatabase): Promise<{ publicationId: string; fingerprints: Record<string, string> }> {
  const userId = randomUUID(); const workspaceId = randomUUID(); const runId = randomUUID(); const baselineId = randomUUID();
  const investigationId = randomUUID(); const aiInvestigationId = randomUUID(); const loopId = randomUUID(); const iterationId = randomUUID();
  const generationId = randomUUID(); const candidateId = randomUUID(); const verificationId = randomUUID(); const attemptId = randomUUID(); const evidenceId = randomUUID();
  await database.insert(user).values({ id: userId, name: 'Restore Drill', email: `${userId}@test.invalid`, emailVerified: true });
  await database.insert(account).values({ id: randomUUID(), issuer: 'local:oauth:github', accountId: '2001', providerId: 'github', userId });
  await database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await database.insert(githubInstallation).values({ installationId: INSTALLATION_ID, workspaceId, githubAccountId: 2001, accountLogin: 'restore-drill', accountType: 'User', status: 'active' });
  await database.insert(repository).values({ githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, ownerId: 2001, ownerLogin: 'restore-drill', name: 'repo', fullName: 'restore-drill/repo', defaultBranch: 'main', isPrivate: false });
  const profileIdentity = computeExecutionProfileIdentity({ baseCommitSha: COMMIT, build: { script: 'build', tool: 'npm' }, githubRepositoryId: REPOSITORY_ID, install: { operation: 'ci', tool: 'npm' }, installationId: INSTALLATION_ID, lockfileType: 'package-lock', nodeMajor: 24, packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), packageManager: 'npm', profileVersion: 2, runtimeFamily: 'node', test: { script: 'test', tool: 'npm' }, testRunner: 'vitest', typecheck: { script: 'typecheck', tool: 'npm' }, workspaceId });
  const profile = { githubRepositoryId: REPOSITORY_ID, workspaceId, installationId: INSTALLATION_ID, profileVersion: 2, profileIdentity, baseCommitSha: COMMIT, runtimeFamily: 'node', nodeMajor: 24, packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck', buildScript: 'build', testScript: 'test', testRunner: 'vitest', packageJsonBlobSha: 'd'.repeat(40), packageJsonContentSha256: 'e'.repeat(64), packageLockBlobSha: 'f'.repeat(40), packageLockContentSha256: '1'.repeat(64), status: 'ready' } as const;
  await database.insert(executionProfile).values(profile);
  const baseline = { id: baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, evidenceVersion: 1, profileIdentity, baseCommitSha: COMMIT, archiveSha256: '2'.repeat(64), sandboxName: 'restore-drill', sourceIdentityBefore: SOURCE, sourceIdentityAfter: SOURCE, sourceUnchanged: true, credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'failed', testExitCode: 1, testTimedOut: false, executionOutcome: 'test_failed', overallOutcome: 'test_failed', cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', errorPhase: 'test', errorCode: 'npm_command_failed', startedAt: NOW, completedAt: NOW, durationMs: 1 } as const;
  await database.insert(repositoryBaseline).values(baseline);
  await database.insert(repairRun).values({ id: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, profileIdentity, baseCommitSha: COMMIT, idempotencyKey: randomUUID(), state: 'ready_for_investigation', baselineId, baselineOutcome: 'test_failed', failureClassification: 'customer_baseline_failure', failureCode: 'test_failed', baselineStartedAt: NOW, completedAt: NOW, stateChangedAt: NOW, updatedAt: NOW });
  const repairIntentId = randomUUID(); const objective = 'Repair the measured restore-drill failure.';
  await database.insert(repairIntent).values({ id: repairIntentId, repairRunId: runId, workspaceId, objective, objectiveHash: sha256(objective) });
  await database.insert(investigation).values({ id: investigationId, repairRunId: runId, repairIntentId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, baselineId, idempotencyKey: randomUUID(), state: 'ready', contextBudgetVersion: 1, maxTreeEntries: 2000, maxFileBytes: 65536, maxCumulativeBytes: 1048576, maxOperations: 50, treeSha: '3'.repeat(40), indexedPathCount: 1, attemptNumber: 1, completedAt: NOW, updatedAt: NOW });
  await database.insert(aiInvestigation).values({ id: aiInvestigationId, investigationId, executionOrdinal: 1, idempotencyKey: randomUUID(), repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 1, state: 'completed', queuedAt: NOW, investigationStartedAt: NOW, completedAt: NOW, completionReason: 'model_conclusion', conclusionStatus: 'diagnosis_found', summary: 'Safe restore drill.', suspectedFiles: [{ path: 'src/restored.ts', reason: 'Measured failure.' }], evidenceReferences: [{ kind: 'baseline', reference: baselineId }], proposedApproach: 'Repair.', confidence: 'medium', updatedAt: NOW });
  await database.insert(repairLoop).values({ id: loopId, repairRunId: runId, workspaceId, investigationId, aiInvestigationId, protocolVersion: 1, maxIterations: 2, idempotencyKey: randomUUID(), state: 'queued', wakeJobId: randomUUID(), createdAt: NOW, updatedAt: NOW });
  const file = { path: 'src/restored.ts', operation: 'add' as const, baseBlobSha: null, baseContentSha256: null, resultContentSha256: sha256(FILE_CONTENT), resultByteLength: Buffer.byteLength(FILE_CONTENT), resultingContent: FILE_CONTENT };
  const candidateIdentity = computeCandidateIdentity({ formatVersion: 1, githubRepositoryId: REPOSITORY_ID, baseCommitSha: COMMIT, profileIdentity, files: [file] });
  await database.insert(repairCandidate).values({ id: candidateId, investigationId, repairRunId: runId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, formatVersion: 1, ordinal: 1, proposalKey: generationId, proposalIdentity: '4'.repeat(64), state: 'freezing', changedFileCount: 1, totalResultBytes: file.resultByteLength, createdAt: NOW, freezingStartedAt: NOW, updatedAt: NOW });
  await database.insert(repairCandidateFile).values({ candidateId, ...file });
  await database.update(repairCandidate).set({ state: 'frozen', candidateIdentity, completedAt: NOW, updatedAt: NOW }).where(eq(repairCandidate.id, candidateId));
  await database.insert(aiCandidateGeneration).values({ id: generationId, aiInvestigationId, executionOrdinal: 2, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, providerId: 'google', modelId: 'gemini-3.1-flash-lite', protocolVersion: 4, idempotencyKey: randomUUID(), state: 'frozen', repairCandidateId: candidateId, completionReason: 'proposal_ready', queuedAt: NOW, generationStartedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW });
  await database.insert(aiCandidateGenerationAttempt).values({ id: randomUUID(), generationId, queueJobId: randomUUID(), attemptNumber: 1, ownershipToken: randomUUID(), state: 'succeeded', claimedAt: NOW, heartbeatAt: NOW, finishedAt: NOW });
  const contract = deriveBaselineRecoveryContract({ repairRunId: runId, baseline, profile });
  await database.insert(repairLoopIteration).values({ id: iterationId, repairLoopId: loopId, ordinal: 1, aiCandidateGenerationId: generationId, objectiveContractVersion: contract.version, objectiveContractSnapshot: JSON.parse(contract.canonicalSnapshot), objectiveContractHash: contract.hash, objectiveContractBytes: contract.bytes, createdAt: NOW });
  await database.insert(candidateVerification).values({ id: verificationId, candidateId, investigationId, repairRunId: runId, baselineId, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, candidateIdentity, formatVersion: 1, state: 'queued', createdAt: NOW, queuedAt: NOW, updatedAt: NOW });
  await database.update(candidateVerification).set({ state: 'verifying', verificationStartedAt: NOW, updatedAt: NOW }).where(eq(candidateVerification.id, verificationId));
  await database.insert(candidateVerificationAttempt).values({ id: attemptId, verificationId, queueJobId: randomUUID(), attemptNumber: 1, expectedEvidenceId: evidenceId, ownershipToken: randomUUID(), state: 'succeeded', claimedAt: NOW, heartbeatAt: NOW, finishedAt: NOW });
  await database.insert(candidateVerificationEvidence).values({ id: evidenceId, verificationId, attemptId, evidenceVersion: 1, candidateId, candidateIdentity, workspaceId, githubRepositoryId: REPOSITORY_ID, installationId: INSTALLATION_ID, baseCommitSha: COMMIT, profileIdentity, baselineId, candidateArtifactIntegrity: 'valid', sandboxName: 'restore-verification', distinctSandboxConfirmed: true, pristineSourceIdentity: SOURCE, pristineBaseIntegrity: 'valid', reconstructedSourceIdentity: '5'.repeat(64), candidateReconstruction: 'valid', credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0, installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false, buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'completed', testExitCode: 0, testTimedOut: false, sourceIdentityAfter: '5'.repeat(64), sourceIntegrityUnchanged: true, cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent', executionOutcome: 'checks_passed', verificationContract: 'checks_passed', baselineComparison: 'previous_baseline_failure_resolved', repairObjectiveEvidence: 'not_measured', startedAt: NOW, completedAt: NOW, durationMs: 1 });
  await database.update(candidateVerificationAttempt).set({ evidenceId }).where(eq(candidateVerificationAttempt.id, attemptId));
  await database.update(candidateVerification).set({ state: 'completed', candidateArtifactIntegrity: 'valid', verificationContract: 'checks_passed', baselineComparison: 'previous_baseline_failure_resolved', evidenceId, completedAt: NOW, updatedAt: NOW }).where(eq(candidateVerification.id, verificationId));
  const objectiveEvidence = canonicalRecord({ version: 'baseline_recovery_evidence_v1', repairRunId: runId, baselineId, profileIdentity, candidateId, candidateIdentity, verificationId, evidenceId, objectiveContractVersion: contract.version, objectiveContractHash: contract.hash, result: 'satisfied', evaluatedChecks: ['test'] }, 16 * 1024);
  await database.update(repairLoop).set({ state: 'running', startedAt: NOW, updatedAt: NOW }).where(eq(repairLoop.id, loopId));
  await database.update(repairLoopIteration).set({ candidateVerificationId: verificationId, objectiveEvidence: 'satisfied', objectiveEvidenceSnapshot: objectiveEvidence.snapshot, objectiveEvidenceHash: objectiveEvidence.hash, objectiveEvidenceBytes: objectiveEvidence.bytes, decision: 'verified', decidedAt: NOW }).where(eq(repairLoopIteration.id, iterationId));
  await database.update(repairLoop).set({ state: 'verified', selectedCandidateId: candidateId, selectedVerificationId: verificationId, selectedEvidenceId: evidenceId, completedAt: NOW, updatedAt: NOW }).where(eq(repairLoop.id, loopId));
  const owner = { sessionId: randomUUID(), user: { id: userId, name: 'Restore Drill', email: `${userId}@test.invalid` }, githubUserId: '2001', workspace: { id: workspaceId, ownerUserId: userId } } satisfies AuthenticatedWorkspace;
  const review = await getHumanReview(database, owner, runId);
  const decision = await createHumanReviewDecision(database, owner, runId, { decision: 'approved', reviewSubjectIdentity: review.reviewSubjectIdentity!, idempotencyKey: randomUUID() });
  const authority = await resolveApprovedHumanReviewAuthority(database, workspaceId, decision.id);
  const publication = await reserveApprovedPublicationForTest(database, owner, { enqueuePublication: async (_transaction, payload) => payload.publicationId }, authority, { decisionIdentity: decision.decisionIdentity, idempotencyKey: randomUUID() }, { clock: () => NOW });

  const grantId = randomUUID(); const expiresAt = new Date('2020-02-02T04:05:06.000Z');
  const limits = { logicalRequests: 0, providerAttempts: 0, inputTokens: 0, outputTokens: 0, sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0, maxConcurrentExternalOperations: 1 };
  await database.insert(executionBudgetGrant).values({ id: grantId, version: 1, scope: 'account', maxLogicalRequests: 0, maxProviderAttempts: 0, maxInputTokens: 0, maxOutputTokens: 0, maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0, maxConcurrentExternalOperations: 1, expiresAt, authorizedBy: 'restore-drill', grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null, githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null, acceptancePurpose: null, limits, expiresAt: expiresAt.toISOString(), authorizedBy: 'restore-drill' }), createdAt: expiresAt });
  const acceptance = { id: randomUUID(), version: 1, kind: 'security_cost_control', state: 'passed', boundaryVersion: 'restore-drill-v1', releasedCommitSha: '7'.repeat(40), protocolVersion: null, workspaceId, repairRunId: null, repairLoopId: null, repairLoopIterationId: null, aiCandidateGenerationId: null, repairCandidateId: null, candidateIdentity: null, candidateVerificationId: null, verificationEvidenceId: null, verificationEvidenceIdentity: null, objectiveContractHash: null, objectiveEvidenceHash: null, humanReviewDecisionId: null, repairPublicationId: null, providerId: null, modelId: null, sandboxExecutionIdentity: null, executionBudgetGrantId: grantId, executionReservationIds: [] as string[], reviewedBy: 'restore-drill', acceptedAt: expiresAt, acceptanceIdentity: '', createdAt: expiresAt } satisfies typeof releaseAcceptance.$inferInsert;
  acceptance.acceptanceIdentity = computeReleaseAcceptanceIdentity(acceptanceIdentityPayload(acceptance as typeof releaseAcceptance.$inferSelect));
  await database.insert(releaseAcceptance).values(acceptance);
  return { publicationId: publication.id, fingerprints: { baselineId, candidateIdentity, evidenceId, decisionIdentity: decision.decisionIdentity, publicationId: publication.id, acceptanceIdentity: acceptance.acceptanceIdentity } };
}

let source: ReturnType<typeof postgres> | undefined;
let restored: ReturnType<typeof postgres> | undefined;
let boss: Awaited<ReturnType<typeof createRepairBoss>> | undefined;
try {
  await admin.unsafe(`create database "${sourceName}"`);
  source = postgres(sourceUrl.toString(), { max: 3, prepare: false });
  const sourceDatabase = drizzle(source, { schema });
  await migrate(sourceDatabase, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const fixture = await seedRepresentativeState(sourceDatabase);
  boss = await createRepairBoss(sourceUrl.toString(), 'publisher');
  const baselineJobId = randomUUID();
  assert.equal(await boss.send(REPAIR_BASELINE_QUEUE, { version: 1, repairRunId: baselineJobId }, { id: baselineJobId, startAfter: 3600 }), baselineJobId);
  assert.equal(await boss.send(REPAIR_PUBLICATION_QUEUE, { version: 1, publicationId: fixture.publicationId }, { id: fixture.publicationId, startAfter: 3600 }), fixture.publicationId);
  await boss.stop({ graceful: false }); boss = undefined;
  await source.end({ timeout: 2 }); source = undefined;

  const container = await findDatabaseContainer();
  const databaseUser = decodeURIComponent(configuredUrl.username);
  const archive = await command('docker', ['exec', container, 'pg_dump', '-Fc', '--no-owner', '--no-privileges', '-U', databaseUser, '-d', sourceName]);
  if (archive.byteLength < 1024) throw new Error('backup_drill_archive_too_small');
  await writeFile(archivePath, archive, { mode: 0o600 });
  const archiveBytes = await readFile(archivePath);
  const listing = await command('docker', ['exec', '-i', container, 'pg_restore', '--list'], archiveBytes);
  if (!listing.includes(Buffer.from('drizzle'))) throw new Error('backup_drill_archive_validation_failed');
  await admin.unsafe(`create database "${restoredName}"`);
  await command('docker', ['exec', '-i', container, 'pg_restore', '--no-owner', '--no-privileges', '-U', databaseUser, '-d', restoredName], archiveBytes);
  restored = postgres(restoredUrl.toString(), { max: 2, prepare: false });
  const restoredDatabase = drizzle(restored, { schema });
  const ledger = await restored<{ hash: string; createdAt: string }[]>`select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id`;
  assert.equal(validateMigrationLedger(ledger), 'complete');
  const [facts] = await restored<{ baselineId: string; candidateIdentity: string; evidenceId: string; decisionIdentity: string; publicationId: string; acceptanceIdentity: string; heartbeat: string | null; bucket: string | null; jobs: number; activeAuthority: number }[]>`
    select v.baseline_id as "baselineId", c.candidate_identity as "candidateIdentity", v.evidence_id as "evidenceId", h.decision_identity as "decisionIdentity",
      p.id as "publicationId", a.acceptance_identity as "acceptanceIdentity",
      to_regclass('public.operational_worker_heartbeat')::text as heartbeat,
      to_regclass('public.http_rate_limit_bucket')::text as bucket,
      (select count(*)::int from pgboss.job where id in (${fixture.publicationId}::uuid, ${baselineJobId}::uuid)) as jobs,
      (select count(*)::int from execution_budget_grant g where g.expires_at > statement_timestamp() and not exists (select 1 from execution_budget_grant_revocation r where r.grant_id = g.id)) as "activeAuthority"
    from repair_candidate c join candidate_verification v on v.candidate_id = c.id
      join human_review_decision h on h.repair_candidate_id = c.id
      join repair_publication p on p.human_review_decision_id = h.id
      join release_acceptance a on a.kind = 'security_cost_control' limit 1
  `;
  assert.deepEqual(facts && { baselineId: facts.baselineId, candidateIdentity: facts.candidateIdentity, evidenceId: facts.evidenceId, decisionIdentity: facts.decisionIdentity, publicationId: facts.publicationId, acceptanceIdentity: facts.acceptanceIdentity }, fixture.fingerprints);
  assert.equal(facts?.heartbeat, 'operational_worker_heartbeat'); assert.equal(facts?.bucket, 'http_rate_limit_bucket');
  assert.equal(facts?.jobs, 2); assert.equal(facts?.activeAuthority, 0);
  let gatewayCalls = 0;
  const unavailable = new Proxy({}, { get: () => async () => { gatewayCalls += 1; throw new Error('external_transport_forbidden'); } });
  const recovery = await processRepairPublicationJob({ id: fixture.publicationId, data: { version: 1, publicationId: fixture.publicationId } } as never, {
    database: restoredDatabase, configuration: { appId: 1, clientId: 'unused', appSlug: 'vigilo', baseUrl: 'https://worker.invalid' },
    gateway: unavailable as never, logger: { write() {} }, clock: () => NOW,
  });
  assert.equal(recovery.status, 'completed'); assert.equal(gatewayCalls, 0);
  const baselineRecovery = await processRepairJob({ id: baselineJobId, data: { version: 1, repairRunId: baselineJobId } } as never, {
    database: restoredDatabase, configuration: { appId: 1, clientId: 'unused', appSlug: 'vigilo', baseUrl: 'https://worker.invalid' },
    gateway: unavailable as never, logger: { write() {} }, clock: () => NOW,
  });
  assert.deepEqual(baselineRecovery, { id: baselineJobId, status: 'deadletter', output: { code: 'run_not_found' } });
  assert.equal(gatewayCalls, 0);
  process.stdout.write(`${JSON.stringify({ migrations: '0000-0023', archive: 'validated', representativeJobs: 2, identities: 'preserved', effectiveExternalAuthority: 0, restoredRecoveryExternalCalls: 0, result: 'passed' })}\n`);
} finally {
  try { await boss?.stop({ graceful: false }); } catch { /* best effort */ }
  try { await source?.end({ timeout: 1 }); } catch { /* best effort */ }
  try { await restored?.end({ timeout: 1 }); } catch { /* best effort */ }
  try { await admin.unsafe(`drop database if exists "${restoredName}" with (force)`); } catch { /* report original error */ }
  try { await admin.unsafe(`drop database if exists "${sourceName}" with (force)`); } catch { /* report original error */ }
  await admin.end({ timeout: 1 });
  await rm(scratch, { recursive: true, force: true });
}
