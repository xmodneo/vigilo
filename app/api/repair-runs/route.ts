import { resolveRequestWorkspace } from '../../../lib/auth/resolve-request';
import { readGitHubAppEnvironment } from '../../../lib/github-app/environment';
import { rejectLegacyRepairStart } from '../../../lib/repair-runs/handlers';

export const runtime = 'nodejs';
export const maxDuration = 600;

export async function POST(request: Request) {
  return rejectLegacyRepairStart(request, readGitHubAppEnvironment(), resolveRequestWorkspace);
}
