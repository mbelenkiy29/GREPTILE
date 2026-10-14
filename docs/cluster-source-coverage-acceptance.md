# Cluster source indexing disclosures

The cluster page previously listed authorized source identities without their current indexed revisions or indexing diagnostics. It now distinguishes configured sources from the source evidence pinned for a particular review, shows index status and review enablement separately, and provides the latest indexing attempt's revision, progress, skipped-file reasons and errors. A different attempt revision is explicitly distinguished from the current index. Missing attempt or skipped-file receipts are shown as unknown, not as complete coverage.

The disclosure uses the existing authorized scope and dashboard read models. No backend/schema, cluster membership, retrieval behavior, credentials or policy changes are introduced. A source's current index is not a claim of provider reachability or review-author authorization. The page explains the actual retrieval cap: at most 10 files per repository and 100 KB across retrieved context. Each review remains authoritative for the actual fetched source revisions and coverage.

Create/edit indexing disclosure summaries now include provider/connection/instance identity, distinguishing same-name repositories in keyboard and accessibility navigation. Existing selection values remain repository IDs.

Local typecheck, lint and production build passed. Lint has zero errors and two existing unused-variable warnings. These are presentation changes; the last full regression run remains 353 tests.

Production release `dpl_BMreu6J5nzMDExRVCx5XBux1vkjm` is READY on https://openreview-flame-two.vercel.app, with the integrated Convex deployment and hosted build passing. Native browser readback shows GitHub index `17456c1b49421d0840cda877fb20a72914ead487` and Origin index `ea89f9a94db4cea48cbcf3d759bb44ea61e1f0eb`. Each expanded latest attempt is completed on its matching index, processed 5/5 eligible files, and records zero skipped files. This proves only these actual receipts, not all hypothetical recovery branches or complete codebase coverage.

At 390px, document width stays 390px; source blocks are 320px and identity summaries 284px. Expanded edit retains only the original GitHub and Origin repository IDs, and create remains unselected. Expanding the actual unindexed team-mapping repository shows `not_indexed`, reviews disabled, and no indexed revision. No Save, Create, Remove, re-index or review action was submitted. Browser warning/error logs are empty, the viewport override was reset, and no inference or access grant occurred.

Artifacts in `output/setup/`: `cluster-source-coverage-{types,lint,build,deploy}.log`, baseline text, desktop/mobile/final screenshots and `cluster-source-coverage-mobile.json`. Live failed/mismatched/missing-receipt branches, dark/viewer walkthroughs and the overall provider/OS matrix remain incomplete.
