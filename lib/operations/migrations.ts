import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EXPECTED_SCHEMA_VERSION = '0023' as const;

export const MIGRATION_MANIFEST = [
  { tag: '0000_auth-workspace', hash: 'd9d6792a7ecd363a0a372e8d1b2c6eb297f314d7c1d85a85753550b50018a3e3', createdAt: 1788660000589 },
  { tag: '0001_github-installation', hash: '480c953e4feb354373ad500d8ecfbc3ca01d17df6b8ca504d35027aa16b4544c', createdAt: 1788772800000 },
  { tag: '0002_repository', hash: 'bbb06225ba32f69a82af32beb37ca20fd21b89a0ebabcad0afe66aaad355c114', createdAt: 1788861600000 },
  { tag: '0003_repository-access', hash: 'd04f845f92c57475b3daefc82e9c722aaf5fb3fd69aaa3baff04472ea9bfebee', createdAt: 1788948000000 },
  { tag: '0004_execution-profile', hash: '74de3cea2dc8a236cc3fde471bfd947a7c4fe4cc7c0e102f73d9fc00d06cf5a6', createdAt: 1789034400000 },
  { tag: '0005_repository-baseline', hash: 'cde9ab998a8ffe90b94806b39f9ceff6c55de4ff1439852f5f608cc6625e3042', createdAt: 1789120800000 },
  { tag: '0006_repair-run', hash: '476a31593cd189ada853691ed50f1561b11382558fbcc447a4fb1dc3fac1255b', createdAt: 1789207200000 },
  { tag: '0007_repair-worker', hash: '0c3e8a5717d0b4ee4f14498a756e9aa1b0c3d9621cd051aa180728b479ac3f91', createdAt: 1789293600000 },
  { tag: '0008_investigation-context', hash: '921021daf50ac61edd1f10b339d1f3c3f4da603a28e753f976139d39ade579a7', createdAt: 1789466400000 },
  { tag: '0009_repair-candidate', hash: '710e062fd6f8e509b4a67b4983d7f57589e7a822cd4bede5a24d552369c2af82', createdAt: 1789552800000 },
  { tag: '0010_candidate-verification', hash: 'ca19149548610d78b624f788a6d13f6337afac5deb5004b02354350bbcac4f28', createdAt: 1789639200000 },
  { tag: '0011_ai-investigation', hash: 'ddea7b4e42583afa8f625081d83f4e88b045b7ba2a6da3ddb485ef32edd7f3bd', createdAt: 1789725600000 },
  { tag: '0012_ai-investigation-rerun', hash: '368b86c23179f1e33403da2434310e4030e5b99042478427c26ac24a3900a754', createdAt: 1789812000000 },
  { tag: '0013_ai-candidate-generation', hash: 'e43ae2229bfdfa33c8ab5222dd76e26372d2275f35a3d0d5c1f745d4bce936d2', createdAt: 1789898400000 },
  { tag: '0014_ai-candidate-generation-finalization', hash: 'd4131d639d26e27a806d6060c07f9e5aa44a1bf1c7e0979c68190a92386f0fa2', createdAt: 1789984800000 },
  { tag: '0015_ai-candidate-generation-rerun', hash: 'dd2370b87f93083ed345a7f5dac0f363aa7057b11895168949483af45b9767c3', createdAt: 1790071200000 },
  { tag: '0016_ai-candidate-generation-protocol-v2', hash: '83c184c7ec86f0c3068ef50942029432eb552032bc2ba682452d769d68fa0a62', createdAt: 1790157600000 },
  { tag: '0017_ai-candidate-generation-protocol-v3', hash: 'b1898fed050aa14e2556cd0022b8cb165849f25145c1c4d30c7ea2b0ea27dfc0', createdAt: 1790244000000 },
  { tag: '0018_historical-schema-reconciliation', hash: '1e4222a4271fc1d4f907a2edbe9ad2aaaaae647f64af745fb2c294013c61d582', createdAt: 1790330400000 },
  { tag: '0019_repair-loop', hash: '96370083023bc1c9d128e5472e0725e07591531156b22ee744bee7675d52c765', createdAt: 1790416800000 },
  { tag: '0020_human-review', hash: '2384495ba485b2f97f139af6fb0c94688a80d1a255abc7d40996e863c9595b6a', createdAt: 1790503200000 },
  { tag: '0021_repair-publication', hash: 'db986bb804e3e20b8f9a90b06972c1a4373795855a1e14646d35f036c97a9343', createdAt: 1790589600000 },
  { tag: '0022_external-execution-authority', hash: 'f3d058dad152612831373e785ebd0be46d681d07f1e9c3c067cc3e8c665ca625', createdAt: 1790676000000 },
  { tag: '0023_operational-readiness', hash: '7cf93d6e3801886667cf7ecfe620f92985fa687c58b076b1fac522c25bc83bc7', createdAt: 1790762400000 },
] as const;

export interface MigrationLedgerEntry {
  hash: string;
  createdAt: number | string;
}

export function validateMigrationLedger(entries: readonly MigrationLedgerEntry[]): 'complete' | 'pending' {
  if (entries.length > MIGRATION_MANIFEST.length) throw new Error('migration_ledger_unexpected');
  for (const [index, entry] of entries.entries()) {
    const expected = MIGRATION_MANIFEST[index];
    if (!expected || entry.hash !== expected.hash || Number(entry.createdAt) !== expected.createdAt) {
      throw new Error('migration_ledger_mismatch');
    }
  }
  return entries.length === MIGRATION_MANIFEST.length ? 'complete' : 'pending';
}

export async function validateMigrationFiles(repositoryRoot: string): Promise<void> {
  const journal = JSON.parse(await readFile(join(repositoryRoot, 'drizzle/meta/_journal.json'), 'utf8')) as {
    entries?: Array<{ idx?: number; tag?: string; when?: number }>;
  };
  if (!Array.isArray(journal.entries) || journal.entries.length !== MIGRATION_MANIFEST.length) {
    throw new Error('migration_manifest_mismatch');
  }
  for (const [index, expected] of MIGRATION_MANIFEST.entries()) {
    const journalEntry = journal.entries[index];
    if (journalEntry?.idx !== index || journalEntry.tag !== expected.tag || journalEntry.when !== expected.createdAt) {
      throw new Error('migration_manifest_mismatch');
    }
    const bytes = await readFile(join(repositoryRoot, 'drizzle', `${expected.tag}.sql`));
    if (createHash('sha256').update(bytes).digest('hex') !== expected.hash) {
      throw new Error('migration_file_hash_mismatch');
    }
  }
}
