# Vigilo

Vigilo is an engineering prototype for repairing a failing test in an eligible public Node.js repository. It freezes a source revision, measures a baseline in an isolated Sandbox, lets a bounded AI investigator inspect the failure, and is designed to verify any proposed change in a separate Sandbox before a person reviews it.

**V0.9 outcome:** the backend completed two real, source-bound failing baselines. On the second attempt, Gemini completed seven bounded investigation requests and six source-context operations, but Vigilo accepted no structured diagnosis. No AI-generated patch or independently verified green repair was produced. We stopped further live attempts rather than treating a provider response or an untested patch as success. The [sanitized evidence](docs/evidence/historical/README.md) records what was measured and what remains unknown.

## What works

- GitHub App integration selects an eligible **public**, single-package Node.js 24/npm repository and binds work to one frozen commit and source manifest.
- Owner-reviewed staging creates one RepairRun, its source checkpoint, six bounded execution grants, and an inert baseline job in one transaction. The self-service Start Repair route is disabled; new operational runs require a separately approved plan.
- An exact-job worker runs the baseline in one `vcpu_1` Vercel Sandbox. It installs dependencies under a registry-only policy, confirms a `deny-all` network transition and same-session readback before repository scripts, records phase results, and verifies stop/delete/lookup-absent cleanup.
- A separate exact-job worker prepares bounded, read-only source context. The Gemini investigation uses four scoped tools, durable request reservations, a strict conclusion schema, and no SDK retries.
- PostgreSQL stores runs, immutable evidence, grants, reservations, provider-attempt events, leases, and PgBoss jobs. Exact-job workers do not start the general multi-queue consumer or automatically execute downstream jobs.

Candidate generation, repair-loop coordination, independent verification, human review, and draft-publication gates exist in the code and have local deterministic coverage. **Their complete AI-generated repair path has not passed live acceptance.** Publication, merge, and deployment are not automatic; draft publication remains gated by missing live acceptance.

## Architecture

Vigilo is a TypeScript modular monolith: a Next.js 16 web application with Better Auth and GitHub OAuth/App access; PostgreSQL 17 with Drizzle and PgBoss; explicit one-shot workers; Google Gemini 3.1 Flash Lite for investigation and candidate generation; and Vercel Sandbox for isolated baseline and verification work. The web process and workers share a release SHA and checked migration ledger, but workers require separate startup and exact authority.

The [system design](docs/DESIGN.md) explains the transaction boundaries, source integrity checks, provider budgets, and five important tradeoffs. Existing deeper notes cover [operations](docs/operations.md), [baseline isolation](docs/baseline.md), [candidate artifacts](docs/candidate.md), and [verification](docs/verification.md). Those component histories do not constitute a live AI-generated repair.

## Measured V0.9 evidence

Two separately approved attempts against the frozen public acceptance fixture recorded `test_failed` baselines. In each, dependency installation, typecheck, and build exited 0; tests exited 1; source identity remained matched; the Sandbox reported `deny-all`; and stop, delete, and absence lookup were confirmed. Each baseline ran for about ten seconds. The database records phase status and exit code, but not individual test names or assertion text.

Attempt 1's prepared AI job was never executed before its grant expired and was later retired. Attempt 2 prepared seven indexed source paths. Its seven Gemini requests each received a successful provider response; six context operations completed (a baseline summary, path listing, three file reads, and one search). The reserved seventh, no-tools finalization did not yield an accepted structured conclusion, and the Investigation ended `model_limit_exceeded`. The final provider response was not retained, so we cannot determine whether it was empty, malformed, or rejected during parsing. No candidate generation, verification Sandbox, repair loop, or repair publication followed. See the [historical evidence package](docs/evidence/historical/README.md).

## Limits and safety boundaries

The current reviewed plan caps an investigation at **7 Gemini requests** and candidate generation at **6**, with each complete serialized request at **256 KiB**. Their input reservations are 1,835,008 and 1,572,864 bytes; output reservations are 17,500 and 36,000 tokens. The account ceiling is 16 logical operations, 205 provider attempts, 3,407,872 serialized input bytes, and 53,500 output tokens. These are Vigilo reservation units and ceilings, **not measured provider usage or a billing guarantee**.

One baseline and one independent verification Sandbox are allowed, each `vcpu_1` for at most ten minutes, plus one repair-loop iteration and one concurrent external operation. Vercel transport attempts are separately bounded; an ambiguous create never authorizes a replacement Sandbox. Gemini SDK retries are disabled. Grants expire by PostgreSQL time, revocation and lease ownership are rechecked, and ambiguous provider outcomes fence further execution. Free Tier and Hobby allowances do not guarantee zero charges or successful execution.

Public repositories only: private repository processing is rejected at source, model, Sandbox, verification, and publication boundaries. Source files, objective text, and tool results are treated as untrusted data. No credentials are placed in the model context or Sandbox commands.

## Limitations

- Vigilo has **not** autonomously repaired the acceptance fixture, produced an AI candidate, shown a live green independent verification, or published a repair pull request.
- The final Gemini response is unavailable. `model_limit_exceeded` identifies the failed finalization boundary but does not prove why the model's output was not accepted.
- The live baseline records do not preserve named failing assertions. The fixture's expected regression is not a substitute for observed assertion text in these records.
- Production hosting, managed backups, monitoring, private repository support, and real-provider crash/restart recovery are not validated. `/api/health` is liveness; readiness requires the matching worker and schema.
- This is an engineering portfolio release, not a commercial or production-ready repair service. The decision after two attempts was to stop live execution and disclose the gap.

## Local setup and reproduction

Use Node.js 24, npm 11, and an **isolated local PostgreSQL database**. Place local credentials in ignored, owner-restricted configuration such as `.env.local`; never copy example values from another operator or commit credentials. Configure the GitHub OAuth/App and provider identities through the project's existing local setup, then independently review provider billing and scopes before any live operation.

```sh
npm ci --ignore-scripts
npm run db:migrate       # only against your own disposable/local database
npm run dev -- --hostname 127.0.0.1 --port 3000
```

`GET /api/health` checks liveness. The application intentionally has no self-service Start Repair action. The code's deterministic suites can be examined with the scripts in `package.json`; live Sandbox and Gemini operations require separate owner-reviewed staging, unexpired grants, exact-job invocation, provider credentials, and spending approval. **Do not run `npm run baseline`, any worker, or staging merely to reproduce this README.** The public evidence package is the reproducible account of the completed live attempts; it does not require a new provider call.

For a short interview walkthrough, use the [2–3 minute demo script](docs/DEMO_SCRIPT.md). Resume-bullet candidates and the evidence needed to support them are included there.
