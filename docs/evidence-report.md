# Task 1.6: structured execution evidence

```sh
npm test
npm run typecheck
npm run evidence
```

`npm run evidence` is offline. It does not load `.env.local`, contact Vercel, or
execute the fixture, patch, baseline, repair, or verifier. It reads
`.vigilo/evidence/records/workflow.json` and the existing frozen candidate under
`.vigilo/candidates/`. Reports are written only to
`.vigilo/evidence/reports/<reportId>.json`. The existing `.vigilo/` ignore rule
covers both imported records and generated reports. No dependency was added.

## Schema version 1

The executable schema is the explicit field decoders in `src/evidence.ts`;
`EvidenceReportV1` exports the resulting TypeScript type. Only selected fields
can appear in a report. Missing values normalize to JSON `null`, including missing
whole stages. Present values of the wrong type or format throw `invalid_evidence`.

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1`; identifies this report schema. |
| `reportId` | Lowercase SHA-256 of compact JSON of all other report fields, in builder order. |
| `createdAt` | Required ISO UTC timestamp with milliseconds, supplied in the input envelope. This is report creation time, not an invented execution timestamp. |
| `observations.baseFixtureIdentity` | Pinned original fixture SHA-256, revalidated while loading the candidate. |
| `observations.candidate` | Candidate schema version, identity, changed paths/content hashes, and artifact validation result. Exact candidate bytes are validated but not included in the report. |
| `observations.baseline` | Nullable Task 1.3 record projection: sandbox name/session, image/runtime, fixture integrity checks, install/policy, typecheck/build/tests, counts/known assertion, credentials and cleanup. |
| `observations.freezing` | Nullable Task 1.4 projection: base/candidate identities, changed paths/hashes/count, validation/frozen status, sandbox, credentials and cleanup. |
| `observations.verification` | Nullable Task 1.5 projection: original/frozen/applied/post-execution identities, repair/verifier identifiers, separation/base integrity checks, runtime/image, install/policy, commands/counts/regression, credentials and cleanup. |
| `classification.rulesVersion` | Integer `1`; identifies the decision rules below. |
| `classification.checks` | Named `true` / `false` / `null` predicates. Null means insufficient evidence. |
| `classification.overallOutcome` | `verified`, `invalid_verification`, `failed_verification`, or `incomplete`. |

Each stage also includes:

- `provenance`: `kind` (`captured_execution` or `imported_tool_output`), optional
  tool item ID, optional execution timestamp, and capture truncation flag.
- `producerClaims`: the original runner's reported success/outcome, separated
  from this report's classification. These claims cannot replace other checks.
- `errorPresent`: true for a recorded error object, false for an explicit null,
  and null if the error field was not recorded. Raw error details are discarded.

Commands retain only the exact allowlisted npm argv, timeout, exit code, timeout
flag, producer status, and output metadata. Command status is the runner's
interpretation; exit code is an observation. Only the pinned installation,
typecheck, build, and JSON-reporter test commands are accepted. An unrecognized
command is malformed evidence; its arguments are never printed or executed.

Output metadata contains `textIncluded: false`, `trust: "untrusted"`, optional
stdout/stderr SHA-256, `sourceTruncated: boolean | null`, and
`reportTruncated: false`. This version deliberately excludes all output text,
including errors, even if a record contains it. It never silently truncates a
report. Explicit source truncation prevents successful classification. Older
command records did not retain a truncation flag; that field remains null, and
their recorded normal-completion status/timeout/exit observations are used.
Whole execution-record capture truncation must explicitly be false for success.

## Input records

The envelope uses the existing runner result objects as data:

```text
{
  schemaVersion: 1,
  createdAt: ISO timestamp,
  baseline: { source: provenance, result: Task 1.3 result } | null,
  freezing: {
    source: provenance,
    sandbox: { name, sessionId? },
    result: Task 1.4 result
  } | null,
  verification: { source: provenance, result: Task 1.5 result } | null
}
```

The optional freeze `sandbox` comes from that run's separate
`sandbox_requested` event, since its final result lacked an identifier. Missing
metadata must stay null. The generator does not infer facts from documentation,
current code defaults, a producer's prose, or the verifier's embedded historical
negative-control summary. Baseline evidence must be supplied as its own record.

For this task, complete original **command tool outputs** were recovered through
the task-history API and parsed as JSON, without reconstructing results from AI
messages. Imported source IDs are:

- Baseline: `exec-75f18255-a59a-4c59-8be4-2d563ad02305`.
- Freeze: `exec-8a1fb235-4ad5-4e84-8761-2adf4b407a73` (including its sandbox event).
- Verification: `exec-b309cfab-b48c-4a9a-a5fb-5d684014384e`.

The import has no exact per-command execution timestamp, so `observedAt` is null.
Task/turn start or completion times are not substituted for execution times.
The baseline and verifier provider session IDs are retained. The repair session
ID, repair runtime/image, repair credential check, and verifier image were not
included in those outputs and remain unavailable. No successful value is inferred
for any of them. Task 1.5 separation uses the recorded unique repair sandbox name.

## Classification rules

All predicates must be true for `verified`:

1. All three records are present, with complete capture provenance.
2. All base and candidate identities agree with the validated original/frozen
   artifact. Changed paths and hashes match exactly.
3. Baseline: all recorded fixture checks true; safe installation exits 0; deny-all
   confirmed in the same session; typecheck/build exit 0; tests exit 1 normally;
   counts are exactly 3 total, 2 passed, 1 failed; known threshold assertion is
   `expected_0_received_500`; credentials absent and cleanup confirmed.
4. Freeze: exact source-only change, validation passed, frozen outside sandbox,
   no recorded error, success claimed, and cleanup confirmed.
5. Verifier: identity equality, pristine-base integrity and separation confirmed;
   repair name matches the freeze event and differs from the verifier name.
   Verifier session ID must be recorded; if both provider session IDs are known,
   they must differ too. Missing repair session ID is not invented.
6. Fresh execution: Node 24 observed; exact safe installation exits 0; deny-all
   readback/same-session confirmed; exact typecheck/build/test commands complete
   normally with exit 0; counts are 3 passed, 0 failed and the named threshold
   regression passes; credentials absent and cleanup confirmed; no recorded error;
   the runner must also have reported successful verification.
7. Post-execution source identity equals the frozen candidate and the recorded
   unchanged-source check is true.

Identity conflicts, changed source, or failed separation take precedence and yield
`invalid_verification`. Other disproven required conditions yield
`failed_verification` (including failure of the baseline/freeze evidence chain).
If no condition is disproven but required evidence is unavailable, the result is
`incomplete`. A raw `success: true` or `outcome: "verified"` cannot override these
rules. These classifications are interpretations of the recorded observations.

## Determinism, storage, and limits

Given the same selected observations, validated artifact, and `createdAt`, output
JSON and report ID are identical regardless of input object key order. A different
creation timestamp produces a different report ID; it never changes base or
candidate identities. No wall clock or random value is read by the builder.

Input JSON is bounded to 256 KiB, candidate data to the existing 16 KiB limit, and
reports to 64 KiB. Input/output files must be regular files. The known runtime
directories and input files reject symlinks. Report publication uses a private
staging file and exclusive atomic link. Existing reports are accepted only when
their bytes match exactly; no previous report is overwritten. Files are created
with mode 0600, directories with 0700. Cleanup removes only the private staging
directory created by this operation under the evidence directory.

This is local evidence, not a cryptographic attestation of the sandbox provider.
The trusted host can replace input records; a hash proves content identity, not
truth of arbitrary claims. The report independently checks the controlled
workflow's recorded evidence chain, within the same quiescent-fixture and trusted
provider-API assumptions as Tasks 1.4/1.5. General malicious-code verification,
durable record services, signing, databases and object storage are outside scope.

## Validation

Focused tests cover verified and incomplete reports, failed verification,
identity conflicts, source mutation, shared sessions, truncation metadata, secret
sentinels in environment/runtime/output fields, malformed values, deterministic
serialization, bounded local input, symlink rejection, and each mandatory verifier
gate. They use synthetic execution records and the real fixture/candidate
validators. The generated local acceptance report uses recovered live records.

The offline acceptance report generated on 2026-09-05 has ID
`1065735f61ef7b5d211600023aca8761056e332c4ab5e252be4915082522fd1b`.
All nine classification checks are true and the overall outcome is `verified`.
Its baseline has 2 passes / 1 known failure; its verifier has 3 passes / 0 failures
and unchanged source identity. All three cleanup records confirm deletion and
absence. No sandbox was provisioned for report generation. The report passed a
credential-pattern scan and comparison against local credential values without
printing them. All 59 focused tests, typecheck/build, and diff checks passed.
