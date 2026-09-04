# Task 1.3: original fixture baseline in Vercel Sandbox

Run from the Vigilo root, using the same ignored local Vercel OIDC credentials
as Task 1.1:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run baseline
```

`npm test` builds first and runs both the original probe tests and the baseline
tests. It does not start a sandbox. `npm run baseline` is the separate, billable
live acceptance command; it exits zero only for the expected application
failure **and confirmed cleanup**. No fixture repair is applied.

## Shared boundary

`src/sandbox-boundary.ts` extracts Task 1.1's unique naming, Node 24 image,
explicit non-persistence, bounded lifetime, SIGINT/SIGTERM cancellation, policy
readback, and independent stop/delete/absence checks. Both `src/probe.ts` and
`src/baseline.ts` use it. The baseline has a 240-second provider deadline and a
210-second client work deadline. The probe retains its 120/90-second deadlines.
Ambiguous creation failures attempt recovery by unique name; cleanup gets fresh
signals even when work was cancelled. As in Task 1.1, host loss, SIGKILL, or a
provider outage can leave cleanup unconfirmed; the result never calls that a
pass. The provider deadline bounds execution.

## Input integrity and transfer

The seven explicitly listed files in `fixtures/free-shipping/` must match the
approved Task 1.2 commit `c349421fac7969ef761b2a799fc9749404cfc511`. The expected
SHA-256 is:

```text
60c6da3af26475c6efd1212487ae1a12d77a069d98fe5dd24dfd301c8d85e596
```

This is SHA-256 of compact JSON containing ordered `{path, sha256}` records,
one per file in the runner's fixed list. Each file digest covers its exact bytes.
Local regular-file checks and the aggregate digest reject modified source,
tests, configuration, or lockfile, including an already repaired fixture.

Only these bytes are uploaded using `sandbox.writeFiles()` to a fresh directory
at `/vercel/sandbox/fixture`. No Git clone, GitHub credentials, `.git`, host
environment file, generated artifacts, or repair patch is transferred. Trusted
Node commands recompute the digest inside the sandbox after upload, after
installation, and after building immediately before tests. The runner needs no
Git executable at runtime. Updating the expected fixture is an explicit future
change to its pinned identity, not an automatic acceptance of local edits.

## Network and execution order

1. Create with `image: "vercel/sandbox/node:24"`, `persistent: false`, no exposed
   ports, and `networkPolicy: { allow: ["registry.npmjs.org"] }`. Confirm the
   returned settings and record the session ID.
2. Verify Node 24 and absence of Vercel credential/configuration variables. Host
   credentials are used only by the SDK; no environment is forwarded to commands.
3. Upload the approved fixture and verify its digest.
4. Run this fixed installation command (90-second child deadline):

   ```sh
   npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=15000
   ```

   The committed lockfile contains public npm tarball URLs and integrity hashes.
   There are no wildcard domains, CIDR allowances, private registries, credential
   brokering, or fallback to unrestricted networking. Installation lifecycle
   scripts are disabled. Audit/funding requests are disabled.
5. Only after installation exits zero, call `sandbox.update({ networkPolicy:
   "deny-all" })`. Read back with `Sandbox.get({ name, resume: false })` and
   require `deny-all`, the same session ID, and a running session. Recheck
   credential absence and fixture integrity. Any failure stops the workflow.
6. Run `npm run typecheck`, `npm run build`, then `npm test -- --reporter=json`,
   each with a 30-second child deadline. These repository-controlled scripts
   execute only after the confirmed deny-all gate.
7. Read the Vitest 5 report from `.vitest/json/output.json`, validate it, and
   always stop and delete the sandbox. Confirm absence using a non-resuming
   lookup returning 404.

The fixed command harness uses Node `spawnSync` with a timeout and `SIGKILL`.
It distinguishes an `ETIMEDOUT` spawn error from an ordinary nonzero child exit
instead of inferring timeouts from exit-code numbers. Output per npm command is
bounded by a 128 KiB buffer limit. The provider/client deadlines and sandbox
cleanup also bound commands that fail to return normally. No repository output
is evaluated, interpolated into shell commands, or printed verbatim: evidence
contains output digests and validated fields. Report reads are limited to 64 KiB.

## Acceptance and failure categories

Expected acceptance requires a normal test-process exit **1**, three completed
tests, two passes, and exactly one failure named
`offers free shipping at exactly 5000 cents`. The assertion must be the pinned
Vitest representation of **expected 0, received 500**. Duplicate/missing tests,
skips, suite errors, wrong assertions, malformed reports, signal terminations,
and timeouts are rejected. The raw stack trace stays untrusted and is discarded.

The structured result distinguishes `expected_baseline_application_failure`,
`dependency_installation_failure`, `command_timeout`, `unexpected_test_failure`,
`build_failure`, and `infrastructure_failure`, with a safe phase/error code.
Cleanup uncertainty prevents success even when the expected regression occurred.

This is a controlled fixture proof, not a general-purpose repository verifier.
Its file identity, test names, report shape, and assertion text are deliberately
pinned. A version change can require reviewing this contract. The managed Node
24 image still rolls forward; actual runtime versions are recorded. No repair,
second verification sandbox, or Task 1.4 behavior is implemented.

## Official sources

- [Vercel Sandbox SDK: creation, file I/O, updates and lifecycle](https://vercel.com/docs/sandbox/sdk-reference)
- [Vercel firewall: domain allowlists and live policy changes](https://vercel.com/docs/sandbox/concepts/firewall)
- [npm ci: lockfile behavior and ignore-scripts](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- [Vitest JSON reporting](https://vitest.dev/guide/reporters.html#json-reporter)
- [Node child-process timeout and output limits](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)

SDK version remains `@vercel/sandbox` 3.2.1. No dependencies were added.

## Recorded live acceptance

The final live run on 2026-09-04 returned `success: true`:

- Sandbox: `vigilo-baseline-9f5034f9-924e-4e2c-85cd-5b27868edc1f`.
- Session: `sbx_jFLCxCVLvo4tMdijFbwGJBUmzis8`; Node `v24.19.0`.
- All four fixture integrity checks passed; credential variables were absent.
- npm installation exited 0 under the registry-only policy.
- Deny-all was read back for the same running session before scripts ran.
- Typecheck and build exited 0; tests exited 1 with two passes and exactly the
  threshold regression (expected 0, received 500).
- Stop and deletion were confirmed; the final lookup returned 404.

All 28 local tests and Vigilo typecheck/build also passed. Future live runs must
independently satisfy acceptance; this record never overrides a failed run.
