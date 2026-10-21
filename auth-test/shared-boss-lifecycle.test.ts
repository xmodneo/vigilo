import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

type Entry = 'worker' | 'staging' | 'probe';

async function runEntrypoint(entry: Entry, mode: string, deadlineMs = 4_000, validWorkerConfig = true) {
  const file = entry === 'worker' ? 'worker/main.ts' : entry === 'staging'
    ? 'operations/stage-reviewed-repair-run.ts' : 'auth-test/fixtures/shared-boss-helper-probe.mjs';
  const child = spawn(process.execPath, ['--import', 'tsx', '--import',
    './auth-test/fixtures/shared-boss-lifecycle.mjs', file, ...(entry === 'staging' ? ['--apply'] : [])], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://127.0.0.1:1/vigilo_test',
      VIGILO_RELEASE_SHA: 'a'.repeat(40), BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 's'.repeat(32), GITHUB_CLIENT_ID: 'Iv1.fixture',
      GITHUB_CLIENT_SECRET: 'fixture-only', GITHUB_APP_ID: validWorkerConfig ? '1' : 'invalid', GITHUB_APP_SLUG: 'vigilo-test',
      GITHUB_APP_CLIENT_ID: 'Iv1.fixture', GITHUB_APP_CLIENT_SECRET: 'fixture-only',
      GITHUB_APP_PRIVATE_KEY_PATH: '/nonexistent/vigilo-fixture-key', GEMINI_PROJECT_ID: 'fixture-project',
      VERCEL_TOKEN: 'fixture-opaque-token', VERCEL_TEAM_ID: 'fixture-team', VERCEL_PROJECT_ID: 'fixture-project',
      VIGILO_TEST_SHARED_BOSS_MODE: mode },
  });
  child.stdin.end(entry === 'staging' ? '{}' : undefined);
  let stdout = ''; let stderr = ''; let killedByTest = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => { killedByTest = true; child.kill('SIGTERM'); }, deadlineMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr, killedByTest };
  } finally { clearTimeout(timer); }
}

test('general worker helper cleans partial pg-boss startup before returning ownership', async () => {
  const result = await runEntrypoint('worker', 'partial_start');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_shared_boss_start_attempted/);
  assert.match(result.stderr, /fixture_shared_boss_stop_attempted/);
  assert.match(result.stderr, /fixture_shared_boss_resources_released/);
  assert.match(result.stderr, /fixture_heartbeat_stopped_without_db/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('SIGTERM during actual general-worker startup cancels before any consumer registration', async () => {
  const result = await runEntrypoint('worker', 'signal_during_startup');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /fixture_shared_boss_start_attempted/);
  assert.match(result.stderr, /fixture_shared_boss_resources_released/);
  assert.match(result.stderr, /fixture_heartbeat_stopped_without_db/);
  assert.doesNotMatch(result.stderr, /fixture_shared_boss_work_registered/);
});

test('general worker helper owns boss until queue configuration succeeds', async () => {
  const result = await runEntrypoint('worker', 'configuration_failure');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_shared_boss_queue_config_attempted/);
  assert.match(result.stderr, /fixture_shared_boss_resources_released/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
});

test('reviewed staging CLI inherits helper cleanup without business or provider execution', async () => {
  const result = await runEntrypoint('staging', 'partial_start');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_staging_apply_called/);
  assert.match(result.stderr, /fixture_shared_boss_resources_released/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('successful helper transfer leaves one normal stop to general worker caller', async () => {
  const result = await runEntrypoint('worker', 'success');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1); // Fake private-key path fails after fully configured boss returns.
  assert.match(result.stderr, /fixture_shared_boss_queue_config_attempted/);
  assert.match(result.stderr, /fixture_shared_boss_resources_released/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
});

test('helper transfers a configured boss without stopping it before caller shutdown', async () => {
  const result = await runEntrypoint('probe', 'success');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /fixture_helper_ownership_transferred[\s\S]*fixture_shared_boss_stop_attempted/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
  assert.match(result.stderr, /fixture_shared_boss_resources_released/);
});

test('helper reports configuration failure as primary after successful startup', async () => {
  const result = await runEntrypoint('probe', 'configuration_failure');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"code":"repair_boss_configuration_failed","cleanupFailed":false/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
});

test('general worker failure before helper start never invokes boss.stop', async () => {
  const result = await runEntrypoint('worker', 'partial_start', 4_000, false);
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /fixture_shared_boss_start_attempted|fixture_shared_boss_stop_attempted/);
});

test('general-worker reporter close failure exits nonzero after execution stops', async () => {
  const result = await runEntrypoint('worker', 'reporter_close_failure');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_heartbeat_stopped_without_db/);
  assert.match(result.stderr, /Vigilo worker shutdown unresolved/);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('helper keeps startup failure primary and reports sanitized failed cleanup', async () => {
  const result = await runEntrypoint('probe', 'start_stop_failure');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"code":"repair_boss_start_failed","cleanupFailed":true/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture_secret_bearing/);
});

test('general worker exits deterministically after bounded hanging helper stop', async () => {
  const result = await runEntrypoint('worker', 'stop_hang', 12_000);
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_shared_boss_start_attempted/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('reviewed staging operator also exits after bounded hanging helper stop', async () => {
  const result = await runEntrypoint('staging', 'stop_hang', 12_000);
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_staging_apply_called/);
  assert.equal(result.stderr.match(/fixture_shared_boss_stop_attempted/g)?.length, 1);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('committed reviewed staging exits non-successfully after bounded hanging caller cleanup', async () => {
  const result = await runEntrypoint('staging', 'post_apply_stop_hang', 12_000);
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_staging_committed_without_db/);
  assert.match(result.stderr, /reviewed_staging_committed_cleanup_unresolved/);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

for (const mode of ['staging_failure_stop_reject', 'staging_failure_stop_hang']) {
  test(`failed staging plus ${mode} reports both failures without claiming commit`, async () => {
    const result = await runEntrypoint('staging', mode, 12_000);
    assert.equal(result.killedByTest, false);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /reviewed_staging_failed_cleanup_unresolved/);
    assert.doesNotMatch(result.stderr, /reviewed_staging_committed_cleanup_unresolved|fixture_secret_bearing/);
  });
}

test('successful staging and successful cleanup retains the normal receipt', async () => {
  const result = await runEntrypoint('staging', 'post_apply_success');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /fixture_staging_committed_without_db/);
  assert.match(result.stdout, /"planIdentity"/);
  assert.doesNotMatch(result.stderr, /reviewed_staging_.*failed|cleanup_unresolved/);
});
