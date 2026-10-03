# Contributing to OpenReview

Thanks for helping. This guide covers the development setup, the rules every change follows, and how to get a pull
request merged. By contributing you agree that your contributions are licensed under the project's license,
AGPL-3.0-only ([LICENSE](LICENSE)). Please follow the [code of conduct](CODE_OF_CONDUCT.md); report security problems
privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 22.9 or newer, pnpm 10 (`corepack enable` picks the version from `package.json`), git, and
Docker for PostgreSQL and Redis (or your own PostgreSQL 16 with pgvector and Redis 7).

```sh
pnpm install
cp .env.example .env
```

Start PostgreSQL (with pgvector) and Redis on localhost. The Compose services do not publish their ports, so for
development run them directly:

```sh
docker run -d --name openreview-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=openreview -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=openreview pgvector/pgvector:pg16
docker run -d --name openreview-redis -p 127.0.0.1:6379:6379 redis:7-alpine
```

In `.env`, set `APP_SECRET` (any 16+ characters), and for local sign-in `AUTH_DEV_LOGIN=true` (adds "Continue as
local developer" to `/sign-in`; refused in production). `DATABASE_URL` and `REDIS_URL` in `.env.example` already point
at localhost. Then:

```sh
pnpm db:migrate     # optional: `pnpm dev` also applies migrations on start
pnpm dev            # Next.js on http://localhost:3000
pnpm worker         # the job worker, in a second terminal (needs the GitHub App variables)
```

`pnpm dev` reads `.env` itself; `pnpm worker` and `pnpm db:migrate` load it with `--env-file-if-exists=.env`. Real
reviews need a GitHub App (create one with `/setup/github-app`, pointing at a tunnel to your machine, or use a test
App), a model key, and an embedding endpoint; `EMBEDDING_PROVIDER=fake` lets indexing run without an embedding key
(semantic search results are then meaningless). See [docs/configuration.md](docs/configuration.md).

Alternatively, run the whole stack in containers with `docker compose up -d --build` (see the [README](README.md)).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm worker` | The background worker |
| `pnpm typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) |
| `pnpm lint` | ESLint |
| `pnpm test` | The whole Vitest suite. Database tests run on PGlite (in-process Postgres with pgvector), so no server is needed. On a small machine: `pnpm test -- --maxWorkers=2` |
| `pnpm vitest run tests/r6.25-github-app-setup.test.ts` | One test file |
| `pnpm build` | Production build (`next build`) |
| `pnpm verify:parity --phase 1` | Runs typecheck, lint, tests, and the build, then prints `PASS <ID>` / `FAIL <ID> <reason>` per spec feature and `PARITY <phase>: <passed>/<total> PASS`; exits 0 only if every ID of the phase passes. `--phase all` and `--skip-build` are supported. |
| `pnpm db:generate` | Generate a migration from `lib/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `pnpm cli:build` | Build the `openreview` CLI into `packages/cli/dist` |
| `pnpm mcp:build` | Build the `openreview-mcp` package into `packages/mcp/dist` |
| `pnpm deps:audit` | `pnpm audit --prod --audit-level=high` (also run in CI) |
| `pnpm demo` | With `DEMO_MODE=true`: indexes `fixtures/demo-repo` on the local git host, opens a pull request with a cross-file bug, and runs the real review pipeline (`LLM_PROVIDER=fake` replays `fixtures/demo-repo/recorded/`; `--record` saves a new recording) |
| `pnpm eval` | Evaluation harness over `eval/cases` (precision, recall, latency, cost; reports in `eval/reports/`). `--provider fake --recorded` replays `eval/recordings/`; see [eval/README.md](eval/README.md) |

## Rules for every change

The product spec, with every feature ID grouped by phase, is [docs/OPENREVIEW_SPEC.md](docs/OPENREVIEW_SPEC.md). Read
it before working on a feature and refer to features by ID (for example `R1.4`). The hard rules:

- **Tests per feature ID (H3).** Each feature ID has at least one automated test whose *title* starts with the ID:
  `test("R3.2 posts inline comments ...", ...)`. The verifier matches test titles, not `describe` blocks, and `R1.1`
  does not match `R1.10`. Tooling and infrastructure tests must not start with a feature ID. Put feature tests in
  `tests/r<id>-<topic>.test.ts`.
- **One model abstraction (H4).** Every model call goes through `lib/llm`. Tests use the fake provider
  (`lib/llm/fake.ts`) or an injected `fetch`; never live keys or the network.
- **No secrets in the repository (H5).** Every new environment variable goes into `lib/env.ts` (zod, with a default
  where sensible), `.env.example` (with a comment), and [docs/configuration.md](docs/configuration.md) in the same
  change; a test checks they agree. Build test fixtures that look like provider keys at runtime (GitHub push
  protection rejects contiguous key literals).
- **Repository content is untrusted (H7).** Code, comments, docs, and pull request text go into prompts only inside
  nonce-tagged data blocks (`dataBlock` in `lib/engine/prompt.ts`) and can never change instructions or settings.
- **Multi-tenancy.** Every tenant-owned table has `org_id` referencing `orgs.id` with `ON DELETE CASCADE`, and every
  query filters by it with `scoped(...)` (`lib/data/tenant.ts`). Take the org from the session or API key, never from
  the request.
- **Validate input** at every boundary (HTTP, webhooks, model output, config files) with zod.
- **Logging** through `lib/log.ts` (structured JSON, correlation ids, redaction); no bare `console.*` in server code.
  Secrets go through `lib/crypto.ts`; never log or store raw tokens.
- **Outbound HTTP** goes through `lib/net/fetch.ts` (the allowlist); a test fails on a bare `fetch`.
- **Brand.** OpenReview's own name and copy only; no other product's name, logos, screenshots, or text, and no fake
  testimonials or customer logos.
- No TODOs, placeholders, stubs, skipped tests, or disabled lint rules in production code.

## Database changes

1. Edit `lib/db/schema.ts` (new tables carry `org_id` with a cascading reference to `orgs.id`).
2. Run `pnpm db:generate` and commit the generated migration in `drizzle/`. Never hand-edit the generated snapshot
   JSON in `drizzle/meta`.
3. SQL Drizzle cannot express (extensions, special indexes, backfills) goes in a custom migration:
   `pnpm drizzle-kit generate --custom --name <name>`, then write the SQL into the new file.
4. Document the table in [docs/DATABASE.md](docs/DATABASE.md) (a test checks that every table is listed).

Migrations are applied when the web app starts, so they must be safe to run against a live database.

## Commits and pull requests

- Commit messages: `<feature IDs> <imperative summary>` on the first line (for example
  `R6.12 Refresh stale knowledge entries after indexing`), a blank line, then a short body explaining what and why.
- Keep pull requests focused. Before opening one, run `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Fill in the pull request template: feature IDs, what changed, how it was tested, and any new variables or
  migrations.
- Update the docs that describe the behavior you changed (`README.md`, `docs/`, `packages/*/README.md`).
