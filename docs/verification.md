# Task 1.5: verify frozen bytes in a fresh sandbox

```sh
npm test
npm run typecheck
npm run verify
```

Use the existing ignored local Vercel credentials. `npm run verify` creates one
billable disposable verifier. It consumes the previously frozen Task 1.4 artifact
from `.vigilo/candidates/5a83213ab30bc5e81a88f9910270ac64c0e3b402b66d13096b591da18f8ea346.json`.
Missing, corrupt, or wrong-provenance artifacts fail before provisioning. It never
regenerates an artifact, reads the predetermined patch, or invokes the repair
runner. This command does not create a repair sandbox or run Task 1.6.

## Trust boundary and provenance

The repair's only code contribution is the frozen artifact's changed bytes.
The host revalidates its schema, scope, base identity, changed-content hashes,
byte lengths, and deterministic identity using Task 1.4's candidate validation.
Artifact reads are bounded to 16 KiB and reject non-regular files and symlinks.

The artifact is bound to the host-recorded Task 1.4 acceptance evidence in
`docs/candidate.md`. That record identifies the producing sandbox as
`vigilo-candidate-77e7b73a-b775-4bc3-b331-6f6f46bdac7c`. Task 1.4 did not retain its
session ID. Consequently separation is proven by the **unique sandbox name**,
not by inventing or inferring an old session ID. Output reports the repair session
as `null`, the new verifier's actual name/session, and
`separationIdentifier: "sandbox_name"`.

This controlled proof accepts only the previously recorded candidate identity.
The host evidence record is trusted provenance, not a signed attestation or a
general-purpose candidate registry. The immutable candidate bytes remain unchanged.

## Fresh reconstruction and execution

1. Load the original seven-file base using the pinned Task 1.3 identity:
   `60c6da3af26475c6efd1212487ae1a12d77a069d98fe5dd24dfd301c8d85e596`.
2. Call the existing `SandboxBoundary` to create a new named Node 24 sandbox with
   persistence disabled, no ports, and the same short 240-second provider /
   210-second client deadlines. Creation uses the managed base image, never a
   repair snapshot, resumed sandbox, cloned filesystem, or mutable Git state.
   Require the actual sandbox name to match the new request and differ from the
   recorded repair name. Keep the verifier session fixed throughout execution.
3. Check Node 24 and Vercel credential absence. Upload only the pristine base.
   Independently enumerate/read all files on the host and verify its exact hash
   before applying any candidate bytes. No dependencies or caches are transferred.
4. Write the exact frozen changed contents to their validated paths. Recollect
   the actual filesystem using the same collector as Task 1.4. Require exactly
   `src/shipping-cost.ts` to differ and the recomputed candidate identity to match.
5. Use the shared Task 1.3 installation helper and unchanged command:

   ```sh
   npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=15000
   ```

   Only `registry.npmjs.org` is allowed. No lifecycle scripts run while fetching.
   The committed lockfile is installed into the new verifier; no repair sandbox
   `node_modules`, npm cache, or other filesystem state is reused.
6. Update the same verifier to `deny-all`, read back its policy and running
   session, recheck credential absence, and recheck source identity. Only then run
   the configured `npm run typecheck`, `npm run build`, and
   `npm test -- --reporter=json`, with 30-second command deadlines.
7. Recollect source after execution, even when tests exit nonzero. Require the
   candidate identity still to match. Then parse the bounded untrusted Vitest
   report: normal exit 0, exactly three passes, zero failures/skips/todos, one
   passing suite, and the exact threshold regression passing without errors.
8. Recheck credentials and session, then stop and delete the verifier and confirm
   absence. Only successful verification **and** confirmed cleanup yield exit 0.

## Source identity and generated files

Before installation, collection allows exactly the original fixture tree. After
installation, only three root directories may be excluded from source identity:
`node_modules`, `dist`, and `.vitest`. Each must be a real directory with the exact
canonical path, never a symlink. These are dependencies and configured command
outputs, not candidate inputs. All original source, tests, configuration, and
lockfile bytes are still read and compared. Unexpected source files, hidden
changes, missing files, or changes to any protected file invalidate verification.

As in Task 1.4, collection assumes completed commands and a quiescent controlled
fixture. It is not an attestation against an actively malicious privileged writer
that changes and restores bytes between observations. Test reports remain untrusted
data, never instructions or commands. No raw repository output or credentials are
printed; the command evidence contains exit status and output hashes.

## Negative control and result categories

The result includes the **recorded Task 1.3 live negative control**, preserved in
`docs/baseline.md`: the same pristine base produced two passes and one known
threshold failure, process exit 1, with confirmed cleanup. This is historical
evidence labeled as such; `npm run verify` does not claim to rerun that baseline.
The new verifier independently determines whether the frozen candidate passes.

- `invalid_candidate`: artifact/base/hash/provenance validation failed before
  provisioning.
- `verifier_infrastructure_failure`: provisioning, transfer, installation,
  network isolation, command execution/deadline, or cleanup could not be confirmed.
- `candidate_verification_failure`: typecheck/build failed, the expected tests
  did not all pass, or source identity changed during repository execution.
- `verified`: exact frozen bytes passed in the fresh environment and cleanup
  was confirmed. This says nothing about PR publication or deployment.

## Reuse and tests

`fixture-execution.ts` extracts Task 1.3's existing installation arguments,
command harness, credentials check, bounded report reading, and error handling.
The baseline and verifier use the same helper and report validation rules; their
required test outcomes differ. `candidate.ts` supplies bounded artifact loading
and a shared sandbox filesystem adapter. The repair runner uses that adapter too.
The existing baseline/repair acceptance records remain intact.

Focused tests cover wrong base, corrupted bytes, wrong identity, rejection before
provisioning, frozen-byte-only uploads, absence of a patch applicator, source
mutation, failed tests/builds, policy failures, sandbox separation, and cleanup.
Temporary real filesystem trees exercise integrity and generated-directory rules.
SDK simulations prove failure handling, not live acceptance.

Existing API sources remain applicable: [Vercel Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference),
[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), and
[Vitest JSON reporting](https://vitest.dev/guide/reporters.html#json-reporter).
No dependency versions or lockfiles changed.

## Recorded live acceptance

The fresh verifier returned `success: true`, `outcome: "verified"` on 2026-09-04:

- Verifier: `vigilo-verifier-7d865876-0d9c-400d-8d39-3931baf4606a`;
  session `sbx_VJ9fGuONTfLyrl7W7pK4HRztlqPc`; Node `v24.19.0`.
- Its actual sandbox name differed from the recorded repair sandbox name.
- Pristine base integrity passed; exactly `src/shipping-cost.ts` changed.
- Applied and post-verification identities both matched frozen identity
  `5a83213ab30bc5e81a88f9910270ac64c0e3b402b66d13096b591da18f8ea346`.
- Registry-only installation exited 0 with lifecycle scripts disabled.
- Deny-all policy and the same running verifier session were confirmed before
  repository execution. Typecheck, build, and tests each exited 0.
- Exactly three tests passed, zero failed; the threshold regression passed.
- Source identity was unchanged after verification; credentials were absent.
- Stop and deletion were confirmed, and the final lookup confirmed absence.

Together with the preserved Task 1.3 negative control, this demonstrates that the
exact frozen bytes repair the broken original base in a fresh environment. It
does not replace future verification runs or authorize publication/deployment.
