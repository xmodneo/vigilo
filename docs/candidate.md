# Task 1.4: apply and freeze the predetermined candidate

Run with the same local Node 24 and ignored Vercel credentials as Task 1.1:

```sh
npm test
npm run typecheck
npm run candidate
```

The live command creates a billable disposable sandbox. It exits zero only after
candidate validation, confirmed sandbox deletion, and host artifact publication.
It performs no dependency installation, application tests, or independent
verification. Those are not acceptance claims for this task.

## Execution and trust boundary

1. Reuse `loadOriginalFixture()` and Task 1.3's exact seven-file identity:
   `60c6da3af26475c6efd1212487ae1a12d77a069d98fe5dd24dfd301c8d85e596`.
   Read the original fixture only; never patch the host fixture.
2. Read only `fixtures/repairs/free-shipping.patch`, checking its regular-file
   type, size, and pinned SHA-256:
   `92d84ade6a0017d5d740baf3b7f28f64dfcaae683920899a401983b4819fc930`.
3. Reuse `SandboxBoundary`: Node 24 image, persistence disabled, no ports,
   deny-all networking for the entire lifetime, 240-second provider deadline,
   210-second client work deadline, and cleanup with independent signals.
   Confirm Node 24 and absence of Vercel credential variables. Host credentials
   are used only by the SDK; no environment or credential files are uploaded.
4. Upload the exact seven files. The host enumerates and reads the sandbox
   filesystem, independently hashing the bytes to confirm the original identity.
   Upload the pinned patch outside the fixture root and check its bytes too.
5. Apply the patch with `git apply --whitespace=error-all -p1`. Git is only the
   patch applicator: there is no repository, index, diff summary, or GitHub access.
   The command has a 10-second timeout. Ignore its output; require exit zero.
6. Independently enumerate every entry and read every allowed file again.
   Include dotfiles; do not apply ignore rules. Compare bytes against the original
   manifest. Require exactly `src/shipping-cost.ts` to change; every test,
   configuration file, lockfile, and other original file must remain identical.
7. Construct the candidate on the host, stop and delete the sandbox, and confirm
   absence. Only then publish the artifact under the ignored `.vigilo/candidates/`
   directory. A failure at any sandbox step still enters the shared cleanup path.

## Candidate format and validation

The JSON artifact contains `schemaVersion`, `baseFixtureHash`, `changes`, and
`candidateHash`. The single change contains its relative path, SHA-256,
`byteLength`, and exact bytes encoded as `contentBase64`. The candidate hash is
SHA-256 over compact canonical JSON of the first three fields, with changes
sorted by path. No timestamps, sandbox IDs, or machine paths enter the identity.
Changing any changed byte changes the identity. The base identity binds all
unchanged files; reconstruction can use that exact base plus the changed bytes.

Validation rejects absolute paths, traversal, backslashes, control characters,
duplicate paths, `.git` metadata, credential/secret paths, unexpected entries
(including hidden files and empty directories), symlinks, hard links, special
files, executable/changed file permissions, and missing original files.
Only the seven exact file paths and the `src`/`test` directories are allowed.
Canonical paths must remain inside the fixture root. File metadata and directory
entries are checked again after reading to detect changes during collection.
Limits are 64 KiB per file, 128 KiB of total file contents, 16 entries per
directory, and 16 KiB for the complete candidate artifact. These intentionally
small limits cover only this controlled fixture.

The artifact and nested manifest objects are frozen in host memory. Publication
uses a private staging file, fsync, read-only permissions, and an exclusive atomic
hard link to `<candidateHash>.json`. An existing artifact must have exactly the
same bytes and permissions; it is never overwritten. Hash/content consistency is
checked again before publication. The file includes everything needed to retain
the changed bytes after the sandbox has been destroyed.

## Limits and provider observations

- On the tested managed image, `patch` is absent and Git is present. A direct
  command launch for the missing executable returned HTTP 400. The failed attempt
  was cleaned up without freezing an artifact. No network installation is needed.
- SDK 3.2.1's `fs.readdir` with `withFileTypes: true` includes dotfiles. Its default
  names-only implementation omits them, so the collector never uses that form.
- The provider filesystem APIs are trusted to expose actual filesystem state.
  This task has a quiescent controlled fixture and one completed patch process;
  it does not claim race-free collection against a concurrent privileged writer.
- Local immutability is enforced by the API, atomic no-overwrite publication,
  hashes, and read-only permissions. A privileged host owner can still alter or
  delete local storage; this is not a tamper-proof external storage service.
- Validation proves scope and artifact integrity, not repair correctness. The
  candidate is not independently verified and must not be described as verified.
- SIGKILL, host loss, and provider outages have the same cleanup limitations as
  Task 1.1. An unconfirmed cleanup prevents successful publication.

## Sources and tests

- [Vercel Sandbox SDK filesystem and lifecycle APIs](https://vercel.com/docs/sandbox/sdk-reference).
  Installed SDK 3.2.1 declarations/source were also checked for enumeration and
  command timeout behavior.
- [Git apply](https://git-scm.com/docs/git-apply): patching plain directories,
  default atomic failure, and path safety.
- Focused tests exercise actual temporary filesystem trees, including hidden
  entries and links, plus path validation, size bounds, protected-file changes,
  stable and byte-sensitive identities, publication conflicts, and forged hashes.
  Existing sandbox failure/cleanup tests remain in the suite. Local tests alone
  do not satisfy live acceptance.

## Live acceptance

The real flow passed on 2026-09-04 in sandbox
`vigilo-candidate-77e7b73a-b775-4bc3-b331-6f6f46bdac7c`:

- Validation passed; exactly one changed path: `src/shipping-cost.ts`.
- Changed-content SHA-256:
  `9f17d94d1775db4649348c57ce6e918e3d086cf97e6bc48831c895bbebf2d8d3`.
- Candidate identity:
  `5a83213ab30bc5e81a88f9910270ac64c0e3b402b66d13096b591da18f8ea346`.
- Stop and deletion confirmed; subsequent lookup confirmed absence.
- The host artifact was published successfully after deletion; the original
  fixture and predetermined patch remained unchanged.

This recorded result does not override a failed future run or imply Task 1.5
verification has happened.
