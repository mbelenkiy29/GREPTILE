# Self-hosting and production deployment

Before opening a hosted deployment to users, work through the [production readiness checklist](production-checklist.md).

For Kubernetes (Helm), AWS (Terraform), offline mode and the list of outbound hosts, see the [self-hosting kit](self-hosting-kit.md).

## Vercel and Convex Free

The hosted deployment runs on Vercel **Pro** in team `michael-belenkiys-projects`, with Convex **Free** at `tidy-ocelot-457`.
- **Hosting history:** the deployment was verified on the `open-review-free` Hobby team on 2026-10-04 and moved back to the Pro team on 2026-10-15. The move used Vercel's zero-downtime project transfer, so the project ID `prj_jMAK4u6yVJUfW2atnWbiZnF8F7b9`, deployments, environment variables, domains and the Git link are unchanged.
- **Older URLs:** deployment URLs created before the move keep their `-open-review-free` suffix.
- **Canonical URL:** https://openreview.tech (since 2026-10-15). The original https://openreview-flame-two.vercel.app and https://www.openreview.tech redirect to it with a 308.
- **Convex resource:** it is managed by the Convex Marketplace integration in the same Pro team. Do not remove that integration: it owns the live backend.
- **Local CLI:** the link (`.vercel/project.json`) and the CLI's default team target the Pro team.
- **Evidence:** full evidence and acceptance boundaries are in [acceptance-matrix.md](acceptance-matrix.md).

### Custom domain and Git deployments (October 15, 2026)

- **Domain.** `openreview.tech` is registered through Vercel in the team `michael-belenkiys-projects`. That team also hosts its DNS, pays its renewal and, since 2026-10-15, owns the `openreview` project. `www.openreview.tech` and the `.vercel.app` alias redirect to the apex.
  - The `_vercel` TXT records added while the project lived in `open-review-free` are no longer needed, but they are harmless.
- **Origins.**
  - `APP_URL` is `https://openreview.tech` in Vercel Production and in Convex `tidy-ocelot-457`.
  - The GitHub App's callback URLs include `https://openreview.tech/api/auth/callback`; the earlier callbacks are kept.
  - The App's setup URL is `https://openreview.tech/api/github/callback`.
  - The webhook is unchanged at `https://tidy-ocelot-457.convex.site/github/webhook`.
- **Git.** The project deploys from `mbelenkiy29/OPENREVIEW` (named `GREPTILE` until 2026-10-16; the old URL redirects, and Vercel follows the repository by ID) with production branch `main`, so merges to `main` deploy automatically.
  - The Ignored Build Step (`if [ "$VERCEL_ENV" = "production" ]; then exit 1; else exit 0; fi`) builds production only, and branch pushes are skipped. This is because the Preview-scoped `CONVEX_DEPLOY_KEY` could not be confirmed to be a Convex preview key. A production key there would deploy unmerged branches to the production backend.
  - Before enabling previews, set a Convex preview deploy key for Preview and clear the ignore command.
- **After a domain change.** Anything registered against the old origin needs updating:
  - The Linear OAuth app needs `https://openreview.tech/api/integrations/linear/callback`.
  - The Atlassian app needs `https://openreview.tech/api/integrations/atlassian/callback`.
  - A desktop bridge paired with the old origin must be paired again (`openreview bridge pair --url https://openreview.tech`), because bridge requests refuse redirects.

For a personal test deployment, host the Next.js application on Vercel Hobby and the backend on Convex Free. Vercel Hobby requires personal, non-commercial use. Convex Free has hard usage limits; model API calls are billed separately by the configured model provider. Do not enable a paid plan to bypass these limits without operator approval.

