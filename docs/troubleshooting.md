# Troubleshooting

Start with the health check and the logs:

```sh
docker compose ps                                  # app and worker should be "healthy"
curl -s http://127.0.0.1:3000/api/health           # {"status":"ok","database":"ok","redis":"ok","worker":"ok"}
docker compose logs --since 30m app worker         # JSON lines; search for "level":"error" or "warn"
```

Every log line carries correlation ids (`deliveryId`, `orgId`, `repoId`, `runId`, `jobId`, ...), so you can follow
one webhook delivery or review run across the app and the worker. **Activity** in the dashboard lists webhook
deliveries with their outcome, error, and the jobs they queued; a failed delivery can be replayed there.

## Startup

**The worker keeps restarting.** It validates the full configuration at start; the log names the missing or invalid
variable. Before the GitHub App is configured, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and
`GITHUB_WEBHOOK_SECRET` are missing; create the App at `/setup/github-app` ([GitHub App setup](github-app.md)).

**The app is unhealthy.** `/api/health` answers `503` with `database` or `redis` set to the error. Check that the
`postgres` and `redis` containers are healthy and that `DATABASE_URL` / `REDIS_URL` point at them (Compose sets both).

**Migrations fail on start.** The app applies migrations before serving (`RUN_MIGRATIONS=true`); the error is in the
app log. The database must have the `vector` extension available (the `pgvector/pgvector:pg16` image has it). To run
them separately: `RUN_MIGRATIONS=false` and `pnpm db:migrate`, or in Compose
`docker compose run --rm --no-deps worker node_modules/.bin/tsx scripts/migrate.ts`.

**`/setup/github-app` returns 404.** After the first user signs in, or once a GitHub App is configured, only instance
administrators may open it: set `INSTANCE_ADMIN_EMAILS` to your email, or sign in as the first user.

## Sign-in

**Signing in loops back to the sign-in page.** Production sessions use `Secure` cookies, which browsers drop on plain
http (except `localhost`). Serve the app over https (see the Caddy setup in [self-hosting](self-hosting.md)) and set
`APP_URL` to that https address.

