# Runbook: GitHub Enterprise

**Goal:** prove that a GitHub Enterprise Server (or GHE.com) installation reviews pull requests end to end.

## Prerequisites

- A GHES instance (3.10+) or GHE.com tenant, a disposable organization and repository, and an admin account.
- The web app's host is in `SCM_ALLOWED_HOSTS`.
- A model key and enough inference budget for roughly 3 reviews.

## Steps

1. On the instance, register a GitHub App with:
   - The permissions in [GitHub App setup](../public/github-app.md): Contents R, Metadata R, Pull requests R/W, Issues R, Checks R/W.
   - All the events listed there.
   - Webhook URL `<APP_URL>/api/providers/<connection id>/webhook`.
   - A generated webhook secret and private key.
2. Install the app on the disposable repository and note the installation ID.
3. In OpenReview, open **Settings → Code Providers → Connect provider → GitHub Enterprise**.
   - **Instance:** the instance root, or the GHE.com subdomain.
   - **Credential:** `{"appId":"…","privateKey":"…","installationId":…}`.
   - **Webhook secret:** the app's secret.
4. Select and enable the repository, and wait for **index ready**.
5. Open a pull request that introduces an obvious bug, for example dividing cents by 100 before a charge. Then confirm:
   - [ ] Inline findings with exact-quote evidence.
   - [ ] A single summary comment.
   - [ ] An `OpenReview` check run that goes in progress, then completes.
6. Push a fix commit. Confirm:
   - [ ] An incremental review.
   - [ ] The fixed thread is resolved.
   - [ ] The summary is edited in place.
7. Reply `@openreview explain this` on a finding. Confirm:
   - [ ] A cited answer.
8. Reply `@openreview fix this`. Confirm:
   - [ ] A `suggestion` block and a Fix link.

## Evidence

Record:
- The PR URL and the reviewed SHAs.
- The review IDs from the dashboard.
- Screenshots of the summary, a finding and the check run.

## Cleanup

Close the PR, uninstall the app, and disconnect the provider connection.
