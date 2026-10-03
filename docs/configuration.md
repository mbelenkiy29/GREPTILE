# Configuration reference

OpenReview is configured with environment variables. [`.env.example`](../.env.example) lists every one of them with a
short comment; copy it to `.env` and fill in what you need. This page explains each variable: its default, and what it
changes. Server variables are validated with zod in [`lib/env.ts`](../lib/env.ts); a missing or malformed required
variable stops the process with a message that names it.

Where the variables are read:

- **Docker Compose** passes `.env` to the `app` and `worker` containers (`env_file`) and also uses it to fill in
  `${…}` references in the compose files. Inside the containers, `DATABASE_URL`, `REDIS_URL`, `NODE_ENV=production`,
  and (worker) `REPO_CACHE_DIR=/data/repos` are set by `docker-compose.yml` and override `.env`.
- **Local development**: `pnpm dev` (Next.js) reads `.env` itself; `pnpm worker` and `pnpm db:migrate` load it with
  Node's `--env-file-if-exists=.env`.
- Changing a variable needs a restart of the processes that read it (`docker compose up -d` recreates containers whose
  configuration changed).

The `openreview` CLI's own variables (`OPENREVIEW_URL`, `OPENREVIEW_TOKEN`, and the local-mode model variables) are
described in [`packages/cli/README.md`](../packages/cli/README.md#environment-variables).

## Minimum for a working server

| Needed for | Variables |
| --- | --- |
| Starting at all | `APP_SECRET`, `DATABASE_URL`, `REDIS_URL` (Compose sets the last two) |
| GitHub reviews (web app webhooks and the worker) | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` (create them with [`/setup/github-app`](github-app.md)) |
| Sign in with GitHub | `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` |
| Reviews, chat, knowledge base | a model: `ANTHROPIC_API_KEY` or `LLM_API_KEY` with the default Anthropic provider, or `LLM_PROVIDER` + `LLM_MODEL` (+ `LLM_BASE_URL`, `LLM_API_KEY`), see [models](models.md) |
| Indexing (every repository is embedded) | a working embedding endpoint: `EMBEDDING_API_KEY` with the default `openai` provider, or `EMBEDDING_PROVIDER=openai-compatible` + `EMBEDDING_BASE_URL` + `EMBEDDING_MODEL` |
| Correct links, cookies, and webhook URLs | `APP_URL` set to the public address (https in production) |

The web app starts and serves `/api/health`, `/sign-in`, and `/setup/github-app` without the GitHub App variables, so a
fresh install can create its App first. The worker exits at start until they are set (Compose restarts it).

## Runtime

| Variable | Default | Effect |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production`. Production refuses `AUTH_DEV_LOGIN`, always marks cookies `Secure`, and sends HSTS. The Compose services always run with `production`. |
| `APP_URL` | `http://localhost:3000` | Public origin of the web app. Used for redirects, OAuth and SSO callback URLs, the GitHub App manifest (webhook, callback, setup URLs), the same-origin check on cookie-authenticated requests, and `Secure` cookies when it is https. |
| `APP_SECRET` | none (required, at least 16 characters) | Signs the GitHub install `state`, OAuth state cookies, and the setup flow's state; derives the encryption key when `ENCRYPTION_KEY` is empty. Generate with `openssl rand -base64 32`. Changing it invalidates sign-in and install flows in progress and, without `ENCRYPTION_KEY`, makes stored secrets unreadable. |
| `ENCRYPTION_KEY` | derived from `APP_SECRET` | 32 random bytes, base64 (`openssl rand -base64 32`). AES-256-GCM key for secrets at rest: organizations' model API keys, SSO client secrets, GitLab/Bitbucket tokens, usage-alert signing secrets, GitHub user tokens. Set it once and keep it; secrets saved under another key must be entered again. |
| `LOG_LEVEL` | `info` (`warn` in tests) | `debug`, `info`, `warn`, or `error`. Logs are JSON lines (warnings and errors on stderr, the rest on stdout) with correlation ids; secrets are redacted. |
| `SOURCE_CODE_URL` | `https://github.com/openreview/openreview` | Where the running version's source is published; linked from the dashboard footer (AGPL-3.0 section 13). Point it at your fork if you modify OpenReview. |

## PostgreSQL and Redis

| Variable | Default | Effect |
| --- | --- | --- |
| `POSTGRES_USER` | `openreview` | Docker Compose only: the database user the `postgres` container creates and the app connects as. |
| `POSTGRES_PASSWORD` | `openreview` in Compose (`.env.example` says `change-me`) | Docker Compose only: that user's password. Set it before the first `docker compose up`; the volume keeps the first value. |
| `POSTGRES_DB` | `openreview` | Docker Compose only: the database name. |
| `DATABASE_URL` | none (required) | PostgreSQL 16 with the `vector` extension. Compose sets it to the `postgres` service; for local development point it at your own server. |
| `REDIS_URL` | none (required) | Redis for the BullMQ job queue, rate limits, and worker heartbeats. Compose sets it to the `redis` service. |
| `RUN_MIGRATIONS` | `true` | Apply pending database migrations when the web app starts (`instrumentation.ts`). Set to `false` to run `pnpm db:migrate` yourself. |

## Sign-in and administration

| Variable | Default | Effect |
| --- | --- | --- |
| `SESSION_TTL_DAYS` | `30` | Days a session stays valid (1–365); active sessions slide forward at most once an hour. |
| `AUTH_DEV_LOGIN` | `false` | Adds "Continue as local developer" to `/sign-in` for local development and end-to-end tests. Refused when `NODE_ENV=production`. |
| `INSTANCE_ADMIN_EMAILS` | empty | Comma-separated emails (case-insensitive) of instance administrators, who may use `/setup/github-app` once a GitHub App is configured. Empty means the first user who signed in. Before any App is configured and before anyone has signed in, the setup page is open so a fresh install can create its App. |

## GitHub

| Variable | Default | Effect |
| --- | --- | --- |
| `GITHUB_APP_ID` | none (required by the worker and webhook receiver) | The GitHub App's numeric id. |
| `GITHUB_APP_SLUG` | none (required) | The App's URL name; the install button opens `GITHUB_WEB_URL/apps/<slug>/installations/new`. |
| `GITHUB_APP_PRIVATE_KEY` | none (required) | The App's private key (PEM). Literal `\n` escapes are accepted, so it fits on one line. |
| `GITHUB_WEBHOOK_SECRET` | none (required) | Secret GitHub signs webhook deliveries with (`X-Hub-Signature-256`); deliveries with a wrong signature get `401`. |
| `GITHUB_API_URL` | `https://api.github.com` | REST API base. GitHub Enterprise Server: `https://ghe.example.com/api/v3`. |
| `GITHUB_WEB_URL` | `https://github.com` | Web origin for OAuth, install pages, and links. GitHub Enterprise Server: `https://ghe.example.com`. |
| `GITHUB_APP_CLIENT_ID` | empty | The App's OAuth client id, for "Sign in with GitHub". Without it the sign-in page offers SSO (and dev login) only. |
| `GITHUB_APP_CLIENT_SECRET` | empty | The App's OAuth client secret. |
| `BOT_MENTION` | `openreview` | The name people `@mention` in pull request comments to ask questions or give commands. |

## GitLab and Bitbucket Cloud

| Variable | Default | Effect |
| --- | --- | --- |
| `GITLAB_URL` | `https://gitlab.com` | GitLab instance origin (self-managed: `https://gitlab.example.com`). See [GitLab](gitlab.md). |
| `BITBUCKET_API_URL` | `https://api.bitbucket.org/2.0` | Bitbucket Cloud REST API base. See [Bitbucket](bitbucket.md). |

## Models and embeddings

All model calls go through the gateway in `lib/llm`; [models](models.md) explains providers and routing.

| Variable | Default | Effect |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `openai`, `openrouter`, `openai-compatible`, or `fake` (an in-process stand-in for tests; never use it for real reviews). `openai` with a non-`api.openai.com` `LLM_BASE_URL` behaves as `openai-compatible`. |
| `LLM_MODEL` | built-in per-task routes for `anthropic` | Default model for every task. Required for `openai`, `openrouter`, and `openai-compatible` unless every task has its own `LLM_MODEL_<TASK>`. |
| `LLM_BASE_URL` | the provider's public API | Endpoint override; required for `openai-compatible` (for example `http://vllm:8000/v1` or `http://localhost:11434/v1`). |
| `LLM_API_KEY` | empty | API key for the provider. With `anthropic`, falls back to `ANTHROPIC_API_KEY`. Required for `openai` and `openrouter`. |
| `LLM_MODEL_REVIEW`, `LLM_MODEL_VERIFY`, `LLM_MODEL_SUMMARY`, `LLM_MODEL_CLASSIFY`, `LLM_MODEL_CONTEXT`, `LLM_MODEL_CHAT`, `LLM_MODEL_KNOWLEDGE`, `LLM_MODEL_RULES` | empty | Model for one task, overriding `LLM_MODEL`. Empty falls back to `LLM_MODEL`, then the built-in route. |
| `LLM_MODEL_FAST`, `LLM_MODEL_DEEP` | empty | Review and verify model for the fast and deep review modes (overrides `LLM_MODEL_REVIEW` / `LLM_MODEL_VERIFY` in that mode). |
| `LLM_TIMEOUT_MS` | `180000` | Per-attempt timeout. Calls are not streamed, so an attempt that may generate many tokens gets `max(LLM_TIMEOUT_MS, maxTokens / LLM_MIN_OUTPUT_TOKENS_PER_SEC)`. |
| `LLM_MIN_OUTPUT_TOKENS_PER_SEC` | `60` | Slowest output rate the timeout allows for; `0` uses `LLM_TIMEOUT_MS` only. |
| `LLM_MAX_RETRIES` | `3` | Retries for transient failures (429, 5xx, 529, timeouts, network errors), 0–10, with backoff. |
| `LLM_PRICING_JSON` | empty | Prices in USD per million tokens merged over the built-in table, e.g. `{"my-model": {"input": 1, "output": 2}}`. Calls to models without a price are recorded with an unknown cost. |
| `LLM_CACHE_TTL_HOURS` | `168` | Lifetime of entries in the opt-in model response cache. |
| `LLM_ALLOW_PRIVATE_ORG_ENDPOINTS` | `false` | Let organizations' own model endpoints use http and private, loopback, or link-local addresses. Off, they must be public https hosts (SSRF guard). |
| `EMBEDDING_PROVIDER` | `openai` | `openai`, `openai-compatible` (needs `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL`), or `fake` (tests). `openai` with a non-OpenAI base URL behaves as `openai-compatible`. Indexing fails if embedding calls fail. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` for `openai` | Embedding model; at most 1536 dimensions (smaller vectors are zero-padded). |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` for `openai` | Embedding endpoint. |
| `EMBEDDING_API_KEY` | empty | Key for the embedding endpoint. |
| `EMBEDDING_CACHE_TTL_DAYS` | `90` | Embedding cache rows older than this are re-embedded and pruned. The cache is keyed by model and the SHA-256 of the text and holds vectors only. |

## Indexing, knowledge base, and the worker

| Variable | Default | Effect |
| --- | --- | --- |
| `REPO_CACHE_DIR` | `/tmp/openreview-repos` | Where the worker keeps repository checkouts (Compose: `/data/repos` on the `repocache` volume). Safe to delete; it is refilled by fetching. |
| `INDEX_MAX_FILE_BYTES` | `524288` | Files larger than this are not indexed. |
| `KNOWLEDGE_ENABLED` | `true` | Generate subsystem notes after indexing and refresh them when their files change. `false`, `0`, `no`, or `off` turns it off. |
| `KNOWLEDGE_MAX_ENTRIES_PER_RUN` | `5` | Entries one refresh regenerates (1–12), one `knowledge` model call each; the rest are picked up by a follow-up run. |
| `WORKER_CONCURRENCY` | `4` | Jobs one worker process runs at once (1–64). |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | Webhook delivery records older than this are pruned hourly by the worker. |

## Reviews and credits

| Variable | Default | Effect |
| --- | --- | --- |
| `CREDITS_FAST`, `CREDITS_STANDARD`, `CREDITS_DEEP` | `1`, `2`, `4` | Credits one review consumes in each mode; usage limits and billing count credits. |
| `REVIEW_DEBOUNCE_MS` | `15000` | A push waits this long before its review starts, so a burst of pushes is reviewed once at the newest head (0–3600000). |
| `REVIEW_STALE_MS` | `600000` | A running review whose heartbeat is older than this is treated as abandoned (worker crash) and re-queued, at most three times (minimum 60000). |

## API and CLI

| Variable | Default | Effect |
| --- | --- | --- |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute per API key (and per signed-in user calling `/api/v1`); over it the API answers `429` with `retry-after`. MCP tool calls share this limit. |
| `LOCAL_REVIEW_TIMEOUT_MS` | `300000` | How long a CLI review against the server (`POST /api/v1/reviews/local`) may run before it is aborted (10000–900000). |

## Plans, usage limits, and billing

Billing is optional. It turns on only when all four `STRIPE_*` variables are set; otherwise every organization is on
the unlimited self-hosted plan and no Stripe API is ever called. Usage caps and alerts under **Settings → Usage &
billing** work either way.

| Variable | Default | Effect |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | empty | Stripe secret API key. |
| `STRIPE_WEBHOOK_SECRET` | empty | Signing secret of the Stripe webhook endpoint at `APP_URL/api/stripe/webhook` (events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`). |
| `STRIPE_PRICE_TEAM_SEAT` | empty | Price id of the team plan's recurring per-seat price. |
| `STRIPE_PRICE_OVERAGE` | empty | Price id of the metered overage price, attached to a billing meter (customer key `stripe_customer_id`, value key `value`); overage credits are reported hourly. |
| `FREE_MONTHLY_CREDITS` | `50` | Credits the free plan includes per billing period (billing on). |
| `TEAM_INCLUDED_CREDITS_PER_SEAT` | `200` | Credits the team plan includes per seat per period; usage beyond is billed as overage. |
| `TEAM_SEAT_PRICE_USD` | `24` | Display price on the billing and pricing pages; keep it equal to your Stripe price. |
| `OVERAGE_CREDIT_PRICE_USD` | `0.2` | Display price per overage credit. |
| `USAGE_ALERT_ALLOW_PRIVATE_URLS` | `false` | Let usage-alert webhooks target http and private addresses (SSRF guard off). |

## Enterprise and hardening

| Variable | Default | Effect |
| --- | --- | --- |
| `SSO_ALLOW_PRIVATE_ISSUERS` | `false` | Let SSO connections use http and private-network issuers and IdP endpoints (an internal Keycloak, for example). |
| `AUDIT_RETENTION_DAYS` | `365` | Audit log entries older than this are pruned hourly by the worker (1–3650). |
| `OUTBOUND_ALLOWLIST` | empty | Extra hosts server-side HTTP may reach, comma-separated; `*.example.com` matches subdomains. The model and embedding endpoints, git hosts, Stripe (when billing is on), and configured SSO issuers and org model endpoints are always allowed. |
| `OUTBOUND_ALLOWLIST_ENFORCE` | `false` | Refuse (and log) outbound HTTP to any other host. Off, such calls are allowed and logged once per host. |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `30` | Requests per minute one client address may make to each public sign-in, SSO, and invitation endpoint. |
| `WEBHOOK_RATE_LIMIT_PER_MINUTE` | `1200` | Webhook deliveries per minute accepted for one installation; over it the receiver answers `429`. |
| `NEXT_TELEMETRY_DISABLED` | `1` | Keeps Next.js anonymous telemetry off (also set in the Docker image). |

## Runtime validation (beta)

The worker can run a repository's install and test commands in a locked-down container and report failures in the
review. It runs only when `RUNTIME_VALIDATION_ENABLED=true` and the repository enables `runtimeValidation`.

| Variable | Default | Effect |
| --- | --- | --- |
| `RUNTIME_VALIDATION_ENABLED` | `false` | Master switch. |
| `SANDBOX_DOCKER_HOST` | empty | Docker Engine API the worker uses: `unix:///var/run/docker.sock` or `tcp://sandbox-host:2375` (plain HTTP; keep it on a private network). Use a separate sandbox host or rootless Docker; never mount the socket into the web container. |
| `SANDBOX_IMAGE` | `node:22-bookworm-slim` | Default image; a repository may choose another. |
| `SANDBOX_ALLOWED_IMAGES` | empty (any) | Comma-separated allowlist of images (`*` wildcards). |
| `SANDBOX_CPUS` | `2` | CPU limit per run. |
| `SANDBOX_MEMORY_MB` | `2048` | Memory limit per run (swap disabled). |
| `SANDBOX_WORKDIR_MB` | `2048` | Size of the in-memory work directory holding the checkout. |
| `SANDBOX_TIMEOUT_SEC` | `600` | Wall-clock limit per run. |
| `SANDBOX_MAX_OUTPUT_KB` | `256` | Captured output kept per run (head and tail). |
| `SANDBOX_REGISTRY_PROXY` | empty | HTTP(S) forward proxy that allows only package registries, for repositories that choose `"network": "install-only"`. Without it installs run offline. Never put credentials in it: the install step can read it. |
| `SANDBOX_INSTALL_NETWORK` | `openreview-sandbox-install` | Docker network (create it with `docker network create --internal`) on which only the registry proxy is reachable. |

## Public demo

A public "Paste a PR" page at `/try` reviews public GitHub pull requests in fast mode and never posts to GitHub. Serve
it only behind a reverse proxy that sets `X-Forwarded-For` (the last hop is trusted).

| Variable | Default | Effect |
| --- | --- | --- |
| `DEMO_ENABLED` | `false` | Turns the page and its job on. |
| `DEMO_PER_IP_PER_HOUR` | `3` | Submissions per hour per client address (IPv6: per /64). |
| `DEMO_GLOBAL_PER_HOUR` | `30` | Submissions per hour for everyone together. |
| `DEMO_POW_DIFFICULTY` | `18` | Proof-of-work difficulty in leading zero bits (8–28; each bit doubles the browser's work). |
| `DEMO_MAX_REPO_MB` | `50` | Largest repository (GitHub-reported size) the demo indexes. |
| `DEMO_MAX_PR_FILES` | `50` | Most changed files in a demo pull request. |
| `DEMO_MAX_PR_ADDITIONS` | `2000` | Most added lines in a demo pull request. |
| `DEMO_DAILY_COST_USD` | `5` | Estimated model spend per UTC day after which demo reviews are refused until the next day. |
| `DEMO_RETENTION_HOURS` | `24` | Demo results and indexes are deleted after this many hours. |
| `DEMO_GITHUB_TOKEN` | empty | Optional token (no scopes needed) for a higher GitHub API rate limit; used only to read public data. |

## Demo / local mode (development only)

A local git host for trying the full review loop without a GitHub App: bare repositories under `LOCAL_GIT_ROOT`, pull
requests and comments stored in Postgres (`local_pull_requests`, `local_comments`), shown at
`/dashboard/local/pr/<id>`. `pnpm demo` creates a demo org, indexes the fixture repository, opens a pull request with a
deliberate cross-file bug, and runs the real review pipeline. Do not enable it on a public server.

| Variable | Default | Effect |
| --- | --- | --- |
| `DEMO_MODE` | `false` | Registers the `local` git host. Refused when `NODE_ENV=production` unless `DEMO_MODE_ALLOW_PRODUCTION=true`. |
| `DEMO_MODE_ALLOW_PRODUCTION` | `false` | Allows `DEMO_MODE` under `NODE_ENV=production` (for a private, single-user evaluation box only). |
| `LOCAL_GIT_ROOT` | `/tmp/openreview-local-git` | Where the local host keeps its bare repositories (`<owner>/<name>.git`); the web app and the worker must share it. |

## Docker Compose and deployment

These are read by the compose files and `deploy/`, not by the application.

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_PORT` | `3000` | Host port the app is published on. `deploy/docker-compose.prod.yml` binds it to `127.0.0.1` only, behind Caddy. |
| `OPENREVIEW_DOMAIN` | none (required by the production override) | Public domain Caddy serves with automatic HTTPS. Point its DNS at the server and set `APP_URL=https://<domain>`. |
| `EXTRA_CA_CERT` | empty | PEM bundle trusted during `docker compose build`, only needed behind a TLS-intercepting proxy. |
