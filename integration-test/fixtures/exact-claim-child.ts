/** Disposable-only exact claimant used to verify cross-process queue isolation. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import * as schema from '../../db/schema.ts';
import { claimExactReviewedBaselineJob, type ExactBaselineRequest } from '../../lib/repair-runs/exact-baseline-job.ts';

async function main(): Promise<void> {
  const address = process.env.DATABASE_URL;
  if (!address) throw new Error('disposable_database_required');
  const target = new URL(address);
  if (target.hostname !== '127.0.0.1' ||
      !(target.port === '55432' || (target.port === '55433' && process.env.VIGILO_DISPOSABLE_NATIVE_POSTGRES === 'true')) ||
      !/^\/vigilo_one_shot_[0-9a-f]+$/.test(target.pathname)) throw new Error('disposable_database_required');
  const input: Buffer[] = [];
  for await (const chunk of process.stdin) input.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const { request, release } = JSON.parse(Buffer.concat(input).toString('utf8')) as {
    request: ExactBaselineRequest; release: string;
  };
  const client = postgres(address, { max: 1, prepare: false });
  try {
    const claimed = await claimExactReviewedBaselineJob(drizzle(client, { schema }), request, release);
    process.stdout.write(JSON.stringify({ id: claimed.id }) + '\n');
  } finally {
    await client.end({ timeout: 1 });
  }
}

main().catch(() => {
  process.stderr.write('exact_claim_child_failed\n');
  process.exitCode = 1;
});
