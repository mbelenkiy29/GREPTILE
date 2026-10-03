# Database

OpenReview stores everything durable in PostgreSQL 16 with the `vector` extension (pgvector). The schema is defined
with Drizzle in [`lib/db/schema.ts`](../lib/db/schema.ts); migrations are generated into [`drizzle/`](../drizzle) and
applied when the web app starts (`RUN_MIGRATIONS=true`) or with `pnpm db:migrate`. SQL Drizzle cannot express lives in
custom migrations: `0000_extensions.sql` (`CREATE EXTENSION vector`), `0002_symbol_embedding_index.sql` and
`0011_chunk_embedding_index.sql` (HNSW cosine indexes on the embedding columns), and two backfills (`0008`, `0017`).

## Tenant scoping

Every tenant-owned table has an `org_id` column, and every query filters by it with `scoped(table, orgId, …)`
(`lib/data/tenant.ts`); the org comes from the session or the API key. Most tables reference `orgs.id` (directly or
through `repos`) with `ON DELETE CASCADE`, so deleting an organization deletes its data; `deleteOrg` also removes the
org's rows from the few tables without a foreign key to `orgs` (`usage_events`, `model_calls`, `llm_response_cache`).
In the tables below, **Tenant** says how a table is scoped.

Not tenant-owned, by design: `users`, `auth_accounts`, `sessions` (people, who can belong to several orgs),
`pending_installations` (installations no org has claimed yet), and `embedding_cache` (vectors only, keyed by model and
content hash, shared across orgs).

## Retention and pruning

| What | When | By |
| --- | --- | --- |
| `webhook_deliveries` older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (30) | hourly | worker (`pruneDeliveries`) |
| `local_pull_requests` | Pull requests on the development-only local git host (`DEMO_MODE`, R6.22). | `org_id`, `repo_id`, `number`, `title`, `author`, `base_ref`, `head_ref`, `base_sha`, `head_sha`, `state` | `org_id` | unique (`repo_id`, `number`); `org_id` |
| `local_comments` | Conversation comments, inline review comments (threaded through `in_reply_to`), and reviews on a local pull request. | `org_id`, `pull_request_id`, `kind`, `body`, `author`, `path`, `line`, `in_reply_to`, `review_id`, `state`, `reactions` | `org_id` | (`pull_request_id`, `kind`); `org_id` |
| `audit_log` older than `AUDIT_RETENTION_DAYS` (365) | hourly | worker (`pruneAudit`) |
| `demo_reviews` and demo repositories (with their index) older than `DEMO_RETENTION_HOURS` (24) | hourly | worker (`purgeDemoData`) |
| Expired `sessions` | on every sign-in, in batches | `pruneExpiredSessions` |
| `cli_sessions` that expired more than a day ago | when a new CLI login starts | `startDeviceLogin` |
| Expired `sso_saml_requests` | when a SAML request is stored | the SAML request store |
| Expired `llm_response_cache` rows | at most every 10 minutes while the cache is written | `PostgresResponseCache.prune` |
| `embedding_cache` rows older than `EMBEDDING_CACHE_TTL_DAYS` (90) | at most every 10 minutes while embeddings are written | `CachedEmbeddings.prune` |
| Index rows of a removed file or repository | on re-index / repository removal | cascades from `files` / `repos` |

Everything else (reviews, findings, feedback, usage, model calls) is kept until the organization or repository is
deleted. Back up the database with [`deploy/backup.sh`](../deploy/backup.sh) (see [self-hosting](self-hosting.md)).

## Organizations, people, and access

