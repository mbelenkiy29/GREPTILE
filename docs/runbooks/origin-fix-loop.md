# Runbook: Origin fix loop

**Goal:** complete the full loop, review → Fix with your agent → human-approved push → re-review that resolves the finding, on Cursor Origin.

## Prerequisites

- The OpenReview Origin app installed on a disposable repository (see [Origin](../origin.md)).
- A paired bridge on the operator's machine (`openreview bridge status` shows paired) with Codex, Claude Code or Cursor Agent installed and signed in.
- A registered checkout at the reviewed revision.

## Steps

1. Push a change with a seeded defect, and wait for the review and its finding.
2. Click **Fix** on the finding. Confirm:
   - [ ] The bridge launches the agent in the registered checkout.
   - [ ] The dashboard shows launch, then successful exit.
3. Inspect the agent's diff and test output yourself. Commit and push only after reviewing them; this approval step stays human.
4. Wait for the re-review of the new revision. Confirm:
   - [ ] The finding is marked resolved.
   - [ ] The summary is updated.
5. Confirm that a stale fix request is refused. Close the PR or move its head, then click **Fix** again; dispatch must refuse.

## Evidence

Record:
- The commit SHAs before and after.
- Screenshots of the fix dispatch status and the resolved finding.
- The `bridge status` output, with no tokens.

## Cleanup

Revoke the bridge pairing if it was temporary, and close the PR.
