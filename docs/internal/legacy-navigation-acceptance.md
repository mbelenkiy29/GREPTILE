# Legacy navigation and setup resume acceptance

October 4, 2026. Native Chrome on hosted release `dpl_CEQshwemhSJoSe9pWnMBSLkVr7TS` verified all eight legacy navigation aliases, dashboard root and the legacy repository-specific Settings link. Final URLs and rendered main headings are saved in `output/setup/navigation-legacy-redirects.json`.

| Legacy path | Current destination |
| --- | --- |
| `/dashboard`, `/dashboard/overview` | `/dashboard/analytics` |
| `/dashboard/repositories` | `/dashboard/settings/repositories` |
| `/dashboard/reviews` | `/dashboard/pulls` |
| `/dashboard/findings` | `/dashboard/pulls/findings` |
| `/dashboard/knowledge` | `/dashboard/memory/knowledge` |
| `/dashboard/rules` | `/dashboard/memory/rules` |
| `/dashboard/team` | `/dashboard/settings/people` |
| `/dashboard/usage` | `/dashboard/settings/usage` |
| `/dashboard/settings?repository=<GitHub acceptance ID>` | `/dashboard/settings/review?repository=<same ID>` |

The overview redirect preserved October 1–4 From/Through parameters and rendered the real report. The reviews redirect preserved the selected GitHub repository. The repository-specific Settings redirect rendered that repository's review settings without submitting any changes.

Settings search displayed its explicit no-match recovery message. Escape restored all grouped links. Searching `api keys`, then Tab, focused its sole matching link; Enter reached the actual API Keys heading and URL. Opening the personal menu and pressing Enter on Resume setup reached `/dashboard/onboarding`, whose saved state was **Ready**: six prior steps Complete, Ready Current, two selected indexed repositories, full revisions, completed attempt information, processed/skipped counts and coverage limits. No indexing, review, inference or key mutation was triggered. Warning/error logs were empty.

The new browser tab remained at its actual 1126px desktop viewport despite responsive capability requests. Measurements confirmed viewport, document and body all 1126px; this turn therefore establishes desktop acceptance only. The temporary responsive override was reset. The misleadingly named initial `navigation-search-empty-mobile.png` is a desktop capture and must not be cited as mobile proof. `navigation-resume-setup-desktop.png` records the final Ready state. Earlier independent mobile menu evidence remains in `portal-menu-acceptance.md`.

No implementation changes or additional tests were needed for this walkthrough; the existing 327 passing tests remain the prior verification result. Detail-suffix redirects, remaining menu actions and complete current-release mobile/dark onboarding remain outside this evidence.

Current-release supplement: [actual legacy review-ID suffix acceptance](analytics-current-export-acceptance.md) now verifies the GitHub PR #4 detail redirect with preserved repository query. Arbitrary suffixes and full mobile/dark onboarding remain outside this proof.
