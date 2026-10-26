import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { exactPhaseQueues, parseExactPhaseArguments } from '../lib/repair-runs/exact-phase-job.ts';
import { assertExactPgBossCompatibility } from '../lib/repair-runs/exact-baseline-job.ts';

const run = '11111111-1111-4111-8111-111111111111';
const job = '22222222-2222-4222-8222-222222222222';
const plan = 'a'.repeat(64);
const revision = 'b'.repeat(40);
const release = 'c'.repeat(40);
const argumentsFor = (phase: string, jobId = job) => [
  '--phase', phase, '--repair-run', run, '--job', jobId, '--plan-identity', plan,
  '--repository-id', '1411517943', '--revision', revision, '--release', release,
];

test('exact phase arguments pin phase, run, job, plan, repository, revision and release', () => {
  assert.doesNotThrow(assertExactPgBossCompatibility);
  assert.deepEqual(Object.values(exactPhaseQueues).sort(), [
    'ai-candidate-generation-v1', 'ai-investigation-v1', 'candidate-verification-v1',
    'investigation-context-v1', 'repair-loop-v1',
  ]);
  for (const phase of Object.keys(exactPhaseQueues)) {
    assert.deepEqual(parseExactPhaseArguments(argumentsFor(phase)), {
      phase, repairRunId: run, jobId: job, planIdentity: plan, repositoryId: 1411517943,
      revision, releaseSha: release,
    });
  }
  assert.equal(parseExactPhaseArguments(argumentsFor('loop', job)).jobId, job,
    'the repair-loop wake job is distinct from the loop and run IDs');
});

test('exact phase arguments reject broad queues, duplicate fields and malformed authority', () => {
  for (const values of [
    argumentsFor('publication'), argumentsFor('toString'), argumentsFor('constructor'),
    argumentsFor('__proto__'), [...argumentsFor('context'), '--queue', 'repair-baseline-v1'],
    [...argumentsFor('context').slice(0, -2), '--phase', 'context'],
    argumentsFor('context').map((value, index) => index === 3 ? 'not-a-uuid' : value),
    argumentsFor('context').map((value, index) => index === 5 ? 'not-a-uuid' : value),
    argumentsFor('context').map((value, index) => index === 7 ? 'wrong' : value),
    argumentsFor('context').map((value, index) => index === 9 ? '1.5' : value),
    argumentsFor('context').map((value, index) => index === 11 ? 'wrong' : value),
    argumentsFor('context').map((value, index) => index === 13 ? 'wrong' : value),
  ]) assert.throws(() => parseExactPhaseArguments(values), /exact_job_invalid/);
});

test('one-shot phase entrypoint cannot register broad consumers or queue-wide retries', () => {
  const root = process.cwd();
  const entrypoint = readFileSync(path.join(root, 'worker/exact-phase-once.ts'), 'utf8');
  const service = readFileSync(path.join(root, 'lib/repair-runs/exact-phase-service.ts'), 'utf8');
  const claim = readFileSync(path.join(root, 'lib/repair-runs/exact-phase-job.ts'), 'utf8');
  for (const source of [entrypoint, service, claim])
    assert.doesNotMatch(source, /\.work\(|\.retry\(|createRepairBoss|createCanonicalRepairSupervisor/);
  assert.match(claim, /j\.name = \$\{queue\} and j\.id = \$\{request\.jobId\}/);
  assert.match(claim, /j\.retry_count = 0/);
  assert.match(claim, /assertReviewedPlanIntegrity/);
  assert.match(claim, /assertMatchedSourceCheckpoint/);
  assert.match(service, /claimExactPhaseJob/);
  assert.match(service, /boss\.touch\(queue, claimed\.id\)/);
  assert.match(service, /boss\.complete\(queue, claimed\.id\)/);
  assert.match(service, /boss\.fail\(queue, claimed\.id/);
});

test('publication remains outside exact phase worker and its release gate is unchanged', () => {
  assert.ok(!(Object.values(exactPhaseQueues) as string[]).includes('repair-publication-v1'));
  const worker = readFileSync(path.join(process.cwd(), 'worker/exact-phase-once.ts'), 'utf8');
  assert.doesNotMatch(worker, /repair-publication-v1|processRepairPublicationJob/);
});

test('one-shot context rechecks durable authority before scoped GitHub token use', () => {
  const root = process.cwd();
  const service = readFileSync(path.join(root, 'lib/repair-runs/exact-phase-service.ts'), 'utf8');
  const contextWorker = readFileSync(path.join(root, 'lib/investigations/worker.ts'), 'utf8');
  assert.match(service, /beforeExternalSourceRead: \(\) => assertSourceReadAuthority/);
  assert.match(service, /clock_timestamp\(\) as authority_time/);
  assert.match(service, /assertMatchedSourceCheckpoint/);
  assert.match(service, /assertReviewedPlanIntegrity/);
  assert.ok(contextWorker.indexOf('await dependencies.beforeExternalSourceRead?.()') <
    contextWorker.indexOf('const context = await withScopedRepositoryToken('));
});
