export async function stageReviewedRepairRun() {
  if (process.env.VIGILO_TEST_SHARED_BOSS_MODE?.startsWith('staging_failure_'))
    throw new Error('fixture_secret_bearing_staging_failure');
  process.stderr.write('fixture_staging_committed_without_db\n');
  return { planIdentity: 'a'.repeat(64), repairRunId: '00000000-0000-4000-8000-000000000001' };
}
