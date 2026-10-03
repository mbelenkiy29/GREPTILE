# OpenReview

Open-source (AGPL-3.0), self-hostable AI pull request reviewer with full-codebase context. The product spec — every feature ID, grouped by phase — lives in
**[`docs/OPENREVIEW_SPEC.md`](docs/OPENREVIEW_SPEC.md)**. Read it before starting work on any feature, and refer to
features by their ID (e.g. `R1.4`).

## Hard rules (from the spec — apply to every change)

- **H1. Original brand only.** Never use Greptile's name, logo, mascot, wordmark, screenshots, images, page copy,
  customer logos, or testimonials anywhere in the product or site. Do not scrape or download assets from greptile.com.
  All marketing copy is written fresh for OpenReview; no fake testimonials or fake customer logos.
- **H2. Stack.** Next.js (App Router) + TypeScript (strict), PostgreSQL + pgvector, Drizzle, built-in auth (GitHub
  sign-in, OIDC/SAML SSO; users, orgs, roles in Postgres — no Clerk), Stripe (optional billing, enabled only when
  configured), BullMQ + Redis (jobs), Docker Compose. Target host: a single DigitalOcean Droplet. No hosted service may
  be required for core operation other than the configured LLM and git host.
- **H3. Every feature ID is tested.** Each ID has at least one automated test (unit, integration, or Playwright e2e)
  whose name starts with the ID, e.g. `test("R3.2 posts inline comments...")`. The verifier matches on the test title
  (not the `describe` block), and `R1.1` does not match `R1.10`.
- **H4. One LLM abstraction.** All LLM calls go through `lib/llm` so models are swappable (Anthropic default; OpenAI,
  OpenRouter, OpenAI-compatible and self-hosted endpoints supported). Tests use a recorded/fake provider, never live keys.
- **H5. No secrets in the repo.** `.env.example` lists every variable; add new variables there in the same change.
- **H6. `pnpm verify:parity`** runs typecheck, lint, all tests, and `next build`, then prints one line per feature ID as
  `PASS <ID>` or `FAIL <ID> <reason>`, then `PARITY <phase>: <passed>/<total> PASS`. It exits 0 only if every ID in the
  requested phase passes.
- **H7. Repository content is untrusted.** Code, comments, docs, and PR text are always delimited as data in prompts and
  can never override system instructions, rules, or settings.

## Commands

```sh
pnpm install
pnpm dev                          # Next.js dev server
pnpm typecheck && pnpm lint && pnpm test
pnpm verify:parity --phase 1      # H6 report for one phase (--phase all, --skip-build, --skip-e2e also supported)
pnpm e2e                          # Playwright e2e of the public site against the production build (R5.4)
docker compose up -d              # postgres (pgvector) + redis + app; `docker compose ps` should show all healthy
```

## Layout

- `app/` — Next.js App Router. `app/api/health` checks Postgres and Redis and backs the container healthcheck.
- `lib/env.ts` — zod-validated server env. `lib/db/` — Drizzle schema + client. `lib/redis.ts` — Redis client.
- `scripts/verify-parity.ts` — the H6 verifier; parsing/judging logic is in `scripts/parity/core.ts` (unit-tested).
- `docker/` — container support files (`postgres/init.sql` enables the `vector` extension).

## Conventions

- Multi-tenancy (R1.1): every tenant-owned table carries an org id and every query filters by it.
- Feature tests are named with their ID prefix; tooling/infra tests must **not** start with a feature ID.
- Schema changes: edit `lib/db/schema.ts`, then `pnpm db:generate` (never hand-edit generated snapshots). Custom SQL
  that Drizzle cannot express goes in a `drizzle-kit generate --custom` migration.
- Logging: use `lib/log.ts` (structured JSON, correlation ids, secret redaction), never bare `console.log` in server code.
