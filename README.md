# Vigilo

Vigilo is a sandbox-first software maintenance platform. Milestone 1 proves its
isolated repair boundary: reproduce a failure, freeze exact candidate bytes,
verify those bytes in a fresh sandbox, produce structured evidence, and clean up.
Task 2.2 adds GitHub identity sign-in, database-backed sessions, and one private
workspace per user. Task 2.3 associates a separately authorized GitHub App
installation with that workspace. Repository selection and repository operations
remain future work.

## Web/API shell

Install the pinned dependencies and start local development:

```sh
npm ci --ignore-scripts
npm run dev
```

Open `http://localhost:3000` for the landing page. The health endpoint is
available at `http://localhost:3000/api/health` and returns the service status as
JSON.

## Local authentication and PostgreSQL

Task 2.2 uses Better Auth for GitHub OAuth and server-side sessions. Create a
GitHub OAuth App with:

- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:3000/api/auth/callback/github`

Copy `.env.example` to the ignored `.env.local` file and set `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, and
`GITHUB_CLIENT_SECRET`. Generate the auth secret locally with
`openssl rand -base64 32`; do not commit or paste any secret into reports or
chat. The OAuth App is used only to establish identity. Repository permissions
will use a separate GitHub App in Task 2.3.

Apply the checked-in PostgreSQL migration explicitly, then start the app:

```sh
npm run db:migrate
npm run dev
```

Visit `http://localhost:3000/sign-in`. A successful GitHub sign-in creates one
database-backed Vigilo session and idempotently provisions exactly one private
workspace. `/app` and `/api/workspace` validate the session against PostgreSQL
and resolve that workspace on the server for every request. Signing out deletes
the active session. OAuth tokens are encrypted at rest by Better Auth and are
never returned by the workspace endpoint.

The reviewable schema is in `db/schema.ts`; SQL migrations and Drizzle snapshots
are under `drizzle/`. Production startup never mutates the schema automatically.
Authentication tests run the same PostgreSQL migration against an ephemeral
PGlite PostgreSQL engine, so normal tests need neither live GitHub OAuth nor a
separately managed test database.

## Local GitHub App installation

Task 2.3 keeps identity OAuth and repository authorization separate. The OAuth
App described above answers who signed in. A distinct GitHub App records what
repository access the user grants to Vigilo. The GitHub App requests only:

- Metadata: read
- Contents: read and write
- Pull requests: read and write

The current installation flow uses `/api/github/installations/setup` as the App
setup URL and `/api/github/installations/callback` as its OAuth callback. GitHub
documents that the `installation_id` in a setup redirect can be spoofed. Vigilo
therefore binds the installation attempt to the current database session and
workspace with a short-lived, single-use state value, then uses a transient
GitHub App user authorization to confirm that the signed-in GitHub user can
access the installation. It independently verifies the installation with an App
JWT before storing stable installation facts. The transient user grant is
revoked immediately. No installation access token is minted or stored.

After creating the local development GitHub App, configure the additional
`GITHUB_APP_*` values from `.env.example`. Save the downloaded private key at
`.secrets/vigilo-dev.pem` with file mode `0600`; `.secrets/` is ignored. Never
paste the PEM into source, chat, or an environment value. Apply the explicit
migration with `npm run db:migrate`, restart the web process, sign in, and visit
`http://localhost:3000/app/github`.

GitHub App setup is intentionally manual for this local milestone. No webhook,
repository listing, installation-token minting, or repository operation exists
in Task 2.3.

Build and run the production server with:

```sh
npm run build
npm start
```

`npm run build` compiles the existing Milestone 1 commands before building the
Next.js application. `npm test` runs the Milestone 1 tests followed by the focused
web tests. The sandbox demonstrations remain independently available through
`npm run demo` and `npm run demo:failure`.

## Milestone 1 execution boundary

Task 1.1 proves the disposable Node.js 24 Vercel Sandbox boundary. Task 1.2 adds
a separate [controlled broken fixture](fixtures/README.md). Task 1.3 runs its
[original failing baseline in a real sandbox](docs/baseline.md). Task 1.4
[applies and freezes the predetermined candidate](docs/candidate.md). Task 1.5
[verifies those frozen bytes in a fresh sandbox](docs/verification.md). Task 1.6 generates an offline
[structured evidence report](docs/evidence-report.md) from recorded execution
results and the frozen candidate artifact.
Task 1.7 exercises [failure cleanup and provider expiry](docs/failure-cleanup.md)
with controlled live sandbox failures.

## Milestone 1 demonstration

Milestone 1 proves the complete execution boundary with one controlled fixture.
The happy path uses one repair sandbox to reproduce the known bug and create the
candidate, followed by a different fresh verifier sandbox that receives only the
pristine base and frozen candidate bytes. Run it with:

```sh
npm run demo
```

The command builds Vigilo, validates the committed fixture, reproduces the
2-passed/1-failed threshold regression, applies only the pinned repair, freezes
the exact candidate under `.vigilo/candidates/`, and confirms repair-sandbox
cleanup. It then provisions a fresh verifier, independently installs dependencies,
confirms deny-all networking before fixture scripts, and requires typecheck,
build, and all three tests to pass without source mutation. Finally it writes a
content-addressed execution record and versioned report under
`.vigilo/evidence/`. The final JSON exits successfully only when every identity,
result, separation, credential, and cleanup proof agrees.

Exercise the existing Task 1.7 dependency-installation failure with:

```sh
npm run demo:failure
```

Expected failure-demo output classifies `dependency_installation_failure`, retains
bounded diagnostic hashes/counts and the allowlisted npm code, starts no later
work, and confirms stop, deletion, and absence. This controlled failure is a
successful demonstration, so the command exits zero only when that failure and
its cleanup are observed exactly.

## Prerequisites and pinned dependencies

- Local Node.js **24.13.0** (`.nvmrc`); the probe rejects other Node majors.
- npm **11.6.2** (`packageManager`).
- `@vercel/sandbox` **3.2.1**.
- TypeScript **7.0.2**, `@types/node` **24.13.3**, and
  `@types/async-retry` **1.4.9** (required by the SDK's public declarations).
- `package-lock.json` pins the resolved dependency tree. Install with `npm ci`.

Tests use Node's built-in runner. Authentication integration tests use PGlite's
embedded PostgreSQL engine and do not use SQLite.

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
- The Milestone 1 demo is intentionally limited to the committed single-package
  Node.js 24/npm/Vitest fixture and one predetermined patch. It does not clone
  GitHub repositories, invoke an AI agent, persist durable jobs, or publish pull
  requests. The managed sandbox image pins Node's major version rather than an OS
  digest, so each report records the observed runtime. `.vigilo/` artifacts are
  local, ignored, unsigned evidence; the trusted host can replace them.

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
