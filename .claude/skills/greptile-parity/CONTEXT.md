# Current state (audited 2026-10-13)

> **Round 2 note (2026-10-14).** This file describes the code *before* round 1. Round 1 (H1–F3) has since shipped: for example `ModelProvider.runTools`, the agentic engine (`src/engine/agent.ts`), the tree-sitter graph, sequence diagrams, the split dashboard sections, Azure DevOps and the remote MCP. So several statements below are out of date. For what exists now, read `docs/parity/REPORT.md` and each round-2 item's **Today** line in `ITEMS.md`, and trust the code over this file. The commands and env-handling notes below still apply.

Treat this as a starting map, not gospel. Verify file and line references before relying on them, and if something has changed, trust the code.

## Stack and architecture
- **Web:** Next.js 15 App Router (`app/`). The dashboard is one file, `app/dashboard/[[...section]]/page.tsx` (about 1,300 dense lines). Server actions are in `app/dashboard/actions.ts`, the HTTP API in `app/api/**`, and styling is about 700 lines of hand-written CSS in `app/globals.css`. There is no Tailwind (`postcss.config.mjs` has no plugins), no component library, no chart library, and no icons. Dark mode works via cookie (`app/theme.tsx`).
- **Web → backend:** the app calls Convex **only server-side via `ConvexHttpClient`**, using custom HS256 JWT session cookies (`src/server.ts`) and a shared `SERVICE_SECRET`. There is no Convex React client and no client-side subscriptions. Live views poll with `router.refresh()` (`app/dashboard/live.tsx`).
- **Backend:** Convex. `convex/schema.ts` is authoritative. Durable staged jobs live in `convex/jobs.ts` (index, review), `reviews.ts`, `recovery.ts` and `crons.ts`. Webhooks go through `convex/http.ts` → `webhooks.ts` → `webhookJobs.ts` (dispatch and triggers). Conversations are `conversations.ts` and `conversationJobs.ts`. Auth helpers are in `convex/auth.ts`, rate limiting in `convex/rateLimit.ts`. **Model keys and GitHub secrets exist only in the Convex env, so all inference runs in Convex actions.**
- **Engine:** `src/engine/`:
  - `review.ts`: `reviewChange()`, `grounded()`; summary assembly ends near line 274 with `diagrams: []`.
  - `model.ts`: Anthropic Messages and OpenAI-compatible adapters, retries, cache.
  - `retrieval.ts`, `indexer.ts`, `embeddings.ts`, `chunks.ts`, `classify.ts`, `diff.ts`.
  - `types.ts`: `ModelProvider` near line 153 has only `generate(request, schema)`. `index-version.ts` holds the index version; bump it to force a re-index.
- **Providers:** the `Scm` type is at `src/gitlab.ts:14`, and `provider()` / `discover()` dispatch is in `convex/scm.ts`. Adapters:
  - `src/github.ts`: `installation()` permission checks around lines 60–85; `publish()` near line 434; `findingComments()`; `reply()`.
  - `src/github-enterprise.ts`, `gitlab.ts`, `gitea.ts`, `bitbucket-cloud.ts`, `bitbucket-forge.ts`, `bitbucket-dc.ts`, `perforce*.ts`, `origin*.ts` (Cursor Origin).
- **Other surfaces:** summary rendering in `src/review-summary.ts`; settings defaults and `summarySections` in `src/review-settings.ts`; CLI in `src/cli.ts` (reads `.openreview.json` near line 176, CLI only); stdio MCP with 8 tools in `src/mcp.ts`; fix prompt in `src/fix-prompt.ts`; local fix bridge in `src/bridge.ts`; tracker context in `src/linear.ts`, `src/atlassian.ts` and `convex/integrationJobs.ts`; budget pricing in `src/inference-billing.ts`.

## Verified vs. coded
- **Verified live on GitHub Cloud:** App install → indexing → PR webhook → retrieval → 7 specialists + verifier → inline comments → `@openreview` follow-ups → fix handoff (Codex, macOS) → fixed-commit re-review and resolution.
- **Coded, with partial or no live verification:**
  - Providers: GitHub Enterprise, GitLab (self-managed verified; GitLab.com not), Gitea (local fixture), Bitbucket Cloud (Forge app never registered), Bitbucket Data Center, Perforce, Origin.
  - Integrations: Jira and Linear context, Confluence adapter.
  - Product features: custom rules, settings inheritance (workspace → team → repo), teams and roles, audit log, analytics, API keys, REST API, runtime worker, auto-approval.
