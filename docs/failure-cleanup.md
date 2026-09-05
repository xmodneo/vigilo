# Task 1.7: failure cleanup

```sh
npm test
npm run typecheck
npm run failures
```

`npm run failures` provisions four non-persistent Node.js 24 sandboxes. It is a
live acceptance command and requires the same host-only Vercel authentication as
the earlier probes. No credential environment is passed to sandbox commands.

Three scenarios exercise the existing `SandboxBoundary.run()` lifecycle. Each
uses deny-all networking, confirms that policy in the same provider session, and
relies on the boundary's `finally` cleanup:

- Installation failure uploads a minimal package without a lockfile and invokes
  `npm ci --offline` with lifecycle scripts disabled. npm deterministically exits
  1 with allowlisted diagnostic code `EUSAGE`; no registry access is required.
- Timeout runs a controlled npm test whose Node process records that it started,
  then outlives a 1.5-second command deadline. The trusted harness uses
  `spawnSync` with `SIGKILL` and classifies only the observed `ETIMEDOUT` result as
  `command_timeout`.
- Cancellation starts the same controlled long-running test, observes its
  credential-absence marker, and aborts through `SandboxBoundary.run()`. The SDK
  wait is cancelled and boundary cleanup stops the whole sandbox, so no later
  workflow step can begin. Cancellation remains distinct from timeout.

Command diagnostics are bounded by the existing 128 KiB child-process buffer.
Reports retain exit/timeout facts, stdout/stderr byte counts and SHA-256 hashes,
and only allowlisted npm/spawn codes. They include no stdout or stderr text.
Provider cleanup error bodies are also excluded; a failed operation is retained
as a generic or HTTP-status code and never marked successful.

The process-loss scenario is deliberately different. A child process provisions
a sandbox with a 60-second provider timeout and sends its sandbox name, provider
session ID, `expiresAt`, and credential check to a supervising process. Only after
the supervisor validates and records those facts does it send `SIGKILL`. This
bypasses the child's `finally`, accurately simulating loss of local control.

After the provider deadline, the supervisor uses `Sandbox.get({ resume: false })`
for metadata-only inspection. Confirmation requires the child to have exited by
`SIGKILL`, the observation to occur after the recorded expiry, and the same
session to be stopped (or the sandbox to be absent). A failed or unauthorized
lookup remains `unconfirmed`; it is never treated as absence. Once expiry is
proven, the supervisor removes any stopped sandbox metadata and confirms absence.
That housekeeping is reported separately from both local-harness cleanup and the
provider expiry observation.

The current SDK behavior matches the Vercel Sandbox reference: `expiresAt`
identifies when a live session stops automatically; `Sandbox.get()` supports
`resume: false`; and command waits accept abort signals. Aborting a client wait
alone does not prove remote termination, which is why cancellation still requires
the boundary's independent stop/delete/absence checks.

## Live acceptance evidence

The controlled run on 2026-09-05 observed:

| Scenario | Outcome | Execution facts | Lifecycle evidence |
| --- | --- | --- | --- |
| Installation | `dependency_installation_failure` | exit 1, `EUSAGE`, not timed out | stop/delete confirmed; absent |
| Timeout | `command_timeout` | operation started, `ETIMEDOUT`, no exit code | stop/delete confirmed; absent |
| Cancellation | `cancelled` | started, cancellation requested/observed, no later work | stop/delete confirmed; absent |
| Process loss | `provider_expiry_confirmed` | child `SIGKILL`; same session stopped after 60-second expiry | no child cleanup claim; observer later deleted metadata and confirmed absent |

All four sandboxes used Node `v24.19.0`, deny-all networking, disabled
persistence, and reported credentials absent. Every acceptance predicate passed,
and no sandbox remained unexpectedly active.
