# Native Linear disconnect and revocation

October 4, 2026. Computer use invoked Disconnect Linear on the approved read-only Michael Belenkiy connection. Revocation acceptance initially ran on release `dpl_B7QWGjhmd2RkQjQcad7QoP99DSRc`; the status-message correction is deployed on READY release `dpl_91kYEHw8b2pj65A71Rp3ymg1xZoR` at https://openreview-flame-two.vercel.app.

## Verified live state

Connection `r57dwvbd99f6hr8fywvd0m7ywx8fmgyn` became inactive at generation 3. Its credential was erased and teams/projects/repositories were empty. Durable revocation job `r9723e0ks6pvbqfmxgkad2z8h18fnxes` completed on attempt 1 and erased its temporary encrypted credential.

An operator saved the encrypted pre-disconnect envelope privately, decrypted tokens only in process memory and made bounded native API probes afterward. The old access token returned HTTP 401 with no identity; its old refresh token returned HTTP 400 and could not renew access. Only statuses and booleans were emitted; tokens and encryption keys were never printed. The private encrypted snapshot was removed after the probes. This supplies native denial evidence beyond a locally completed revocation job.

The deployed requirements reader returned zero files for MIC-1 after disconnect and omitted the Linear scope. The active Atlassian adapter separately reported MIC-1 outside its selected resources. Direct old-generation receipt validation rejected the former generation-2 authorization. The deployed cache read entry point also rejected it before lookup, even for a nonexistent acceptance key. No synthetic cached model result was inserted; this proves native receipt invalidation at the read boundary, not reuse of a real paid cached review or a live in-flight publication race.

## Recovery message correction

The native walkthrough found that the existing page's `saved=linear-refresh` parameter retained **Linear connection refreshed.** even after the card became Disconnected. Disconnect now redirects to a clean confirmation URL with **Connection disconnected. Requirements access removed.** The old refresh-success banner is also suppressed when its selected connection is inactive or missing. Disconnect failures display explicit admin/retry guidance instead of a framework action error. The server mutation's existing authorization/revocation logic is unchanged.

No new tests were added for this small reversible status/redirect change. Existing 179 Node + 149 Convex = 328 tests are the prior passing regression result. New lint, typecheck and local/hosted production builds passed. On the final release, native browser navigation to the former refresh-success URL showed Disconnected with zero refresh-success messages. The clean disconnected-confirmation URL showed Connection disconnected. Requirements access removed., with empty warning/error logs. These rendered-state checks used direct URLs; no second native disconnect was performed through the new redirect action, whose final routing was inspected in source. Screenshot: `output/setup/linear-disconnected-final-status.png`. Native refresh/lease/viewer/scope-change regressions remain recorded in `linear-refresh-acceptance.md`.

## Reconnection preparation and limits

The actual Connect Linear workspace link reaches the Michael Belenkiy native consent screen, still requesting only **Read access to your workspace**. The final Authorize click is pending a new action-time confirmation because the earlier grant was revoked. Upon approval, restore only MIC and the GitHub acceptance repository; reconnection must not silently retain the prior scope. The app registration/client ID remain intact. No inference, review, issue creation or project mutation occurred.

Evidence: `output/setup/linear-revocation-job-live.json`, `linear-native-revoked-receipt.json`, `linear-post-disconnect-requirements-live.json`, `linear-stale-context-rejection-live.log`, `linear-revoked-cache-read-live.log`, `linear-disconnected-live-initial.png`, `linear-reconnect-consent-prepared.png`, `linear-disconnect-*.log`.

Remaining native coverage includes user-initiated remote revocation from Linear settings, automatic expiry/401 recovery, interrupted/retried native revocation jobs, issue team/project movement, relevant published requirements citation and live in-flight publication recovery. Local disconnect plus native token denial does not establish all those paths.
