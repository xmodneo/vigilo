import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const envelope = JSON.stringify({ sessionCookie: 'fixture-cookie', actor: { workspaceId: 'fixture', reviewerUserId: 'fixture' },
  retirement: { repairRunId: '11111111-1111-4111-8111-111111111111', planIdentity: 'a'.repeat(64),
    accountGrantIdentity: 'b'.repeat(64), repositoryId: 1411517943, revision: 'c'.repeat(40),
    authorizedReleaseSha: 'd'.repeat(40) } });

async function runRetirement(mode: string, validEnvironment = true, deadlineMs = 4_000) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import',
    './auth-test/fixtures/retirement-cli-lifecycle.mjs', 'operations/retire-reviewed-stage.ts'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://127.0.0.1:1/vigilo_test',
      BETTER_AUTH_URL: 'http://localhost:3000', BETTER_AUTH_SECRET: validEnvironment ? 's'.repeat(32) : 'short',
      GITHUB_CLIENT_ID: 'Iv1.fixture', GITHUB_CLIENT_SECRET: 'fixture-only',
      VIGILO_TEST_RETIREMENT_LIFECYCLE: mode },
  });
  child.stdin.end(envelope);
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

test('retirement CLI closes partially started pg-boss and owned client without provider activity', async () => {
  const result = await runRetirement('partial_start');
  assert.equal(result.killedByTest, false, 'the actual CLI must exit without the test deadline');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_retirement_start_attempted/);
  assert.match(result.stderr, /fixture_retirement_stop_attempted/);
  assert.match(result.stderr, /fixture_retirement_resources_released/);
  assert.match(result.stderr, /fixture_retirement_client_closed/);
  assert.doesNotMatch(result.stderr, /fixture_retirement_command_reached|fixture_secret_bearing/);
  assert.equal(result.stderr.match(/fixture_retirement_stop_attempted/g)?.length, 1);
  assert.equal(result.stderr.match(/fixture_retirement_client_close_attempted/g)?.length, 1);
});

test('retirement CLI does not stop pg-boss before start was attempted', async () => {
  const result = await runRetirement('partial_start', false);
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /fixture_retirement_start_attempted|fixture_retirement_stop_attempted/);
});

test('retirement CLI stops once after successful start and later local failure', async () => {
  const result = await runRetirement('later_failure');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture_retirement_command_reached/);
  assert.match(result.stderr, /fixture_retirement_resources_released/);
  assert.match(result.stderr, /fixture_retirement_client_closed/);
  assert.equal(result.stderr.match(/fixture_retirement_stop_attempted/g)?.length, 1);
  assert.equal(result.stderr.match(/fixture_retirement_client_close_attempted/g)?.length, 1);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('retirement CLI preserves startup as primary failure when stop also fails', async () => {
  const result = await runRetirement('start_stop_failure');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reviewed_retirement_start_failed[\s\S]*reviewed_retirement_cleanup_failed:boss_stop/);
  assert.equal(result.stderr.match(/fixture_retirement_stop_attempted/g)?.length, 1);
  assert.match(result.stderr, /fixture_retirement_client_closed/);
  assert.doesNotMatch(result.stderr, /fixture_secret_bearing/);
});

test('retirement CLI bounds a hanging stop and exits nonzero', async () => {
  const result = await runRetirement('stop_hang', true, 12_000);
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reviewed_retirement_start_failed[\s\S]*reviewed_retirement_cleanup_failed:boss_stop/);
  assert.match(result.stderr, /fixture_retirement_client_closed/);
});

test('retirement CLI successful mock lifecycle stops and closes exactly once', async () => {
  const result = await runRetirement('success');
  assert.equal(result.killedByTest, false);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /"kind":"reviewed_stage_retirement"/);
  assert.match(result.stderr, /fixture_retirement_command_reached/);
  assert.match(result.stderr, /fixture_retirement_resources_released/);
  assert.match(result.stderr, /fixture_retirement_client_closed/);
  assert.equal(result.stderr.match(/fixture_retirement_stop_attempted/g)?.length, 1);
  assert.equal(result.stderr.match(/fixture_retirement_client_close_attempted/g)?.length, 1);
});
