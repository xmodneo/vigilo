import { getAuth, getAuthDatabase } from './server.ts';
import { resolveAuthenticatedWorkspace } from './protected-context.ts';

export function resolveRequestWorkspace(headers: Headers) {
  const auth = getAuth();
  return resolveAuthenticatedWorkspace(
    (requestHeaders) => auth.api.getSession({ headers: requestHeaders }),
    getAuthDatabase(),
    headers,
  );
}

/** Operator staging must not provision a workspace outside its transaction. */
export function resolveExistingRequestWorkspace(headers: Headers) {
  const auth = getAuth();
  return resolveAuthenticatedWorkspace(
    (requestHeaders) => auth.api.getSession({ headers: requestHeaders }),
    getAuthDatabase(),
    headers,
    { existingWorkspaceOnly: true },
  );
}