| Table | Purpose | Key columns | Tenant | Indexes |
| --- | --- | --- | --- | --- |
| `orgs` | An organization (workspace). Every user has one personal workspace. | `id` (`org_…`), `slug`, `personal`, `settings` (org-wide review defaults), `onboarding_completed_at`, `created_by` | is the tenant | unique `slug`; unique personal workspace per creator |
| `users` | A person who signs in. | `id` (`usr_…`), `email` (verified, lowercased), `github_id`, `github_login` | global | unique `github_id`; `email`; `github_login` |
| `auth_accounts` | A linked identity: `github`, `oidc`, `saml`, or `dev`. GitHub user tokens are encrypted. | `user_id`, `provider`, `provider_account_id`, `access_token_enc` | global (per user) | unique (`provider`, `provider_account_id`) |
| `sessions` | A signed-in browser; `id` is the SHA-256 of the cookie token. | `user_id`, `active_org_id`, `expires_at`, `sso_org_ids` | global (per user) | `user_id`; `expires_at` |
| `memberships` | A user's role in an org. | `org_id`, `user_id`, `role` (`owner`, `admin`, `member`) | `org_id` | unique (`org_id`, `user_id`) |
| `invitations` | Invitation links (only the token hash is stored), optionally limited to an email or GitHub login, valid 7 days. | `org_id`, `email`, `github_login`, `role`, `token_hash`, `expires_at`, `accepted_at`, `revoked_at` | `org_id` | unique `token_hash`; `org_id`; `email`; `github_login` |
| `api_keys` | REST API / MCP / CLI keys (`or_live_…`); only the SHA-256 is stored. | `org_id`, `prefix`, `token_hash`, `scopes`, `expires_at`, `revoked_at` | `org_id` | unique `token_hash`; (`org_id`, `created_at`) |
| `cli_sessions` | `openreview login` device-code logins; the device code is stored hashed. | `device_code_hash`, `user_code`, `org_id`, `user_id`, `status`, `api_key_id`, `expires_at` | `org_id` once approved | unique `device_code_hash`; unique `user_code`; `expires_at` |
| `sso_connections` | An org's OIDC or SAML connection; the OIDC client secret is encrypted. | `org_id`, `protocol`, `issuer`, `client_id`, `client_secret_enc`, `saml_certificates`, `allowed_domains`, `default_role`, `enforce` | `org_id` | `org_id` |
| `sso_saml_requests` | Outstanding SAML requests, single use, for `InResponseTo` checks. | `id`, `org_id`, `connection_id`, `expires_at` | `org_id` | `expires_at` |
| `audit_log` | Who did what, to which object, from where. | `org_id`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `metadata`, `ip` | `org_id` | (`org_id`, `created_at`) |

## Git hosts and repositories

| Table | Purpose | Key columns | Tenant | Indexes |
| --- | --- | --- | --- | --- |
| `installations` | A GitHub App installation, or the stand-in for a GitLab / Bitbucket connection, owned by one org. | `org_id`, `provider`, `external_id`, `account_login`, `permissions`, `missing_permissions`, `suspended`, `scm_credential_id` | `org_id` | unique (`provider`, `external_id`); `org_id` |
| `pending_installations` | GitHub installations created on GitHub but not yet claimed by an org (from the `installation.created` webhook). | `provider`, `external_id`, `account_login`, `sender_login`, `permissions` | none until claimed | unique (`provider`, `external_id`) |
| `scm_credentials` | A GitLab or Bitbucket Cloud connection; the token is encrypted. | `org_id`, `provider`, `base_url`, `token_enc`, `scopes`, `missing_scopes`, `last_checked_at`, `last_error` | `org_id` | `org_id` |
| `scm_webhooks` | The webhook OpenReview created on a GitLab project or Bitbucket repository, with its random secret (hashed and encrypted). | `org_id`, `repo_id`, `credential_id`, `external_hook_id`, `secret_hash`, `secret_enc` | `org_id` | unique `repo_id`; unique `secret_hash`; (`provider`, `external_hook_id`); `org_id` |
| `repos` | A repository: enabled state, index status, review settings. | `org_id`, `installation_id`, `external_id`, `full_name`, `default_branch`, `enabled`, `archived`, `index_status`, `indexed_sha`, `settings` | `org_id` | unique (`installation_id`, `external_id`); `org_id` |
| `webhook_deliveries` | Every verified webhook delivery and its outcome; failed ones keep a redacted payload for replay. | `delivery_id`, `provider`, `event`, `org_id`, `status`, `reason`, `jobs`, `error`, `payload` | `org_id` (null until the installation is linked) | (`org_id`, `received_at`); (`status`, `received_at`) |

