import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const migrationHashes = new Map([
  ['0006_repair-run.sql', '476a31593cd189ada853691ed50f1561b11382558fbcc447a4fb1dc3fac1255b'],
  ['0007_repair-worker.sql', '0c3e8a5717d0b4ee4f14498a756e9aa1b0c3d9621cd051aa180728b479ac3f91'],
  ['0009_repair-candidate.sql', '710e062fd6f8e509b4a67b4983d7f57589e7a822cd4bede5a24d552369c2af82'],
  ['0010_candidate-verification.sql', 'ca19149548610d78b624f788a6d13f6337afac5deb5004b02354350bbcac4f28'],
  ['0011_ai-investigation.sql', 'ddea7b4e42583afa8f625081d83f4e88b045b7ba2a6da3ddb485ef32edd7f3bd'],
  ['0017_ai-candidate-generation-protocol-v3.sql', 'b1898fed050aa14e2556cd0022b8cb165849f25145c1c4d30c7ea2b0ea27dfc0'],
]);

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const migrationPath = (...segments: string[]) => resolve(process.cwd(), 'drizzle', ...segments);

test('historical migration files reproduce the hashes recorded when they were applied', async () => {
  for (const [file, expected] of migrationHashes) {
    const content = await readFile(migrationPath(file), 'utf8');
    assert.equal(sha256(content), expected, file);
  }
});

test('journal orders reconciliation, RepairLoop, and human review migrations', async () => {
  const journal = JSON.parse(await readFile(migrationPath('meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  assert.deepEqual(journal.entries.slice(-3).map(({ idx, tag }) => ({ idx, tag })), [
    { idx: 18, tag: '0018_historical-schema-reconciliation' },
    { idx: 19, tag: '0019_repair-loop' },
    { idx: 20, tag: '0020_human-review' },
  ]);
  assert.ok(journal.entries.every((entry, index, entries) => index === 0 || entry.when > entries[index - 1]!.when));
});

test('renumbering does not change the reviewed RepairLoop SQL bytes', async () => {
  const content = await readFile(migrationPath('0019_repair-loop.sql'), 'utf8');
  assert.equal(sha256(content), '96370083023bc1c9d128e5472e0725e07591531156b22ee744bee7675d52c765');
});

test('reconciliation is forward-only and never rewrites Drizzle history', async () => {
  const content = await readFile(migrationPath('0018_historical-schema-reconciliation.sql'), 'utf8');
  assert.doesNotMatch(content, /(?:update|delete\s+from|alter\s+table)\s+["']?drizzle["']?\s*\.\s*["']?__drizzle_migrations/i);
  for (const marker of [
    'repair_run_active_identity_unique',
    'unconfirmed_after_create_failure',
    'ON DELETE RESTRICT',
    'candidate_verification_candidate_id_key',
    'tool_call_count" between 0 and 20',
    'OLD."execution_ordinal"',
  ]) assert.ok(content.includes(marker), marker);
});

test('human-review migration enforces relational authority without claiming cryptographic recomputation', async () => {
  const content = await readFile(migrationPath('0020_human-review.sql'), 'utf8');
  for (const marker of [
    'human_review_decision_insert_guard',
    'human_review_decision_mutation_guard',
    'IS NOT DISTINCT FROM',
    'human_review_generation_write_guard',
    'human_review_candidate_write_guard',
    'human_review_verification_write_guard',
    'human_review_candidate_file_insert_guard',
    'OLD."repair_run_id", NEW."repair_run_id"',
    'JOIN "candidate_verification_attempt"',
    'a."expected_evidence_id" = e."id"',
    'other_i."candidate_verification_id" = v."id"',
    'b."credentials_exposure" = \'absent\'',
    'p."status" = \'ready\'',
    'ON DELETE RESTRICT',
  ]) assert.ok(content.includes(marker), marker);
  assert.doesNotMatch(content, /digest\s*\(|sha256\s*\(/i);
});
