# GitHub App setup

OpenReview talks to GitHub as a **GitHub App that you own**: it receives webhooks, reads code, and posts reviews with
the App's installation tokens, and people sign in with the App's OAuth credentials. Each OpenReview server needs its
own App, because the App's webhook URL points at that server.

## Option 1: create it from this server (recommended)

1. Set `APP_URL` in `.env` to the server's public https address and `APP_SECRET` to a random string
   (`openssl rand -base64 32`), and start OpenReview (`docker compose up -d`).
2. Open `https://<your server>/setup/github-app`.
3. Optionally enter a GitHub organization (leave it empty to create the App under your personal account; you must be
   an owner of the organization), adjust the App name (unique on GitHub, at most 34 characters), and choose whether
   other accounts may install it. Select **Continue**, review the manifest, and select **Create the App on GitHub**.
4. GitHub asks you to confirm the name and creates the App, then sends you back to
   `/setup/github-app/callback`, which exchanges GitHub's one-time code (`POST /app-manifests/{code}/conversions`) for
   the App's credentials and shows them **once**: App ID, slug, client ID and secret, webhook secret, and private key,
   as ready-to-paste `.env` lines. OpenReview does not store them; the page is sent with `Cache-Control: no-store`.
5. Paste the lines into `.env` (replacing any existing `GITHUB_APP_*` / `GITHUB_WEBHOOK_SECRET` values) and run
   `docker compose up -d` to restart the app and worker with them.
6. Sign in with GitHub and install the App on the repositories to review (**Repositories → Install**, or the
   onboarding wizard).

Who may use the setup page: while no GitHub App is configured **and** nobody has signed in yet, anyone who can reach
the server (a fresh install has no other way in, so do this right after the first start). After that, only instance
administrators: the users whose emails are listed in `INSTANCE_ADMIN_EMAILS`, or, when that is empty, the first user
who signed in. Signed-out visitors are sent to sign in; other users get a 404. The flow's `state` is bound to an HttpOnly cookie in the browser that started
it, so a link to the callback from anyone else is refused.

The page is built from [`github-app-manifest.json`](../github-app-manifest.json) (`{{APP_URL}}` is replaced with your
`APP_URL`). On GitHub Enterprise Server set `GITHUB_WEB_URL` and `GITHUB_API_URL` first; the manifest is then posted
to your instance.

## Option 2: create it by hand

In GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (or the organization's settings), and use
the values from the manifest:

| Setting | Value |
| --- | --- |
| Homepage URL | `APP_URL` |
| Callback URL | `APP_URL/api/auth/github/callback` |
| Request user authorization (OAuth) during installation | off |
| Setup URL | `APP_URL/api/github/callback` (redirect on update: off) |
| Webhook | active, URL `APP_URL/api/webhooks/github`, a random secret (`openssl rand -hex 32`) |
| Permissions | see below |
| Events | see below |

Then generate a private key and copy the App ID, slug (from the App's URL), client ID, a new client secret, the
webhook secret, and the private key into `.env`:

```sh
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_CLIENT_ID=Iv23...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_WEBHOOK_SECRET=...
# The PEM on one line with \n escapes, or in double quotes with \n escapes
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
```

## Permissions

The manifest asks for exactly what the code uses (`REQUIRED_PERMISSIONS` and `RECOMMENDED_PERMISSIONS` in
[`lib/data/installations.ts`](../lib/data/installations.ts); a test keeps the manifest in sync).

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | read | Repository list, `repository` events (required by GitHub for every App) |
| Contents | read | Clone and fetch for indexing, read files and `openreview.json` at the base commit |
| Pull requests | write | Read pull requests, files, and commits; post reviews with inline comments; reply in review threads; react |
| Issues | write | The summary comment and mention answers are issue comments on the pull request |
| Checks | read (recommended) | CI status as review context; without it reviews simply have no CI context |

An installation that lacks a required permission is flagged in **Settings → GitHub** and in the logs
(`installation is missing required permissions`). After you add permissions to the App, each installation's owner
must accept them on GitHub; the `new_permissions_accepted` event updates OpenReview.

## Events

| Event | Used for |
| --- | --- |
| `pull_request` | Review on open, push (`synchronize`, debounced), reopen, and ready for review; on close, collect feedback on OpenReview's comments and mine teammates' comments into candidate rules |
| `pull_request_review` | Mentions and commands in review bodies |
| `pull_request_review_comment` | Mentions, commands, and replies in inline threads; teammates' comments for rule mining |
| `issue_comment` | Mentions and commands in the pull request conversation |
| `push` | Incremental re-indexing of the default branch |
| `repository` | Renames, transfers, archiving, visibility and default branch changes |

GitHub always sends `installation` and `installation_repositories` to Apps (they cannot be selected); OpenReview uses
them to link installations, track permissions and suspension, and sync the repository list. `ping` is acknowledged.

## Installing and linking

Installing from OpenReview (**Repositories → Install**) signs the request with the org that started it; GitHub
redirects back to `/api/github/callback`, and the installation is linked only after GitHub confirms the signed-in user
can access it. An App installed directly on GitHub shows up as a pending installation that an org admin can claim from
onboarding. One installation belongs to exactly one OpenReview org.

## Rotating credentials

- **Private key**: generate a new key in the App settings, update `GITHUB_APP_PRIVATE_KEY`, restart, then delete the
  old key on GitHub.
- **Webhook secret**: change it in the App settings and `GITHUB_WEBHOOK_SECRET` together; deliveries signed with the
  old secret are refused (`401`) and can be redelivered from GitHub's **Advanced** tab.
- **Client secret**: create a new one, update `GITHUB_APP_CLIENT_SECRET`, restart, delete the old one.

Problems? See [troubleshooting](troubleshooting.md#github).
