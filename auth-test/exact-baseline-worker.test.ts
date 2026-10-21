import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseExactBaselineArguments, assertExactPgBossCompatibility } from '../lib/repair-runs/exact-baseline-job.ts';
import { runReviewedRetirementCommand } from '../lib/external-execution/reviewed-retirement-cli.ts';
import { createCanonicalRepairSupervisor, startCanonicalRepairSupervision, superviseCanonicalRepairQueues } from '../lib/operations/queue-supervision.ts';
import { canonicalRepairQueues } from '../lib/operations/queues.ts';
import { REVIEWED_BASELINE_QUEUE } from '../lib/repair-runs/queue.ts';

const run = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const sha = 'b'.repeat(40);
const args = ['--repair-run', run, '--job', run, '--plan-identity', hash,
  '--repository-id', '1411517943', '--revision', sha, '--release', sha];

test('exact baseline operator arguments reject arbitrary queue, duplicates, and changed identities', () => {
  assert.deepEqual(parseExactBaselineArguments(args), {
    repairRunId: run, jobId: run, planIdentity: hash, repositoryId: 1411517943, revision: sha, releaseSha: sha,
  });
  for (const candidate of [
    [...args, '--queue', 'ai-investigation-v1'],
    [...args.slice(0, -2), '--job', run],
    args.map((value, index) => index === 3 ? '22222222-2222-4222-8222-222222222222' : value),
    args.map((value, index) => index === 7 ? '1.5' : value),
    args.map((value, index) => index === 9 ? 'invalid' : value),
    args.map((value, index) => index === 11 ? 'invalid' : value),
  ]) assert.throws(() => parseExactBaselineArguments(candidate), /exact_job_invalid/);
  assert.doesNotThrow(assertExactPgBossCompatibility);
});

