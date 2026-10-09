import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';

import * as schema from '../db/schema.ts';
import { DurableExternalExecutionAuthorizer } from '../lib/external-execution/authority.ts';
import { computeExecutionGrantIdentity } from '../lib/external-execution/identity.ts';
import type { ExternalExecutionAmounts, ExternalExecutionScope } from '../lib/external-execution/types.ts';

// Deliberately accepts no URL or environment configuration. The only database
// target is constructed from this script's newly owned RAM-backed container.
if (process.argv.length !== 2) throw new Error('disposable_probe_accepts_no_database_configuration');
const image = 'postgres:17-alpine';
const name = `vigilo-envelope-test-${randomUUID()}`;
const label = 'vigilo.disposable-live-envelope';
const password = randomUUID(); // Generated test credential; never logged.
let containerId: string | undefined;
const clients: ReturnType<typeof postgres>[] = [];
const docker = (...args: string[]) => {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim(); }
  catch { throw new Error(`disposable_docker_command_failed:${args[0]}`); }
};
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const pending = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
const expectFailure = (result: unknown, code: string) => {
  assert.ok(result && typeof result === 'object' && 'error' in result);
  assert.ok(result.error instanceof Error);
  assert.equal(result.error.message, code);
};
function migrationsDirectory(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1, root = dirname(root)) {
    if (existsSync(join(root, 'package.json')) && existsSync(join(root, 'drizzle/meta/_journal.json'))) return join(root, 'drizzle');
  }
  throw new Error('repository_migration_directory_unavailable');
}