## Code index

| Table | Purpose | Key columns | Tenant | Indexes |
| --- | --- | --- | --- | --- |
| `index_jobs` | One index run: kind, trigger, status, progress, changed files. | `org_id`, `repo_id`, `kind`, `trigger`, `status`, `progress`, `from_sha`, `to_sha` | `org_id` | (`org_id`, `repo_id`, `id`); (`repo_id`, `queue_job_id`) |
| `files` | Indexed files at the indexed commit, with language and classification tags. | `org_id`, `repo_id`, `path`, `language`, `content_hash`, `tags` | `org_id` | unique (`repo_id`, `path`); GIN on `tags`; `org_id` |
| `symbols` | Functions, classes, types, routes, tables, tests, CI jobs, ... with source and embedding. | `org_id`, `repo_id`, `file_id`, `name`, `kind`, `qualified_name`, `start_line`, `end_line`, `embedding` | `org_id` | (`repo_id`, `name`); (`repo_id`, `kind`); (`repo_id`, `qualified_name`); `file_id`; `org_id`; HNSW on `embedding` |
| `edges` | The code graph: call, import, export, reference, extends, implements, depends_on, tested_by, route_handler, schema_consumer. | `org_id`, `repo_id`, `kind`, `from_file_id`, `from_symbol_id`, `target_name`, `to_file_id`, `to_symbol_id` | `org_id` | (`repo_id`, `kind`, `to_symbol_id`); (`repo_id`, `kind`, `to_file_id`); (`repo_id`, `kind`, `from_file_id`); (`repo_id`, `target_name`); `from_symbol_id`; `org_id` |
| `file_chunks` | Retrieval chunks (code, doc, config) with a generated `tsvector`; doc chunks are embedded. | `org_id`, `repo_id`, `file_id`, `path`, `kind`, `content`, `tsv`, `embedding` | `org_id` | GIN on `tsv`; (`repo_id`, `path`); `file_id`; `org_id`; HNSW on `embedding` |
| `repo_dependencies` | Dependencies declared in package manifests. | `org_id`, `repo_id`, `manifest_path`, `ecosystem`, `name`, `version_spec`, `kind` | `org_id` | unique (`repo_id`, `manifest_path`, `ecosystem`, `name`, `kind`); (`repo_id`, `name`); `org_id` |
| `repo_commits` | Recent commits of the indexed branch and the paths they touched. | `org_id`, `repo_id`, `sha`, `message`, `author`, `committed_at`, `changed_paths` | `org_id` | unique (`repo_id`, `sha`); (`repo_id`, `committed_at`); GIN on `changed_paths`; `org_id` |
| `knowledge_entries` | Knowledge base: one entry per subsystem, generated and refreshed from the index, editable. | `org_id`, `repo_id`, `slug`, `title`, `kind`, `description`, `related_files`, `risks`, `stale`, `source`, `proposed_description` | `org_id` | unique (`repo_id`, `slug`); (`org_id`, `repo_id`) |
| `knowledge_runs` | One knowledge refresh: trigger, what was stale and regenerated, usage, skip reason. | `org_id`, `repo_id`, `trigger`, `status`, `generated`, `remaining`, `cost_usd` | `org_id` | (`org_id`, `repo_id`, `id`); unique running run per `repo_id` |

## Reviews and findings

