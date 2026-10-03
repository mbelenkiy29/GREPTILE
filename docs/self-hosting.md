# Self-hosting

OpenReview runs on one server with Docker Compose: the web app, the worker, PostgreSQL with pgvector, and Redis. This
page walks through a production install on a single server (a DigitalOcean Droplet is the reference target; any Linux
host with Docker works), then covers TLS, backups, upgrades, scaling, and the features larger teams need: offline
operation, single sign-on, the audit log, and per-organization model providers. Every variable mentioned here is
listed in [`.env.example`](../.env.example) and explained in [configuration](configuration.md).

## What you need

- A Linux server with Docker Engine and the Docker Compose plugin.
- A domain name whose DNS you control (for HTTPS and GitHub webhooks).
- A model provider: an Anthropic API key (default), or OpenAI, OpenRouter, or an OpenAI-compatible server
  ([models](models.md)).
- An embedding endpoint (OpenAI by default, or any OpenAI-compatible embedding server): indexing embeds every symbol.
- A GitHub account or organization where you can create a GitHub App (or GitLab / Bitbucket Cloud credentials).

**Server size.** These are starting points, not measured limits; watch memory and disk and resize as needed.

| Team | Droplet | Disk |
| --- | --- | --- |
| Trying it out, a few small repositories | 2 vCPU, 4 GB RAM | 50 GB |
| A team with tens of active repositories | 4 vCPU, 8 GB RAM | 100 GB |
| Many large repositories or several workers | 8 vCPU, 16 GB RAM | 200 GB+ |

Postgres holds the code index (symbols, chunks, embeddings) of every repository, and the worker keeps a checkout of
each repository in the `repocache` volume, so disk grows with the size of the indexed code. Building the images
(`docker compose build`) needs about as much memory as the largest row's workload; on a 4 GB server add swap first.
Model calls run at the provider, so CPU mostly goes to parsing during indexing.

## Install on a single server

1. **Create the server** (Ubuntu LTS) and point DNS at it: an `A` (and `AAAA`, if you use IPv6) record for, say,
   `review.example.com`. Allow inbound TCP 22, 80, and 443 (and UDP 443 for HTTP/3) in the firewall.
2. **Install Docker Engine and the Compose plugin** following Docker's instructions for your distribution
   (<https://docs.docker.com/engine/install/ubuntu/>), then check with `docker compose version`.
3. **Get OpenReview and configure it:**

   ```sh
   git clone https://github.com/openreview/openreview.git /opt/openreview && cd /opt/openreview
   cp .env.example .env
   ```

   Edit `.env` and set at least:

   ```sh
   APP_URL=https://review.example.com
   OPENREVIEW_DOMAIN=review.example.com
   APP_SECRET=<openssl rand -base64 32>
   ENCRYPTION_KEY=<openssl rand -base64 32>
   POSTGRES_PASSWORD=<openssl rand -hex 24>
   ANTHROPIC_API_KEY=<your key>          # or LLM_PROVIDER / LLM_MODEL / LLM_API_KEY
   EMBEDDING_API_KEY=<your OpenAI key>   # or EMBEDDING_PROVIDER=openai-compatible + EMBEDDING_BASE_URL + EMBEDDING_MODEL
   ```

   `NODE_ENV`, `DATABASE_URL`, and `REDIS_URL` in `.env` are ignored inside the containers (Compose sets them).
4. **Start it** with the production override, which adds Caddy for HTTPS:

   ```sh
   docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps
   ```

   The first start builds the images, creates the database, and applies migrations. `postgres`, `redis`, and `app`
   become healthy; the `worker` restarts until the GitHub App variables exist (next step).
5. **Create the GitHub App** right away at `https://review.example.com/setup/github-app` (it is open only until
   someone signs in or an App is configured), paste the credentials it shows into `.env`, and run the same
   `up -d` command again. See [GitHub App setup](github-app.md). For GitLab or Bitbucket Cloud see
   [GitLab](gitlab.md) and [Bitbucket](bitbucket.md).
6. **Sign in** with GitHub at `https://review.example.com`, finish onboarding, and install the App on your
   repositories. Indexing starts immediately; the first review runs on the next pull request.

To avoid typing both `-f` flags every time, put `COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.prod.yml` in
the shell environment (or in `.env`; Docker Compose reads it from there too), then use plain `docker compose …`.

### What the production override changes

[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml):

- adds `caddy` ([`deploy/Caddyfile`](../deploy/Caddyfile)), the only service listening publicly (80 and 443). Caddy
  obtains and renews a Let's Encrypt certificate for `OPENREVIEW_DOMAIN` automatically (DNS must point at the server
  and port 80 must be reachable), redirects http to https, compresses responses, and proxies to `app:3000`;
- publishes the app on `127.0.0.1:${APP_PORT}` only: Docker-published ports bypass host firewalls such as `ufw`, so
  the app must not listen on the public interface;
