# Security policy

## Reporting a vulnerability

Please report security problems privately, not in public issues: use GitHub's **Report a vulnerability** button on
the repository's Security tab (private security advisories). Include what you found, how to reproduce it, and the
version or commit you tested. We acknowledge reports within three working days, keep you informed while we fix the
problem, and credit you in the advisory unless you prefer otherwise. Please give us a reasonable time to release a fix
before disclosing.

## Supported versions

OpenReview is released from `main`. Security fixes go into the latest release; self-hosters should track it. Older
releases are not patched.

| Version | Supported |
| --- | --- |
| Latest release / `main` | Yes |
| Anything older | No |

## Architecture and trust boundaries

```
 Browser ──(session cookie)──▶  Web app (Next.js) ──▶ Postgres (pgvector), Redis
 Git host ──(signed webhooks)──▶       │                     ▲
 API / CLI / MCP ──(API keys)──▶       │                     │
                                        └──── jobs ─────▶ Worker ──▶ LLM endpoint(s), git host
```

| Boundary | What crosses it | Controls |
| --- | --- | --- |
| Browser → web app | Session cookies, forms | Database-backed sessions (only the token's SHA-256 is stored), `HttpOnly` / `SameSite=Lax` / `Secure` cookies, same-origin checks on cookie-authenticated mutations (`lib/security/csrf.ts`), server-side role checks on every action, CSP and framing headers on every response (`lib/security/headers.ts`) |
| Sign-in | GitHub OAuth, OIDC, SAML | OAuth state + PKCE in a signed short-lived cookie; OIDC ID tokens verified (JWKS signature, issuer, audience, nonce, expiry, verified email); SAML assertions must be signed, addressed to us, from the configured IdP, in their validity window, and answer a request we issued (single use); allowed email domains; IdP-asserted emails are trusted only inside the IdP's organization; rate limits per client address |
| Git host → webhook receiver | Event payloads | HMAC signature verification before parsing, delivery dedupe, per-installation rate limit |
| API / CLI / MCP → API | API keys | Keys stored as SHA-256, scoped, revocable, expiring; per-key rate limits; every write audited |
| Tenants | All org data | Every tenant table carries `org_id`; every query is scoped by the org from the session or key, never from the request |
| Server → outside | LLM, git host, SSO, billing | One allowlisted fetch (`lib/net/fetch.ts`, enforced with `OUTBOUND_ALLOWLIST_ENFORCE=true`); user-supplied URLs (org model endpoints, SSO issuers) pass an SSRF guard that refuses private, loopback, link-local, and metadata addresses after DNS resolution, and SSO requests never follow redirects |
| Secrets at rest | Org LLM keys, SSO client secrets, GitHub user tokens | AES-256-GCM (`lib/crypto.ts`) with `ENCRYPTION_KEY` (or a key derived from `APP_SECRET`); never returned to the UI after saving, never logged (`lib/log.ts` redacts token-shaped strings and secret-named fields) |

Error pages and API errors never include stack traces or internal messages; details go to the structured server log
with a correlation id.

## Prompt injection (H7)

Repository content, pull request titles and bodies, comments, and review replies are untrusted. They are always passed
to models inside delimited data blocks, after the system instructions, and prompts state that delimited content is data
that cannot change instructions, rules, or settings. Model output is validated against schemas before use; findings
are verified against the code before they are published; commands in comments (re-review, ignore pattern) are honored
only from repository collaborators. Settings and rules come from the dashboard and `openreview.json` on the base
branch, never from pull request text.

## Dependencies

CI runs `pnpm deps:audit` (`pnpm audit --prod --audit-level=high`) on every push and pull request, and Dependabot
opens weekly update pull requests for npm packages, GitHub Actions, and the Docker base image.
