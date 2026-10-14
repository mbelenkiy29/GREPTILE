# Parity items: specs and acceptance criteria

Round 1 order is H → A → B → C → D → E → F (all done). Round 2 (G → J → K → L → M → V) is at the end of this file. Round 1 hard dependencies:
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

---

# Round 2 (added 2026-10-14)

These items come from an audit of OpenReview against Greptile's public site, docs and changelog (features through September 2026). Round 1 (H1–F3) is done; see `docs/parity/REPORT.md`. Each item has a **Today** line giving starting points from the audit. Verify them in the code before relying on them.

The order is G → J → K → L → M → V. Letter I is skipped to avoid confusion with 1. Hard dependencies:
- G1 comes before J5 (the requirements check is a summary section).
- G2 comes before J2 (security findings reuse the badge rendering).
- K1 comes before K2 (directory tiers come from the cascading config).
- L3 comes before L4 (the plugins call the new MCP tools).
- J3 and M1 interact: generated-test reviews cost more credits. Whichever lands second wires them together.
- V1 comes last.

The round-1 rules still apply:
- GitHub first; other providers only through optional `Scm` capabilities.
- Every new Convex function is access-checked and audited.
- All repository, PR, ticket and model text is untrusted.
- Live inference, live provider runs and outward-facing changes are Needs human.

---

## Phase G: What appears on the PR (round 2)

### G1 Verdict first, and findings outside the changed lines
- **Today:**
  - `src/review-summary.ts:42-56` renders the score after the findings and has no verdict.
  - Findings anchored outside changed lines are dropped (`src/engine/review.ts:64-75`), and GitHub publishing refuses them (`src/github.ts:609`).
- **Verdict and score at the top:**
  - Open the summary with a one-line verdict and the `n/5` score.
  - Compute the verdict deterministically from the score, unresolved severities and coverage limits, never from free model text.
  - Use original wording, such as "Ready to merge", "Merge after fixes" and "Needs changes".
  - Keep the existing section toggles, and keep existing `summarySections` settings working.
- **Outside the changed code:**
  - A verified finding may be anchored on an unchanged line when its evidence includes at least one changed line that causes it. Example: a caller in an untouched file broken by the change, which is the multi-hop case.
  - Publish these in an "Outside the changed code" summary section, or in one separate PR comment edited in place like B3. Never post them as inline review comments.
  - The `grounded()` exact-quote rules still apply to every quote.
- **Dashboard:** the review detail page shows these findings too.
- **Accept:**
  - Verdict mapping tests covering every severity and score boundary and incomplete coverage.
  - Rendering snapshots.
  - A grounding test: an outside-diff finding with no changed-line evidence is rejected.
  - A publication test: never inline, edited in place, no duplicates on retry.
  - Existing summary and publication tests stay green; record any deliberate updates in the ledger.

### G2 Priority badges
- **Today:** inline comments show plain text such as `**HIGH: title** (NN% confidence)` (`src/review-summary.ts:68`).
- **Mapping:** map severities to priority labels with original styling. Suggested: critical = P0, high = P1, medium = P2, low = P3. Log the final mapping under Decisions.
- **Where they appear:** inline comment titles, the summary findings table, the dashboard, Slack and email notifications, and API and MCP output (as an additive field).
- **Security tag:** findings in the `security` category get a separate "Security" tag that J2 reuses.
- **Constraints:**
  - Text or emoji only. Hosted images break on self-hosted and air-gapped installs.
  - Never copy Greptile's badge artwork or wording.
- **Accept:** mapping tests, rendering tests for each surface, and an additive API schema test (old clients unaffected).

### G3 Clarifying questions and replies without a mention
- **Today:**
  - The finding schema has no question field.
  - Thread replies only run when the reply mentions `@openreview` (`convex/webhookJobs.ts:229-241` → `convex/conversationJobs.ts`).
- **Questions:**
  - A finding may carry an optional `question` of at most 300 characters, for when the change's intent is unclear. Render it under the inline comment as a question to the author.
  - A question never counts as a finding on its own, and it never blocks approval by itself.
