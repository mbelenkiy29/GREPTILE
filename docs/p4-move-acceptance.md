# Native Perforce move ingestion and checkout verification

On 2026-10-04 the disposable native Server / P4 Code Review fixture created review **26**, version 1, archive **27**, revision `p4:26:1:27:034682bf95b8fa9ee94d6ba628a6df6a8c1f0d4179a98a14cc14c9cf417fe4ea`.

## Verified behavior

- `move/add` is an addition at its new depot path; `move/delete` removes the old path from retrieval. Unchanged caller source remains available as cross-file context.
- Native Swarm's new-path `#0` diff lookup returned HTTP 404. Additions now derive the complete empty-left-side diff from digest-verified archived bytes, including newline markers.
- Native Swarm's deletion hunk was `@@ -1,4 +0,1 @@` with four removed lines and no right-side lines. The adapter normalizes only the observed empty deletion placeholder, validates all hunk counts, and rejects other invalid ranges. Shelf ingestion requires the complete indexed baseline to be covered by deletions.
- A move target has no submitted baseline, but native local `fstat` retains the moved source's have revision. The bridge checks that its moved source belongs to the same reviewed archive's move/delete manifest and that both local have/moved revisions match that source's pinned baseline. Native file actions, server/client/user identity, mappings, archived/local digests and deleted-path absence remain required. Wrong/missing moved sources and wrong revisions fail closed.
- Read-only bridge verification passed for all **five** local files in `output/setup/p4-native/bridge-moves-checkout`. Existing native agent checkouts were preserved. No agent was launched and no model was called in this verification.
- A separately authorized, automatic-review-off hosted poll imported six native rows, including #26. Existing hosted review count remained six. The original receipt’s cost delta was not established (see correction below). Settings were restored and polling returned to disabled. Computer use inspected both the native review's move/add and move/delete indicators and its hosted Awaiting current review row, with no console errors.

## Native fixture recovery

The Docker VM's overlay had less than the native server's 250 MB minimum for temporary files. Shelving stopped visibly. The fixture boot script now uses its existing host-backed `/data/tmp` for `TMP` and `TEMP`, whose filesystem had about 21 GB available; the server's disk safeguards were retained. The fixture server was restarted with the same database, journal and SSL identity. See Perforce's [temporary-directory environment documentation](https://help.perforce.com/helix-core/server-apps/cmdref/2024.2/Content/CmdRef/TMP.html).

Ordinary additions and deletions also passed full native source ingestion against retained review **14**, revision `p4:14:1:15:74483c3231265db265caab2ea28a377fdcfec891cca2bd6e0a0b94aa69bd0dac`. Its added source is present and deleted test source is removed. Evidence: `output/setup/p4-native/actions-ingestion-evidence.json`.

Final production release: **dpl_DfRWyjNeYjqUeD1KbHnUcyyD4GFd**, at the unchanged canonical https://openreview-flame-two.vercel.app. Vercel production and Convex deployment/build succeeded with no removed indexes.

## Evidence and limits

- `output/setup/p4-native/moves-verification-evidence.json`
- `output/setup/p4-native/moves-catalog-live-evidence.json`
- `output/setup/p4-native/moves-portal-live.png`
- `output/setup/p4-native/moves-hosted-catalog-live.png`
- `output/setup/p4-moves-{tests,regression,typecheck,lint,build}.log`

Full regression suite: 164 Node tests + 125 Convex tests = **289**. Focused assertions cover move context, manifests, missing/conflicting baselines, malformed native deletion ranges, incomplete deletions and invalid native moved-source mappings. Local lint, typecheck and production build pass. Typecheck was rerun after the local build completed because running both simultaneously removed the generated `.next/types` files during its first read.

No schema migration or new production environment variable is required. The Native Fix launch and human completion/push-equivalent/resolution loop for these action types is **not verified** by read-only checkout verification. Full supported OS/provider acceptance and native P4 automatic approval also remain outstanding. No Greptile parity claim is made.

### Cost evidence correction

The earlier catalog receipt used nonexistent `reviews.cost` with a zero fallback. Its historical cost delta is not established; that field is now null with a correction. Review counts and native move verification remain valid. See [catalog review acceptance](catalog-review-acceptance.md) for the corrected script and independently measured current recovery totals.