- About 92 tests exist. See `docs/acceptance-matrix.md` for the evidence table.

## Facts behind the gaps
- **Model layer:**
  - Default model is `gpt-4.1`.
  - `src/inference-billing.ts:13` fails closed for every model except `gpt-4.1` and `text-embedding-3-small` when a budget is active.
  - `src/engine/model.ts:130,136` always sends `max_tokens`, with output fixed at 6000.
  - Anthropic JSON output is prompt-only, and there is no tool calling anywhere.
- **Pipeline:**
  - It is fixed: retrieval → up to 7 specialists (2 concurrent, `Promise.all`, so one failure fails all) → verifier → resolution → summary.
  - Each call resends up to about 300 KB.
  - PRs over 500 files, or with a truncated patch or tree, fail outright.
- **Scale:** `repositories.data` calls `.collect()` on every file, rule and preference row (`convex/repositories.ts:~190–205`) per review and per 20-file index batch, which hits the Convex read-limit ceiling.
- **Graph:**
  - Only TS/JS is parsed (by the TS compiler); everything else uses regex.
  - Call edges are raw callee text, unresolved.
  - Traversal is one hop (`convex/context.ts`).
  - Embeddings are optional, one per file, built from the first 8,000 characters.
- **PR output:**
  - No ```suggestion blocks.
  - Single-line comments only.
  - Every push posts a new review instead of editing the existing one.
  - No thread resolution, and check runs are only read.
  - The score is 0–5 "merge readiness".
  - No label, author or bot triggers. Style comments are banned in the prompt.
  - Server reviews ignore repo config.
- **Learning and memory:**
  - Reactions are ignored, and so are human reviewer comments.
  - Preferences are per-repo and come only from explicit feedback or `@openreview ignore this pattern`.
  - Preferences can't be edited. A delete mutation exists in `convex/settings.ts` but no UI calls it.
- **Product surfaces:**
  - No web codebase chat: the cited-answer engine only answers inside PR threads.
  - `/api/context` is keyword, symbol and path search only.
  - MCP is stdio only.
  - No Slack, email or notifications, and no Notion.
- **SaaS features:**
  - GitHub-only login (`users.githubId` is required in the schema) and invites by GitHub login.
  - Logout only deletes the cookie.
  - No billing.
  - The landing page is a sign-in splash, and there are no public docs (`docs/` is mostly internal `*-acceptance.md` QA logs).
  - No diff viewer.
  - Analytics has no time-saved metric or per-author/per-repo trends.

## Commands
- **Install:** `pnpm install` (Node ≥ 24, pnpm 11). `node_modules` was missing at audit time.
- **Checks:**
  - `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
  - `pnpm test` runs `tsx --test tests/*.test.ts` and `vitest run`; vitest picks up `tests/**/*.spec.ts`.
- **Local services:**
  - `pnpm backend` runs `convex dev` against an anonymous local deployment at `127.0.0.1:3210`; `pnpm dev` serves the web app at `localhost:3000`.
  - `pnpm test:e2e` (`scripts/browser.ts`) needs both, and only runs against localhost.
- **Convex codegen** after schema or function changes: `pnpm exec convex codegen`, or `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once` (from the README).
- **Eval:** `pnpm eval --validate` checks fixtures offline. Plain `pnpm eval` and `pnpm demo` call real models and **need approval**.

## Environment and deployment (names only; never print values)
- **Local:** `.env.local` and `.env.backend` hold GitHub App and OAuth credentials, session, service and webhook secrets, `LLM_*` (OpenAI `gpt-4.1`; the key expires 2026-11-01) and `CREDENTIAL_ENCRYPTION_KEY`. Embeddings, Origin, Bitbucket, Linear and Atlassian are not configured locally.
- **Production:**
  - Vercel project `openreview` (team scope `open-review-free`) has production deploys whose `/api/health` reports ok.
  - Production is behind **Vercel Deployment Protection**, so outside users and OAuth callbacks are blocked.
  - The production build runs `convex deploy` using `CONVEX_DEPLOY_KEY`.
  - Changing any of this is a human step.
- **Git:** at audit time `main` had **zero commits** and no remote. Everything was untracked, and `.gitignore` already excluded `.env*` (except `.env.example`), `output/`, `.convex/`, `.vercel/`, `node_modules/` and `*.tsbuildinfo`.
- **Inference budget:** about $0.12 of $5 was unreserved at audit time (`docs/remaining-live-prerequisites.md`).
