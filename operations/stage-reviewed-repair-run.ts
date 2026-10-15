/** Local-only operator entrypoint. Provide the typed request via protected stdin. */
import { resolveExistingRequestWorkspace } from '../lib/auth/resolve-request.ts';
import { runReviewedStagingCommand } from '../lib/external-execution/reviewed-staging-cli.ts';
import { stageReviewedRepairRun } from '../lib/external-execution/reviewed-staging.ts';
import { getJobPublisherInfrastructure } from '../lib/jobs/server.ts';
import { readRuntimeRelease } from '../lib/operations/release.ts';
import { PgBossRepairQueue } from '../lib/repair-runs/queue.ts';
import { googleProjectIdentity } from '../lib/external-execution/provider-account.ts';
import { sandboxCredentials } from '../lib/external-execution/sandbox-auth.ts';

const MAX_INPUT_BYTES = 64 * 1024;

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
      try {
        return await stageReviewedRepairRun(infrastructure.database, context, plan,
          approvedPlanIdentity, new PgBossRepairQueue(infrastructure.boss),
          { runtimeReleaseSha: readRuntimeRelease(), configuredProviderAccounts: {
            googleProjectId: google.projectId, vercelTeamId: vercel.teamId, vercelProjectId: vercel.projectId,
          } });
      } finally { await infrastructure.boss.stop(); }
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  // Never echo parsed stdin, headers, connection strings, provider settings,
  // or untrusted nested database errors to an operator terminal.
  process.stderr.write('reviewed_staging_failed\n');
  process.exitCode = 1;
});
