# Vigilo

Vigilo is a repair garage for AI builders. It diagnoses a reproducible problem,
prepares an exact repair candidate, checks that candidate in a fresh verification
environment, and presents the measured evidence for human review.

Vigilo is a controlled beta. It does not guarantee a repair, automatically merge
code, deploy software, or establish that a repository is production-ready.

## Controlled-beta scope and limitations

Vigilo currently supports eligible public, single-package Node.js 24/npm repositories.
Repairs may be inconclusive, fail verification, or end in a
review-required state. Vigilo does not automatically merge or deploy code. Draft
pull request publication remains unavailable until independent Task 4.3 live
acceptance is completed. Production hosting, managed backup/PITR, and monitoring
have not yet been selected or validated.

Private repositories are unsupported and code-enforced at every source, model,
sandbox, verification, review, and publication boundary. This beta is not
approved for private customer repository processing.

## Supported repository contract

An eligible repository has:

- public visibility;
- a root `package.json` and committed root `package-lock.json`;
- npm and Node.js 24 compatibility;
- one package, with no workspace or monorepo layout;
- a supported root test script with safe script delegation; and
- optional root typecheck and build scripts, which Vigilo runs when present.

The repository profile is checked against one exact commit. Stale access,
ambiguous scripts, conflicting lockfiles, unsupported package managers or test
runners, and malformed metadata fail closed.

## Repair workflow

1. Connect GitHub and choose an eligible public repository.
2. Describe a reproducible problem and start a separately authorized Repair Run.
3. Vigilo measures the frozen baseline and prepares bounded read-only context.
4. A bounded AI investigation records a structured assessment.
5. Vigilo freezes the exact proposed changed-file artifact.
6. A fresh sandbox reconstructs and verifies that exact candidate.
7. A reviewer sees the AI assessment, stored candidate content, baseline,
   verification evidence, measurable objective result, and bounded attempt history.
8. Approval or rejection immutably binds that exact candidate and evidence.
9. Draft pull-request publication is a separate action and is available only when
   its independent server-derived acceptance and authority gates pass.

Approval does not publish, merge, or deploy. Publication can create only a draft
pull request; it cannot mark a pull request ready, merge, deploy, force-push, or
delete a branch.

## Data use and provider resources

Before repository selection: Vigilo currently supports public repositories only.
Selecting a repository lets Vigilo inspect its metadata and, when explicitly
authorized, read source from an exact revision.

During an authorized repair, selected public repository source and the repair
objective may be sent to configured AI and sandbox providers. Vigilo may retain
the repair objective, frozen candidate contents, verification evidence, and audit
history. External execution remains separately server-authorized.

Execution is bounded by durable Vigilo server-side grants, exact operation scopes,
attempt limits, leases, and provider-call ceilings. Application budgets limit
resource use but do not guarantee a provider bill or dollar amount. With no valid
grant, effective external execution authority is zero and history remains read-only.

The development and live acceptance model is Google Gemini
`gemini-3.1-flash-lite`; this is not the final production model. The Gemini Free
Tier is used only for development and live acceptance against the public Vigilo
repository. Current Free Tier terms state that submitted content may be used to
improve Google products. It is not approved for private customer source.

## Local development

Requirements:

- Node.js 24;
- npm 11;
- PostgreSQL reachable through the ignored local `DATABASE_URL`; and
- local credentials only in ignored `.env.local` / `.secrets/` paths.

Install without lifecycle scripts, start the existing local PostgreSQL service
using the operator-approved mechanism for that environment, verify `DATABASE_URL`
targets it, apply the checked migration ledger, and start the web app:

```sh
npm ci --ignore-scripts
npm run db:migrate
npm run dev
```

Start the multi-queue worker separately only when the intended operation has
explicit external-execution authority:

```sh
npm run worker:dev
```

Useful deterministic checks:

```sh
npm run typecheck
npm test
npm run build
```

`GET /api/health` is dependency-free liveness only. `GET
/api/health/readiness` checks the database ledger, queue registration,
operational schemas, and a fresh same-release worker heartbeat. Neither health
endpoint contacts an external provider.

## Current release and acceptance state

- The checked clean-install migration ledger is `0000` through `0023`.
- Migration `0023_operational-readiness.sql` has been applied to the positively
  identified local development database. This local fact says nothing about
  production, staging, shared databases, or arbitrary deployments.
- `0020_human-review.sql`, `0021_repair-publication.sql`, and
  `0022_external-execution-authority.sql` were likewise applied only to the
  positively identified local development database during their reviewed
  workflows.
- Arbitrary deployments must independently verify and apply their own migration ledger through the forward-only migration process.
- Task 4.3 live acceptance remains pending. The real protocol-v4 generation to
  fresh verification, real sandbox evidence reconciliation, live verified
  recovery, live second iteration, and real-provider crash/restart recovery are
  not live-validated.
- The production publication resolver now requires the exact immutable
  `repair_loop_live`, `human_review_live`, `draft_publication_live`, and
  `security_cost_control` acceptance set for `VIGILO_RELEASE_SHA`. No such live
  set exists, so publication remains hard-closed with `live_acceptance_pending`.
  In the current zero-authority state, production publication cannot reach a GitHub write.
- A server-only, expiring one-shot bootstrap path exists solely for a future,
  separately authorized live draft-publication acceptance. It requires the
  exact prior repair-loop, human-review, and security/cost acceptances plus a
  subject-bound durable grant; no bootstrap grant or reservation exists today.
- Effective external execution authority is zero. No current UI state creates a
  grant or acceptance.
- The zero-spend policy remains in force. No live acceptance, provider request,
  Sandbox creation, or GitHub publication occurred while wiring this gate.
- Milestone 7.4 operational readiness is local and deterministic, not deployed
  production acceptance. Managed SaaS production readiness has not been established.

## Architecture and operations

- [Controlled-beta operations](docs/operations.md): deployment topology,
  readiness, migrations, backup/restore, incidents, and data lifecycle.
- [Baseline boundary](docs/baseline.md)
- [Candidate artifact](docs/candidate.md)
- [Fresh verification](docs/verification.md)
- [Evidence report](docs/evidence-report.md)
- [Failure cleanup](docs/failure-cleanup.md)

The system is a modular monolith: a stateless Next.js web service, one
multi-queue worker, and PostgreSQL for durable application, queue, authority,
audit, and operational state. Production startup never mutates schema
automatically. Credentials remain server-side and are never returned by the
workspace UI.