test('one-shot entrypoint has no broad queue or consumer registration', () => {
  const source = readFileSync(path.join(process.cwd(), 'worker/baseline-once.ts'), 'utf8');
  const service = readFileSync(path.join(process.cwd(), 'lib/repair-runs/one-shot-service.ts'), 'utf8');
  assert.doesNotMatch(source, /createRepairBoss|\.work\(|retryStale|recoverPending/);
  assert.doesNotMatch(service, /\.work\(|createRepairBoss|AI_INVESTIGATION_QUEUE|REPAIR_LOOP_QUEUE/);
  assert.match(service, /claimExactReviewedBaselineJob/);
  assert.match(service, /boss\.complete\(REVIEWED_BASELINE_QUEUE, claimed\.id\)/);
});

test('reviewed baseline jobs have a fixed queue separate from the general baseline consumer', () => {
  const queue = readFileSync(path.join(process.cwd(), 'lib/repair-runs/queue.ts'), 'utf8');
  const worker = readFileSync(path.join(process.cwd(), 'worker/main.ts'), 'utf8');
  const claim = readFileSync(path.join(process.cwd(), 'lib/repair-runs/exact-baseline-job.ts'), 'utf8');
  assert.match(queue, /REVIEWED_BASELINE_QUEUE = 'repair-baseline-reviewed-v1'/);
  assert.match(queue, /boss\.send\(REVIEWED_BASELINE_QUEUE, validated/);
  assert.match(worker, /boss\.work<[^\n]+>\(REPAIR_BASELINE_QUEUE/);
  assert.doesNotMatch(worker, /boss\.work<[^\n]+>\(REVIEWED_BASELINE_QUEUE/);
  assert.match(claim, /j\.name = \$\{REVIEWED_BASELINE_QUEUE\}/);
});

test('general worker cannot enable schema-wide pg-boss supervision over the reviewed queue', () => {
  const queue = readFileSync(path.join(process.cwd(), 'lib/repair-runs/queue.ts'), 'utf8');
  const worker = readFileSync(path.join(process.cwd(), 'worker/main.ts'), 'utf8');
  const supervision = readFileSync(path.join(process.cwd(), 'lib/operations/queue-supervision.ts'), 'utf8');
  assert.match(queue, /supervise:\s*false/);
  assert.doesNotMatch(queue, /supervise:\s*role\s*===\s*'worker'/);
  assert.match(worker, /createCanonicalRepairSupervisor/);
  assert.match(worker, /await stopGeneralWorker\(/);
  assert.match(worker, /error instanceof QueueSupervisionShutdownError \|\| error instanceof GeneralWorkerShutdownError/);
  assert.match(worker, /worker shutdown unresolved; exiting fail-closed/);
  assert.match(supervision, /application_name: 'vigilo-queue-supervisor'/);
  assert.match(supervision, /statement_timeout: MAINTENANCE_STATEMENT_TIMEOUT_MS/);
  assert.match(supervision, /lock_timeout: MAINTENANCE_LOCK_TIMEOUT_MS/);
  assert.match(supervision, /migrate: false/);
  assert.match(supervision, /supervise: false/);
});

test('manual general-worker supervision allows only the seven canonical queues', async () => {
  const names: string[] = [];
  await superviseCanonicalRepairQueues({ supervise: async (name?: string) => { names.push(name ?? 'unscoped'); } });
  assert.deepEqual(names, canonicalRepairQueues);
  assert.equal(names.length, 7);
  assert.ok(!names.includes(REVIEWED_BASELINE_QUEUE));
});

test('scheduled normal-queue supervision runs and stops without touching reviewed jobs', async () => {
  const names: string[] = [];
  let firstPass!: () => void;
  const completed = new Promise<void>((resolve) => { firstPass = resolve; });
  const supervisor = startCanonicalRepairSupervision({ stop: async () => {}, supervise: async (name?: string) => {
    names.push(name ?? 'unscoped');
    if (names.length === canonicalRepairQueues.length) firstPass();
  } }, () => assert.fail('canonical supervision must not fail'), 5);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([completed, new Promise<never>((_, reject) =>
      { deadline = setTimeout(() => reject(new Error('canonical_supervision_not_scheduled')), 1_000); })]);
  } finally {
    if (deadline) clearTimeout(deadline);
    await supervisor.stop();
  }
  assert.deepEqual(names, canonicalRepairQueues);
  assert.ok(!names.includes(REVIEWED_BASELINE_QUEUE));
});

test('idle shutdown is idempotent and prevents later scheduled or manual passes', async () => {
  let stops = 0;
  let calls = 0;
  const supervisor = startCanonicalRepairSupervision({
    supervise: async () => { calls++; },
    stop: async () => { stops++; },
  }, () => assert.fail('unexpected supervision error'), 1);
  const first = supervisor.stop();
  assert.equal(supervisor.stop(), first);
  await first;
  await supervisor.runNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stops, 1);
  assert.equal(calls, 0);
});

test('in-flight shutdown waits for the real pass and starts no subsequent queue', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const names: string[] = [];
  const supervisor = startCanonicalRepairSupervision({
    supervise: async (name?: string) => { names.push(name ?? 'unscoped'); entered(); await held; },
    stop: async () => {},
  }, () => assert.fail('unexpected supervision error'));
  const running = supervisor.runNow();
  await started;
  const stopping = supervisor.stop();
  let settled = false;
  void stopping.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release();
  await Promise.all([running, stopping]);
  assert.deepEqual(names, [canonicalRepairQueues[0]]);
});

test('supervision rejection settles before shutdown, while cleanup rejection fails closed', async () => {
  const failedPass = startCanonicalRepairSupervision({
    supervise: async () => { throw new Error('database_unavailable'); },
    stop: async () => {},
  }, () => {});
  await assert.rejects(failedPass.runNow(), /database_unavailable/);
  await failedPass.stop();

  const failedCleanup = startCanonicalRepairSupervision({
    supervise: async () => {},
    stop: async () => { throw new Error('cancel_failed'); },
  }, () => {});
  await assert.rejects(failedCleanup.stop(), /queue_supervision_shutdown_unresolved/);
  await assert.rejects(failedCleanup.stop(), /queue_supervision_shutdown_unresolved/);
});

test('scheduled pass rejection reports safely even when its reporter throws', async () => {
  let reports = 0;
  const supervisor = startCanonicalRepairSupervision({
    supervise: async () => { throw new Error('maintenance_failed'); },
    stop: async () => {},
  }, () => { reports++; throw new Error('reporter_failed'); }, 1);
  try {
    for (let i = 0; i < 50 && reports === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(reports > 0);
  } finally {
    await supervisor.stop();
  }
});

test('failed cancellation of a still-running pass cannot report successful shutdown', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const supervisor = startCanonicalRepairSupervision({
    supervise: async () => { entered(); await new Promise<void>(() => {}); },
    stop: async () => { throw new Error('cancel_failed'); },
  }, () => {});
  void supervisor.runNow().catch(() => undefined);
  await started;
  const began = Date.now();
  await assert.rejects(supervisor.stop(), /queue_supervision_shutdown_unresolved/);
  assert.ok(Date.now() - began >= 7_500 && Date.now() - began < 10_000,
    'unresolved ownership must fail closed at the bounded cleanup deadline');
});

test('maintenance pool creation fails safely when database is unavailable', async () => {
  await assert.rejects(createCanonicalRepairSupervisor('postgres://127.0.0.1:1/vigilo_test', () => {}),
    /queue_supervision_start_failed|queue_supervision_shutdown_unresolved/);
});

test('malformed one-shot process exits promptly before opening database or provider clients', async () => {
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['--import', 'tsx', 'worker/baseline-once.ts', '--queue', 'other'], {
    cwd: process.cwd(), timeout: 5000, env: { PATH: process.env.PATH },
  }), (error: unknown) => {
    assert.equal((error as { killed?: boolean }).killed, false);
    assert.match((error as { stderr?: string }).stderr ?? '', /baseline_one_shot_failed/);
    return true;
  });
});

async function runOneShotWithLocalBossFixture(mode: string, invalidAppId = false, timeout = 4_000) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vigilo-one-shot-start-'));
  try {
    const keyPath = path.join(directory, 'test-key.pem');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(keyPath, key, { mode: 0o600 });
    const child = promisify(execFile);
    try {
      await child(process.execPath, ['--import', 'tsx', '--import',
      './auth-test/fixtures/baseline-once-pg-boss-start.mjs', 'worker/baseline-once.ts', ...args], {
      cwd: process.cwd(), timeout,
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://127.0.0.1:1/vigilo_test',
        GITHUB_APP_ID: invalidAppId ? 'invalid' : '1', GITHUB_APP_SLUG: 'vigilo-test', GITHUB_APP_CLIENT_ID: 'Iv1.test',
        GITHUB_APP_PRIVATE_KEY_PATH: keyPath, VIGILO_RELEASE_SHA: sha,
        VIGILO_TEST_BOSS_START_MODE: mode },
      });
      assert.fail('the test-only one-shot subprocess unexpectedly succeeded');
    } catch (error) {
      return error as { killed?: boolean; code?: number; stderr?: string };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('partially started pg-boss is stopped and the one-shot subprocess exits without provider activity', async () => {
  const failure = await runOneShotWithLocalBossFixture('partial_start');
  assert.equal(failure.killed, false, 'the process must exit without the test timeout killing it');
  assert.equal(failure.code, 1);
  assert.match(failure.stderr ?? '', /fixture_boss_start_attempted/);
  assert.match(failure.stderr ?? '', /fixture_boss_stop_attempted/);
  assert.match(failure.stderr ?? '', /fixture_boss_resources_released/);
  assert.equal(failure.stderr?.match(/fixture_boss_stop_attempted/g)?.length, 1);
  assert.equal(failure.stderr?.match(/fixture_boss_resources_released/g)?.length, 1);
  assert.match(failure.stderr ?? '', /baseline_one_shot_start_failed/);
});

test('successful pg-boss start still receives one stop after a later local failure', async () => {
  const failure = await runOneShotWithLocalBossFixture('started');
  assert.equal(failure.killed, false);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr ?? '', /fixture_boss_start_attempted/);
  assert.match(failure.stderr ?? '', /fixture_boss_stop_attempted/);
  assert.match(failure.stderr ?? '', /fixture_boss_resources_released/);
  assert.equal(failure.stderr?.match(/fixture_boss_stop_attempted/g)?.length, 1);
  assert.equal(failure.stderr?.match(/fixture_boss_resources_released/g)?.length, 1);
});

test('start failure remains primary when pg-boss stop also fails', async () => {
  const failure = await runOneShotWithLocalBossFixture('stop_failure');
  assert.equal(failure.killed, false);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr ?? '', /baseline_one_shot_start_failed[\s\S]*baseline_one_shot_cleanup_failed:boss_stop/);
  assert.match(failure.stderr ?? '', /fixture_boss_stop_attempted/);
  assert.equal(failure.stderr?.match(/fixture_boss_stop_attempted/g)?.length, 1);
  assert.doesNotMatch(failure.stderr ?? '', /fixture_stop_failure/);
});