**"GitHub sign-in isn't configured yet".** Set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` (the App's OAuth
credentials) and restart. The App's callback URL must be `APP_URL/api/auth/github/callback`.

**`invalid_state` after GitHub or SSO sign-in.** The attempt took longer than ten minutes or started in another tab or
on another host name. Use the same `APP_URL` host you configured and try again.

**SSO problems.** The sign-in page explains the failure (unknown domain, connection disabled, email not verified,
domain not allowed, response not verifiable). Check the connection under **Settings → Single sign-on**:

- OIDC: the IdP's redirect URI must be `APP_URL/api/auth/sso/<id>/callback`, the IdP must return a verified email,
  and the issuer URL must be the one the IdP publishes (its discovery document's `issuer`).
- SAML: the ACS URL is `APP_URL/api/auth/saml/<id>/acs`, assertions must be signed with a certificate configured on the
  connection, and IdP-initiated sign-in is not supported.
- An IdP on a private network needs `SSO_ALLOW_PRIVATE_ISSUERS=true`; with `OUTBOUND_ALLOWLIST_ENFORCE=true` the
  issuer's hosts are allowed automatically.
- Locked out by an enforced connection: `UPDATE sso_connections SET enforce = false WHERE org_id = '<org id>';`

**`429` from sign-in or invitation pages.** `PUBLIC_RATE_LIMIT_PER_MINUTE` per client address. Behind a proxy, make
sure exactly one trusted proxy appends the client address to `X-Forwarded-For`; otherwise every visitor shares the
proxy's address.

## GitHub

**Webhook deliveries fail with `401 invalid signature`.** `GITHUB_WEBHOOK_SECRET` does not match the App's webhook
secret. Set both to the same value, restart, and redeliver from the App's **Advanced** tab on GitHub.

**No deliveries arrive.** The App's webhook URL must be `APP_URL/api/webhooks/github` and reachable from GitHub (not
`localhost`, not behind a firewall). GitHub's **Advanced** tab shows each attempt and its response.

**`429` responses to webhooks.** One installation sent more than `WEBHOOK_RATE_LIMIT_PER_MINUTE` deliveries in a
minute. GitHub does not retry automatically; redeliver from GitHub or replay from **Activity** after raising the limit.

**Missing permissions.** **Settings → GitHub** lists installations missing a required permission (`metadata`,
`contents` read; `pull_requests`, `issues` write). Add the permission to the App, then the installation's owner must
accept it on GitHub (**Settings → Applications → Installed GitHub Apps**). Without `checks: read` reviews just have
no CI context.

**"That GitHub installation is already connected to another organization".** One installation belongs to one
OpenReview org. Uninstall the App from that GitHub account (OpenReview removes the installation when GitHub reports it
deleted), then install it again from the organization that should own it.

**Reviews do not appear on a pull request.** Look at the review run in **Reviews**: `skipped` runs show why (draft,
branch filters, reviews disabled for the repository, archived, usage limit, installation suspended). A repository must
be indexed before its first review; see the next section.

**GitHub rate limits.** Jobs that hit a GitHub rate limit wait for the reset instead of failing; the run shows
`waiting …`. Large installations indexing many repositories at once can take a while.

## Indexing

**A repository stays `pending` or `indexing`.** The worker must be running (`worker` in `/api/health` should be
`ok`). The repository's page shows the index job's phase and progress. Indexing a repository is serialized by a
database lock, so a second run waits for the first. A run interrupted by a worker crash is marked failed when the next
run of that repository starts; **Full re-index** from the repository menu starts one. **Cancel indexing** stops a
running job.

**Indexing fails with an embedding error.** Indexing embeds every symbol and documentation chunk. Configure a working
embedding endpoint (`EMBEDDING_API_KEY` for the default OpenAI provider, or `EMBEDDING_PROVIDER=openai-compatible` with
`EMBEDDING_BASE_URL` and `EMBEDDING_MODEL`); see [models](models.md#embeddings).

**Files are missing from the index.** Generated, vendored, binary, lock, secret, and files over
`INDEX_MAX_FILE_BYTES` are skipped by design; each index job records how many files it skipped and why.

**Disk fills up.** Checkouts live in `REPO_CACHE_DIR` (the `repocache` volume). It is a cache: remove the volume while
the worker is stopped, and checkouts are fetched again.

## Models

**Reviews fail with "Every review model call failed".** The review log line has the provider's error. Common causes:
missing or wrong key (`LLM_API_KEY` / `ANTHROPIC_API_KEY`), a model id the provider does not know (`LLM_MODEL`,
`LLM_MODEL_<TASK>`), `LLM_BASE_URL` not reachable from the container, or (with `OUTBOUND_ALLOWLIST_ENFORCE=true`) a
host that is not allowed (`outbound request blocked by the allowlist`). An organization with its own provider can use
**Test connection** in **Settings → Model provider**.

**Timeouts on deep reviews or slow self-hosted models.** Raise `LLM_TIMEOUT_MS` or lower
`LLM_MIN_OUTPUT_TOKENS_PER_SEC` so slow generations are allowed to finish; use the fast mode for very large changes.

**`429` / `529` from the provider.** Calls are retried with backoff (`LLM_MAX_RETRIES`); persistent rate limits mean the
provider's limits are lower than your volume. Lower `WORKER_CONCURRENCY`, or use the fast mode by default.

**"the organization's model provider settings could not be read".** The stored key cannot be decrypted, usually
because `ENCRYPTION_KEY` (or `APP_SECRET` without it) changed. Save the organization's model settings again.

**Malformed output from a self-hosted model.** Structured output is validated; a model that cannot follow JSON
schemas fails those calls. Use a stronger model for `review` and `verify` (`LLM_MODEL_REVIEW`, `LLM_MODEL_VERIFY`).

## API, CLI, and MCP

**`401` from the API.** The key is wrong, revoked, or expired; create a new one under **Settings → API keys**.
**`403`** means the key lacks the route's scope (the message names it). **`429`** means more than
`API_RATE_LIMIT_PER_MINUTE` requests a minute for that key; wait for `retry-after`.

**`openreview review` says the repository is not connected or not indexed.** The `origin` remote must match a
repository connected in the dashboard, and indexing must have finished. Use `--local` to review without the server.

**CLI review times out (`504`).** Server reviews may run for `LOCAL_REVIEW_TIMEOUT_MS`. Use `--mode fast` or review a
smaller change; behind a proxy, allow requests at least that long.
