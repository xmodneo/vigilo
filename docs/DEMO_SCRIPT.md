# Vigilo V0.9 — 2–3 minute interview walkthrough

**Before the demo:** open the README, [system design](DESIGN.md), and [sanitized historical evidence](evidence/historical/README.md). Use recorded evidence and source navigation only. Do not start a worker, stage a run, or call a provider for this walkthrough.

**0:00–0:30 — Problem and scope.** “Vigilo explores a safe AI repair workflow for public Node.js repositories. It freezes an exact commit, measures the failing baseline, gives the model bounded read-only tools, and would verify a candidate in a fresh Sandbox before human review. This V0.9 release demonstrates the backend and its failure controls; it does not claim an autonomous repair.”

**0:30–1:15 — Show the trust boundaries.** In [reviewed staging](../lib/external-execution/reviewed-staging.ts), point to the atomic run/grant/job transaction and the fixed release, source, expiry, and provider identities. In [the one-shot entrypoint](../worker/baseline-once.ts), show that an exact job is claimed only after authorization. Mention that a queued job is inert until its separate worker invocation; the old self-service Start Repair route is disabled.

**1:15–1:55 — Show measured Sandbox evidence.** Use the baseline table in the evidence package: both real runs installed dependencies, typechecked and built successfully, then exited 1 on tests. The recorded source identities matched; networking was `deny-all` before repository scripts; stop/delete/absence cleanup completed. Explain that a red baseline is a successful measurement, **not** a successful repair. Do not quote a named failing assertion from these live records; it was not retained.

**1:55–2:30 — Show bounded AI behavior and the stop.** Attempt 2 prepared seven source paths. Gemini returned seven successful provider responses, leading to six audited context operations. Its reserved, tool-free finalization did not yield an accepted structured conclusion. Vigilo recorded `model_limit_exceeded`, exhausted the attempt, and did not start candidate generation or verification. The final response content is unavailable, so the exact rejection cause is unknown.

**2:30–3:00 — Engineering judgment.** “The useful result is a source-bound, auditable execution path that fails closed. We stopped after two live attempts rather than spending a third on an unexplained model/protocol failure. The missing green verification is a limitation, not a hidden success.” Point to the five tradeoffs in [DESIGN.md](DESIGN.md).

## Resume-bullet candidates and proof

These are **candidate wording**, to use only with the stated evidence and qualifications:

1. “Built a TypeScript/Next.js/PostgreSQL repair prototype with transactional, owner-reviewed execution grants and exact-job PgBoss workers.” **Support:** source in `lib/external-execution/reviewed-staging.ts`, `worker/baseline-once.ts`, `worker/exact-phase-once.ts`, plus the recorded staged and terminal run/job history. **Qualification:** local controlled-beta implementation, not deployed production service.
2. “Executed two real frozen-source Vercel Sandbox baselines with verified `deny-all` policy, source-integrity checks, and confirmed cleanup.” **Support:** the two durable baseline rows summarized in [historical evidence](evidence/historical/README.md). **Qualification:** tests were red as expected; no AI-generated green repair followed.
3. “Implemented bounded Gemini tool access and durable provider-attempt accounting; diagnosed a live finalization failure and stopped downstream execution.” **Support:** `lib/ai-investigations/runner.ts`, `gemini-provider.ts`, and seven successful provider-attempt events with six audited context operations. **Qualification:** no accepted diagnosis; the final response was not retained, so its precise failure mechanism is unknown.

The most interesting design decisions are the separation of **enqueue from spend**, frozen source and candidate identities, and permanent fencing of ambiguous provider outcomes. The live AI repair remains unverified because the second attempt exhausted its seven-request investigation without an accepted conclusion, and no candidate or independent verification was produced.
