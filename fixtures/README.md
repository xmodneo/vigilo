# Task 1.2: controlled broken fixture

`free-shipping/` is a standalone, single-root Node.js 24 + npm + TypeScript
project. It has no dependency on Vigilo's runtime, no npm workspace membership,
and no runtime dependencies. Vitest, TypeScript, and Node type declarations are
its only direct development dependencies; exact versions and the full dependency
tree are pinned in its own manifest and `package-lock.json`.

## Behavior and intentional defect

`shippingCostCents(subtotalCents)` calculates a checkout shipping fee. Its input
contract is a nonnegative safe integer representing a subtotal in cents; input
validation, currencies, tax, and discounts are outside this fixture's scope.

| Subtotal | Expected shipping | Original shipping |
| --- | --- | --- |
| 4,999 cents | 500 cents | 500 cents |
| 5,000 cents | 0 cents | **500 cents (bug)** |
| 5,001 cents | 0 cents | 0 cents |

The one intentional application bug is the exclusive `>` comparison instead of
the inclusive `>=` threshold. There are no clocks, random values, environment
variables, network calls, databases, or external APIs in the source or tests.

## Run the broken baseline

From the Vigilo repository root, with Node 24 and npm 11.6.2:

```sh
cd fixtures/free-shipping
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm test
```

The build and typecheck must succeed. The suite must exit **1**, with **one
failed and two passed tests**. The failing test is
`offers free shipping at exactly 5000 cents`: expected `0`, received `500`.
A dependency, import, compilation, or runner error does not qualify as the
expected failure. Do not skip the regression or change its assertion.
Test discovery is restricted to `test/`, so compiled files in `dist/` are not
run a second time after building.

For machine-readable test results, use:

```sh
npm test -- --reporter=json
```

Vitest 5 writes this report to `.vitest/json/output.json`, which is ignored.
Test outcomes are deterministic; runner timing fields and absolute paths in
reports naturally vary. No report or build output is committed.

## Predetermined repair

The repair lives separately at `repairs/free-shipping.patch`, relative to this
directory. Apply it only to a disposable **copy** of `free-shipping/`. From the
copy's root, use `patch -p1 < /path/to/fixtures/repairs/free-shipping.patch`.
It changes exactly one source line:

```diff
-  return subtotalCents > 5_000 ? 0 : 500;
+  return subtotalCents >= 5_000 ? 0 : 500;
```

With the same lockfile and unchanged tests, a repaired result must have all
**three tests passing**, exit **0**, and a successful build/typecheck. The
repository's baseline source must retain `>` after local verification. Delete
the disposable copy when done. Never treat a permanently repaired baseline as
this fixture.

## Copy boundary

Copy only the contents of `free-shipping/`, excluding `node_modules/`, `dist/`,
and `.vitest/`. Its manifest, lockfile, configuration, source, and tests are
self-contained. Do not copy Vigilo's root `.env.local`, `.vercel/`, `.git/`, or
runtime code. The repair and this documentation stay outside the fixture input.
No Git repository or GitHub credentials are needed to copy or run it.

Installing packages needs access to the public npm registry (or a populated npm
cache); the application and test cases themselves perform no networking.
Task 1.2 defines the local fixture. Task 1.3 adds a separate
[Vigilo baseline runner](../docs/baseline.md) that uploads and tests the original
fixture in a Vercel Sandbox; it does not change or repair these fixture files.

The root Vigilo test suite covers the complete Milestone 1 execution logic;
run this intentionally failing fixture suite separately as its negative control.

Official Vitest references: [single-run execution](https://vitest.dev/guide/)
and [JSON reporting](https://vitest.dev/guide/reporters.html#json-reporter).