1. Link this directory to your Vercel Hobby project with `vercel link`. Provision the Convex **Free** Marketplace resource for that project and connect it to Production and Preview, with Sensitive enabled and no custom prefix. Accept the Marketplace/Convex agreements in your account. Keep development pointed at the existing local backend. Marketplace resources belong to a Vercel-managed Convex team; open the resource's **Open in Convex** link if it is missing from your personal Convex team.
2. The committed `vercel.json` deploys Convex and builds Next.js together. The integration provides the production `CONVEX_DEPLOY_KEY`; never expose it through a `NEXT_PUBLIC_` variable. `convex deploy` injects `NEXT_PUBLIC_CONVEX_URL` during the frontend build.
3. Set Vercel Production variables: `APP_URL` (the canonical HTTPS site origin), `NEXT_PUBLIC_CONVEX_SITE_URL` (the deployment's `.convex.site` origin), `SESSION_SECRET`, `SERVICE_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, and `CREDENTIAL_ENCRYPTION_KEY`. The App private key is used by the installation callback; the encryption key is used by provider setup. Keep both server-only.
4. Set Convex production variables using its dashboard or `convex env set --from-file` targeting the cloud deployment: `APP_URL`, matching `SESSION_SECRET`/`SERVICE_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, and the configured `LLM_*` values. Only the backend needs the model API key. Configure operator-approved `SCM_ALLOWED_HOSTS` when connecting additional provider instances.
5. Configure the existing GitHub App's OAuth callback as `https://<web-origin>/api/auth/callback`, installation setup URL as `https://<web-origin>/api/github/callback`, and webhook URL as `https://<deployment>.convex.site/github/webhook`. Preserve its selected-repository permissions. Stop the old webhook tunnel after delivery to the cloud endpoint is verified.
6. Deploy with `vercel --prod`. Verify the public `/api/health` and Convex `/health`, sign in through GitHub, check workspace/repository visibility and indexing, and verify an actual webhook delivery and review. A successful build or health response alone does not prove the review loop.

Before migrating existing data, export a snapshot with file storage and preserve it securely. Import into the new cloud deployment only; retain the original local database until the hosted workspace is verified. Secrets and snapshot exports are excluded from Git and deployment uploads. Existing bridge devices must point at the hosted application; a fresh production workspace requires a new pairing.

Use an explicit cloud deployment reference for every migration command, for example `--deployment <team-slug>:<project-slug>:prod`; do not rely on the local project's default deployment. Verify the target's dashboard identity and empty Data/Files views before importing. Import the snapshot without `--replace`, `--replace-all` or `--yes`, so unexpected existing data cannot be silently erased. Retain the existing credential encryption key when importing encrypted provider records, and use matching session/service secrets on web and backend. Check provider instance allowlists before enabling cloud jobs: local-only provider URLs cannot be reached from the cloud. Review default-off automation policies and terminal job states before import; preserve the local backup until hosted sign-in, stored file access and webhook processing pass.

The local coding agent still runs on the paired user's machine. Docker runtime validation requires its [separately deployed worker](runtime-worker.md); Vercel and Convex do not provide a Docker daemon.

See [Convex's Vercel deployment guide](https://docs.convex.dev/production/hosting/vercel), [Convex limits](https://docs.convex.dev/production/state/limits), and [Vercel Hobby eligibility](https://vercel.com/docs/plans/hobby).

## Docker deployment

Run the web app and Convex open-source backend on your own infrastructure. See [Convex self-hosting](https://docs.convex.dev/self-hosting) and the [upstream Docker configuration](https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker/docker-compose.yml).

1. Install Docker/Compose and Node.js 24/pnpm 11 on your administration machine.
2. Copy `.env.example` to `.env.local`. Generate independent 32-byte random values for `SESSION_SECRET`, `SERVICE_SECRET`, `GITHUB_WEBHOOK_SECRET`, and `CONVEX_INSTANCE_SECRET`. Do not reuse the session secret as the instance secret.
3. Set `APP_URL` to the HTTPS web origin, `CONVEX_PUBLIC_BACKEND_URL` to your HTTPS Convex client/admin origin, and `CONVEX_PUBLIC_SITE_URL` to the HTTPS HTTP-action origin. Set `NEXT_PUBLIC_CONVEX_SITE_URL` to that site origin. These URLs must be reachable by GitHub (webhooks) and the web server (Convex).
4. Put TLS reverse proxies in front of ports 3000, 3210, and 3211. Compose binds them to loopback. Keep administrative access restricted and do not publish Docker sockets. If moving web/backend to separate hosts, update the internal `NEXT_PUBLIC_CONVEX_URL` override accordingly.
5. Set environment values and export the Compose variables in your shell, or use `docker compose --env-file .env.local`. Start the backend:

```sh
docker compose --env-file .env.local up -d backend
docker compose exec backend ./generate_admin_key.sh
```

Save the generated admin key securely. It is an operator credential and must never be shipped to the browser or MCP client.

6. Deploy functions and schema:

```sh
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
CONVEX_SELF_HOSTED_ADMIN_KEY='<admin-key>' \
pnpm exec convex deploy
```

7. Synchronize required backend secrets and model variables using `convex env set --from-file .env.backend` with the same self-hosted URL/admin key. `.env.backend` must include `SESSION_SECRET`, `SERVICE_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and your `LLM_*` settings. The web additionally needs GitHub client ID/secret, App slug, and `APP_URL`.
8. Build/start the web service:

```sh
docker compose --env-file .env.local up -d --build web
```

9. Register/configure the GitHub App as described in README, sign in, create a workspace, install the App, enable a test repository, wait for indexing, and open a deliberately buggy cross-file PR. Verify comment/evidence/resolution with the real model before enabling reviews broadly.

Health endpoints: `/api/health` (web), `/health` on the Convex HTTP origin, `/version` on the backend origin. The web health response distinguishes configured environment from liveness; it does not prove GitHub/model reachability.

Pin `CONVEX_BACKEND_IMAGE` to a tested tag or digest for production. Compose pins the backend digest verified during implementation; review upstream release notes before changing it. Back up the entire Convex data volume consistently, including storage, and rehearse restoration. Use encrypted disks/backups. Follow upstream Convex upgrade instructions; do not delete the data volume to upgrade.

Dependency checks: run `pnpm audit --prod`, review findings, and use patched versions. GitHub App access should be limited to selected repositories. Model provider URLs are operator-controlled and must be trusted; private endpoints require explicit local opt-in.

Docker build/Compose execution require a functioning Docker daemon. Real deployment and GitHub/model acceptance cannot be verified with unit fixtures alone. See `docs/implementation-status.md` for current evidence and limits.

### GitHub Enterprise API and author identity

Enterprise Server connections accept the instance root or its `/api/v3` API root. API requests use `/api/v3`; source and clone links use the actual server hostname, including servers whose hostname starts with `api.`. Dedicated GHE.com connections use `api.SUBDOMAIN.ghe.com` for API calls and `SUBDOMAIN.ghe.com` for source/clone links. Add the input instance host to `SCM_ALLOWED_HOSTS`; when entering its web host, also explicitly authorize the derived API host. Credentials are never forwarded through redirects.

After installing the OpenReview GitHub App, authors link an existing personal account token in Settings → Personal agents. The authenticated profile and PR author must have the same immutable native user ID on that connection. This link is separate from the installation key and from GitHub.com sign-in. Links expire after 24 hours, can be revoked, and require re-linking after their instance/kind/credential authority changes. Legacy personal links created before instance-bound authority also require re-linking; GitHub.com sign-in and native P4 links are unaffected. Enterprise Server/GHE.com live acceptance requires a real Enterprise installation and author account; contract coverage alone does not establish it.

### Bitbucket Data Center author identities

After connecting the admin-managed native bot, authors link an existing personal HTTP access token in Personal agents. The instance must expose its native authenticated `X-AUSERNAME` response header and permit filtered read-only user lookup. Reverse proxies that remove this header will cause verification to fail; OpenReview does not substitute a user-entered account name. Actual Data Center author identity and review/publication acceptance require a provisioned Data Center installation and remain unverified until tested there.
