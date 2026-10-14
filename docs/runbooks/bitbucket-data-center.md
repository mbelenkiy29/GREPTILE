# Runbook: Bitbucket Data Center

**Goal:** verify reviews and follow-ups on a self-hosted Bitbucket Data Center.

## Prerequisites

- Bitbucket Data Center 8.x or later, reachable over HTTPS from the backend, with its host in `SCM_ALLOWED_HOSTS`.
- A bot user with an HTTP access token and repository write access.
- A disposable project and repository.

## Steps

1. Connect via **Settings → Code Providers → Bitbucket Data Center**:
   - **Instance:** the base URL.
   - **Credential:** `{"token":"…","username":"…"}`.
   - **Webhook secret:** 32+ characters.
2. In the repository, open **Settings → Webhooks**. Add the shown URL and secret, with these events:
   - Pull request opened, source branch updated, comment added, and reviewer events.
   - Push.
3. Enable the repository and wait for **index ready**.
4. Open a pull request with a seeded bug. Confirm:
   - [ ] Inline comments anchored on the changed lines.
   - [ ] One summary comment per run.
5. Comment `@openreview explain this` as a user with repository write access. Confirm:
   - [ ] A cited reply.
6. Repeat step 5 as a user without write access. Confirm:
   - [ ] No reply.

## Evidence

Record:
- The PR URL and SHAs.
- Screenshots of an inline comment and the summary.
- The denied follow-up attempt.

## Cleanup

Decline the PR, remove the webhook, and revoke the bot token.
