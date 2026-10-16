# GitHub App setup

Each OpenReview deployment uses its own GitHub App. Register it under GitHub **Settings → Developer settings → GitHub Apps**.

| Setting | Value |
| --- | --- |
| Homepage URL | your `APP_URL` |
| Callback URL (user authorization) | `APP_URL/api/auth/callback` |
| Setup URL | `APP_URL/api/github/callback` |
| Webhook URL | `CONVEX_SITE_URL/github/webhook` |
| Webhook secret | `GITHUB_WEBHOOK_SECRET` |

## Repository permissions

The required permissions are:
- **Contents:** read.
- **Metadata:** read.
- **Pull requests:** read and write (for review comments, the summary in the pull request description, and reactions).
- **Issues:** read (for comment webhooks).
- **Checks:** read.

Two upgrades are optional, and OpenReview skips each feature at runtime when the permission is missing:
- **Checks: read and write:** an "OpenReview" check run per review.
- **Contents: read and write:** fix pull requests from `@openreview fix this in a new PR`, which must also be enabled per repository.

## Events

Subscribe to:
- Installation and Installation repositories.
- Pull request, Pull request review, and Pull request review comment.
- Issue comment.
- Push.
- Repository.

## Credentials

1. Generate a private key and convert it to PKCS#8:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in github-key.pem -out app-key.pem
   ```

2. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the backend.
3. Copy the client ID and secret to the web app too, because they are used for sign-in.

Keep the private key on server infrastructure only. Installation tokens are minted per request and never stored.