let stage = 'owned_container_preflight';
let report: Record<string, unknown> | undefined;
try {
  docker('image', 'inspect', image); // Cached image only; no pull or registry call.
  containerId = docker('run', '--pull=never', '--rm', '--detach', '--name', name,
    '--label', `${label}=true`, '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,noexec,size=268435456',
    '--env', 'POSTGRES_USER=vigilo_envelope_test', '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', 'POSTGRES_DB=vigilo_envelope_test', image);
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const [identity] = JSON.parse(docker('inspect', containerId));
  assert.equal(identity.Name, `/${name}`);
  assert.equal(identity.Config.Labels[label], 'true');
  assert.equal(identity.Config.Image, image);
  assert.equal(identity.HostConfig.AutoRemove, true);
  assert.equal(identity.Mounts.some((mount: { Type: string }) => ['volume', 'bind'].includes(mount.Type)), false);
  assert.equal(Object.hasOwn(identity.HostConfig.Tmpfs, '/var/lib/postgresql/data'), true);
  const [binding] = identity.NetworkSettings.Ports['5432/tcp'];
  assert.equal(binding.HostIp, '127.0.0.1');
  assert.match(binding.HostPort, /^\d+$/);
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    // The entrypoint uses a temporary Unix-socket server during initialization.
    // Wait for the final TCP listener, not that intermediate init server.
    try { docker('exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'vigilo_envelope_test', '-d', 'vigilo_envelope_test'); ready = true; break; }
    catch { await delay(100); }
  }
  assert.equal(ready, true, 'owned disposable database must become ready');
  const url = `postgres://vigilo_envelope_test:${password}@127.0.0.1:${binding.HostPort}/vigilo_envelope_test`;
  const connect = (applicationName: string) => {
    const client = postgres(url, { max: 1, prepare: false, connect_timeout: 5,
      connection: { application_name: applicationName, statement_timeout: 8_000, lock_timeout: 5_000 },
      onnotice: () => undefined });
    clients.push(client); return client;
  };
  const a = connect('vigilo-envelope-a'); const b = connect('vigilo-envelope-b'); const observer = connect('vigilo-envelope-observer');
  stage = 'disposable_connection_identity';
  const [aIdentity] = await a`select current_database() as database_name, current_user as role_name, pg_backend_pid() as pid`;
  const [bIdentity] = await b`select pg_backend_pid() as pid`;
  assert.equal(aIdentity?.database_name, 'vigilo_envelope_test'); assert.equal(aIdentity?.role_name, 'vigilo_envelope_test');
  assert.notEqual(aIdentity?.pid, bIdentity?.pid);
  const migrationsFolder = migrationsDirectory();
  stage = 'disposable_migrations';
  await migrate(drizzle(a), { migrationsFolder });
  const history = await a`select hash from drizzle.__drizzle_migrations order by created_at, id`;
  assert.deepEqual(history.map((row) => row.hash), readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash));
  assert.equal(history.length, 24);

  const databaseA = drizzle(a, { schema }); const databaseB = drizzle(b, { schema });
  const now = new Date(); const expiresAt = new Date(now.getTime() + 3_600_000); const accountId = randomUUID();
  const limits = { logicalRequests: 100, providerAttempts: 100, inputTokens: 100_000, outputTokens: 100_000,
    sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0, maxConcurrentExternalOperations: 2 };
  await databaseA.insert(schema.executionBudgetGrant).values({ id: accountId, version: 1, scope: 'account',
    maxLogicalRequests: limits.logicalRequests, maxProviderAttempts: limits.providerAttempts,
    maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens, maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0,
    maxVerificationAttempts: 0, maxRepairLoopIterations: 0, maxConcurrentExternalOperations: 2,
    expiresAt, authorizedBy: 'disposable-test', createdAt: now,
    grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'account', workspaceId: null, repairRunId: null,
      githubRepositoryId: null, baseCommitSha: null, operationCategory: null, providerId: null, modelId: null,
      acceptancePurpose: null, limits, expiresAt: expiresAt.toISOString(), authorizedBy: 'disposable-test' }) });
  const amounts: ExternalExecutionAmounts = { logicalRequests: 1, providerAttempts: 1, inputTokens: 1, outputTokens: 1,
    sandboxIdentities: 0, sandboxRuntimeMs: 0, verificationAttempts: 0, repairLoopIterations: 0 };
  const seed = async () => {
    const userId = randomUUID(); const workspaceId = randomUUID(); const repairRunId = randomUUID(); const grantId = randomUUID();
    await databaseA.insert(schema.user).values({ id: userId, name: 'Synthetic operator', email: `${userId}@test.invalid`, emailVerified: true });
    await databaseA.insert(schema.workspace).values({ id: workspaceId, ownerUserId: userId });
    await databaseA.insert(schema.repairRun).values({ id: repairRunId, workspaceId, githubRepositoryId: 42, installationId: 77,
      profileIdentity: 'b'.repeat(64), baseCommitSha: 'a'.repeat(40), idempotencyKey: randomUUID(), state: 'created' });
    const scope: ExternalExecutionScope = { workspaceId, repairRunId, githubRepositoryId: 42, baseCommitSha: 'a'.repeat(40),
      operationCategory: 'gemini_investigation', providerId: 'google', modelId: 'gemini-3.1-flash-lite' };
    const operationLimits = { ...limits, logicalRequests: 10, providerAttempts: 10, maxConcurrentExternalOperations: 0 };
    await databaseA.insert(schema.executionBudgetGrant).values({ id: grantId, version: 1, scope: 'operation',
      ...scope, maxLogicalRequests: 10, maxProviderAttempts: 10, maxInputTokens: limits.inputTokens, maxOutputTokens: limits.outputTokens,
      maxSandboxIdentities: 0, maxSandboxRuntimeMs: 0, maxVerificationAttempts: 0, maxRepairLoopIterations: 0,
      maxConcurrentExternalOperations: 0, expiresAt, authorizedBy: 'disposable-test', createdAt: now,
      grantIdentity: computeExecutionGrantIdentity({ version: 1, scope: 'operation', workspaceId, repairRunId,
        githubRepositoryId: 42, baseCommitSha: scope.baseCommitSha!, operationCategory: scope.operationCategory,
        providerId: scope.providerId, modelId: scope.modelId!, acceptancePurpose: null, limits: operationLimits,
        expiresAt: expiresAt.toISOString(), authorizedBy: 'disposable-test' }) });
    return { scope, grantId };
  };
  const blocked = async (connection: postgres.TransactionSql, applicationName: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [activity] = await connection`select wait_event_type as type from pg_stat_activity where application_name = ${applicationName}`;
      if (activity?.type === 'Lock') return;
      await delay(10);
    }
    throw new Error('expected_independent_connection_lock_wait');
  };
  const passed: string[] = [];
  const check = async (title: string, operation: () => Promise<void>) => { stage = title; await operation(); passed.push(title); };
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls += 1; return Response.json({ ok: true }); };

  await check('ambiguity completion wins admission atomically across independent connections', async () => {
    const { scope } = await seed(); const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: fakeFetch });
    const second = new DurableExternalExecutionAuthorizer(databaseB, { fetch: fakeFetch });
    const permit = await first.reserve({ scope, amounts }); const ordinal = await permit.beginProviderAttempt();
    let finish!: ReturnType<typeof pending<void>>; let admission!: ReturnType<typeof pending<Awaited<ReturnType<typeof second.reserve>>>>;
    await observer.begin(async (transaction) => {
      await transaction`select id from external_execution_semaphore where id = 'global' for update`;
      finish = pending(permit.finishProviderAttempt(ordinal, 'ambiguous')); await blocked(transaction, 'vigilo-envelope-a');
      admission = pending(second.reserve({ scope, amounts })); await blocked(transaction, 'vigilo-envelope-b');
    });
    assert.equal(Object.hasOwn(await finish, 'error'), false); expectFailure(await admission, 'provider_attempt_ambiguous');
    await permit.complete('ambiguous', 'provider_attempt_ambiguous');
    const after = await Promise.all([pending(first.reserve({ scope, amounts })), pending(second.reserve({ scope, amounts }))]);
    after.forEach((result) => expectFailure(result, 'provider_attempt_ambiguous')); assert.equal(calls, 0);
  });

  await check('admission before ambiguity cannot later begin provider transport', async () => {
    const { scope } = await seed(); const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: fakeFetch });
    const second = new DurableExternalExecutionAuthorizer(databaseB, { fetch: fakeFetch });
    const permit = await first.reserve({ scope, amounts }); const ordinal = await permit.beginProviderAttempt();
    let admission!: ReturnType<typeof pending<Awaited<ReturnType<typeof second.reserve>>>>; let finish!: ReturnType<typeof pending<void>>;
    await observer.begin(async (transaction) => {
      await transaction`select id from external_execution_semaphore where id = 'global' for update`;
      admission = pending(second.reserve({ scope, amounts })); await blocked(transaction, 'vigilo-envelope-b');
      finish = pending(permit.finishProviderAttempt(ordinal, 'ambiguous')); await blocked(transaction, 'vigilo-envelope-a');
    });
    const admitted = await admission; assert.ok('value' in admitted); assert.equal(Object.hasOwn(await finish, 'error'), false);
    await assert.rejects(admitted.value.meteredFetch('https://provider.invalid'), /provider_attempt_ambiguous/);
    await admitted.value.complete('failed', 'provider_attempt_ambiguous'); await permit.complete('ambiguous', 'provider_attempt_ambiguous');
    assert.equal(calls, 0);
  });

  await check('expired unmatched start fences restart and changed operation identity', async () => {
    const { scope } = await seed(); let clock = new Date();
    const first = new DurableExternalExecutionAuthorizer(databaseA, { clock: () => clock, leaseMs: 10, fetch: fakeFetch });
    const permit = await first.reserve({ scope, amounts }); await permit.beginProviderAttempt(); clock = new Date(clock.getTime() + 11);
    const restarted = new DurableExternalExecutionAuthorizer(databaseB, { clock: () => clock, fetch: fakeFetch });
    await assert.rejects(restarted.reserve({ scope, amounts, operationKey: randomUUID() }), /provider_attempt_ambiguous/);
    await permit.complete('failed'); assert.equal(calls, 0);
  });

  await check('lease expiry between reservation and transport denies dispatch', async () => {
    const { scope } = await seed(); let clock = new Date();
    const first = new DurableExternalExecutionAuthorizer(databaseA, { clock: () => clock, leaseMs: 10, fetch: fakeFetch });
    const permit = await first.reserve({ scope, amounts }); clock = new Date(clock.getTime() + 11);
    await assert.rejects(permit.meteredFetch('https://provider.invalid'), /execution_authority_expired/);
    await permit.complete('failed'); assert.equal(calls, 0);
  });

  await check('grant revocation and attempt admission do not deadlock or dispatch stale authority', async () => {
    const { scope, grantId } = await seed(); const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: fakeFetch });
    const permit = await first.reserve({ scope, amounts }); let admission!: ReturnType<typeof pending<number>>;
    await b.begin(async (transaction) => {
      await transaction`select id from execution_budget_grant where id = ${grantId} for update`;
      admission = pending(permit.beginProviderAttempt()); await blocked(transaction, 'vigilo-envelope-a');
      await transaction`insert into execution_budget_grant_revocation (id, grant_id, revoked_by, reason_code) values (${randomUUID()}, ${grantId}, 'disposable-test', 'test_revoked')`;
    });
    expectFailure(await admission, 'execution_authority_missing'); await permit.complete('failed', 'execution_authority_missing'); assert.equal(calls, 0);
  });

  await check('late success after sibling ambiguity cannot become durable success', async () => {
    const { scope } = await seed();
    const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: fakeFetch });
    const second = new DurableExternalExecutionAuthorizer(databaseB, { fetch: fakeFetch });
    const late = await first.reserve({ scope, amounts }); const sibling = await second.reserve({ scope, amounts });
    const lateOrdinal = await late.beginProviderAttempt(); const siblingOrdinal = await sibling.beginProviderAttempt();
    await sibling.finishProviderAttempt(siblingOrdinal, 'ambiguous');
    await assert.rejects(late.finishProviderAttempt(lateOrdinal, 'succeeded'), /provider_attempt_ambiguous/);
    await late.complete('succeeded'); // Unresolved on-wire attempt is conservatively ambiguous, never success.
    await sibling.complete('ambiguous');
    const events = await observer`select event_type from external_execution_event where reservation_id = ${late.reservationId}`;
    assert.equal(events.some((event) => ['attempt_succeeded', 'completed'].includes(event.event_type)), false);
    const [lease] = await observer`select state from external_execution_lease where reservation_id = ${late.reservationId}`;
    assert.equal(lease?.state, 'ambiguous');
  });

  await check('reservation completion rechecks a newly activated sibling fence', async () => {
    const { scope } = await seed();
    const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: fakeFetch });
    const second = new DurableExternalExecutionAuthorizer(databaseB, { fetch: fakeFetch });
    const late = await first.reserve({ scope, amounts }); const sibling = await second.reserve({ scope, amounts });
    const lateOrdinal = await late.beginProviderAttempt(); const siblingOrdinal = await sibling.beginProviderAttempt();
    await late.finishProviderAttempt(lateOrdinal, 'succeeded');
    await sibling.finishProviderAttempt(siblingOrdinal, 'ambiguous');
    await assert.rejects(late.complete('succeeded'), /provider_attempt_ambiguous/);
    await late.complete('failed', 'provider_attempt_ambiguous'); await sibling.complete('ambiguous');
    const events = await observer`select event_type from external_execution_event where reservation_id = ${late.reservationId}`;
    assert.equal(events.some((event) => event.event_type === 'completed'), false);
  });

  await check('late attempt success after ownership expiry is rejected', async () => {
    const { scope } = await seed(); let clock = new Date();
    const first = new DurableExternalExecutionAuthorizer(databaseA, { clock: () => clock, leaseMs: 10, fetch: fakeFetch });
    const late = await first.reserve({ scope, amounts }); const ordinal = await late.beginProviderAttempt();
    clock = new Date(clock.getTime() + 11);
    await assert.rejects(late.finishProviderAttempt(ordinal, 'succeeded'), /execution_authority_expired/);
    await late.complete('ambiguous');
    const events = await observer`select event_type from external_execution_event where reservation_id = ${late.reservationId}`;
    assert.equal(events.some((event) => event.event_type === 'attempt_succeeded'), false);
  });

  await check('late attempt success after durable grant revocation is rejected', async () => {
    const { scope, grantId } = await seed();
    const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: fakeFetch });
    const late = await first.reserve({ scope, amounts }); const ordinal = await late.beginProviderAttempt();
    await b`insert into execution_budget_grant_revocation (id, grant_id, revoked_by, reason_code) values (${randomUUID()}, ${grantId}, 'disposable-test', 'test_revoked')`;
    await assert.rejects(late.finishProviderAttempt(ordinal, 'succeeded'), /execution_authority_missing/);
    await late.complete('ambiguous');
    const events = await observer`select event_type from external_execution_event where reservation_id = ${late.reservationId}`;
    assert.equal(events.some((event) => event.event_type === 'attempt_succeeded'), false);
  });

  await check('provider I/O holds no semaphore, grant, or lease locks', async () => {
    const { scope, grantId } = await seed(); let permitId = '';
    const first = new DurableExternalExecutionAuthorizer(databaseA, { fetch: async () => {
      calls += 1;
      await observer.begin(async (transaction) => {
        await transaction`select id from external_execution_semaphore where id = 'global' for update nowait`;
        await transaction`select id from execution_budget_grant where id in (${grantId}, ${accountId}) order by id for update nowait`;
        await transaction`select reservation_id from external_execution_lease where reservation_id = ${permitId} for update nowait`;
      });
      return Response.json({ ok: true });
    } });
    const permit = await first.reserve({ scope, amounts }); permitId = permit.reservationId;
    await permit.meteredFetch('https://provider.invalid'); await permit.complete('succeeded'); assert.equal(calls, 1);
  });
  stage = 'disposable_historical_migration_reconciliation';
  const reconciliation = JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', join(dirname(migrationsFolder), 'integration-test/migration-reconciliation-postgres.ts')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      env: { PATH: process.env.PATH, DATABASE_URL: url } }).trim());
  assert.equal(reconciliation.cleanInstall, 'passed'); assert.equal(reconciliation.historicalUpgrade, 'passed');
  assert.equal(reconciliation.finalSchemaComparison, 'equal'); assert.equal(reconciliation.representativeRows, 'preserved');
  assert.equal(reconciliation.failClosedCases.length, 6);
  report = { result: 'passed', checks: passed.length, migrations: history.length,
    historicalReconciliation: 'passed', failClosedReconciliationCases: reconciliation.failClosedCases.length,
    independentConnections: true, fakeTransportDispatches: calls, persistentDatabaseAccess: false, externalProviderAccess: false };
} catch (error) {
  // No URL, generated credential, SQL parameters, or provider response is logged.
  console.error(JSON.stringify({ result: 'failed', stage, errorType: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof postgres.PostgresError ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
} finally {
  try { await Promise.all(clients.map((client) => client.end({ timeout: 5 }))); }
  finally {
    if (containerId) {
      const [owned] = JSON.parse(docker('inspect', containerId));
      assert.equal(owned.Id, containerId); assert.equal(owned.Name, `/${name}`); assert.equal(owned.Config.Labels[label], 'true');
      assert.equal(docker('stop', '--timeout=1', containerId), containerId); // --rm removes only our container/RAM storage.
      assert.equal(docker('ps', '--all', '--filter', `id=${containerId}`, '--format', '{{.ID}}'), '');
    }
  }
}
if (report && process.exitCode !== 1) console.log(JSON.stringify({ ...report, ownedContainerRemoved: true }));
