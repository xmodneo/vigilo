import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import type { ExternalExecutionAuthorizer, ExternalExecutionPermit, ExternalExecutionScope } from '../lib/external-execution/types.ts';

export const TEST_ACCESS_TOKEN = 'fake-sandbox-access-token';
export function configureSandboxTestCredentials(t: TestContext): void {
  const names = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN'] as const;
  const previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
  }));
  for (const name of names) delete process.env[name];
  process.env.VERCEL_TOKEN = TEST_ACCESS_TOKEN;
  process.env.VERCEL_TEAM_ID = 'team_test';
  process.env.VERCEL_PROJECT_ID = 'project_test';
}

export const TEST_EXTERNAL_EXECUTION_SCOPE: ExternalExecutionScope = Object.freeze({
  workspaceId: '00000000-0000-4000-8000-000000000001',
  repairRunId: '00000000-0000-4000-8000-000000000002',
  githubRepositoryId: 1,
  baseCommitSha: 'a'.repeat(40),
  operationCategory: 'gemini_investigation',
  providerId: 'google',
  modelId: 'gemini-3.1-flash-lite',
});

export function createTestExternalExecutionAuthorizer(): ExternalExecutionAuthorizer {
  return {
    reserve: async (): Promise<ExternalExecutionPermit> => {
      const reservationId = randomUUID();
      const ownershipToken = randomUUID();
      let attempt = 0;
      return {
        reservationId,
        ownershipToken,
        fence: 1,
        sandboxResourceClass: 'vcpu_1',
        assertOwnership: async () => undefined,
        beginProviderAttempt: async () => ++attempt,
        finishProviderAttempt: async () => undefined,
        renew: async () => undefined,
        complete: async () => undefined,
        meteredFetch: (input, init) => globalThis.fetch(input, init),
      };
    },
  };
}
