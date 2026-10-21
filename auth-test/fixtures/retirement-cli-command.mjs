export async function runReviewedRetirementCommand() {
  process.stderr.write('fixture_retirement_command_reached\n');
  if (process.env.VIGILO_TEST_RETIREMENT_LIFECYCLE === 'later_failure')
    throw new Error('fixture_secret_bearing_command_failure');
  return { kind: 'reviewed_stage_retirement', repairRunId: '11111111-1111-4111-8111-111111111111',
    planIdentity: 'a'.repeat(64), baselineJobId: '11111111-1111-4111-8111-111111111111',
    result: 'retired', revokedGrantCount: 6 };
}
