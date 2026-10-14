# Notifications, Slack and email

OpenReview sends nothing until a workspace connects Slack or a member verifies an email address.

## Slack

1. An operator creates the Slack app from [slack-app-manifest.yml](slack-app-manifest.yml).
2. Set the app's credentials:
   - `SLACK_CLIENT_ID` on both Next.js and Convex.
   - `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on Convex only.
3. A workspace admin opens **Settings → Notifications → Add to Slack**. The bot token is stored encrypted with `CREDENTIAL_ENCRYPTION_KEY`. One Slack workspace can connect to only one OpenReview workspace.
4. The admin links channels by ID. For each channel they choose:
   - **Notifications:** review completed and/or high-severity findings, for all repositories or selected ones.
   - **Q&A:** off by default. It answers `@OpenReview <question>` about 1–5 selected repositories.
     - Answers come from the codebase-chat engine. Every claim cites lines at the indexed revision.
     - Anyone in the channel can ask, so link only repositories that channel may read. Code is read with the installing admin's repository access.
     - Questions are rate-limited to 20 per Slack workspace per minute, count against the inference budget, and are recorded as `slack` usage.
5. `/openreview status` shows a channel's links and each repository's index state, visible only to the person who ran it.

Every request from Slack is checked against `SLACK_SIGNING_SECRET`. Requests more than five minutes old are rejected, and retried events are processed only once.

## Email

Set `RESEND_API_KEY` and `EMAIL_FROM` on Convex. Each member sets a notification email in **Settings → Notifications** and confirms it through a one-hour link; only a hash of the link token is stored. Members choose, separately for completed reviews and for high-severity findings, one of:
- **Off.**
- **My pull requests:** pull requests whose author matches the member's login.
- **All repositories I can access.**

Without email configuration, deliveries are recorded as skipped.

## Delivery guarantees

Each (event, review, target) is delivered at most once; a failed delivery is retried when the job runs again. A repository the member can no longer access is never emailed about.
