# Vigilo — execution boundary proofs

Task 1.1 proves the disposable Node.js 24 Vercel Sandbox boundary. Task 1.2 adds
a separate [controlled broken fixture](fixtures/README.md). Task 1.3 runs its
[original failing baseline in a real sandbox](docs/baseline.md). Task 1.4
[applies and freezes the predetermined candidate](docs/candidate.md). Task 1.5
[verifies those frozen bytes in a fresh sandbox](docs/verification.md). There is
no web app, database, or model integration. Task 1.6 generates an offline
[structured evidence report](docs/evidence-report.md) from recorded execution
results and the frozen candidate artifact.
Task 1.7 exercises [failure cleanup and provider expiry](docs/failure-cleanup.md)
with controlled live sandbox failures.

## Prerequisites and pinned dependencies

- Local Node.js **24.13.0** (`.nvmrc`); the probe rejects other Node majors.
- npm **11.6.2** (`packageManager`).
- `@vercel/sandbox` **3.2.1**.
- TypeScript **7.0.2**, `@types/node` **24.13.3**, and
  `@types/async-retry` **1.4.9** (required by the SDK's public declarations).
- `package-lock.json` pins the resolved dependency tree. Install with `npm ci`.

Tests use Node's built-in runner; no test framework dependency is needed.

## Local credentials

Use an existing Vercel project with Sandbox access. Supply either:

- `VERCEL_OIDC_TOKEN`, or
- all of `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

Set these in the local process environment or an ignored `.env.local` file.
The probe loads `.env.local` using Node's native environment-file support.
Do not commit credentials or paste them into reports. An incomplete access-token
configuration fails explicitly, rather than falling back to another project.

Vercel documents obtaining a development OIDC token by linking an existing
project and pulling its environment with the Vercel CLI. That CLI is not a
dependency of this project. Development OIDC tokens expire; renew them when
necessary. Do not create a new Vercel project just to run the probe without
reviewing that choice.

Source: https://vercel.com/docs/sandbox/concepts/authentication

## Run

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run probe
```

`npm test` builds the TypeScript first. Alternatively, run `npm run build` before
`npm run probe`. The live probe creates a billable sandbox and is intentionally
separate from the local tests. It exits zero only when all checks and cleanup
are confirmed. Exit one means failed, blocked, or inconclusive acceptance.

## What the real probe checks

1. The local runtime is Node 24 and credentials are configured.
2. `Sandbox.create()` uses a unique name, `image: "vercel/sandbox/node:24"`,
   `persistent: false`, `timeout: 120000`, `networkPolicy: "allow-all"`, and no
   exposed ports. No local environment is forwarded to the sandbox.
3. Provider-returned persistence, network policy, and timeout match the request.
   Record the VM session identifier; it must remain unchanged during the probe.
4. Sandbox commands report a Node 24 version and verify the four Vercel
   credential/configuration variables are absent without printing their values.
   Another command writes a fixed file in `/tmp`, reads it back, and removes it.
5. A HEAD request to `https://example.com/` **inside this sandbox** must complete
   TCP/TLS connection and return HTTP 2xx within 10 seconds. This is the positive
   control. Failure leaves the task inconclusive and triggers cleanup.
6. Call `sandbox.update({ networkPolicy: "deny-all" }, { signal })`. Read the
   policy back with `Sandbox.get({ name, resume: false })`; require `deny-all`
   and the same still-running VM session before proceeding.
7. Repeat the identical HTTPS request in a fresh Node process in that same VM.
   Both requests use `agent: false` to avoid connection reuse. Record TCP/TLS
   connection progress and the actual failure category, error name, and code.
   Only a passed positive control plus a confirmed transition plus failure to
   establish communication qualifies as `blocked`. An HTTP response or any
   TCP/TLS connection after denial counts as `not_blocked`. A timeout by itself,
   failed control, missing observation, or failed transition is inconclusive.
8. A `finally` block calls `stop()` and then `delete()`. Deletion is attempted
   even if stopping fails. A subsequent `Sandbox.get({ name, resume: false })`
   must return HTTP 404 before absence is confirmed.

The initial JSON event prints the unique requested sandbox name before creation,
so an ambiguous creation response still leaves an identifier. The final JSON
report contains requested settings, sandbox/session identity, runtime, filesystem,
`credentialsExposure`, `outboundPositiveControl`, `networkPolicyTransition`,
`outboundAfterDeny`, cleanup outcomes, and a safe error code. Checks not reached
are marked `not_run`/`not_checked`; outbound denial defaults to `inconclusive`.
Raw SDK errors/headers/tokens are never printed.

## Cleanup and limitations

- Work has a 90-second client deadline. The sandbox has a 120-second provider
  deadline. SIGINT/SIGTERM abort work and enter cleanup. Each cleanup call uses
  a fresh bounded signal, independent of the cancelled work.
- Stop and deletion outcomes are reported separately. Deletion requests orphan
  snapshot cleanup as an extra safeguard; this probe never requests a snapshot.
- If creation fails ambiguously, the probe looks up its unique name without
  resuming it and attempts cleanup if found. A failed lookup is not proof that
  no resource was created. Keep the printed name for manual inspection.
- SIGKILL, host loss, and provider outages can prevent client cleanup. The
  provider deadline bounds execution but does not prove the sandbox record was
  deleted. Inspect unresolved resources in Vercel; there is no cleanup service
  in Task 1.1.
- Current APIs distinguish stopping a session from deleting a named sandbox.
  Persistence is explicitly disabled. Networking intentionally starts at
  `allow-all` for this trusted, credential-free A/B probe, then changes to
  `deny-all`. No repository or third-party code is executed during this window.
  The legacy `runtime: "node24"` selector is deprecated in favor of `image`;
  `updateNetworkPolicy()` is deprecated in favor of `update({ networkPolicy })`.
- The managed `node:24` image receives nightly updates. Its major version is
  selected, but its OS and Node patch version are not digest-pinned. The actual
  runtime version is recorded. No reproducible application environment is
  claimed by this first probe.
- This is a same-VM A/B acceptance test of one endpoint and protocol, not a
  comprehensive network penetration test. It does not assume the provider
  guarantees any particular denial error. Error codes are evidence, not the
  acceptance rule; connection progress and the A/B prerequisites decide it.
- Local tests cover result classification and failure handling, including a
  narrowly mocked SDK failure path. They do **not** prove real VM isolation or
  satisfy acceptance. Task 1.1 requires a successful real `npm run probe`.

## Official API sources checked for this task

- Creation, commands, live policy updates, stop, delete, and non-resuming lookup:
  https://vercel.com/docs/sandbox/sdk-reference
- Node 24 managed image and update behavior:
  https://vercel.com/docs/sandbox/concepts/images
- Deny-all blocks outbound access, including DNS:
  https://vercel.com/docs/sandbox/concepts/firewall
- Published SDK 3.2.1 TypeScript declarations also confirm `networkPolicy`,
  `persistent`, `timeout`, and `delete({ deleteOrphanSnapshots: true })`.
  SDK source: https://github.com/vercel/sandbox/tree/main/packages/vercel-sandbox
- Node's built-in test runner:
  https://nodejs.org/docs/latest-v24.x/api/test.html

## Acceptance status

The real A/B probe passed on 2026-09-04 with `success: true`:

- Sandbox: `vigilo-probe-d976ac7b-045a-4ef2-b598-945dd9e91dba`.
- VM session: `sbx_IGyzsLiFE8CYpnFw04HG3EKMDEEr`; Node `v24.19.0`.
- Filesystem passed; credential variables absent.
- Positive control: HTTP 200 with TCP/TLS connected.
- Policy transition: `deny-all` read back, same running session confirmed.
- After denial: `AggregateError` / `ETIMEDOUT`; neither TCP nor TLS connected.
- Cleanup: stop and deletion confirmed; subsequent lookup returned 404.

Local tests are separate evidence. Future runs must independently satisfy every
acceptance condition; this recorded result must never override a failed run.
