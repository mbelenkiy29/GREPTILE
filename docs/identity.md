# Sign-in, accounts and sessions

## Sign-in methods

| Method | Configure (web app) | Email trusted for account linking |
| --- | --- | --- |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Never (no email scope is requested) |
| GitLab | `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET`, optional `GITLAB_OAUTH_URL`; scope `read_user`; redirect URI `<APP_URL>/api/auth/gitlab/callback` | Only confirmed gitlab.com accounts |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; scopes `openid email profile`; redirect URI `<APP_URL>/api/auth/google/callback` | When Google reports `email_verified` |
| Email link | `EMAIL_SIGN_IN=true` on the web app, plus `RESEND_API_KEY`/`EMAIL_FROM` on Convex | Always (clicking the link proves ownership) |

## Account linking

- **Same provider account:** a sign-in from a provider account OpenReview has seen before is the same user.
- **Different provider, same email:**
  - It joins the existing user only when **both** identities carry the same email marked verified by their provider.
  - Otherwise a separate user is created.
  - This means an attacker who registers someone else's address somewhere without verification cannot take over that person's account.
- **Explicit linking:** to attach another method, sign in, open **Settings → Account & sessions** and choose **Link …**. A provider account that already belongs to another user cannot be linked.

## Sessions

- **Cookie and server-side record:**
  - Browser sessions carry a random session ID in the signed cookie, and only its SHA-256 is stored.
  - Every Convex call and every dashboard page load checks that the session exists, belongs to the user, has not been revoked and has not expired (7 days).
- **Managing sessions:**
  - **Settings → Account & sessions** lists active sessions.
  - **Sign out** ends the current one.
  - **Sign out everywhere** revokes all of them, plus any older session-less cookies from before this change.
- **Workspace removal:** removing a member from a workspace signs them out everywhere. It also revokes their API keys and bridge pairings for that workspace.

## Email invitations

Admins can invite by email (**Settings → People**). The link is single use, expires in 7 days and can be revoked. Whoever opens it signs in with any method and accepts. Only the token's hash is stored. GitHub-login invitations continue to work.

## Migration

`users.githubId` is optional. Existing GitHub users get a `github` identity on their next sign-in. After deploying, you can also backfill all users at once:

```bash
npx convex run identity:backfillIdentities --prod
```

The backfill is idempotent and paginated.

## SSO / SAML

SSO/SAML is deferred. When it is added, plan to front OpenReview with a self-hosted OIDC/SAML broker that exposes a standard OIDC provider, using the same identity and linking rules.
