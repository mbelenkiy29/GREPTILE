# Runbook: GitLab.com

**Goal:** prove reviews, suggestions, follow-ups and emoji feedback on GitLab.com.

## Prerequisites

- A GitLab.com group with a disposable project.
- A bot account with Developer access and a personal access token with the `api` scope.
- Inference budget for roughly 3 reviews.

## Steps

1. Connect the project. In **Settings → Code Providers → Connect provider → GitLab**:
   - **Instance:** `https://gitlab.com`.
   - **Credential:** the bot token.
   - **Webhook secret:** 32+ random characters.
2. In the project, open **Settings → Webhooks**. Add the shown URL and the secret token, with these events:
   - Merge request events.
   - Push events.
   - Comments.
   - **Emoji events** (needed for C1).
3. Enable the project and wait for **index ready**.
4. Open a merge request with a seeded bug. Confirm:
   - [ ] Positioned discussions.
   - [ ] `suggestion:-N+M` blocks that apply cleanly.
   - [ ] One summary note, edited on re-review.
5. React 👎 to a finding. Then:
   - [ ] Confirm the reaction appears in Analytics → reactions.
   - [ ] Confirm the learned preference appears in Memory.
6. Comment `@openreview review again`. Confirm:
   - [ ] A new review is queued.
7. Comment `@openreview fix this` in a finding discussion. Confirm:
   - [ ] A validated suggestion reply.

## Evidence

Record:
- The MR URL and the head SHAs.
- Screenshots of a suggestion block and the summary note.
- The reactions count.

## Cleanup

Close the MR, delete the webhook, and revoke the bot token.
