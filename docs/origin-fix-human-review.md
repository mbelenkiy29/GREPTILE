# Origin acceptance PR #1: saved agent fix ready for human review

Destination: https://cursor.com/codebase/mbelenkiy/openreview-origin-acceptance/pull/1 — disposable native Origin acceptance repository, branch `seeded-cross-file-cents`. On October 4, 2026 at 21:37 UTC, the native CLI confirmed the PR remains open at version 1 and head `3d6c5e9292fd879098b205006d78f471c00605dd`, matching the saved Claude checkout.

Checkout: `/Users/mbele/Documents/ChatGPT/greptile/output/setup/origin-native-acceptance`. The earlier native Fix launch left exactly these two unstaged files: modified `src/money.mjs` and new `tests/money.test.mjs`. No new agent launch, inference, commit, push, or merge was performed during this preparation.

The fixture README requires integer cents across the checkout and provider payload. The reviewed implementation divides by 100, so `1234` cents becomes `12.34`. The fix preserves the amount and existing nonnegative safe-integer validation:

```diff
--- a/src/money.mjs
+++ b/src/money.mjs
@@ -1,4 +1,4 @@
 export function normalizeAmount(amountInCents) {
   if (!Number.isSafeInteger(amountInCents) || amountInCents < 0) throw new Error("Expected nonnegative integer cents");
-  return amountInCents / 100;
+  return amountInCents;
 }
```

The complete new file `tests/money.test.mjs` is:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAmount } from "../src/money.mjs";

test("normalizeAmount returns integer cents unchanged", () => {
  for (const cents of [0, 1, 99, 1234, 100000]) {
    const result = normalizeAmount(cents);
    assert.equal(result, cents);
    assert.ok(Number.isSafeInteger(result));
  }
});

test("normalizeAmount rejects non-integer or negative amounts", () => {
  for (const bad of [12.34, -1, NaN, "1234"]) {
    assert.throws(() => normalizeAmount(bad), /Expected nonnegative integer cents/);
  }
});
```

Fresh verification ran `node --test tests/checkout.test.mjs tests/money.test.mjs` in an isolated copy of the reviewed source with the new regression, then in the saved fixed checkout. Baseline: 2 failures (cross-file checkout and cents preservation), 1 pass (input validation), exit 1. Fix: all 3 pass, exit 0. The original checkout and reviewed HEAD were preserved. Tests use a stripped environment, built-in Node modules, no dependency installation, network requests, or inference.

These are local regression receipts, not recorded hosted runtime evidence. They establish the synthetic unit contract; they do not establish real payment-provider integration or complete agent/OS parity.

Receipts: `output/setup/origin-human-review-receipt.json`, `origin-human-review-native-revision.json`, `origin-human-review-reviewed-baseline.log`, and `origin-human-review-saved-fixed-checkout.log`.

Publishing remains pending human approval. The proposed next step is to commit and normally push only the exact two files above to this disposable Origin PR, refresh its native version if required, and inspect automatic review/resolution within the existing inference cap. No merge is proposed. Your acceptance plan requires human diff review before the pushed-fix/re-review step; the earlier GitHub approval applies only to GitHub PR #4.
