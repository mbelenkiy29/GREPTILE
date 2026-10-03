# GitLab

OpenReview reviews GitLab merge requests (gitlab.com or a self-managed instance) through the same pipeline as GitHub
pull requests: it posts a summary note that is updated in place on every re-review, one positioned diff discussion per
finding (with GitLab `suggestion:-N+0` blocks for exact fixes), answers `@openreview` mentions in their thread, and
indexes the default branch on every push.

## 1. Point OpenReview at your instance

| Variable     | Default              | Meaning                                                      |
| ------------ | -------------------- | ------------------------------------------------------------ |
| `GITLAB_URL` | `https://gitlab.com` | Your GitLab origin, e.g. `https://gitlab.example.com`.        |
| `APP_URL`    | —                    | Must be reachable from GitLab: webhooks go to `$APP_URL/api/webhooks/gitlab`. |

The instance in `GITLAB_URL` may be on a private network. Admins can also connect another GitLab instance, but only a
public HTTPS one (private, loopback, and plain-http addresses are refused so the form cannot reach internal services).

## 2. Create an access token

Use a **group access token** (all projects in a group) or a **project access token** (one project). A personal access
token also works, but then reviews are posted as that person.

- **Role:** Maintainer. GitLab only lets Maintainers create project webhooks.
- **Scopes:** `api` (notes, discussions, webhooks, approvals, pipelines) and `read_repository` (cloning for the index).
- **Expiry:** pick one that suits you. OpenReview shows the expiry date and warns 14 days before it.

## 3. Connect

An owner or admin opens **Settings → Git providers**, enters the GitLab URL and the token, and clicks **Connect
GitLab**. OpenReview checks the token with `GET /personal_access_tokens/self` (active, scopes, expiry) and `GET /user`
(the account comments are posted as), then stores it encrypted (AES-256-GCM with `ENCRYPTION_KEY`, or a key derived
from `APP_SECRET`). The token is never shown again or returned by any API.

**Check** re-validates the token and refreshes its health (invalid or revoked, missing scopes, expiring, expired).
**Disconnect** removes every webhook OpenReview created, the stored token, and the connection's repositories with their
reviews and index.

## 4. Choose projects

Open **Repositories** on the connection. It lists the projects where the token has the Maintainer role. **Enable**:

1. records the project as a repository of the org,
2. creates a project webhook (`POST /projects/:id/hooks`) for merge request, comment (note), and push events, with a
   random secret that OpenReview stores hashed and encrypted, and
3. queues the first full index.

**Disable** (here or on the Repositories page) deletes the webhook and pauses reviews; the index and history are kept.
Webhook setup is automatic: there is nothing to configure in GitLab.

## How events are handled

| GitLab event                                  | OpenReview does                                           |
| --------------------------------------------- | --------------------------------------------------------- |
| Merge request opened / reopened               | Review (subject to the auto-review, draft, and branch settings) |
| Merge request updated with new commits        | Incremental re-review of the new commits                  |
| Merge request marked ready (draft removed)    | Review                                                    |
| Merge request closed or merged                | Collect feedback (award emoji, replies) and mine rules    |
| Note mentioning `@openreview` (or `/openreview …`) | Answer in the same discussion                         |
| Reply to an OpenReview diff note              | Record feedback                                           |
| Push to the default branch                    | Incremental index                                         |

Every delivery is verified: the `X-Gitlab-Token` header must match that hook's secret (constant-time), and the payload
must be about that hook's project; otherwise the request gets `401` and nothing is stored. Deliveries are deduplicated
by `Idempotency-Key` (GitLab 17.4+), then `X-Gitlab-Event-UUID`, and appear under **Activity**, where a failed one can be
replayed.

Commands that change state (`re-review`, `ignore this pattern`, feedback commands) need the Developer role or higher on
the project; anyone can ask questions.
