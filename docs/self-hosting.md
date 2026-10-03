# Self-hosting: enterprise features and offline operation

This page covers the parts of a self-hosted OpenReview install that larger teams need: single sign-on, the audit log,
bring-your-own model provider per organization, and running with no outbound traffic except the LLM and git host.
Every variable mentioned here is listed, with its default, in `.env.example`.

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

It turns enforcement on, keeps Next.js telemetry off (`NEXT_TELEMETRY_DISABLED=1`, also set in the image), and puts
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
