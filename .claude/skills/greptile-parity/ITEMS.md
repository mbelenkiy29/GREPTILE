# Parity items: specs and acceptance criteria

The order is H → A → B → C → D → E → F. Hard dependencies:
- H1 and H2 come before everything else.
- H3 comes before A2, C2, D1 and D2 (tool calling, structured output).
- A1 comes before A2.
- A3 comes before A4 (chunks come from the parser).
- A2 comes before D1 (chat reuses the tool loop).
- B1 comes before C4.
- B3 comes before B4 and B5.
- D1 comes before the Slack Q&A part of D4.
- D4 (email channel) comes before the email login and invites in E2.

Build GitHub (Cloud and Enterprise) first for every PR-facing feature. Port a feature to another provider only where that provider's API natively supports it, by adding an optional capability member on `Scm`. Document unsupported combinations in that provider's doc under `docs/`.

---

## Phase H: Housekeeping

### H1 Baseline
- Run `pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- Record the pass/fail results and test counts under "Baseline" in the ledger.
- If untouched code fails, fix it minimally as H1a, in its own commit after H2.

### H2 Git baseline
1. Before any feature change, confirm that `.gitignore` covers `.env*` (except `.env.example`), `output/`, `.convex/`, `.vercel/`, `node_modules/` and build artifacts.
2. List the files about to be committed (`git status --porcelain`). Scan them for secrets: private key blocks, `sk-`, `ghp_`, `ghs_`, `xox[bp]-`, `AKIA`, and long hex or base64 tokens in non-test files. **Stop and report** if you find any.
3. Commit the untouched project on `main` as `chore: baseline snapshot`.
4. Create branch `parity` and do all further work there.
- **Needs human:** create a private remote and push.

### H3 Model layer modernization
- Add a tool-calling method to `ModelProvider` (`src/engine/types.ts`), e.g. `runTools(request, tools, options)`, returning assistant content, tool calls and usage.
  - Implement it natively: Anthropic Messages tool use, and OpenAI-compatible function calling.
  - Leave `generate()` unchanged for existing callers.
- **Structured output:** use native structured output where the provider supports it (OpenAI `response_format: {type: "json_schema"}`; Anthropic forced tool use or its current structured-output feature). Keep the existing zod validation and repair retry as the fallback.
- **Output tokens:** send `max_completion_tokens` for OpenAI reasoning models. Make output tokens configurable with `LLM_MAX_OUTPUT_TOKENS` plus per-task overrides.
- **Prompt caching:** make the large shared review context a stable prompt prefix and add Anthropic `cache_control` breakpoints on it. Record cache-read and cache-write tokens in usage and cost (`convex/reviews.ts` cost records).
- **Pricing:** replace the hard-coded allowlist in `src/inference-billing.ts` with a price table. It should have built-in entries for current Anthropic and OpenAI models plus operator overrides, and still **fail closed** for unknown models when a budget is active.
- **Defaults** when `LLM_PROVIDER=anthropic`: current Claude models, for example `claude-sonnet-5-5` for review, verify and conversation, and `claude-haiku-5-5` for summary and knowledge. Confirm the IDs against current Anthropic docs.
- **`.env.example`:** add `LLM_MODEL_KNOWLEDGE`, `LLM_MODEL_CONVERSATION` and `LLM_MAX_OUTPUT_TOKENS`.
- **Accept:** fake-HTTP tests per adapter covering a tool-call round trip (multi-turn), the structured-output path, cache-control placement, the reasoning-model token parameter, and the price table failing closed. Existing model tests (`tests/model.test.ts`) still pass.

### H4 Production-readiness runbook (prepare only)
Write `docs/production-checklist.md`, covering:
- Disabling Vercel Deployment Protection for production, or serving production on a custom domain, so the public and OAuth callbacks can reach the app.
- Confirming that production Convex has every required env var **name**. The human runs `convex env list --prod` themselves, because it prints values.
- The GitHub App webhook URL pointing at the production Convex site URL, and the callback and setup URLs matching `APP_URL`.
- Replacing the model key, which expires 2026-11-01.
- Backups for the Convex data.

Add each step to "Needs human".

---

## Phase A: Review quality

### A1 Resilience and scale (do first in phase A)
- **Repository reads:** replace the whole-repository `.collect()` reads in `repositories.data` (and similar hot paths) with indexed, paginated, need-based reads. A review or index batch loads only the files, symbols, edges, rules and preferences it needs.
- **Truncated GitHub tree:** fall back to per-directory tree traversal or the existing `archive()` tarball path instead of failing.
- **Oversized PRs and truncated patches:** degrade instead of failing. Rank files by risk (`src/engine/classify.ts`), review the top N within the mode's budget, and list skipped files with reasons in the summary and dashboard.
- **Specialists:** use `Promise.allSettled`. Record per-specialist failures, publish partial results with a visible note, and fail the review only if every specialist failed.
- **Accept:** convex-test coverage for a repository above the old read ceiling, plus tests for a truncated tree, a 600-file PR, and one specialist throwing. The existing pipeline tests (`tests/pipeline.spec.ts`, `tests/engine.test.ts`) stay green.

### A2 Agentic reviewer
- **Setting:** add repo setting `reviewEngine: "pipeline" | "agentic"`. The default stays `"pipeline"`. Switching the default needs a live pipeline-vs-agentic evaluation that the user approves; log it under Needs human.
- **Tools** given to the model must be read-only, tenant-scoped and revision-consistent. Label every tool result with its revision.
  - `search_code(query)` uses full-text search, plus vector search when available.
  - `read_file(path, startLine, endLine)` returns PR head content for changed files and indexed content otherwise.
  - `find_definition(symbol)`, `find_references(symbol)`.
  - `list_directory(path)`, `get_related_files(path)`.
  - `get_past_findings(path)`, `get_rules()`.
  - `report_finding(...)` takes the existing finding schema.
- **Budgets per mode** (fast, standard, deep): maximum tool calls, tokens and wall-clock time.
- **Long runs:** Convex actions have a wall-clock limit (600 s in `docker-compose.yml`; check current Convex Cloud limits). Persist the tool-loop transcript and state between scheduled steps, following the staged-job pattern in `convex/jobs.ts`, so long investigations resume instead of timing out. Honor cancellation between steps.
- **Keep every existing gate:** `grounded()`, confidence and severity thresholds, dedup, the verifier, and execution-claim checks.
- **Prompt injection:** tool output is untrusted data, and text inside files can never change tool permissions or budgets.
- **Accept:** a scripted fake model issues tool calls and the tests cover:
  - Finding a multi-hop cross-file bug through `find_references`.
  - Budget exhaustion producing a graceful partial result.
  - Cancellation mid-loop.
  - Resuming after a simulated action timeout.
  - Injected instructions in a file not altering behavior.
  - Tenant isolation.
- Also add at least 3 multi-hop fixtures in `scripts/fixtures.ts` that pass `pnpm eval --validate`. Do not run them live.

### A3 Multi-language code graph
- Use tree-sitter (`web-tree-sitter` WASM plus grammars) for at least Python, Go, Java, Kotlin, Rust, Ruby, C#, PHP, C/C++ and Swift. Keep the TS compiler path for TS/JS.
- Extract definitions, imports and exports, and calls. Resolve imports to repository files, and resolve calls to symbol definitions where possible. Store the resolved edges.
- Add bounded multi-hop traversal (2–3 hops, ranked) in `convex/context.ts`, and expose it to the A2 tools.
- Verify that WASM loads inside a Convex `"use node"` action; it may need a `convex.json` with `node.externalPackages`. If it can't, parse in a step that can, and log the decision.
- Bump `src/engine/index-version.ts`.
- **Accept:** a small fixture per language with expected symbols and edges, a resolution test, and a multi-hop ranking test.

### A4 Semantic retrieval
- Embed at chunk level (function and class chunks from A3, with window fallback) instead of one vector per file.
- Rank with a hybrid of vector score, full-text score and graph proximity.
- Turn it on automatically when an embedding endpoint is configured, and show its status clearly in the dashboard when it isn't.
- Backfill on re-index, idempotently. Keep 1,536 dimensions, or record a migration under Decisions first. Record cost.
- **Accept:** a ranking test with fake embeddings, a backfill idempotency test, and a test that works with embeddings disabled.

---

## Phase B: What appears on the PR

### B1 Committable suggestions
- Findings may carry an optional `suggestion`: replacement text for an exact line range.
- Validate that it applies cleanly to the head content of that range.
- Render it as a GitHub ```suggestion block (GitLab: ```suggestion:-N+M). If validation fails, drop the suggestion and keep the finding.
- **Accept:** tests for rendering, for validation, and for a stale range rejecting the suggestion.

### B2 Multi-line comments
- Use `start_line`/`start_side` with `line`/`side` for ranges inside a diff hunk. Fall back to a single line when the range leaves the hunk.
- **Accept:** tests for ranges inside and outside a hunk.

### B3 Summary redesign, edited in place
- **One summary comment per PR**, found by a hidden marker and **edited** (PATCH the issue comment) on every run, instead of a new review body each push. Inline findings stay in the review.
- **Update replay and idempotency logic and its tests:** `tests/publication.test.ts`, `tests/github.test.ts`, `tests/origin-publication.test.ts` and other provider publication tests.
- **Sections**, each toggleable through `summarySections` in `src/review-settings.ts`:
  - overview
  - per-file table (file | one-line change description)
  - issues table (severity | linked location | title)
  - confidence score `n/5` with a one-sentence rationale, replacing the 0–5 "merge readiness" label but keeping the severity cap
  - risk
  - resolved findings
  - skipped files (from A1)
  - visible "Last reviewed commit: `<short sha link>`"
- Update the live preview in `app/dashboard/summary-settings.tsx`.
- **Accept:** rendering snapshot tests and edit-in-place replay tests (no duplicate comments across runs or retries).

### B4 Sequence diagrams
- When a PR changes an interaction across two or more components, generate a Mermaid sequence diagram from the reviewed code, never from speculation.
- Validate the syntax and omit the diagram on failure.
- Add a new `summarySections` key `diagram`. Render the diagram in the dashboard's review detail too.
- Remove the `diagrams: []` stub.
- **Accept:** tests for generation with a fake model, for the validation reject path, and for the toggle.

### B5 Incremental review and thread hygiene
- **On synchronize:** if the previously reviewed head is an ancestor of the new head (compare API), review only the new commits' changes while keeping full-PR context. Otherwise (force push, rebase) do a full review.
- **Resolved findings:** post a short reply in the bot's own thread and resolve it with the GitHub GraphQL `resolveReviewThread` mutation, getting thread IDs from `pullRequest.reviewThreads`. Never resolve threads started by humans.
- **Accept:** tests for ancestor vs force-push, for only bot-owned threads getting resolved, and for idempotency.

### B6 Check runs
- If the installation has `checks:write`, create a check run when the review starts (`in_progress`) and complete it with a conclusion. Make the conclusion configurable: `neutral` by default, `failure` when findings reach a chosen severity. Include a short summary and a dashboard link.
- Without the permission, skip silently. Do not change the permission validation in `Github.installation()`.
- **Needs human:** add the permission in the GitHub App settings; installation owners must accept it.
- **Accept:** tests with and without the permission, plus conclusion-mapping tests.

### B7 Triggers and comment types
- **Settings:**
  - review on label (`pull_request.labeled`)
  - an "only on @mention" mode
  - excluded authors and bots (globs)
  - file-count and size limits
  - optional `style` and `syntax` categories, off by default; style is currently banned in the prompt, so make that conditional
  - a strictness preset 1–3 that maps to confidence and severity thresholds
- Wire them into `convex/webhookJobs.ts` dispatch, settings inheritance and the settings UI.
- **Accept:** dispatch tests for each trigger and filter, and an inheritance test.

### B8 Repo config as code
- **Source:** server reviews read `.openreview.json` and an optional `.openreview/` folder (`config.json`, `rules.md`, nested per-directory overrides) **from the base branch**, so a PR can't disable its own review. Use the same zod schema as the CLI.
- **Precedence:** workspace → team → repo dashboard settings → repo file, except admin-locked fields.
- **Dashboard:** show the effective config and the source of each value.
- **Invalid files:** show a visible warning; the review still runs.
- **Accept:** tests for base-branch sourcing (head edits ignored), precedence, locked fields, and invalid files.

---

## Phase C: Learning and memory

### C1 Reaction feedback
- GitHub sends **no webhook for reactions**. Poll 👍/👎 on OpenReview's own comments using the REST reactions endpoints for review comments and issue comments. Poll on PR close or merge, and on a rate-limited cron for open PRs.
- GitLab: use emoji webhook events.
- Store reactions as feedback, feed the preference learner, and show the counts in analytics.
- **Accept:** polling tests with fake API responses, dedup tests, and tests for the analytics aggregation.

### C2 Learn from human reviewers
1. Periodically ingest human (non-bot) review comments from merged PRs in each enabled repo, bounded and incremental.
2. Use the model to extract candidate team conventions, then cluster and dedupe them.
3. Store them as **suggested** learned rules with evidence links and frequency.
4. Admins approve them, or opt into auto-approve per repo.
- **Guardrails:** learned rules may only add review guidance. They never suppress security findings, approve PRs, change permissions or alter tool budgets. Reject instruction-like or injection-like text.
- **Accept:** extraction tests with a fake model, guardrail rejection tests, and approval-flow tests.

### C3 Memory management
- On the Memory page, list, search and filter learned rules and preferences, showing provenance.
- Let users edit the text, set the scope (repo, team or workspace), enable or disable, delete (wire up the existing delete mutation in `convex/settings.ts`), and approve suggestions.
- Audit-log every change. Viewers get read-only access.
- **Accept:** convex-test coverage for role enforcement and scope inheritance, and an e2e check for the page.

### C4 `@openreview fix this`
- In a finding thread, reply with a validated committable suggestion (B1) and the Fix handoff link.
- Optionally, and only by opt-in, open a fix PR on a new branch. This requires `contents:write` at runtime and a repo setting allowing it. Never push to the PR's own branch.
- **Accept:** command parsing tests, permission tests, and suggestion validation tests.

---

## Phase D: Product surfaces

### D1 Codebase chat (web)
- `/dashboard/chat` lets users ask questions across one or more selected repos.
  - Answers stream.
  - Every claim cites file:line links pinned to an indexed revision, validated in the style of `conversationAnswerSchema`.
  - Threads are persisted in new Convex tables and listed; follow-ups keep context.
- Reuse the A2 tool loop with chat-specific budgets.
- Enforce `convex/rateLimit.ts` and the inference budget, and record usage and cost.
- **Streaming design:** choose one that fits a server-side `ConvexHttpClient`, custom sessions, and model keys that exist only in Convex. Examples are Convex HTTP-action streaming, or persisted deltas consumed by an SSE route handler. Log the choice under Decisions.
- **Accept:** a test that a user can never retrieve another workspace's code or threads, citation validation tests, and an e2e check for the page.

### D2 Public query API
- All endpoints are API-key authenticated:
  - `POST /api/query`: a question over repos returns an answer plus sources, with optional streaming.
  - `POST /api/search`: hybrid search returns ranked snippets.
  - `POST /api/repositories`: enable and index an installed repo.
  - `GET /api/repositories/:id`: index status.
- Add per-key scopes (read, write, admin) in `convex/apiKeys.ts` and `src/api-auth.ts`, keeping existing keys working.
- Document it in `docs/openapi.yaml`.
- **Accept:** route tests for auth, scopes, tenant isolation and validation errors.

### D3 Remote MCP
- Add a Streamable HTTP MCP endpoint (`app/api/mcp/route.ts`, `@modelcontextprotocol/sdk`) with Bearer API-key auth.
- Expose the same tools as stdio, plus `ask_codebase` (D2) and semantic `search_code`. Keep stdio working.
- **Accept:** protocol tests for listing tools, calling a tool, and rejecting a request without auth.

### D4 Slack and notifications
- **Notifications module:** a `notifications` module with Slack and email channels that does nothing when unconfigured.
- **Slack app:**
  - per-workspace OAuth install
  - `app_mention` → codebase Q&A in the thread (D1 engine)
  - per-repo channel notifications: review completed, high-severity finding
  - a status slash command
  - request signature verification
  - ship `docs/slack-app-manifest.yml`
- **Email:** add a provider adapter (e.g. Resend) for notifications and for E2 invites, with user-level notification preferences.
- **Needs human:** create the Slack app and the email account, and set the keys.
- **Accept:** signature tests, event routing tests and notification fan-out tests, all with fakes.

### D5 Notion and Confluence
- **Notion:** OAuth integration that reads pages linked by URL in the PR text as read-only requirements context. Follow the Linear and Atlassian patterns (`src/linear.ts`, `src/atlassian.ts`, `convex/integrationJobs.ts`, `src/requirements-context.ts` limits).
- **Confluence:** finish the space-selection UI.
- **Accept:** adapter tests, plus revocation and 401-recovery tests.

---

## Phase E: Running it as a product

### E1 Billing (cloud mode only)
- **Stripe:** Checkout, the Customer Portal, and webhooks into Convex with signature verification and idempotent event handling.
- **Plans** (configurable): a 14-day trial and a per-seat tier, with seats counted from active members.
- **Quotas and status:** per-workspace review quotas, past-due and grace handling, and a usage and billing page.
- **Self-host:** `BILLING_ENABLED=false` (the self-host default) disables all of it. Use test mode only.
- **Needs human:** a Stripe account and keys. On Vercel, Stripe can be provisioned via the Marketplace.
- **Accept:** webhook replay and idempotency tests, quota enforcement tests, and seat counting tests.

### E2 Identity
- **Data model:** add an `identities` table (provider + providerUserId). Make `users.githubId` optional, with a migration for existing users.
- **Logins:**
  - GitHub (existing)
  - GitLab OAuth
  - Google OAuth
  - email magic link (D4 email)
- **Invitations:** by email, with expiring single-use tokens.
- **Sessions:**
  - a server-side session table checked in `src/server.ts`
  - revocation, including "sign out everywhere"
  - automatic revocation on member removal
- **SSO/SAML:** optional, through a self-hostable option behind config. It may be deferred; log the decision.
- **Accept:** migration tests, account-linking tests (no takeover through unverified email), and session revocation tests.

### E3 Marketing and docs
- **Landing page:** hero, how it works, feature sections, self-host vs. cloud, pricing (cloud only), FAQ, footer.
- **Public docs at `/docs` (MDX):** quickstart, GitHub App setup, each provider, configuration including `.openreview.json`, rules, API, MCP, CLI, self-hosting.
- **Also:** a changelog page, SEO metadata and an OG image.
- **Internal QA logs:** move `docs/*-acceptance.md` to `docs/internal/` and fix every link (grep `README.md` and `docs/`).
- **Accept:** `pnpm build`, an e2e check that the pages render, and no broken internal links.

### E4 UI polish
- Split `app/dashboard/[[...section]]/page.tsx` into per-section components.
- Adopt a small component system (e.g. Tailwind + shadcn/ui) incrementally. Tailwind's preflight will restyle existing hand-written CSS, so scope it or migrate deliberately.
- Add a chart library for analytics.
- Add a diff viewer with inline findings to the review detail page.
- **Analytics:** estimated time saved (configurable minutes per finding), per-author and per-repo trends, and addressed rate over time. Back them with **daily aggregate tables**, not raw scans.
- Add loading and not-found states, and toasts.
- **Accept:** `pnpm test:e2e` green (update selectors deliberately), desktop and 390 px mobile, light and dark, and no console errors.

---

## Phase F: Providers and verification

### F1 Azure DevOps
- Build a new `Scm` adapter covering:
  - pull requests, iterations and diffs
  - comment threads
  - statuses
  - service-hook webhooks with secret verification
  - PAT or Entra app auth
- Wire it into `convex/scm.ts`, the connection kinds in the schema, the settings UI and the docs.
- **Accept:** contract tests mirroring `tests/gitlab-approval.test.ts` and `tests/providers.test.ts`.
- **Needs human:** an Azure DevOps org for live verification.

### F2 Live-verification runbooks
- For each of these, write a step-by-step runbook in `docs/` and mark it in the ledger as Needs human:
  - GitHub Enterprise
  - GitLab.com
  - Bitbucket Cloud (Forge app registration and deployment)
  - Bitbucket Data Center
  - the Origin fix loop
  - every new Phase B, C and D capability
- Add `docs/acceptance-matrix.md` rows for the new features, with their evidence level.

### F3 Fix handoff
- Add a path that doesn't need the bridge: "Copy fix prompt". Add an open-in-agent link only where an agent publishes an **official** deep-link scheme; verify it in current docs and never invent URL schemes.
- Make the Windows and Linux bridge code paths testable with fakes.
- **Needs human:** real-OS verification on Windows and Linux.
- **Accept:** prompt rendering tests and platform path tests.
