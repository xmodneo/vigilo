import { randomUUID } from "node:crypto";

import type {
  ExternalExecutionAuthorizer,
  ExternalExecutionPermit,
  ExternalExecutionScope,
} from "../lib/external-execution/types.js";

export const TEST_ACCESS_TOKEN = "fake-sandbox-access-token";

export function sandboxAuthority(
  operationCategory: "sandbox_baseline" | "sandbox_verification",
): { authorizer: ExternalExecutionAuthorizer; scope: ExternalExecutionScope } {
  const authorizer: ExternalExecutionAuthorizer = {
    reserve: async (): Promise<ExternalExecutionPermit> => {
      let attemptOrdinal = 0;
      return {
        reservationId: randomUUID(),
        ownershipToken: randomUUID(),
        fence: 1,
        sandboxResourceClass: "vcpu_1",
        assertOwnership: async () => undefined,
        beginProviderAttempt: async () => ++attemptOrdinal,
        finishProviderAttempt: async () => undefined,
        renew: async () => undefined,
        complete: async () => undefined,
        meteredFetch: (input, init) => globalThis.fetch(input, init),
      };
    },
  };
  return {
    authorizer,
    scope: {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      githubRepositoryId: 1,
      baseCommitSha: "a".repeat(40),
      operationCategory,
      providerId: "vercel",
    },
  };
}
