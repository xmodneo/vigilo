// Control-plane-only validation. Never probe a credential or include it in an error.
export class SandboxConfigurationError extends Error {
  constructor(public readonly code: 'sandbox_auth_mode_unsupported' | 'credentials_missing' | 'incomplete_credentials') {
    super(code);
    this.name = 'SandboxConfigurationError';
  }
}

export class SandboxTransportError extends Error {
  readonly code = 'sandbox_transport_redirect';
  constructor() { super('sandbox_transport_redirect'); this.name = 'SandboxTransportError'; }
}

export function sandboxCredentials(environment: NodeJS.ProcessEnv): { token: string; teamId: string; projectId: string } {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = environment;
  // Presence, including an empty configured value, is ambiguous. No fallback.
  if (environment.VERCEL_OIDC_TOKEN !== undefined) throw new SandboxConfigurationError('sandbox_auth_mode_unsupported');
  // SDK 3.2.1 decodes any three-segment token and refreshes when owner_id is truthy.
  // Conservatively reject the entire shape, without decoding credential contents.
  if (token?.split('.').length === 3) throw new SandboxConfigurationError('sandbox_auth_mode_unsupported');
  if (!token && !teamId && !projectId) throw new SandboxConfigurationError('credentials_missing');
  if (![token, teamId, projectId].every((value) => value && value.trim() === value && !/\s/.test(value))) {
    throw new SandboxConfigurationError('incomplete_credentials');
  }
  return { token: token!, teamId: teamId!, projectId: projectId! };
}
