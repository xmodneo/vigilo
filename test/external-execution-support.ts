import { randomUUID } from "node:crypto";

import type {
  ExternalExecutionAuthorizer,
  ExternalExecutionPermit,
  ExternalExecutionScope,
} from "../lib/external-execution/types.js";

export const TEST_OIDC_TOKEN = `test.${Buffer.from(JSON.stringify({
  owner_id: "team_test",
  project_id: "project_test",
  exp: 4_102_444_800,
})).toString("base64url")}.signature`;

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
