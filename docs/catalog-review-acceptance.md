# Requesting the displayed revision from the PR catalog

The catalog’s **Review current revision** action now dispatches through trusted backend provider identity. Git providers fetch current native metadata and reject a changed head or provider revision key. Perforce requires a native administrator, completed authorized submitted baseline, archived open shelf, and matching displayed head/base revisions. It works when automatic reviews and the Git-style enable flag are off, as an explicit manual request. Missing baseline and metadata-only `p4-status:` rows do not expose the action. Viewer/member access cannot bypass native administrator authority.

Catalog clicks coalesce requests for the same revision. Existing Git re-review callers keep their force behavior, and existing P4 callers need not supply the new optional expected revisions. Failed prepared P4 inputs are removed. Existing GitHub requests remain compatible. No schema migration or environment variable was added.

The UI supplies the displayed head and base as hidden fields, disables its button while requesting, provides an accessible finding-specific button name, and renders a retryable error. P4 review status also requires the current indexed submitted baseline to match before an old result is presented as current.

## Verification

164 Node tests and 127 Convex tests (**291 total**) passed, together with lint, typecheck, and production build. Tests exercise stale displayed/native revisions, changed baselines, closed and unarchived shelves, native admin isolation, duplicate request coalescing, cleanup of rejected prepared inputs, and legacy Git force compatibility. Positive enqueue assertions use mocked native APIs and cancel scheduled work before model execution; they do not establish successful live AI review launch.

Computer use verified the real hosted button against native review **26**. With native polling disabled, that disposable review was temporarily archived while the catalog retained its open row. Clicking the catalog button returned the visible recovery message and re-enabled the button. Desktop and the initial 390px mobile release were inspected; mobile error clipping was corrected with a separate wrapped row. Final-release mobile verification remains pending: the native Mac was locked, and the browser viewport override failed to apply. A desktop screenshot is not treated as mobile proof. The native review was restored to Needs review and its exact version/archive/revision was revalidated with native APIs and local checkout verification. No agent launched.

Before and after the failed live click, the repository retained **six reviews, 45 recorded model calls, and $0.180404 recorded model-call cost**. Polling stayed disabled. These totals concern only this P4 repository, not the overall project budget or historical failed-fixture usage.

Evidence is in `output/setup/p4-catalog-review-{before,after}-evidence.json`, `p4-catalog-review-error-desktop.png`, `p4-review-{archived,restored}-native.png`, `p4-native/moves-verification-evidence.json`, and the `p4-catalog-review-*` validation/deployment logs. The full provider/agent/OS/runtime acceptance matrix remains incomplete; no parity claim follows from this check.

## Correction to earlier P4 catalog cost receipts

The original `p4-catalog-live.ts` read a nonexistent `reviews.cost` field and defaulted it to zero. Its three earlier catalog receipts therefore **do not establish a historical cost delta**. Their valid review counts and native/catalog metadata are retained, but `costDelta` is now null with an explanatory correction. Earlier status/matrix statements have been corrected. Both catalog acceptance scripts now sum actual `modelCalls.estimatedCost` and count model calls. Current live recovery receipts prove the before/after totals above; they cannot retrospectively establish the earlier totals.

Final hosted release: `dpl_PhwMXLuv3vTu7grHtau2BLv1Eqbm`, READY at https://openreview-flame-two.vercel.app on the OpenReview Free Hobby team. Convex remains tidy-ocelot-457. Final mobile proof awaits an unlocked Mac; `p4-catalog-review-responsive-override-failed.png` records the failed override at desktop size and is not acceptance proof.
