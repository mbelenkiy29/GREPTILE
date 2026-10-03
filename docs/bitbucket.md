# Bitbucket Cloud

OpenReview reviews Bitbucket Cloud pull requests through the same pipeline as GitHub: a summary comment updated in place
on every re-review, one inline comment per finding (`inline: { path, to }`), threaded answers to `@openreview` mentions,
and an index of the default branch kept current on every push. Bitbucket has no suggestion blocks, so an exact fix is
shown as a fenced `diff`, and it renders no HTML, so OpenReview's hidden markers are written as markdown reference
definitions.

## 1. Settings

| Variable            | Default                          | Meaning                                                      |
| ------------------- | -------------------------------- | ------------------------------------------------------------ |
| `BITBUCKET_API_URL` | `https://api.bitbucket.org/2.0`  | Bitbucket Cloud REST API base.                                |
| `APP_URL`           | —                                | Must be reachable from Bitbucket: webhooks go to `$APP_URL/api/webhooks/bitbucket`. |

## 2. Create a credential

Preferred: a **workspace access token** (Workspace settings → Access tokens). Repository access tokens work for a single
repository. An **app password / API token** with its username also works; comments are then posted as that user.

Scopes:

- `repository` — read code and clone for the index,
- `pullrequest:write` — read pull requests and post comments,
- `webhook` — create and delete the repository webhooks.

Bitbucket reports a token's scopes in the `x-oauth-scopes` response header; OpenReview checks them when you connect and
on **Check**. When the host does not report scopes (some app passwords), the connection shows "scopes not reported".

## 3. Connect

An owner or admin opens **Settings → Git providers**, enters the workspace ID (the part after `bitbucket.org/`), the
token, and, for an app password, the username, then clicks **Connect Bitbucket**. The secret is stored encrypted and is
never shown again or returned by any API. **Disconnect** removes OpenReview's webhooks, the stored secret, and the
connection's repositories with their reviews and index.

## 4. Choose repositories

Open **Repositories** on the connection to list the workspace's repositories. **Enable** records the repository, creates
a repository webhook (`POST /repositories/{workspace}/{repo}/hooks`) with a random secret for these events, and queues the
first index:

`pullrequest:created`, `pullrequest:updated`, `pullrequest:fulfilled`, `pullrequest:rejected`,
`pullrequest:comment_created`, `repo:push`.

**Disable** deletes the webhook and pauses reviews. Webhook setup is automatic.

## How events are handled

| Event                          | OpenReview does                                             |
| ------------------------------ | ----------------------------------------------------------- |
| `pullrequest:created`          | Review (subject to the auto-review, draft, and branch settings) |
| `pullrequest:updated`          | Re-review when the head commit changed (title edits are ignored) |
| `pullrequest:fulfilled` / `rejected` | Collect feedback from replies and mine rules           |
| `pullrequest:comment_created`  | Answer mentions in the comment's thread; record replies to OpenReview's comments as feedback |
| `repo:push` to the default branch | Incremental index                                        |

Every delivery is verified: `X-Hook-UUID` names the hook, `X-Hub-Signature` must be the HMAC-SHA256 of the body with that
hook's secret (constant-time), and the payload must be about that hook's repository; otherwise the request gets `401`
and nothing is stored. Deliveries are deduplicated by `X-Request-UUID` and appear under **Activity**.

Bitbucket comments have no reactions, so feedback comes from replies and `/openreview` commands. State-changing commands
need workspace membership (read with the credential; when it cannot be read, those commands are refused and questions
are still answered).
