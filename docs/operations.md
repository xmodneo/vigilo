# Vigilo controlled-beta operations

## Deployment topology and release identity

Vigilo is a three-part modular monolith: one stateless Next.js web service, one
multi-queue worker, and one shared PostgreSQL database containing application,
pg-boss, execution-authority, and operational state. Every production web and
worker process must receive the same exact 40-character `VIGILO_RELEASE_SHA`.
Readiness requires migration 0023 and a fresh `ready` worker heartbeat with the
same release and exact seven-queue registration. Provider availability is not a
readiness dependency. Task 4.3 live acceptance remains pending and draft
publication remains hard-blocked. Normal publication resolves the complete
immutable four-kind acceptance set for the exact `VIGILO_RELEASE_SHA`; a later
commit therefore invalidates that release acceptance.

The first separately authorized live draft-publication acceptance may use a
server-only one-shot bootstrap. That path remains unavailable unless the exact
repair-loop, human-review, and security/cost acceptances already resolve and an
expiring durable grant binds the workspace, installation, repository, frozen
revision, run, loop iteration, generation, candidate, verification evidence,
human decision, release, and draft-only operation. The reservation is consumed
on success or ambiguity. It cannot merge, deploy, force-push, or update the
default branch, and it is not exposed in the customer UI. No such grant or live
acceptance exists today.

The customer HTTP path accepts only the complete four-kind gate. A future
operator procedure must reserve the first acceptance publication server-side;
the customer endpoint cannot use bootstrap authority. Its recorded issuer and
acceptance reviewer must resolve to the same existing GitHub-authenticated
workspace owner who approved the exact subject. No grant or acceptance issuance
API exists. Privileged database writers remain a trust boundary: canonical hashes
prove consistency, not that a fabricated transport occurred. Test adapters are
excluded from the worker build, and resolver injection is restricted to the Node
test harness. Execution evidence requires matched provider-attempt events,
terminal audit events, unrevoked grants, and matching lease fences.

Revocation or privacy changes observed after a remote write prevent subsequent
writes and local success; they cannot undo a remote side effect already executed.

The source and model workers support public GitHub repositories only. A private
repository may remain visible as historical metadata, but selection and every
source, model, sandbox, RepairLoop, verification, and publication boundary fail
with `private_repository_not_supported` before transport use.

## Secret ownership and rotation

- Web: Better Auth secret, GitHub OAuth credentials, rate-limit HMAC key.
- Worker: Gemini and Vercel credentials only when an authorized operation uses them.
- Shared minimum: database URL, GitHub App signing identity/key, release SHA.

Production secrets belong in the eventual hosting platform's secret facility,
never source control, logs, browser bundles, process arguments, or database
rows. Local `.env.local`, `.secrets/`, and `.vigilo/` are development-only and
ignored. Rotate a suspected credential first, revoke sessions/tokens or grants,
then investigate with stable event codes. Hosted secret-manager selection and
rotation drills remain future deployment acceptance work.

