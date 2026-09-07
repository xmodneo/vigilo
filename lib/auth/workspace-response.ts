import { AccessDeniedError, type AuthenticatedWorkspace } from './protected-context.ts';

export async function createWorkspaceResponse(
  resolveContext: () => Promise<AuthenticatedWorkspace>,
): Promise<Response> {
  try {
    const context = await resolveContext();

    return Response.json(
      {
        identity: { githubUserId: context.githubUserId },
        workspace: { id: context.workspace.id },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json(
        { error: error.code },
        {
          headers: { 'Cache-Control': 'no-store' },
          status: 401,
        },
      );
    }
    throw error;
  }
}