- **Replies without a mention:**
  - In threads that OpenReview started, answer human replies without requiring `@openreview`.
  - Make it a repo setting, on by default. Log the default under Decisions.
  - Never answer bots or OpenReview itself. Rate-limit per thread and per PR.
  - Grounding and `conversationAnswerSchema` still apply.
- **Accept:**
  - Schema and rendering tests.
  - Dispatch tests: replies in a bot-owned thread with no mention are answered; human-started threads, bot authors and loops are not.
  - Rate-limit tests.

### G4 Review footer
- **Today:** the footer has "View review / Re-review" and "Last reviewed commit" (`src/review-summary.ts:77`).
- **Add:**
  - A review counter, for example "Review 3 on this pull request", counted from stored reviews for the PR.
  - A re-run hint naming the exact comment command (`@openreview review`), alongside the existing dashboard link.
  - On GitLab and other providers, use the command syntax each provider's dispatch supports.
- **Accept:** counter tests (retries and replays don't double count), and rendering tests per provider.

### G5 Feature tips
- **Show a tip** in the summary footer when a review's data suggests a feature would help. Examples:
  - No rules are configured.
  - Many findings were dismissed: suggest the strictness setting.
  - A ticket is referenced but its integration isn't connected.
  - Agentic review is available but off.
- **Limits:**
  - At most one tip per review, and a per-repo cooldown.
  - Toggle it as a `summarySections` key.
  - Log under Decisions whether it defaults to on for cloud and off for self-hosted.
- **Accept:** tip selection tests, cooldown tests, and a toggle test.

---

## Phase J: Review engine depth

### J1 Hypothesis agents
- **Today:** one LLM specialist per category, two at a time (`src/engine/review.ts:196-231`), or a single agentic loop (`src/engine/agent.ts`).
- **Engine:** add `reviewEngine: "hypotheses"`.
  1. A planner turn proposes up to N concrete bug hypotheses (structured: claim, changed location, what to check), bounded per mode.
  2. Each hypothesis runs as a small, budgeted `runReviewAgent` investigation with a hypothesis-specific prompt. Run them in parallel with a concurrency limit.
  3. Findings flow through the existing gates: `grounded()`, dedupe, the verifier and thresholds.
- **Budgets:** per-hypothesis and total budgets per mode. One hypothesis failing or running out of budget never fails the review.
- **Default:** stays `pipeline`. Switching it needs a live three-way evaluation, which is Needs human.
- **Evaluation:** support `--engine=hypotheses` in `scripts/eval.ts`, with transcripts per hypothesis.
- **Accept:** scripted fake-model tests covering:
  - planner output validation and caps
  - parallelism within the concurrency limit
  - one hypothesis failing
  - total budget exhaustion
  - cross-hypothesis dedupe
  - injection text in files not changing hypotheses or budgets
  - the eval wrapper recording each hypothesis's transcript

### J2 Security agent
- **Today:** security is only an LLM category, plus `--security` and `@openreview review security`.
- **Dependency check:**
  - When manifests or lockfiles change, query the OSV.dev API (`/v1/querybatch`) for added or changed package versions.
  - Cover at least npm/pnpm/yarn, PyPI, Go, Cargo and Maven.
  - Publish verified advisories as findings, with a link to the advisory, the affected version and the fixed version.
- **Pattern scan:**
  - A small, original, tested set of high-signal static checks over changed lines: hard-coded secrets, SQL built from string concatenation, disabled TLS verification, `eval` of input, and similar.
  - Model judgment never replaces these checks; the model only explains and ranks.
- **Exploit check:** for security findings, an optional model step judges exploitability from grounded evidence. Lower the confidence when an exploit path isn't shown.
- **Security tag:** use the G2 "Security" tag.
- **Settings:** a per-repo toggle, on by default for cloud. Self-hosted installs can disable outbound OSV calls (see M4).
- **Accept:**
  - Fake-HTTP OSV tests: batching, unknown ecosystems, API failure degrading with a visible note.
  - Lockfile diff parsing tests per ecosystem.
  - Pattern-check true and false positive fixtures.
  - A test that learned rules cannot suppress security findings.

### J3 Generated tests in the sandbox
- **Today:** the runtime worker runs one admin-approved, digest-pinned command per PR (`docs/runtime-worker.md`, `convex/runtime.ts`, `scripts/runtime-worker.ts`). Its result appears only in the summary's "Test execution" section.
- **Opt-in per repo:**
  1. For a verified finding, the agent drafts a minimal test meant to reproduce it.
  2. The existing sandbox runs it through an admin-approved command template with a test-file placeholder. Conditions: no network, a time limit and a memory limit, on a copy of the head revision.
  3. Attach the outcome (pass or fail, the trimmed output, the test code in a collapsed block) as evidence on that finding's comment.
- **Constraints:**
  - Generated tests are never committed or pushed.
  - Output is untrusted. Execution claims must come from recorded runtime evidence (`executionClaimIssues`).
  - A failing generated test raises confidence; a passing one lowers it or drops the finding. Log the exact policy.
- **Accept:**
  - Fake-worker tests covering template substitution, sandbox limits passed through, and the evidence attached to the right comment.
  - Timeout and crash handling.
  - An injection test.
  - A no-commit guarantee test.
- **Needs human:** a live sandbox run on a real repository.

### J4 Knowledge base in reviews
- **Today:** knowledge entries are generated (`convex/knowledgeJobs.ts`) and shown in the dashboard, API and MCP. Reviews receive only the `knowledgePaths` file list (`convex/jobs.ts:457`).
- **Change:**
  - Pass the approved knowledge entries relevant to the changed paths into the shared review context, ranked, bounded by tokens, and labelled as derived background.
  - Knowledge text can never be an evidence quote; quotes must come from source.
  - Show which entries were used in the summary's "What we checked" (Coverage) section.
- **Accept:** selection and ranking tests, a token-bound test, a test that knowledge-only evidence is rejected, and a stale-entry test (entries for deleted paths are skipped).

### J5 Requirements check against linked tickets
- **Today:** referenced Jira, Linear and Notion tickets are fetched and given to reviewers as context (`convex/integrationJobs.ts:65`, `src/engine/review.ts:65`). There is no explicit check.
- **Requirements section:** when a PR references a ticket, add a "Requirements" summary section, toggleable. It lists each acceptance criterion as met, not met or unclear, with grounded quotes from the ticket and the code.
- **"Not met" items:** they become findings only when the code evidence is grounded. Auto-approve (`src/approval.ts`) treats any grounded "not met" as blocking.
- **Accept:** fake-model tests for criterion extraction, the three outcomes, grounding rejection, the approval interaction and the toggle.

### J6 Routing for AI-authored pull requests (experimental)
- **Detection** uses explicit signals only, never style guessing:
  - known agent bot authors
  - `Co-Authored-By` trailers naming coding agents
  - agent branch prefixes
  - PR-body markers
- **Routing:** when the repo setting `aiAuthoredModel` is set, review those PRs with that model. Off by default.
- **Record** the detection reason in review metadata, and show it in the dashboard.
- **Accept:** detection tests for each signal (and no false positive on ordinary PRs), a routing test with fake providers, and an inheritance test.

### J7 Third-party API guidance packs
- **Guidance packs:** versioned Markdown packs that load when a change imports or calls a matching package or SDK.
  - Built-in packs live in the repo. Repo-local packs can go under `.openreview/guides/`, read from the base branch.
  - Packs add review guidance only; they can never suppress findings.
- **Seed packs:** ship two or three original, small packs, such as webhook signature verification, idempotency keys and SDK retry and timeouts.
  - Each claim links to the vendor's current official docs.
  - Don't imply any partnership.
- **Accept:** match tests (import detection per language), a precedence test (built-in vs repo pack), an injection-guard test, and a test that packs cannot suppress findings.

### J8 Elixir in the code graph
- **Today:** Elixir uses the regex fallback (`src/engine/indexer.ts:210-222`).
- **Change:** add a tree-sitter Elixir grammar, pinned and compatible with `web-tree-sitter` 0.22.6, with definitions, imports or aliases, and calls. Bump `src/engine/index-version.ts`.
- **Accept:** a fixture with expected symbols and edges, and a resolution test, following `tests/graph.test.ts`.

---

## Phase K: Configuration and learning (round 2)

### K1 Real cascading directory config
- **Today:** nested `<dir>/.openreview.json` files only add rules and instructions (`src/repo-config.ts:92-100`).
- **Cascade:**
  - `.openreview/` folders at any depth (`config.json`, `rules.md`, `files.json` for ignore and include globs) apply to files under them. Deeper folders override shallower ones field by field.
  - Admin-locked fields still win, and everything is still read from the base branch.
- **Per-file settings:** categories, strictness, ignore and comment types are resolved per file. For PR-wide settings such as the review tier, use the strictest or highest value among the touched directories. Log the rule under Decisions.
- **Dashboard:** "effective config" shows the cascade with the source of each value.
- **Accept:** tests for inheritance and override order, per-file resolution, locked fields, invalid nested files (warning, review continues), and head-branch edits being ignored.

### K2 Per-PR effort overrides
- **Today:** the review tier is fast, standard or deep at workspace, team and repo level. Per PR, there is only `review security`.
- **Add:**
  - `@openreview review fast|deep` comment commands.
  - An optional PR label such as `openreview:deep`.
  - The directory-level tier from K1.
- **Precedence:** documented, with admin limits respected. Example: a workspace can cap deep reviews.
- **Accept:** command parsing tests, label dispatch tests, precedence tests and cap tests.

### K3 Configurable agent budgets
- **Today:** turn and tool-call budgets are fixed per mode (`src/engine/agent.ts:35-38`).
- **Change:**
  - Workspace, team and repo settings can lower or raise the turns and tool calls for the agentic and hypothesis engines, within operator hard caps set by environment variables.
  - Add the variables to `.env.example`.
  - Show the effective budget in review metadata.
- **Accept:** tests for clamping to the hard caps, inheritance, and the budget reaching the agent.

### K4 Wildcard and team rule scopes
- **Today:** a rule is either workspace-wide or for one repo (`convex/repositories.ts:202-208`).
- **Change:**
  - Add team-scoped rules and repo glob patterns (for example `acme/*-service`).
  - Precedence and dedupe across scopes. Add UI for picking a scope.
  - Migration: existing rules keep their meaning.
- **Accept:** convex-test coverage for scope matching, precedence, migration, and role enforcement (viewers read-only).

### K5 AI rule assistant
- **Features:**
  - Draft a rule from a plain-language description.
  - Refine existing rules: tighten vague wording, flag conflicts and duplicates.
  - Suggest rules from findings that teams repeatedly fixed and from approved learned conventions.
  - Import rule files is L1's job; this item is the dashboard side.
- **Approval:** every output is a suggestion that needs admin approval, with the C2 guardrails: guidance only, injection-like text rejected.
- **Accept:** fake-model tests for drafting, refining, conflict detection and suggestion provenance; guardrail tests; and an approval-flow test.

### K6 Learning from commits
- **Today:** learning uses reactions, replies and human comments, but not commits.
- **Change:**
  - When a later commit changes a finding's lines and the finding resolves, record an "addressed" signal.
  - Findings left unaddressed through merge record an "ignored" signal.
  - Feed both into the preference learner with the existing bounds, and show the addressed rate over time in analytics.
  - Learning can never suppress security findings.
- **Accept:** signal derivation tests (addressed, ignored, force-push edge cases), learner bound tests and an analytics aggregation test.

### K7 Repository onboarding automation
- **Today:** new repos are added with `enabled: false` (`convex/webhooks.ts:190`), and clusters are manual (`convex/scopes.ts`).
- **Auto-enable:** a workspace or team setting that enables newly installed repos, off by default for existing workspaces. Audited.
- **Suggested clusters:**
  - Propose clusters from cross-repo imports and package references, shared dependency names, and naming patterns.
  - One-click approval. Never auto-applied.
- **Accept:** webhook tests with the setting on and off, and suggestion tests with fake repository data.

---

## Phase L: Developer tooling

### L1 CLI onboarding
- **Today:** the CLI has `login`, `status`, `review`, `runtime`, `bridge` and `p4` (`src/cli.ts:52-115`).
- **Add `openreview onboard`:**
  - Authenticate, then pick or create a workspace.
  - Show the provider install link. It only prints or opens the URL; it never changes provider settings.
  - Enable repositories.
  - Import existing AI rule files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`, `GEMINI.md`, `.windsurfrules`) as **suggested** rules that need approval.
- **Agents:** a non-interactive `--yes --json` path so coding agents can run it.
- **Accept:** a test per step with a fake API, rule-file discovery and parsing tests, and a non-interactive mode test.

### L2 CLI review: resume and inline output
- **Today:** `src/cli.ts:116-250` supports `--base`, `--json`, `--agent` and `--mode`.
- **Add:**
  - `--resume`, which continues an interrupted agentic local review from saved `AgentState` in the OS cache directory. Discard the state if the head moved.
  - An `--inline` output format that prints findings as `file:line` blocks with context.
- **Accept:** resume tests (same head resumes, a moved head restarts) and output format snapshots.

### L3 MCP: OAuth and more tools
- **Today:** stdio and remote Streamable HTTP MCP with 11 tools and a Bearer API key (`src/mcp-tools.ts`, `app/api/mcp/route.ts`).
- **OAuth:**
  - Add OAuth for the remote endpoint following the current MCP authorization spec: protected resource metadata, PKCE, and whatever client-registration method the spec currently requires. Verify against current docs.
  - Keep API keys working.
  - Tokens are tenant-scoped, and their scopes map to the D2 key scopes.
- **New tools:**
  - `trigger_review`
  - `list_unresolved_comments` (across the caller's open PRs)
  - `get_review_status`
  - `add_custom_context` (creates suggested rules)
  - `report`, with PR status, weekly summary or team metrics, reusing `/api/analytics`
- **Accept:** protocol tests for the OAuth discovery and token flow with fakes, scope enforcement and tenant isolation, plus a test per new tool.

### L4 Claude Code and Codex plugins, and a resolve loop
- **Claude Code plugin:** a plugin package in the repo, following the current documented format (verify it).
  - Bundle the MCP server config and a skill or command that loops:
    1. Fetch unresolved OpenReview comments for the current branch's PR.
    2. Fix them.
    3. Commit locally.
    4. Ask the user to push, or push only if the user configured it.
    5. Trigger a re-review and wait.
    6. Repeat, up to a maximum number of iterations.
  - Use original names and never copy Greptile's.
- **Codex:** ship a Codex plugin only if Codex documents an official plugin format. Otherwise ship the skill or `AGENTS.md` snippet plus the MCP config, and log the decision.
- **Accept:**
  - Manifest validation tests.
  - A loop-logic test with fake MCP responses: stops when clean, stops at the maximum, and never force-pushes.
  - Install docs.

### L5 More fix-handoff targets
- **Change:** add Conductor and Devin to "Fix with your agent", but only through officially documented deep links or APIs, checked in current docs. Never invent URL schemes; same rule as F3.
- **API-based targets:** where only an API exists (for example a Devin session API), make it an opt-in that uses the user's own configured key, hidden when no key is set.
- **Accept:** link-format tests and a hidden-when-unconfigured test. Document any target left out, and why.

---

## Phase M: Business, enterprise and deployment

### M1 Free tier, credits and spending caps (cloud only)
- **Today:** Stripe per-seat monthly review quota, trial and grace period (`src/billing.ts`). The only spending cap is a deployment-wide operator budget (`convex/inferenceBudget.ts`).
- **Free tier and credits:**
  - A free single-developer tier.
  - Configurable credits per review kind. Suggested: standard 1, generated-test reviews 3 (J3).
  - Included credits per seat, and extra credits.
- **Spending cap:**
  - A customer-set monthly dollar cap that pauses reviews with a visible note when reached.
  - Admin email and Slack notice at 80% and 100%.
- **Stripe:** use current usage-based billing APIs (verify in docs), in test mode only. `BILLING_ENABLED=false` still disables everything.
- **Accept:** credit accounting tests, cap enforcement tests (pause, resume next period), tests for webhook replay of usage records, and a free-tier seat limit test.
- **Needs human:** Stripe products and meters.

### M2 SSO (SAML and OIDC)
- **Today:** no SSO; it was deferred in E2.
- **Per-workspace SSO:**
  - SAML 2.0 and OIDC through a maintained, self-hostable library. Log the choice.
  - Domain verification by DNS TXT, which the human adds.
  - Optional enforcement, and just-in-time membership.
  - Account linking follows the E2 no-takeover rules.
- **Accept:**
  - Signed-assertion tests with test keys: valid, expired, wrong audience, replay.
  - An enforcement test and a linking test.
- **Needs human:** an IdP for live verification.

### M3 Data controls and workspace deletion
- **Data-sharing setting:**
  - A per-workspace setting that controls whether review data may be used beyond that workspace, for example in aggregate analytics or evals. Private by default.
  - Retention settings for reviews and transcripts.
- **Workspace deletion:**
  - Owner-only, with a grace period.
  - An idempotent, paginated purge of every workspace-owned table. Audited.
  - Provider installs are revoked only as a Needs-human step.
- **Accept:** convex-test coverage for the purge (all tables, no cross-tenant deletion, resumable), role tests and retention tests.

### M4 Self-hosting kit
- **Today:** there is `docker-compose.yml` and a `Dockerfile`, and BYO LLM includes local endpoints (`LLM_ALLOW_LOCAL`).
- **Add:**
  - A Helm chart (`deploy/helm/`) for the web app and the self-hosted Convex backend.
  - Terraform for AWS (`deploy/terraform/aws/`).
  - An offline mode, `OPENREVIEW_OFFLINE=true`, that turns off every outbound call except the configured model, embedding and SCM hosts. That includes the OSV checks, integrations and tips.
  - Bundled tree-sitter grammars, and an egress list in the docs.
- **Accept:**
  - `helm lint` and `helm template`, and `terraform validate`, when the tools are installed. Otherwise log it under Needs human.
  - Offline-mode tests proving outbound calls are skipped.
- **Needs human:** a real cluster and an AWS account.

### M5 Self-managed GitLab behind proxies
- **Today:** self-managed HTTPS GitLab with a host allowlist. Redirects are refused (`src/credentials.ts:5-10`, `src/gitlab.ts:51-54`).
- **Add:**
  - A separate internal API URL and external web URL.
  - A custom CA bundle, and an HTTPS proxy setting.
  - Follow same-host redirects only.
  - The allowlist still applies.
- **Accept:** tests with fake HTTP for URL splitting, CA option plumbing, proxy plumbing, and a cross-host redirect being refused.

---

## Phase V: Round 2 verification

### V1 Runbooks, matrix and fixtures
- **Runbooks:** for every round-2 capability that can only be confirmed live, write a step-by-step runbook in `docs/` and add it to Needs human. That includes G3 replies without a mention, J2 OSV, J3 sandbox, L3 OAuth with a real MCP client, L4 plugins, M1 Stripe, M2 IdP and M4 cluster.
- **Acceptance matrix:** add rows to `docs/acceptance-matrix.md` with evidence levels.
- **Eval fixtures:** add fixtures for J1, J2 and J5 to `scripts/fixtures.ts` that pass `pnpm eval --validate`. Do not run them live.
- **Finish:**
  - Add a "Round 2" section to `docs/parity/REPORT.md`, following the same structure as round 1.
  - Update the README feature list.
  - Refresh the eval plan to cover three engines (pipeline, agentic, hypotheses).
