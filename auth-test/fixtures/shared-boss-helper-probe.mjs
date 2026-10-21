import { createRepairBoss } from '../../lib/repair-runs/queue.ts';

try {
  const boss = await createRepairBoss('postgres://127.0.0.1:1/vigilo_test', 'publisher');
  process.stderr.write('fixture_helper_ownership_transferred\n');
  await boss.stop({ graceful: true, timeout: 5_000 });
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error?.code, cleanupFailed: error?.cleanupFailed }) + '\n');
  process.exitCode = 1;
  if (error?.cleanupFailed) process.exit(1);
}