- sets `restart: unless-stopped` on every service and rotates container logs (`json-file`, 10 MB × 5 files).

Caddy sets `X-Forwarded-For` to the connecting client's address, which is what OpenReview's per-address rate limits
read. Keep Caddy the only proxy in front of the app (or configure `trusted_proxies` in the Caddyfile if you add a load
balancer in front of it).

Without the override (`docker compose up -d`), the app listens on port `APP_PORT` (3000) over plain http, which is
fine on a laptop or behind your own TLS proxy. Sign-in cookies are `Secure` in production, so browsers only keep them
over https (or on `localhost`).

### Health checks

- `app`: `GET /api/health` must answer `200` (Postgres and Redis reachable). It also reports the newest worker
  heartbeat for information.
- `worker`: `worker/healthcheck.ts` checks that this container's worker refreshed its Redis heartbeat (every 15 s).
- `postgres` (`pg_isready`) and `redis` (`redis-cli ping`).

The worker starts only after the app is healthy, so migrations have run before any job does.

## Backups

All state worth keeping is in PostgreSQL. Redis holds the job queue (review runs whose job was lost are re-queued by the
worker's recovery sweep; a lost indexing job can be started again from the repository menu), and the `repocache`
volume is refilled by fetching. Back up Postgres with
[`deploy/backup.sh`](../deploy/backup.sh), which runs `pg_dump --format=custom` inside the `postgres` container (no
credentials on the command line), writes `openreview-<UTC timestamp>.dump`, and deletes dumps older than the
retention:

```sh
deploy/backup.sh /var/backups/openreview 14     # directory (default ./backups), days to keep (default 14)
```

Run it daily from cron (as a user that can run `docker`):

```cron
17 3 * * * /opt/openreview/deploy/backup.sh /var/backups/openreview 14 >> /var/log/openreview-backup.log 2>&1
```

Copy the backup directory off the server (object storage or another host): a backup on the same disk does not survive
losing the server. Keep `.env` (especially `APP_SECRET` and `ENCRYPTION_KEY`) somewhere safe as well; encrypted
secrets in the database cannot be read without them.

Restore into a fresh install (same version or older dump):

```sh
docker compose up -d postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < openreview-20260101T031700Z.dump
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d
```

## Upgrades

```sh
cd /opt/openreview
deploy/backup.sh                       # always back up first
git pull                               # or check out a release tag
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

Database migrations run automatically when the new app container starts (`RUN_MIGRATIONS=true`, applied by
`instrumentation.ts` before the server takes traffic; concurrent starts are safe). The worker waits for the app to be
healthy, and a stopping worker gets five minutes (`stop_grace_period`) to finish running reviews; anything it could not
finish is re-queued by recovery. Read the release notes for new variables (`.env.example` lists them all).

## Scaling

- **More jobs per worker:** raise `WORKER_CONCURRENCY` (default 4) if the server has spare CPU and the model
  provider's rate limits allow it.
- **More workers:** `docker compose … up -d --scale worker=3`. Workers share the queue and the `repocache` volume;
  indexing of one repository is serialized by a Postgres advisory lock, and a review is claimed by exactly one worker.
- **A separate database:** a managed PostgreSQL 16 with the `vector` extension available (for example DigitalOcean
  Managed PostgreSQL) works. `docker-compose.yml` sets `DATABASE_URL` for the app and worker (it takes precedence over
  `.env`), so set yours in a compose override file and drop their dependency on the `postgres` service.
- Index size grows with code size; vector search uses HNSW indexes on `symbols.embedding` and
  `file_chunks.embedding`.

## Offline / air-gapped

OpenReview has no telemetry, update checks, analytics, web fonts, or CDN assets. Its only outbound connections are:

| Destination | Why | Configured by |
| --- | --- | --- |
| LLM endpoint | Reviews, conversations, knowledge base | `LLM_PROVIDER`, `LLM_BASE_URL` |
| Embedding endpoint | Code search embeddings | `EMBEDDING_PROVIDER`, `EMBEDDING_BASE_URL` |
| Git host API and web (and `git fetch` over https) | Webhooks, PR data, comments, checkouts | `GITHUB_API_URL`, `GITHUB_WEB_URL` (and the GitLab / Bitbucket URLs when used) |
| Stripe | Billing, only when billing is configured | `STRIPE_SECRET_KEY` |
| SSO identity providers | OIDC discovery, keys, token exchange | Each org's SSO connection |
| An org's own model endpoint | Bring-your-own LLM | Each org's model provider settings |

Every server-side HTTP request goes through `lib/net/fetch.ts`, which checks the host against that list plus
`OUTBOUND_ALLOWLIST` (comma-separated hosts; `*.example.com` matches subdomains). With
`OUTBOUND_ALLOWLIST_ENFORCE=true` anything else is refused and logged as `outbound request blocked by the allowlist`;
without it such calls go ahead and are logged once per host as a warning, so you can audit an install before turning
enforcement on. A test (`tests/r4.6-offline.test.ts`) fails if production code calls `fetch` without the wrapper.

Run the offline bundle with the override file:

```sh
docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
```

With HTTPS through Caddy, add the production override as the last file:
`docker compose -f docker-compose.yml -f docker-compose.offline.yml -f deploy/docker-compose.prod.yml up -d` (Caddy
itself needs outbound access to Let's Encrypt to obtain certificates).

The offline override turns enforcement on, keeps Next.js telemetry off (`NEXT_TELEMETRY_DISABLED=1`, also set in the image), and puts
Postgres and Redis on an internal network with no route out. For a fully local model, point `LLM_BASE_URL` (and
`EMBEDDING_BASE_URL`) at an OpenAI-compatible server on your network, such as vLLM or Ollama.

User avatars are loaded by the browser from the git host's avatar URLs; that traffic does not pass through the server.

## Single sign-on (OIDC and SAML)

Owners configure SSO in **Settings → Single sign-on**. Each connection lists the URLs to paste into the identity
provider:

- **OIDC:** redirect URI `APP_URL/api/auth/sso/<id>/callback`. Enter the issuer URL, client ID, and client secret
  (stored encrypted, never shown again). OpenReview uses the authorization code flow with PKCE, verifies the ID token's
  signature against the issuer's JWKS, its issuer, audience, nonce, and expiry, and requires `email_verified`.
- **SAML 2.0:** ACS URL `APP_URL/api/auth/saml/<id>/acs`, SP entity ID and metadata at
  `APP_URL/api/auth/saml/<id>/metadata`. Paste the IdP metadata XML, or its entity ID, SSO URL (HTTP-Redirect), and
  signing certificate. Assertions must be signed, addressed to the SP entity ID, issued by the configured IdP, within
  their validity window (two minutes of clock skew), and answer a request OpenReview made (IdP-initiated sign-in is not
  accepted).

Only emails in the connection's allowed domains may sign in. People who sign in for the first time join the
organization with the connection's default role (member or admin). People sign in from **Sign in with SSO** on the
sign-in page with their work email or the organization's slug.

**Requiring SSO.** After signing in through the connection yourself, you can require it. Members who signed in with
GitHub are then sent through the identity provider before they can use the organization, and their SSO identity is
linked to their existing account. A linked identity only confirms SSO for that account; it is never a way to sign in
to the GitHub-backed account on its own. Disabling a connection also stops requiring it. If an identity provider
breaks while SSO is required, the instance operator can lift the requirement with
`UPDATE sso_connections SET enforce = false WHERE org_id = '<org id>';`.

Identity provider URLs must be public https URLs (they are checked against private, loopback, and link-local
addresses). For an identity provider on your internal network set `SSO_ALLOW_PRIVATE_ISSUERS=true`.

## Audit log

**Settings → Audit log** (owners and admins) lists who did what and from which address: repository, review settings,
rules, learned preferences, members, invitations, API keys, SSO, model provider, and organization changes, review
requests and cancellations from the dashboard, API, and CLI, finding feedback, webhook replays, and GitHub
installations linked or removed. Filter by actor, action category, and date range, and export the filtered log as
CSV (`/api/orgs/current/audit.csv`; cells that start with `=`, `+`, `-`, or `@` are prefixed with `'` so spreadsheets
never evaluate them). The worker deletes entries older than `AUDIT_RETENTION_DAYS` (default 365). Deleting an
organization deletes its audit log with the rest of its data; the deletion itself is recorded in the server log.

