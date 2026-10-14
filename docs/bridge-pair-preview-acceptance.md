# Bridge pairing review before access grant

October 4, 2026. Production release `dpl_GXUnX9eTXGhGNdcDW2ek5aPq23pU` is READY on Vercel with the matching Convex deployment.

Personal agents now first reviews a pairing code. The preview shows the device name, signed-in account, selected workspace, 90-day revocable access scope and code expiry. Reviewing does not bind the device or grant access. Approval rechecks current account, workspace membership, device identity, expiration and revocation. Changing the input hides the previous preview; changing workspace/account remounts the form. Existing direct approval API callers remain compatible.

Native Chrome verification on the production alias:
- An unknown valid-format code returns an inline recovery error and no approval button.
- A fresh pending Linux CLI code displays Linux native acceptance, @mbelenkiy29 and OpenReview acceptance with the correct scope.
- At actual 390px innerWidth, document width is 390px and the preview is 280px wide (x75–355), without horizontal overflow. An initial viewport override affected another tab and was not counted as mobile evidence; a fresh active tab supplied the verified result.
- Changing the code removes the stale preview and approval button.
- A read-only backend receipt after both previews confirms the Linux device has neither account nor workspace binding. Only the previously approved Mac device is paired. No new access has been granted.

The Linux CLI created its private guest credential only after checking that no configuration existed. The pending request expires after ten minutes; it is not an authorized credential until approval. No Mac credential was copied, no agent task launched and no inference was spent. The approval page is retained for the human checkpoint.

355 tests pass (195 Node, 160 Convex), both typechecks pass, lint has zero errors and two existing warnings, and build passes. The new authorization test covers nonmembership, viewer restriction, wrong account/device, expiry after preview, revocation and paired replay. Local checks do not establish live agent execution.

Receipts: `output/setup/bridge-pair-preview-final-tests.log`, `bridge-pair-preview-final-types.log`, `bridge-pair-preview-backend-types.log`, `bridge-pair-preview-lint.log`, `bridge-pair-preview-build.log`, `bridge-pair-preview-deploy-retry.log`, `bridge-pair-preview-devices-after.json`. Screenshots: `bridge-pair-preview-ready.png`, `bridge-pair-preview-mobile.png`, `bridge-pair-preview-unknown.png`.

Remaining: explicit Linux access approval, checkout registration and exact-revision native agent launch/fix checks. Full provider/OS acceptance and Greptile parity remain incomplete.
