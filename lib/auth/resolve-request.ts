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
