# Audit history pagination acceptance

October 4, 2026. The portal previously read only the newest 100 audit events. It now uses an admin-authorized indexed cursor query with 30 events per page. Older activity reaches historical events; Newest activity returns to the first page. Each page retains actor lookup, UTC times and the accessible horizontal table. The existing `scopes.activity` query remains compatible for current callers.

The regression inserts 151 own-workspace events interleaved with foreign events, traverses six pages, verifies exact descending order and no duplicates, and denies unauthorized users, foreign workspace reads and a demoted viewer. Full verification: **171 Node + 141 Convex = 312 tests**, lint, typecheck and production build passed.

Backend deployment is Convex `tidy-ocelot-457`. Vercel production release **dpl_9dfjSheqs8F8kX7uwwjpfgr2URx2** is READY and aliased to https://openreview-flame-two.vercel.app. Its hosted build passed.

Live backend traversal returns 227 real events over pages `[30,30,30,30,30,30,30,17]`, including 127 beyond the previous 100-event window. The first 100 exactly match the compatible query. All events belong to the selected workspace; no repeated IDs, fixture mutation or inference request occurred.

Computer use traversed all eight production pages and verified the terminal 17-row page has no Older activity link. Newest activity returns to 30 current events. At a real 390×844 viewport, document/body remain 390 pixels wide. The table is 318 pixels wide with 819 pixels of content; keyboard End reaches scrollLeft 500.5, Home restores its start, and the region retains focus. Mobile Older activity opens the next 30-row page. Shift+Tab focuses Newest activity and brings both pagination links into view. Console warnings/errors were empty. Normal viewport was restored and the production audit tab retained.

Evidence in ignored `output/setup/`: `audit-pagination-live-evidence.json`, `audit-pagination-browser-evidence.json`, `audit-pagination-mobile-{live,controls-live}.png`, full check/deploy/inspect logs and the read-only live script. This is existing-owner browser acceptance. Multi-user browser role restrictions and the full expanded product acceptance matrix remain incomplete.