test('a hanging pg-boss stop is bounded and cannot keep the one-shot process alive', async () => {
  const failure = await runOneShotWithLocalBossFixture('stop_hang', false, 12_000);
  assert.equal(failure.killed, false);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr ?? '', /baseline_one_shot_start_failed[\s\S]*baseline_one_shot_cleanup_failed:boss_stop/);
});

for (const mode of ['reporter_close_failure', 'reporter_close_hang']) {
  test(`one-shot ${mode} exits nonzero with a sanitized reporter-cleanup diagnostic`, async () => {
    const failure = await runOneShotWithLocalBossFixture(mode, false, 12_000);
    assert.equal(failure.killed, false);
    assert.equal(failure.code, 1);
    assert.match(failure.stderr ?? '', /baseline_one_shot_cleanup_failed:heartbeat_client_close/);
    assert.doesNotMatch(failure.stderr ?? '', /fixture_secret_bearing/);
  });
}

test('a failure before pg-boss start does not call stop', async () => {
  const failure = await runOneShotWithLocalBossFixture('partial_start', true);
  assert.equal(failure.killed, false);
  assert.equal(failure.code, 1);
  assert.doesNotMatch(failure.stderr ?? '', /fixture_boss_start_attempted|fixture_boss_stop_attempted/);
});

