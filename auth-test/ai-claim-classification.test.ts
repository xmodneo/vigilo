import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { processAiInvestigationJob } from '../lib/ai-investigations/worker.ts';
import { processAiCandidateGenerationJob } from '../lib/ai-candidate-generations/worker.ts';
import { createTestContext } from './support.ts';

const transientDatabase = { transaction: async () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); } };
const dependencies = { gateway: {} as never, configuration: {} as never,
  createProvider: () => { throw new Error('provider must not be called on a failed claim'); } };

test('investigation claim distinguishes transient database failure from genuine missing parent', async (t) => {
  const id = randomUUID();
  const job = { id, data: { version: 1, aiInvestigationId: id } } as never;
  assert.deepEqual(await processAiInvestigationJob(job, { ...dependencies, database: transientDatabase as never }),
    { id, status: 'failed', output: { code: 'ai_investigation_claim_failed' } });
  const context = await createTestContext(); t.after(() => context.client.close());
  assert.deepEqual(await processAiInvestigationJob(job, { ...dependencies, database: context.database }),
    { id, status: 'deadletter', output: { code: 'ai_investigation_not_found' } });
});

test('generation claim distinguishes transient database failure from genuine missing parent', async (t) => {
  const id = randomUUID();
  const job = { id, data: { version: 1, proposalGenerationId: id } } as never;
  assert.deepEqual(await processAiCandidateGenerationJob(job, { ...dependencies, database: transientDatabase as never }),
    { id, status: 'failed', output: { code: 'ai_candidate_generation_claim_failed' } });
  const context = await createTestContext(); t.after(() => context.client.close());
  assert.deepEqual(await processAiCandidateGenerationJob(job, { ...dependencies, database: context.database }),
    { id, status: 'deadletter', output: { code: 'ai_candidate_generation_not_found' } });
});
