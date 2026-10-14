# Runbook: Bitbucket Cloud (Forge)

**Goal:** register and deploy the OpenReview Forge app, install it on a workspace, and verify reviews.

## Prerequisites

- An Atlassian developer account and the Forge CLI (`npm i -g @forge/cli`, then `forge login`).
- A disposable Bitbucket Cloud workspace and repository.
- Workspace admin rights.

## Steps

1. Register the app. From `forge/bitbucket` (manifest `forge/bitbucket/manifest.yml`), run `forge register`.
   - Accept the developer terms.
   - Note the app ARI.
2. Set `BITBUCKET_FORGE_APP_ID` and `BITBUCKET_FORGE_ENVIRONMENT_ID` on the web server to the exact registered ARIs. See [Bitbucket Cloud](../bitbucket-cloud.md) for the remote endpoint and authentication requirements. Then run `forge deploy -e production`.
3. Install the app on the workspace with `forge install` (product Bitbucket), and approve the scopes.
4. In OpenReview, go to **Settings → Code Providers → Bitbucket Cloud**:
   1. Create an installation authorization.
   2. Paste the single-use code into the app's settings page in Bitbucket.
   3. Choose **Verify access and activate**.
5. Select and enable the repository, and wait for **index ready**.
6. Open a pull request with a seeded bug. Confirm:
   - [ ] Findings and the summary comment.
   - [ ] Signed product events arrive (provider events show completed).
7. Uninstall the app. Confirm:
   - [ ] The uninstall lifecycle event disables the connection and its repositories, as described under "Native settings and uninstall" in the guide.

## Evidence

Record:
- The app ID (not secrets) and the installation ID.
- The PR URL and SHAs.
- Screenshots of activation and of the review.

## Cleanup

Uninstall the app, and archive or delete the disposable workspace.