test('retirement operator accepts only authenticated exact request envelope', async () => {
  const context = { sessionId: 'test', user: { id: 'owner', name: 'Owner', email: 'owner@example.test' },
    githubUserId: 'github', workspace: { id: 'space', ownerUserId: 'owner' } };
  const request = { repairRunId: run, planIdentity: hash, accountGrantIdentity: hash,
    repositoryId: 1411517943, revision: sha, authorizedReleaseSha: sha };
  let retired = 0;
  const dependencies = { resolveContext: async (cookie: string) => {
    assert.equal(cookie, 'session'); return context;
  }, retire: async () => { retired++; return { kind: 'reviewed_stage_retirement' as const,
    repairRunId: run, planIdentity: hash, baselineJobId: run,
    result: 'retired' as const, revokedGrantCount: 6 as const }; } };
  const envelope = { sessionCookie: 'session', actor: { workspaceId: 'space', reviewerUserId: 'owner' }, retirement: request };
  assert.equal((await runReviewedRetirementCommand(envelope, dependencies)).result, 'retired');
  assert.equal(retired, 1);
  await assert.rejects(runReviewedRetirementCommand({ ...envelope, queue: 'other' }, dependencies), /retirement_invalid/);
  await assert.rejects(runReviewedRetirementCommand({ ...envelope, actor: { ...envelope.actor, workspaceId: 'other' } }, dependencies), /retirement_unauthorized/);
  assert.equal(retired, 1);
});
