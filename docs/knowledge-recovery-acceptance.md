# Knowledge recovery and provider revision display

October 4, 2026. This frontend update preserves complete recorded revisions in repository cards, Knowledge entries and Pull Request rows. Perforce submitted/shelved revision identities remain opaque strings; the UI no longer abbreviates them to `p4:openr` or `p4:26:1:`. Git revisions are also displayed in full. Pull Request rows remain in the existing keyboard-accessible horizontal table container.

Knowledge search now rejects direct URL queries over 200 characters visibly instead of silently searching a truncated value. The original filter remains editable. No knowledge query runs for the invalid search, and no empty-result claim is shown. Correcting the filter restores the normal query.

Each repository Knowledge query handles failures independently. Successful repository results remain available; failed repositories display an alert and a retry link preserving team, repository and search filters. The count is explicitly incomplete whenever any read fails. A failed read cannot produce the normal “No matching knowledge” empty state. Backend authorization and source-link validation remain unchanged; raw backend errors are not exposed.

Validation after the recovery regression update: 183 Node + 149 Convex = 332 tests passed, plus lint, typecheck and local production build. No inference was requested. The earlier revision-display release used the preceding 328-test result.

Per-repository transport failure recovery is implemented and regression-tested; an actual hosted read failure has not been injected. Current unavailable Perforce provider tunnels do not imply a failed Knowledge database read. This update does not establish full provider live acceptance or Greptile parity.

`src/knowledge-view.ts` supplies the dashboard's validated, filtered read state. Four regression checks cover partial failures retaining successful entries without exposing private exception text; all-failed versus successful-empty results and retry recovery; the 200/201-character boundary with no truncated or invalid reads; and encoded retry URLs retaining team/repository/search. Retry uses a normal page link to obtain a fresh server read rather than reuse the router's existing failed navigation. The fixture does not claim a native retry click after a real hosted outage.

Hosted READY release: `dpl_FZ8tTMNe8NYYhodAJ4PK7vY8nbv9`. Native Chrome walkthrough on the production alias:

- Direct 201-character query retained the selected Origin repository and complete original search; an inline error appeared, without counts or an empty-result claim. Screenshot: `output/setup/knowledge-search-too-long-current.png`.
- Filling “Money” and clicking Apply restored two Origin entries with the complete indexed Git revision `ea89f9a94db4cea48cbcf3d759bb44ea61e1f0eb`. Screenshot: `output/setup/knowledge-search-recovered-current.png`.
- Perforce PR #26 showed `p4:26:1:27:034682bf95b8fa9ee94d6ba628a6df6a8c1f0d4179a98a14cc14c9cf417fe4ea`; other current/historical shelf rows also retained their full identities. Keyboard End scrolled the existing table container. Document and viewport widths were both 1126px; warning/error logs were empty. Screenshot: `output/setup/p4-pull-full-revisions-current.png`.
- Repository management showed the full baseline `p4:openreview-native-p4:submitted:5:869f0297e00fd45f0ebd9faff301fc2ffdb34b427844f96016f1fc9a84c24dc7`. The Perforce Knowledge query succeeded with zero entries; no Perforce entry-rendering evidence is claimed. The unavailable provider endpoint was not contacted and no review was requested.

This walkthrough is desktop evidence, not a new mobile/dark-mode proof. The verified Origin Knowledge result is left open; the separate Linear restoration consent remains awaiting its pending approval.

Recovery regression release: `dpl_DH5mp4BMHsC89jk3gYcSaM8yqL1H` is READY. Hosted build passed. Native Chrome again verified a 201-character error without empty/count claims, correction through the visible Apply button to two Origin entries, retained repository selection and empty warning/error logs. Current screenshot: `output/setup/knowledge-retry-recovered-current.png`. The preceding native Perforce revision display walkthrough remains valid historical evidence; it was not repeated in this recovery-only release. No live failed-read retry is claimed.
