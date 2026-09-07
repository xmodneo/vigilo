import { resolveRequestWorkspace } from '../../../lib/auth/resolve-request';
import { createWorkspaceResponse } from '../../../lib/auth/workspace-response';

export function GET(request: Request): Promise<Response> {
  return createWorkspaceResponse(() => resolveRequestWorkspace(request.headers));
}
