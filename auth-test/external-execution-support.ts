import { randomUUID } from 'node:crypto';

import type { ExternalExecutionAuthorizer, ExternalExecutionPermit, ExternalExecutionScope } from '../lib/external-execution/types.ts';

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
