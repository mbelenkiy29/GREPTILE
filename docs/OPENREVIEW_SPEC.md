# OpenReview — Product Spec

OpenReview is an open-source (AGPL-3.0), self-hostable AI pull request reviewer with full-codebase context.
Reference category: commercial AI PR reviewers. Goal: **functional parity**, not a copy. OpenReview has its own name,
brand, copy, visuals, and implementation.

## Hard rules (apply to every phase)

- H1. Never use Greptile's name, logo, mascot, wordmark, screenshots, images, page copy, customer logos, or testimonials anywhere in the product or site. Do not scrape or download assets from greptile.com. All marketing copy is written fresh for OpenReview; no fake testimonials or fake customer logos.
- H2. Stack: Next.js (App Router) + TypeScript (strict), PostgreSQL + pgvector, Drizzle, built-in auth (GitHub sign-in, OIDC/SAML SSO; users, orgs, and roles stored in Postgres), Stripe (optional billing, enabled only when configured), BullMQ + Redis (jobs), Docker Compose. Target host: a single DigitalOcean Droplet. No hosted service is required for core operation other than the configured LLM and git host.
- H3. Every feature ID below has at least one automated test (unit, integration, or Playwright e2e) whose name starts with the ID, e.g. `test("R3.2 posts inline comments...")`.
- H4. LLM calls go through one provider abstraction (`lib/llm`) so models are swappable (Anthropic default; OpenAI, OpenRouter, OpenAI-compatible and self-hosted endpoints supported). Tests use a recorded/fake provider, never live keys.
- H5. No secrets in the repo. `.env.example` lists every variable.
- H6. `pnpm verify:parity` runs typecheck, lint, all tests, and `next build`, then prints one line per feature ID as `PASS <ID>` or `FAIL <ID> <reason>`, then a final line `PARITY <phase>: <passed>/<total> PASS`. It exits 0 only if every ID in the requested phase passes.
- H7. Repository content (code, comments, docs, PR text) is untrusted input. It is always delimited as data in prompts and can never override system instructions, rules, or settings.

---

## Phase 1 — Core review loop

