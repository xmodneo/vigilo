import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from 'node:fs';
import { join } from 'node:path';

import type { LocalStagingArtifact } from './local-staging-handler.ts';

const MAX_ARTIFACT_BYTES = 64 * 1024;

/** One fixed ignored path. No browser value, environment path, or symlink selects a plan. */
export function readLocalStagingArtifact(repositoryRoot: string): LocalStagingArtifact {
  const directory = join(repositoryRoot, '.vigilo');
  const directoryState = lstatSync(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink() ||
      (directoryState.mode & 0o022) !== 0 || directoryState.uid !== process.getuid?.())
    throw new Error('local_staging_artifact_unavailable');
  const descriptor = openSync(join(directory, 'm77b-approved-plan.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || (state.mode & 0o777) !== 0o600 || state.uid !== process.getuid?.() ||
        state.size < 1 || state.size > MAX_ARTIFACT_BYTES)
      throw new Error('local_staging_artifact_unavailable');
    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== state.size) throw new Error('local_staging_artifact_unavailable');
    return JSON.parse(bytes.subarray(0, count).toString('utf8')) as LocalStagingArtifact;
  } catch {
    throw new Error('local_staging_artifact_unavailable');
  } finally { closeSync(descriptor); }
}
