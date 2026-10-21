import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { executionProfile, githubInstallation, repairRun, repository, repositoryBaseline, user, workspace } from '../db/schema.ts';
import { MIGRATION_MANIFEST, validateMigrationFiles } from '../lib/operations/migrations.ts';

const migrationsFolder = resolve(process.cwd(), 'drizzle');
const now = new Date('2031-01-02T03:04:05.000Z');

test('disposable 0024→current upgrade preserves repository, profile, eight runs, and fourteen baselines', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'vigilo-selection-upgrade-'));
  const client = new PGlite();
  t.after(async () => { await client.close(); await rm(folder, { recursive: true, force: true }); });
  await mkdir(join(folder, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  assert.equal(journal.entries.length, 27);
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 25) }));
  for (const entry of journal.entries.slice(0, 25)) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }

  const database = drizzle(client);
  await migrate(database, { migrationsFolder: folder });
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const repositoryId = 72001;
  const installationId = 73001;
  const profileIdentity = 'a'.repeat(64);
  const commit = 'b'.repeat(40);
  await database.insert(user).values({ id: userId, name: 'Migration operator', email: `${userId}@test.invalid`, emailVerified: true });
  await database.insert(workspace).values({ id: workspaceId, ownerUserId: userId });
  await database.insert(githubInstallation).values({ installationId, workspaceId, githubAccountId: 74001,
    accountLogin: 'fixture', accountType: 'User', status: 'active' });
  await client.query(`insert into repository
    (github_repository_id,workspace_id,installation_id,owner_id,owner_login,name,full_name,default_branch,is_private)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [repositoryId, workspaceId, installationId, 74001, 'fixture', 'old', 'fixture/old', 'main', false]);
  await database.insert(executionProfile).values({ githubRepositoryId: repositoryId, workspaceId, installationId,
    profileVersion: 2, profileIdentity, baseCommitSha: commit, runtimeFamily: 'node', nodeMajor: 24,
    packageManager: 'npm', lockfileType: 'package-lock', installOperation: 'ci', typecheckScript: 'typecheck',
    buildScript: 'build', testScript: 'test', testRunner: 'node-test', packageJsonBlobSha: 'c'.repeat(40),
    packageJsonContentSha256: 'd'.repeat(64), packageLockBlobSha: 'e'.repeat(40),
    packageLockContentSha256: 'f'.repeat(64), status: 'ready' });

  const baselineIds: string[] = [];
  for (let index = 0; index < 14; index += 1) {
    const id = randomUUID();
    baselineIds.push(id);
    await database.insert(repositoryBaseline).values({ id, workspaceId, githubRepositoryId: repositoryId,
      installationId, evidenceVersion: 1, profileIdentity, baseCommitSha: commit,
      archiveSha256: '1'.repeat(64), sandboxName: `historical-${index}`,
      sourceIdentityBefore: '2'.repeat(64), sourceIdentityAfter: '2'.repeat(64), sourceUnchanged: true,
      credentialsExposure: 'absent', networkPolicy: 'deny-all', installStatus: 'completed', installExitCode: 0,
      installTimedOut: false, typecheckStatus: 'completed', typecheckExitCode: 0, typecheckTimedOut: false,
      buildStatus: 'completed', buildExitCode: 0, buildTimedOut: false, testStatus: 'completed', testExitCode: 0,
      testTimedOut: false, executionOutcome: 'baseline_passed', overallOutcome: 'baseline_passed',
      cleanupStop: 'confirmed', cleanupDelete: 'confirmed', cleanupLookup: 'absent',
      startedAt: now, completedAt: now, durationMs: 1 });
  }
  const runIds: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = randomUUID();
    runIds.push(id);
    await database.insert(repairRun).values({ id, workspaceId, githubRepositoryId: repositoryId,
      installationId, profileIdentity, baseCommitSha: commit, idempotencyKey: randomUUID(),
      state: 'ready_for_investigation', baselineId: baselineIds[index]!, baselineOutcome: 'baseline_passed',
      baselineStartedAt: now, completedAt: now, stateChangedAt: now, updatedAt: now });
  }
  const historicalLedger = (await client.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle.__drizzle_migrations order by id')).rows;
  assert.equal(historicalLedger.length, 25);

  await migrate(database, { migrationsFolder });
  await validateMigrationFiles(process.cwd());
  const ledger = (await client.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle.__drizzle_migrations order by id')).rows;
  assert.equal(ledger.length, 27);
  assert.deepEqual(ledger.slice(0, 25), historicalLedger);
  assert.deepEqual(ledger.map((row) => row.hash), MIGRATION_MANIFEST.map((entry) => entry.hash));
  assert.equal(ledger[25]?.hash, createHash('sha256').update(await readFile(join(migrationsFolder,
    '0025_repository-selection-history.sql'))).digest('hex'));

  const [retained] = await database.select().from(repository).where(eq(repository.githubRepositoryId, repositoryId));
  assert.equal(retained?.workspaceId, workspaceId);
  assert.equal(retained?.isSelected, true);
  assert.equal((await database.select().from(executionProfile))[0]?.profileIdentity, profileIdentity);
  assert.deepEqual((await database.select({ id: repairRun.id }).from(repairRun)).map((row) => row.id).sort(), runIds.sort());
  assert.deepEqual((await database.select({ id: repositoryBaseline.id }).from(repositoryBaseline)).map((row) => row.id).sort(), baselineIds.sort());

  const indexRows = await client.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where indexname = 'repository_one_selected_per_workspace_unique'");
  assert.match(indexRows.rows[0]?.indexdef ?? '', /UNIQUE INDEX.*workspace_id.*WHERE.*is_selected/i);
  await assert.rejects(database.insert(repository).values({ githubRepositoryId: 72002, workspaceId, installationId,
    ownerId: 74001, ownerLogin: 'fixture', name: 'other', fullName: 'fixture/other',
    defaultBranch: 'main', isPrivate: false, isSelected: true }));
  await database.insert(repository).values({ githubRepositoryId: 72002, workspaceId, installationId,
    ownerId: 74001, ownerLogin: 'fixture', name: 'other', fullName: 'fixture/other',
    defaultBranch: 'main', isPrivate: false, isSelected: false });
  assert.equal((await database.select().from(executionProfile)).length, 1);
});