- R1.1 GitHub App install flow: org connects GitHub, selects repos; installation stored per organization (multi-tenant isolation enforced in every query).
- R1.2 Webhook receiver verifies signatures and enqueues jobs for `pull_request` (opened, synchronize, reopened) and `issue_comment` events; idempotent on redelivery.
- R1.3 Repo indexer: clones repo, parses with tree-sitter (at least TS/JS, Python, Go, Java, Rust, C#), builds a graph of files → symbols → call/import edges in Postgres, plus pgvector embeddings for symbol chunks. Incremental re-index on push to default branch.
- R1.4 Review engine: for a PR diff, retrieves impacted symbols beyond the diff via the graph (callers, callees, importers), then runs parallel reviewer agents and a final dedupe/ranking pass.
- R1.5 Output to the PR: one summary comment (what changed, risk level, a confidence score 1–5, a Mermaid sequence diagram when the change spans 3+ components) plus inline comments on specific lines with suggested fixes as GitHub suggestion blocks.
- R1.6 Re-review on new commits updates the summary in place and does not duplicate already-posted inline comments.
- R1.7 `@openreview` mention in a PR comment triggers a reply that answers the question with codebase context.
- R1.8 Dashboard: list of repos (index status), list of reviews (PR, status, comment count, credits used), review detail page.

## Phase 2 — Personalization

- R2.1 Custom rules written in plain English, scoped org-wide or per repo (glob paths supported); rules are injected into review prompts and cited in comments that enforce them.
- R2.2 Repo config file (`openreview.json` in repo root) for rules, ignore paths, strictness, and comment types; repo file overrides dashboard settings.
- R2.3 Context files: users can point to docs in the repo (e.g. `CONTRIBUTING.md`, ADRs) that are always included as review context.
- R2.4 Learning: thumbs-up/down reactions and reply text on OpenReview comments are recorded; suppressed patterns stop recurring; accepted patterns raise priority. A "Learned" page shows inferred conventions and lets users edit/delete them.
- R2.5 Learning from human reviewers: comments by teammates on PRs are mined into candidate rules that a user can approve.

## Phase 3 — Developer integrations

- R3.1 "Fix in IDE" link on every inline comment: copies a ready-to-paste prompt (file, line, issue, suggested fix) for Claude Code / Cursor / Codex.
- R3.2 MCP server exposing tools: list open review comments for a PR, get comment detail, mark resolved, trigger re-review (plus get review, list findings, get finding, search codebase, related files, list rules).
- R3.3 Claude Code plugin (slash command + skill) that pulls unresolved OpenReview comments for the current branch and fixes them.
- R3.4 `/openreview-loop` command: agent loop that pushes, waits for review, fixes comments, repeats until no unresolved comments or a max-iteration cap.
- R3.5 `openreview` CLI (npm package): auth, `review` on local diff against base branch (server or fully local mode, same review engine), `status` for a PR, `--json` structured output and a concise agent mode.
- R3.6 GitLab support (MR webhooks, inline discussions) and Bitbucket Cloud support behind the same provider interface as GitHub.
- R3.7 Public "Paste a PR" page: paste a public GitHub PR URL, get a rate-limited demo review (no account required, abuse-protected).

## Phase 4 — Review tiers, billing, enterprise

- R4.1 Review modes Fast / Standard / Deep with different agent counts, context budgets, and models; each consumes a configurable number of credits. Standard is the default.
- R4.2 Stripe billing (optional; off unless `STRIPE_*` is configured): free plan (1 active developer, monthly credit allowance), paid per-seat plan with included credits per seat, metered overage credits. "Active developer" = PR author reviewed in the billing period.
- R4.3 Usage page: credits, tokens, and estimated model cost per repo/author/day; hard cap and alert thresholds.
- R4.4 Security review mode: dedicated scan profile (injection, authz gaps, secrets, unsafe deserialization, dependency risks) runnable on demand per PR or per repo.
- R4.5 Runtime validation (beta): optionally runs the PR branch's test command in an isolated container with no network and resource limits; failures are attached to the review.
- R4.6 Enterprise: OIDC and SAML SSO, audit log of admin actions and review events (exportable CSV), BYO LLM endpoint per org (key encrypted at rest), self-host bundle (Docker Compose + docs) that runs with no outbound calls except the configured LLM and git host.

## Phase 5 — Marketing site and docs (original OpenReview design)

- R5.1 Landing page with original copy and visuals: hero, how-it-works (index → parallel review → verification → learning), example findings (clearly labeled; no fabricated customer data), personalization, integrations, security/self-hosting, FAQ, CTA. Passes H1.
- R5.2 Pricing page driven by the same plan config Stripe uses (single source of truth), with a self-hosted option.
- R5.3 Docs site (MDX) covering install, `openreview.json`, rules, learning, CLI, MCP, self-hosting.
- R5.4 Lighthouse ≥ 90 performance and accessibility on landing and pricing (checked in CI via `@lhci/cli`), responsive at 375px and 1440px (Playwright screenshots).

## Phase 6 — Production readiness

- R6.1 Built-in auth: GitHub sign-in (OAuth with state and PKCE), DB-backed sessions in secure HttpOnly cookies, organizations with owner/admin/member roles, invitations, personal workspaces, and server-side role checks on every mutation.
- R6.2 Onboarding wizard: sign in → create or join a workspace → install the GitHub App → select repositories → configure review behavior → live indexing progress → ready state that tells the user to open a pull request.
- R6.3 Rich indexing: languages, functions, methods, classes, interfaces, types, imports, exports, references, package manifests and dependencies, config files, database schemas, routes/endpoints, tests, CI workflows, docs and repo instructions; skips gitignored, generated, vendored, binary, oversized, and secret files; index jobs track state, progress, retries, and changed files.
- R6.4 Code graph: entities for files, modules/packages, functions, classes, methods, routes, schemas, and tests with relations imports, exports, calls, references, extends, implements, depends-on, tested-by, route-to-handler, and schema-to-consumer.
- R6.5 Retrieval engine: hybrid exact-symbol, path, full-text, graph traversal (callers, callees, importers, tests), embeddings, docs, recent changes, historical findings, and rules, returning deduplicated, ranked, token-budgeted context with the reason each item was retrieved.
- R6.6 Review job state machine persisted per run (queued → ingesting → retrieving_context → reviewing → verifying → summarizing → publishing → completed / failed / cancelled), resumable after a restart, cancellable, with per-PR locking so only the newest head commit is reviewed.
- R6.7 Change classification routes each PR to specialized reviewers (correctness, security, data, API compatibility, testing, performance, rules); any reviewer may return zero findings.
- R6.8 Verification judge: every candidate finding is checked against repository context (code accuracy, introduced by the PR, actionable, non-trivial, not already reported or already commented) before publication; rejected candidates are kept with the reason.
- R6.9 Finding model and lifecycle: structured findings (severity, numeric confidence, category, evidence, impact, suggested fix, originating agent, status, fingerprint) tracked across commits; not reposted after line moves; automatically marked resolved when a later commit fixes them.
- R6.10 Finding feedback: useful, not useful, resolved, won't fix, and false positive from the dashboard, API, and GitHub; learned preferences are structured, inspectable, and resettable.
- R6.11 Rules v2: categories, severity, enable/disable, instructions, file patterns, org and repo scope; findings show the rule that produced them.
- R6.12 Knowledge base: automatically generated subsystem entries (description, related files, dependencies, known risks, past findings, conventions, last updating commit), refreshed incrementally after meaningful changes and browsable in the dashboard.
- R6.13 Dashboard: Overview, Repositories, Reviews (with lifecycle detail), Findings (filters by repository, severity, category, status, author, date, usefulness), Knowledge, Rules, Team, Usage, Settings, and Activity, all paginated and tenant-scoped.
- R6.14 Review settings: automatic review, draft behavior, target and ignored branches, ignored paths, max comments, min confidence, min severity, categories, model, review mode, custom instructions, automatic re-review, and comment style, with sensible defaults.
- R6.15 Model gateway: per-task model routing (classify, context, review, verify, summary, chat), retries with backoff, validated structured output, and every call recorded with provider, model, tokens, latency, estimated cost, and error.
- R6.16 Cost controls: embedding cache, safe response cache, token budgets, review cancellation, duplicate suppression, and estimated model cost recorded per pull request.
- R6.17 Follow-up conversations: mentions in PR comments and review threads answer explain, fix, re-review, security review, ignore-pattern, and "what depends on this" requests using repository and review context; threads are persisted.
- R6.18 REST API with org-scoped, hashed API keys: repositories, re-index, reviews, create review, findings, feedback, and rules.
- R6.19 Fix with AI: per-finding portable fix prompts and a "Fix All" task combining every unresolved high-confidence finding, available in the dashboard, API, CLI, and MCP.
- R6.20 Security hardening: secrets encrypted at rest, CSRF/state protection, rate limiting, SSRF guard on user-supplied URLs, log redaction, and prompt-injection separation of untrusted content.
- R6.21 Observability: structured JSON logs with correlation ids (installation, delivery, repository, PR, review, agent); webhook deliveries persisted with their outcome; failures visible in the dashboard.
- R6.22 Demo/local mode: a local git host over a fixture repository and simulated pull request runs the real pipeline end to end without a GitHub App.
- R6.23 End-to-end: on a fixture repository with a known cross-file bug, a PR webhook leads to indexing, context retrieval, review, a verified finding, a published inline comment with a fix, an answered follow-up, and, after a fixing push, an incremental re-review that marks the finding resolved.
- R6.24 Evaluation harness: `pnpm eval` runs documented bug fixtures (auth, authz, null handling, concurrency, data loss, breaking API, query bugs, cross-file logic, missing validation, regressions) and reports true positives, false positives, missed bugs, duplicates, latency, tokens, and estimated cost.
- R6.25 Self-hosting and open-source docs: README, architecture, database, GitHub App setup (including an app manifest), model configuration, deployment, CLI, MCP, troubleshooting, CONTRIBUTING, SECURITY, and LICENSE; Docker images with health checks.
