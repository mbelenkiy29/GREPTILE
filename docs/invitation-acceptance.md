# Workspace invitation acceptance

October 4, 2026. Existing workspace users previously could not see invitations to another workspace; acceptance was shown only during first-workspace creation. Pending invitations are now visible on all dashboard routes and first-workspace setup, with workspace name, role and expiry. Acceptance selects the joined workspace, clears the prior team selection and redirects to Analytics.

People now lists active pending invitations for administrators and provides revocation. Reissuing the same workspace/login invitation atomically replaces prior grants, preventing an old higher-role invitation from remaining valid. Other-workspace invitations are preserved. Invitees are matched to their authenticated GitHub identity. Revocation, exact expiry and missing workspaces prevent acceptance; existing memberships retain their role. Client forms expose joining/revoking states and actionable recovery errors.

Two new durable backend regressions verify named invitation visibility for users already in a workspace, identity/organization isolation, replacement, revocation, single-use acceptance, viewer role, exact expiry, deleted workspaces and existing owner-role preservation. Full checks: 170 Node + 136 Convex = 306 tests, lint, typecheck and local build. No schema or environment change. Hosted deployment and live browser acceptance are recorded in implementation-status.md.

New-member browser identity/permission acceptance, responsive and full recovery states remain unverified. Existing backend tests establish those authorization rules; they do not replace live multi-user acceptance.


Initial live release dpl_5ER1tig1aHXe1LyJQnxtpFYGZM9a completed on the canonical domain with the existing Convex backend. A self-invitation to the isolated recovery workspace exercised pending management and invitation visibility from the already-selected main workspace. Acceptance consumed the invitation, switched to recovery Analytics, and preserved the existing owner role. No recipient was granted new access.

This first walkthrough found the uncontrolled workspace select retained its previous selection after acceptance, despite the correct cookie and displayed workspace. Workspace/team selects now remount when their effective scope changes. Final deployment and repeated acceptance are recorded in implementation-status.md. The initial evidence is a completed existing-owner path, not a new-viewer access claim.


Final READY release dpl_9KhbFHACat9JJ4MynLr8MBd55L5i repeated acceptance successfully with the corrected selected workspace immediately after redirect. A second real page retained the consumed invitation; replay returned the visible invalid/expired recovery message without changing access. The existing owner remained owner, pending list became empty and main workspace was restored. Both self-invitations were consumed. No new access or inference was used. Admin revocation UI and new-member multi-user browser acceptance remain pending.

Screenshots: output/setup/invitations-pending-live.png, invitations-cross-workspace-live.png, invitations-consumed-owner-live.png and invitations-replay-error-live.png. Logs: invitations-{backend-tests,regression,lint,typecheck,build,vercel-deploy,selector-vercel-deploy}.log.

## Live admin revocation and stale-page recovery — October 4

On the canonical production portal, computer use selected the isolated Onboarding recovery acceptance workspace and created a temporary viewer invitation to its existing owner, mbelenkiy29. A second real page retained the invitation before revocation. The admin clicked Revoke invitation; the current page removed both the pending row and invitee acceptance section and showed No pending invitations. The existing membership remained owner.

On the stale second page, Accept invitation was rejected with “Invitation unavailable or expired. Refresh to see current invitations.” Repeating Revoke there was also rejected with its bounded workspace-access recovery message. Reload removed stale controls and returned the empty pending state. No browser warnings/errors were captured. The second page was closed and the main workspace restored.

This completes live admin revocation, revoked-request acceptance rejection and stale revoke recovery for an existing owner. It does not prove new-member viewer restrictions or multi-user browser isolation. One temporary invitation was created and revoked; no account gained access, no role was changed, no external message or model request occurred. No software/deployment change; latest full suite remains 306 tests.

Evidence: output/setup/invitations-revoke-pending-live.png, invitations-revoked-live.png, invitations-revoked-replay-live.png and invitations-revoke-replay-error-live.png.
