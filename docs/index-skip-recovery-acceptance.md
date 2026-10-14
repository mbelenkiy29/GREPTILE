# Idempotent indexing exclusion counts

October 4, 2026. Fixed and deployed to production Convex tidy-ocelot-457. The existing Vercel frontend remains at READY release `dpl_GqVdoJFqYHjVQe88bdfN9FRj9CKB`; this change affects backend indexing only.

## Problem and change

Index jobs retain the first 500 skipped-file details for inspection. Previously that bounded sample also served as retry deduplication: a content-time exclusion beyond the sample was counted again when its batch retried. This could inflate the skipped total even though only one file was excluded.

The new additive `indexSkippedFiles` table records `jobId` and `path`, indexed by `by_job_path`. `repositories.skippedFile` checks the existing bounded sample for legacy/manifest exclusions, then the indexed per-job receipt. It inserts the receipt and increments the total in the same transaction. The visible sample remains capped at 500, while distinct files beyond that sample each count once. A subsequent index job counts its own exclusions independently. Existing lease, job lifecycle and repository/native authority gates run before either receipt or total writes. Receipts contain no source content or credentials and have no public read API.

The failing regression reproduced 502 instead of 501 after recording the same file twice with an already-full sample. After the fix, the same file remains counted once across a new retry lease; another distinct file increments once, and a separate job maintains its own count. A second regression verifies stale leases, expired leases and disabled repository writers create neither counts nor receipts.

## Verification and rollout

190 Node + 158 Convex = **348 passing tests**, lint, backend/frontend typechecks and production build passed. The final strengthened receipt assertions also passed in the focused suite. Deployment regenerated bindings, typechecked, validated the schema, added the index without deleting any indexes, and confirmed the production push. A live read confirms the new table is available and the Origin fixture remains Ready.

Rollout inspection found zero queued or running index jobs. No source indexing or inference was triggered. The inference ledger remains 4,606,786 committed and 270,556 reserved micros, below its 5,000,000-micro cap. Historical completed counts are preserved: omitted historical details cannot be reconstructed reliably, and this change does not claim to repair already-inflated totals. A self-hosted upgrade during an old running job cannot retroactively identify omitted pre-upgrade exclusions; the receipts guarantee deduplication for newly recorded exclusions and new jobs.

Receipts/logs: `output/setup/index-skips-red.log`, `index-skips-green.log`, `index-skips-regression.log`, `index-skips-lint.log`, `index-skips-backend-types.log`, `index-skips-types.log`, `index-skips-build.log`, `index-skips-convex-deploy.log`, `index-skips-rollout-receipt.json`, and `index-skips-deployed-receipt.json`.

This establishes durable exclusion retry correctness and deployed schema compatibility. It is not a native large-repository timeout simulation or full Greptile parity acceptance.
