/** Local-only operator entrypoint. Provide the typed request via protected stdin. */
import { resolveExistingRequestWorkspace } from '../lib/auth/resolve-request.ts';
import { runReviewedStagingCommand } from '../lib/external-execution/reviewed-staging-cli.ts';
import { stageReviewedRepairRun } from '../lib/external-execution/reviewed-staging.ts';
import { getJobPublisherInfrastructure } from '../lib/jobs/server.ts';
import { readRuntimeRelease } from '../lib/operations/release.ts';
import { PgBossReviewedBaselineQueue, RepairBossInitializationError } from '../lib/repair-runs/queue.ts';
import { googleProjectIdentity } from '../lib/external-execution/provider-account.ts';
import { sandboxCredentials } from '../lib/external-execution/sandbox-auth.ts';

const MAX_INPUT_BYTES = 64 * 1024;
const BOSS_CLEANUP_DEADLINE_MS = 8_000;

class ReviewedStagingCleanupError extends Error {
  constructor(readonly committed: boolean, readonly stagingFailed = false) { super('reviewed_staging_cleanup_unresolved'); }
}

async function stopOwnedBoss(boss: { stop(): Promise<unknown> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => boss.stop()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReviewedStagingCleanupError(false)), BOSS_CLEANUP_DEADLINE_MS);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function readProtectedInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_INPUT_BYTES) throw new Error('reviewed_plan_invalid');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !['--dry-run', '--apply'].includes(process.argv[2] ?? ''))
    throw new Error('reviewed_staging_usage');
  const mode = process.argv[2] === '--apply' ? 'apply' : 'dry-run';
  const request = await readProtectedInput();
  const result = await runReviewedStagingCommand(mode, request, {
    resolveContext: (cookie) => resolveExistingRequestWorkspace(new Headers({ cookie })),
    apply: async (context, plan, approvedPlanIdentity) => {
      const google = googleProjectIdentity(process.env.GEMINI_PROJECT_ID ?? '');
      const vercel = sandboxCredentials(process.env);
      const infrastructure = await getJobPublisherInfrastructure();
      let receipt: Awaited<ReturnType<typeof stageReviewedRepairRun>> | undefined;
      let primaryFailure: unknown;
      try {
        receipt = await stageReviewedRepairRun(infrastructure.database, context, plan,
          approvedPlanIdentity, new PgBossReviewedBaselineQueue(infrastructure.boss),
          { runtimeReleaseSha: readRuntimeRelease(), configuredProviderAccounts: {
            googleProjectId: google.projectId, vercelTeamId: vercel.teamId, vercelProjectId: vercel.projectId,
          } });
      } catch (error) { primaryFailure = error; }
      try { await stopOwnedBoss(infrastructure.boss); }
      catch { throw new ReviewedStagingCleanupError(receipt !== undefined, primaryFailure !== undefined); }
      if (primaryFailure) throw primaryFailure;
      return receipt!;
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  // Never echo parsed stdin, headers, connection strings, provider settings,
  // or untrusted nested database errors to an operator terminal.
  process.stderr.write(error instanceof ReviewedStagingCleanupError && error.committed
    ? 'reviewed_staging_committed_cleanup_unresolved\n'
    : error instanceof ReviewedStagingCleanupError && error.stagingFailed
      ? 'reviewed_staging_failed_cleanup_unresolved\n' : 'reviewed_staging_failed\n');
  process.exitCode = 1;
  // The helper's bounded stop failed; do not leave its pg-boss handles alive
  // after this local operator process has failed.
  if ((error instanceof RepairBossInitializationError && error.cleanupFailed) || error instanceof ReviewedStagingCleanupError) process.exit(1);
});
