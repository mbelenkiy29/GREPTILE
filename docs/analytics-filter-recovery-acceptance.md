# Analytics filters and recovery acceptance

October 4, 2026. Hosted release `dpl_CEQshwemhSJoSe9pWnMBSLkVr7TS`, https://openreview-flame-two.vercel.app, Convex `tidy-ocelot-457`.

## Change

The Analytics page now retains its filters and displays an inline, retryable error for invalid dates, reversed dates, periods longer than 366 days, inaccessible repositories and failed report queries. Invalid filters disable CSV export and render no report. `src/analytics-period.ts` provides strict calendar-date validation shared by the portal and CSV endpoint: rolled dates such as February 30 are rejected, and Through includes the entire UTC day. The CSV endpoint returns HTTP 400 for invalid dates; this response branch was inspected in source, not independently exercised through the live browser.

## Native browser evidence

Computer use on the hosted release verified the following selected periods and scopes. Counts below are recorded analytics attribution, not the provider-wide key bill or remaining inference budget.

| Scope, October 1–4 inclusive UTC | PRs | Reviews | Findings | CSV cost |
| --- | ---: | ---: | ---: | ---: |
| GitHub `mbelenkiy29/openreview-acceptance`, author `@mbelenkiy29` | 4 | 21 | 5 | $1.088394 |
| Origin team, all its accessible repositories | 1 | 3 | 1 | $0.142550 |

The GitHub report showed five critical findings, 80% addressed, 100% rated usefulness, 46 seconds average duration and 419,094 recorded tokens. Its actual downloaded CSV contained October 2: 16 reviews, 5 findings, $0.706800; October 3: 5 reviews, 0 findings, $0.381594. The nonexistent-author filter returned an empty report with zero counts/cost/tokens and unavailable duration/feedback.

Selecting the Origin team restricted the repository options to its one repository. The report showed one critical finding, 0% addressed, 23 seconds and 43,840 tokens. Its downloaded CSV contained October 3: 3 reviews, 0 findings, $0.096466; October 4: 0 reviews, 1 finding, $0.046084. Reviews, findings and usage use their own recorded timestamps, so a later finding or usage event can appear on a day with no newly created review. The October 4-only report correctly showed 0 reviews, 1 finding, $0.05 rounded and 15,848 tokens.

On the final release, the browser verified inline errors and absent report content for an oversized period, reversed dates, malformed February 30 and a GitHub repository outside the selected Origin team. Export was disabled. Correcting the oversized period through the form recovered the single-day report. The final scope was restored to **All accessible teams**, with GitHub and `@mbelenkiy29` selected; fresh native DOM readback confirmed 21 reviews and both activity buckets.

At 390×844, the recovered author-filter report and oversized-period recovery page had document/body widths of 390 pixels. Warning/error browser logs were empty. Temporary viewport overrides were reset. No review or inference was requested and no credential, provider installation or membership was changed.

Local evidence artifacts: `output/setup/analytics-author-filter-live.csv`, `analytics-team-filter-live.csv`, `analytics-author-filter-mobile.png`, `analytics-invalid-period-mobile.png` and `analytics-filter-recovery-*.log`.

## Verification and limits

179 Node + 148 Convex = **327 passing tests**, lint, sequential typecheck and local production build passed. The hosted production build and deployment completed successfully. Date regressions cover inclusive UTC days, a full leap year, malformed/rolled dates, timestamps supplied instead of dates, reversed dates and oversized periods.

Large-period load/read-limit acceptance, current-release dark recovery states and a separate live viewer identity remain pending. Existing authorization regressions cover cross-context findings/usage joins, including parent reviews outside the selected period. This walkthrough does not establish the full Greptile parity matrix or a universal provider billing cap.

Current-release supplement: [native export, direct HTTP rejection and detail-link evidence](analytics-current-export-acceptance.md) now independently verifies the previously source-only hosted HTTP 400 branch. Historical counts above remain period/snapshot-specific.
