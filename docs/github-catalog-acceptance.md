# GitHub Cloud catalog acceptance

Verified October 4, 2026 against the existing production GitHub App installation and mbelenkiy29/openreview-acceptance. This establishes metadata sync and desktop filtering; remaining native Fix and the full provider matrix are incomplete.

The authenticated hosted sync imported all four current open PRs in one native page. Titles, author metadata, open state, head and base revisions matched fresh native API reads. Automatic review was temporarily off. The repository retained 21 reviews, 213 recorded model calls and $1.088394 in recorded inference cost before and after. The receipt measures modelCalls.estimatedCost. Original effective/local settings, enabled state and indexed revision were restored by the harness finalizer.

Computer use verified all four hosted rows and retained completed-review statuses/scores. Searching one-click returned only PR #4; clearing the filter restored all four rows. No browser warnings/errors were observed. No indexing, review or agent launch occurred. Mobile, multi-page GitHub import and recovery cases remain pending.

Evidence (ignored local acceptance artifacts):

- output/setup/github-catalog-live-evidence.json
- output/setup/github-catalog-live.ts and .log
- output/setup/github-catalog-hosted-desktop.png
- output/setup/github-catalog-hosted-filter.png

Production remains https://openreview-flame-two.vercel.app, Convex tidy-ocelot-457 and READY frontend dpl_H36rc5GUTYskJdSDyvRiwt85C8Uk. No application code, schema, environment or deployment changed. Last full software regression remains 299 tests, lint, typecheck and build passing; it was not repeated for documentation-only changes.
