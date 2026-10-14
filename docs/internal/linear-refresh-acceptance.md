# Native Linear refresh and recovery action

October 4, 2026. Release `dpl_B7QWGjhmd2RkQjQcad7QoP99DSRc` is READY at https://openreview-flame-two.vercel.app with Convex `tidy-ocelot-457`.

## Implementation

Admins can now choose **Refresh Linear connection** on an active Linear connection. The authenticated action uses the same transactional refresh lease and native token exchange as automatic expiry recovery, verifies the native workspace identity afterward, and rejects a disconnect or authorization-generation change during the operation. It retains selected teams, projects and repositories. The portal displays an explicit success status or retry/reconnect guidance on failure. Viewers cannot call the action and do not receive the control. No client secret, new grant or broader permission is required.

The regression uses an actual workspace viewer, not merely a foreign account: its refresh is denied before HTTP. An admin fixture verifies the refresh-token grant, rotated encrypted credentials, cleared lease, retained scope/generation, and rejection of a scope change during identity verification. Earlier refresh-lease regressions cover overlapping claims and wrong-lease writes.

## Native acceptance

Computer use clicked the deployed control on the existing approved **Michael Belenkiy** read-only connection (`r57dwvbd99f6hr8fywvd0m7ywx8fmgyn`). The native OAuth API returned refreshed credentials; the portal showed **Linear connection refreshed.** Native selected controls remained MIC only and GitHub `mbelenkiy29/openreview-acceptance` only, with no project restriction. Browser warning/error logs were empty.

An operator verification read the encrypted pre/post credential envelopes privately, decrypted only in process memory, and emitted booleans rather than tokens:

- Access token changed: true.
- Refresh token changed: true.
- Expiry advanced: `1791226231732` → `1791226834682`.
- Authorization generation stayed 2; selected resources stayed identical.
- Refresh lease cleared, connection active and error absent.

The temporary encrypted pre-refresh snapshot was removed after comparison. No tokens or encryption keys appear in the public receipt. The deployed requirements action subsequently fetched the explicitly referenced existing benign MIC-1 issue using the refreshed connection: 1,591 bytes, native source URL and revision `2026-09-07T18:23:46.048Z`, SHA-256 `259a6fe4f7d7b89da92305d3fa87dd013b10e837fa6cae0df34be7033075ad9c`, identical to its pre-refresh source. The Atlassian adapter again explicitly omitted the unrelated MIC-1 reference. No review or inference was requested.

Evidence: `output/setup/linear-refresh-live.png`, `linear-refresh-live-receipt.json`, `linear-post-refresh-requirements-live.json`, `linear-refresh-vercel-deploy.log` and local verification logs.

## Validation and remaining scope

179 Node + 149 Convex = **328 passing tests**, lint, typecheck, backend typecheck and local/hosted production builds pass. An initial generated-type inference cycle was fixed with an explicit action return type; the final build/typechecks pass. The regression's initial reused-response mock was corrected to create a fresh response per request; final Convex suite passes.

This proves native manual refresh and post-refresh retrieval using the production refresh implementation. It does not independently simulate a naturally expired token or native 401 retry, interrupted live lease, remote revocation, issue movement, published relevant requirements citation, or a separate viewer's browser. Native disconnect/revocation/cache recovery and remaining provider/OS acceptance stay open. This turn used the existing desktop viewport; no new mobile or dark-mode claim is made.