V1 Sandbox authentication requires explicit `VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
and `VERCEL_PROJECT_ID`. The token must be a non-refreshing, team-scoped access
token held only in the control plane, never in sandbox environments, source,
commands, logs, evidence, or API responses. OIDC configuration (including an
empty configured variable or a mixed mode) and three-segment JWT-shaped tokens
fail with `sandbox_auth_mode_unsupported`; incomplete fields also fail before
transport. Vigilo neither unsets credentials nor silently falls back to SDK
auto-discovery. OIDC itself is not unsafe: it is deferred until a separately
reviewed refresh implementation can meter every request. Readiness remains
provider-independent; credential configuration is validated locally at the
execution boundary, without any provider probe.

Sandbox SDK 3.2.1 permits two retries, at most three metered fetch invocations
per SDK HTTP operation. Vigilo forces manual redirects and rejects all 3xx
responses without following or recording Location. Redirect and durable-authority
errors terminate SDK retries; network errors, 429, and 5xx remain metered retries.
Successful responses and reservation completion recheck unrevoked, unexpired
grants and lease/fence ownership; late failures remain consumed. The unchanged 96-attempt
reservation is a hard ceiling over application-visible Sandbox HTTP attempts
within one reserved lifecycle, including cleanup/recovery requests and retries.
Separately authorized recovery has its own reservation, still subject to the
cumulative operation/account grants; 96 is not a whole-RepairRun limit.
Each invocation checks durable authority, grants/revocations, active lease/fence,
expiry, and remaining allowance before dispatch; its lease retains the global
concurrency slot acquired at reservation. Failed and ambiguous attempts remain
consumed. This does not bound DNS, TLS, TCP retransmissions, provider-internal
work, or monetary charges. No real access token was inspected or provisioned in
this remediation, and no live acceptance of this boundary has occurred.

## HTTP abuse boundary

All API routes except dependency-free liveness pass through PostgreSQL-backed
fixed-window limiting. Authenticated requests use the server-resolved user
identity; anonymous authentication/setup traffic and invalid sessions use an
HMAC-hashed client IP. Plaintext IPs are never stored. Production anonymous-IP
protection requires an explicit `VIGILO_TRUST_PROXY_HOPS` value from 1 through
8; readiness fails closed when it or the rate-limit HMAC key is absent or
malformed. Caller-supplied forwarding headers are ignored unless that contract
is configured. Liveness remains outside the database-backed limiter so it stays
dependency-free; readiness and all workflow/status routes are limited. This is
an application abuse-control boundary, not a replacement for an eventual edge
rate limiter.

## Local operational snapshot

`npm run ops:snapshot` performs read-only bounded aggregate queries for the
seven known queues, worker freshness, active runs and stale leases, provider
attempt outcomes, authority/budget failures, cleanup and publication ambiguity,
migration compatibility, and rate-limit activity. Labels are fixed
low-cardinality categories only. The command is local/operator-facing and is
not a public metrics endpoint or evidence that production monitoring exists.

## Forward-only migration procedure

1. Record the exact release SHA and checked migration manifest.
2. Put web traffic into maintenance/unready state.
3. Drain and stop the worker; confirm there is no unsafe external lease.
4. Create and validate a recoverable backup.
5. Run `npm run db:migrate`. It acquires Vigilo's fixed PostgreSQL advisory lock,
   verifies the ordered ledger/hash prefix, migrates once, and verifies the full ledger.
6. Verify expected catalog objects, triggers, and historical fingerprints.
7. Start the worker with the same release SHA and require a fresh `ready`
   heartbeat with the exact queue set and schema version.
8. Start web, confirm readiness is 200, then route traffic.

Never edit a historical migration, stored hash, or ledger row. Repair a
committed bad migration with a new forward migration.

## Backup and restore

Run `npm run test:backup-restore-postgres` only against the local disposable
database host. It creates two uniquely named disposable databases, migrates the
source through 0023, writes safe fixtures, produces and validates a custom-format
archive, restores it, compares ledger and fingerprints, proves external
authority is zero, and drops only those databases. Never restore over the
persistent development database. Hosted backup/PITR behavior is unverified until
deployment infrastructure is selected.

For controlled beta, the proposed (not proven) recovery objectives are RPO 15
minutes and RTO 4 hours. They are not production SLOs.

## Incident response

Stop routing new work and revoke or expire execution grants when external cost
authority may be involved. Drain workers when safe; preserve immutable evidence
and append-only events. Record only release, schema, stable failure code, bounded
queue category, and time range—never raw source, prompts, output, tokens, or keys.
Restore service only after manifest, heartbeat, queues, and authority checks pass.

Provider outage: do not loosen budgets or retry ceilings. Execution-authority
incident: revoke grants and confirm effective authority is zero. Sandbox cleanup
incident: stop replacement work until absence is confirmed. Queue corruption or
backlog: drain, inspect the bounded snapshot, and do not delete jobs or evidence
speculatively. Duplicate or ambiguous publication: remain in `review_required`;
never guess or update a remote ref. Cross-workspace concern: disable affected
entry points and verify exact workspace joins before resuming.

## Customer-data lifecycle

For V1 beta, disconnect blocks new work and revokes active access where
possible; sessions and OAuth state can be removed. Immutable repair evidence and
provenance cannot be blindly cascaded without invalidating audit authority.
Export, retention, and deletion require explicit product/legal policy approval.
Workspace/account deletion is operator-assisted and fail-closed. These are
engineering constraints, not claims about statutory retention requirements.

## Known limitations

Production hosting, managed backups/PITR, private repositories, Task 4.3 live
acceptance, live draft publication, real-provider crash recovery, and guaranteed
repair quality are not validated. The local operational snapshot is not a
monitoring service. No paid monitoring, hosted PostgreSQL, or secret manager is
selected by Milestone 7.4.

The reviewed dependency patches pin Next.js 16.3.8, Sandbox's compatible Undici
7.29.1, and PostCSS 8.5.23's source-map-js 1.2.2. Sandbox remains 3.2.1. Narrow
parent-scoped overrides avoid unrelated upgrades. Install with lifecycle scripts
disabled and run root and fixture audits against the lockfiles; an audit covers
known advisories, not all possible supply-chain risk. Current execution authority
remains zero and Task 4.3 live acceptance remains pending.

Residual audit finding (2026-10-06): the independently frozen free-shipping
fixture still resolves `source-map-js@1.2.1` through its PostCSS 8.5.28 tree and
reports high-severity [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
The root override does not patch that independent lockfile. The controlled
fixture contains no supplied indexed source maps; its shipping tests and the
inspected PostCSS/Vite/Vitest paths do not call SourceNode indexed-map re-emission.
This is not a general safety claim about arbitrary source maps or future tooling.
Final classification: **C — MUST REPLACE THE FUTURE LIVE ACCEPTANCE FIXTURE WITH A
CLEAN EQUIVALENT**. Exact reuse of this lockfile by the future public acceptance
repository has not been established and is not approved by this remediation.
Keep the historical deterministic fixture unchanged: its audited digest includes
the lockfile, and editing it would invalidate prior identity/evidence assumptions.
Before M7.7B, obtain separate approval for a clean equivalent public fixture with
a freshly frozen identity and trustworthy measured failing baseline; do not reuse
historical candidate/verification evidence for it. No fixture/repository creation
or historical evidence change is authorized by this review.
