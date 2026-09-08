import { and, eq } from 'drizzle-orm';

import { account } from '../../db/schema.ts';
import type { VigiloDatabase } from '../db/types.ts';
import { ensureWorkspaceForUser } from '../workspaces.ts';

type AuthSession = {
  session: {
    id: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export type SessionReader = (headers: Headers) => Promise<AuthSession | null>;

export interface AuthenticatedWorkspace {
  sessionId: string;
  user: AuthSession['user'];
  githubUserId: string;
  workspace: {
    id: string;
    ownerUserId: string;
  };
}

export class AccessDeniedError extends Error {
  constructor(public readonly code: 'unauthorized') {
    super(code);
    this.name = 'AccessDeniedError';
  }
}

export async function resolveAuthenticatedWorkspace(
  getSession: SessionReader,
  database: VigiloDatabase,
  headers: Headers,
): Promise<AuthenticatedWorkspace> {
  const currentSession = await getSession(headers);
  if (!currentSession) {
    throw new AccessDeniedError('unauthorized');
  }

  const [githubAccount] = await database
    .select({ accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, currentSession.user.id),
        eq(account.providerId, 'github'),
      ),
    )
    .limit(1);

  if (!githubAccount) {
    throw new AccessDeniedError('unauthorized');
  }

  const ownedWorkspace = await ensureWorkspaceForUser(database, currentSession.user.id);

  return {
    sessionId: currentSession.session.id,
    user: currentSession.user,
    githubUserId: githubAccount.accountId,
    workspace: {
      id: ownedWorkspace.id,
      ownerUserId: ownedWorkspace.ownerUserId,
    },
  };
}