| Table | Purpose | Key columns | Tenant | Indexes |
| --- | --- | --- | --- | --- |
| `pull_requests` | A pull request as last ingested by a review run. | `org_id`, `repo_id`, `number`, `state`, `draft`, `base_sha`, `head_sha`, `last_reviewed_sha` | `org_id` | unique (`repo_id`, `number`); `org_id` |
| `pull_request_commits` | Commits of a pull request. | `org_id`, `pull_request_id`, `sha`, `message`, `author` | `org_id` | unique (`pull_request_id`, `sha`); `org_id` |
| `reviews` | One row per pull request, aggregating its runs (status, risk, summary, counts, cost). | `org_id`, `repo_id`, `pr_number`, `status`, `summary_comment_id`, `last_run_id`, `open_findings`, `cost_usd` | `org_id` | unique (`repo_id`, `pr_number`); (`org_id`, `created_at`); (`org_id`, `updated_at`) |
| `review_runs` | One review attempt: state machine position, stage timings, classification, context stats, models, tokens, cost, credits. | `org_id`, `review_id`, `trigger`, `mode`, `status`, `heartbeat_at`, `stage_timings`, `cost_usd`, `credits` | `org_id` | (`org_id`, `queued_at`); `review_id`; `status` |
| `agent_runs` | Each specialized agent's work in a run. | `org_id`, `review_run_id`, `agent`, `status`, `model`, `candidates`, `accepted`, `cost_usd` | `org_id` | `review_run_id`; `org_id` |
| `findings` | Structured findings tracked across commits, including rejected and held-back candidates with reasons. | `org_id`, `repo_id`, `review_id`, `fingerprint`, `severity`, `confidence`, `category`, `path`, `start_line`, `evidence`, `verification`, `visibility`, `status` | `org_id` | unique (`review_id`, `fingerprint`); (`org_id`, `status`, `severity`); (`repo_id`, `created_at`); (`org_id`, `created_at`) |
| `review_comments` | Inline comments posted to a pull request. | `org_id`, `review_id`, `path`, `line`, `fingerprint`, `external_id`, `finding_id` | `org_id` | unique (`review_id`, `fingerprint`); `org_id` |
| `runtime_validations` | Runtime validation result of a review run (install and test commands in a container). | `org_id`, `review_run_id`, `status`, `image`, `failed_step`, `exit_code`, `output_excerpt`, `failing_tests` | `org_id` | unique `review_run_id`; `org_id` |
| `mention_replies` | Answers to `@openreview` mentions, one per source comment. | `org_id`, `repo_id`, `pr_number`, `source_kind`, `source_comment_id`, `reply_comment_id` | `org_id` | unique (`repo_id`, `source_kind`, `source_comment_id`) |
| `conversations` | A follow-up thread with OpenReview on a pull request (inline thread or PR conversation). | `org_id`, `repo_id`, `pr_number`, `finding_id`, `kind`, `external_thread_id` | `org_id` | unique (`repo_id`, `kind`, `external_thread_id`); (`org_id`, `repo_id`, `pr_number`) |
| `conversation_messages` | Messages in a conversation (`user` or `assistant`), with the detected intent. | `org_id`, `conversation_id`, `role`, `author`, `body`, `intent` | `org_id` | unique (`conversation_id`, `role`, `external_comment_id`); (`conversation_id`, `created_at`); `org_id` |
| `demo_reviews` | Public demo reviews, owned by the system org `org_demo`; the client address is stored only as a keyed hash. | `id` (unguessable), `org_id`, `owner`, `repo`, `pr_number`, `status`, `client_key`, `pow_nonce`, `result` | `org_id` (`org_demo`) | unique `pow_nonce`; (`client_key`, `created_at`); `created_at`; `org_id` |

## Rules and learning

