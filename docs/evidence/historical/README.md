# Historical live evidence — V0.9

This is a **sanitized summary of read-only PostgreSQL evidence inspected on 2026-11-03**, paired with the published worker and protocol code. It omits workspace/user/account IDs, run and job UUIDs, Sandbox identifiers, credentials, raw provider payloads, source contents, and session material. “Attempt 1” and “Attempt 2” refer to the two separately owner-approved M7.7B live repair attempts. The public fixture was frozen at commit `3575b04ff48cf07f9f52b5b3f8cf529520619307`. These records are evidence of bounded execution, **not evidence of an autonomous repair**.

## Real baseline results

| Durable field or check | Attempt 1 | Attempt 2 |
| --- | --- | --- |
| RepairRun state after baseline | `ready_for_investigation` | `ready_for_investigation` |
| Baseline execution and overall outcome | `test_failed` | `test_failed` |
| Dependency installation | completed, exit 0 | completed, exit 0 |
| Typecheck | completed, exit 0 | completed, exit 0 |
| Build | completed, exit 0 | completed, exit 0 |
| Tests | failed, exit 1 | failed, exit 1 |
| Source unchanged and before/after identities equal | yes | yes |
| Approved source checkpoint and manifest matched | yes | yes |
| Recorded Sandbox network policy | `deny-all` | `deny-all` |
| Recorded credential exposure | absent | absent |
| Stop / delete / absence lookup | confirmed / confirmed / absent | confirmed / confirmed / absent |
| Recorded baseline duration | 10.258 seconds | 10.450 seconds |

The `test_failed` result is the expected **red baseline outcome** for the seeded fixture; it does not mean the overall repair succeeded. The live baseline rows contain test phase status and exit code, but do **not** retain individual passing/failing test names, counts, assertion text, or raw test output. We therefore do not publish a claimed observed assertion. The source checkpoint and baseline integrity fields support the frozen-source claim; the recorded `deny-all` and cleanup fields support the isolation and lifecycle claims. They are application evidence, not independent provider billing or infrastructure logs.

## Investigation outcomes

- **Attempt 1:** bounded context became ready with seven indexed paths. Its AI Investigation remained unstarted until authority expired. The exact queued job was later retired and cancelled through the owner-confirmed retirement path. No Gemini request or diagnosis was recorded for that attempt.
- **Attempt 2:** bounded context became ready with seven indexed paths and no tree truncation. The AI worker made seven logical Gemini investigation requests. The provider-event ledger has **seven successful attempt outcomes**, with observed usage totaling 4,407 input tokens and 369 output tokens. Vigilo reserved 48,911 complete serialized-request bytes and 17,500 output tokens across those calls; reservations are not actual token usage or a bill.

| Request | Durable context operation following the successful response | Recorded output tokens |
| --- | --- | ---: |
| 1 | Read sanitized baseline summary | 10 |
| 2 | List seven indexed paths | 9 |
| 3 | Read one test file | 22 |
| 4 | Read one source file | 20 |
| 5 | Search allowed text; zero matches | 15 |
| 6 | Read package metadata | 18 |
| 7 | No context operation; reserved tool-free finalization | 275 |

All six context operations completed without recorded truncation, budget exhaustion, or failure. The final request received a successful provider response, but the Investigation ended `failed` with `model_limit_exceeded`; its only worker attempt ended `exhausted`. No conclusion status, summary, suspected files, evidence references, or proposed approach was stored. The PgBoss job ended terminally with zero retries. No candidate generation, repair loop, independent verification Sandbox, or repair publication was created for this attempt.

## What this evidence cannot show

The provider response content, including the last response, was not retained. Vigilo's output-token accounting can include thought tokens. Consequently, 275 recorded output tokens do **not** prove that a diagnosis was emitted or that a valid diagnosis was rejected. The runner reserves request 7 for a strict conclusion and maps an invalid final result or final protocol error to `model_limit_exceeded`. The exact final-response shape and precise cause of rejection are unknown. The available baseline summary also lacks named test diagnostics; the record cannot prove the model had enough information to diagnose the defect.

The current reviewed-plan ceilings of seven investigation and six generation requests describe the implementation, not a successful end-to-end run or guaranteed Free Tier/Hobby cost. Earlier deterministic component demonstrations in this repository are separate from these live AI attempts. No green AI-generated repair, human approval of such a repair, draft repair PR, merge, or deployment is claimed.

## Provenance and disclosure boundary

This summary was derived from a transaction marked read-only against the positively identified local Vigilo development database, selecting only phase status, exit codes, source-integrity booleans, cleanup classifications, context counts, terminal states, and provider-event usage totals. Public source references for the controls include `lib/repository-baselines/runner.ts`, `src/sandbox-boundary.ts`, `lib/ai-investigations/runner.ts`, `lib/ai-investigations/gemini-provider.ts`, and `lib/external-execution/reviewed-plan.ts`. No database export or provider payload is included here. This is a local historical record, not a claim about another deployment.
