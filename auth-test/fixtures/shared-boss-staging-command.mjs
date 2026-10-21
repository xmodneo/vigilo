export async function runReviewedStagingCommand(_mode, _request, dependencies) {
  process.stderr.write('fixture_staging_apply_called\n');
  return dependencies.apply({ workspace: { id: 'fixture', ownerUserId: 'fixture' }, user: { id: 'fixture' } }, {}, 'a'.repeat(64));
}