| Table | Purpose | Key columns | Tenant | Indexes |
| --- | --- | --- | --- | --- |
| `rules` | Plain-English review rules, org-wide or per repository, optionally path-limited; mined candidates await approval. | `org_id`, `repo_id`, `title`, `text`, `category`, `severity`, `paths`, `status`, `source`, `evidence` | `org_id` | (`org_id`, `status`); `repo_id` |
| `learned_patterns` | Learned preferences: suppress / boost patterns and per-category confidence adjustments. | `org_id`, `repo_id`, `kind`, `scope`, `category`, `signal`, `confidence_delta`, `evidence_count`, `user_edited` | `org_id` | (`org_id`, `repo_id`); unique category preference per (`repo_id`, `category`) |
| `finding_feedback` | Feedback on a finding from the dashboard, API, MCP, CLI, or GitHub reactions, replies, and commands. | `org_id`, `finding_id`, `user_id`, `external_author`, `source`, `kind`, `pattern_id`, `counts_for_learning` | `org_id` | unique per external reaction/comment; unique vote per user and kind; (`org_id`, `created_at`); `finding_id` |
| `comment_feedback` | Raw ledger of reactions and replies on OpenReview's inline comments. | `org_id`, `review_comment_id`, `kind`, `external_id`, `author`, `sentiment` | `org_id` | unique (`review_comment_id`, `kind`, `external_id`); `org_id` |
| `human_review_comments` | Teammates' inline review comments, mined into candidate rules. | `org_id`, `repo_id`, `pr_number`, `external_id`, `author`, `body`, `mined_at` | `org_id` | unique (`repo_id`, `external_id`); (`org_id`, `repo_id`, `mined_at`) |

## Models and usage

| Table | Purpose | Key columns | Tenant | Indexes |
| --- | --- | --- | --- | --- |
| `model_calls` | One row per logical model call: task, provider, model, tokens, latency, estimated cost, outcome. | `org_id`, `repo_id`, `review_run_id`, `task`, `mode`, `provider`, `model`, `cost_usd`, `status`, `attempts` | `org_id` (null for calls without one) | (`org_id`, `created_at`); `review_run_id` |
| `embedding_cache` | Embedding vectors by model and content hash (no text), shared across orgs. | `model`, `content_hash`, `dims`, `embedding` | global | primary key (`model`, `content_hash`) |
| `llm_response_cache` | Opt-in cache of deterministic model responses, per org. | `key`, `org_id`, `kind`, `response`, `expires_at` | `org_id` | `expires_at`; `org_id` |
| `org_llm_settings` | An org's own model provider; the API key is encrypted. | `org_id`, `provider`, `base_url`, `api_key_enc`, `model`, `task_models` | `org_id` (primary key) | primary key `org_id` |
| `usage_events` | Metered usage: one row per unit of work, `kind` = `review` (pull request and CLI reviews), `index`, `chat`, `knowledge`, `embedding`, or `eval`. | `org_id`, `repo_id`, `review_run_id`, `author`, `kind`, `trigger`, `credits`, `cost_usd` | `org_id` | (`org_id`, `created_at`) |
| `usage_settings` | Monthly credit and cost caps, alert thresholds, and an alert webhook (secret encrypted). | `org_id`, `monthly_credit_cap`, `monthly_cost_cap_usd`, `alert_thresholds`, `alert_webhook_url` | `org_id` (primary key) | primary key `org_id` |
| `usage_alerts` | Alerts that fired, at most once per org, period, metric, and threshold. | `org_id`, `period_start`, `metric`, `threshold`, `delivered_at`, `error` | `org_id` | unique (`org_id`, `period_start`, `metric`, `threshold`); (`org_id`, `created_at`) |
| `usage_limit_notices` | One-time pull request comments explaining a review skipped by a usage limit. | `org_id`, `repo_id`, `pr_number`, `reason`, `period_start`, `comment_id` | `org_id` | unique (`org_id`, `repo_id`, `pr_number`, `reason`, `period_start`) |
| `billing_accounts` | Stripe billing state per org, mirrored from Stripe webhooks (only with billing configured). | `org_id`, `stripe_customer_id`, `stripe_subscription_id`, `plan`, `status`, `seats`, `current_period_start`, `current_period_end` | `org_id` (primary key) | unique `stripe_customer_id` |
| `billing_events` | Processed Stripe webhook events, so each is applied once. | `id` (Stripe event id), `org_id`, `type`, `outcome` | `org_id` | (`org_id`, `created_at`) |
| `billing_usage_reports` | Overage credits already reported to Stripe per period, so reporting sends only the delta. | `org_id`, `period_start`, `reported_credits` | `org_id` | primary key (`org_id`, `period_start`) |