## Bring your own model provider

Owners and admins can point an organization's model calls at their own provider in **Settings → Model provider**:
Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint, with a base URL, API key (encrypted at rest and
never shown again), a default model, and optional per-task models. **Test connection** sends one tiny request through
the saved settings. Reviews, conversations, rule mining, and the knowledge base for that organization then run against
it; embeddings for code search keep using the server's embedding model. Base URLs must be public https endpoints
unless `LLM_ALLOW_PRIVATE_ORG_ENDPOINTS=true`, and the operator's own API key is never sent to an organization's
endpoint.

## Rate limits and security headers

Public endpoints (GitHub sign-in, SSO lookup / start / callback / ACS, invitation acceptance) allow
`PUBLIC_RATE_LIMIT_PER_MINUTE` requests per client address per minute, counted in Redis. The client address is the
last `X-Forwarded-For` hop, so put exactly one trusted reverse proxy in front of the app. The GitHub webhook receiver
allows `WEBHOOK_RATE_LIMIT_PER_MINUTE` signed deliveries per installation per minute. Over a limit the server answers
`429` with `Retry-After`.

Every response carries a Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `Permissions-Policy`, and (in production builds) `Strict-Transport-Security`. See `SECURITY.md`
for the threat model.

## Troubleshooting

See [troubleshooting](troubleshooting.md) for webhook, permission, indexing, model, rate-limit, and SSO problems.
