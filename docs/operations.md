# Vigilo controlled-beta operations

## Deployment topology and release identity

Vigilo is a three-part modular monolith: one stateless Next.js web service, one
multi-queue worker, and one shared PostgreSQL database containing application,
pg-boss, execution-authority, and operational state. Every production web and
worker process must receive the same exact 40-character `VIGILO_RELEASE_SHA`.
Readiness requires migration 0023 and a fresh `ready` worker heartbeat with the
same release and exact seven-queue registration. Provider availability is not a
readiness dependency. Task 4.3 live acceptance remains pending and draft
publication remains hard-blocked.

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

`undici@7.29.0` is installed transitively through `@vercel/sandbox`. The current
npm audit groups several advisories under one high-severity transitive finding,
including optional WebSocket, interceptor/cache, BalancedPool, and HTTP response
decompression behavior. Vigilo does not invoke the SDK's interactive WebSocket,
cache, dump, RetryHandler, or BalancedPool APIs. Its supported sandbox boundary
does use the SDK's authenticated HTTP client and Agent, so the transitive HTTP
response-handling dependency remains tracked rather than being described as
unreachable. Current execution authority is zero and Task 4.3 live acceptance is
pending. This is not evidence that unreviewed SDK paths are safe; upgrading the
sandbox dependency remains separate reviewed work.
