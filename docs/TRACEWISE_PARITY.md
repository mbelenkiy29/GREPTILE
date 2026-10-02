# Tracewise — Feature Parity Spec

Reference product: Greptile (AI PR reviewer with full-codebase context).
Goal: **functional parity**, not a copy. Tracewise has its own name, brand, copy, and visuals.

## Hard rules (apply to every phase)

- H1. Never use Greptile's name, logo, mascot, wordmark, screenshots, images, page copy, customer logos, or testimonials anywhere in the product or site. Do not scrape or download assets from greptile.com. All marketing copy is written fresh for Tracewise; no fake testimonials or fake customer logos.
- H2. Stack: Next.js (App Router) + TypeScript (strict), PostgreSQL + pgvector, Drizzle, Clerk (auth + orgs), Stripe (billing), BullMQ + Redis (jobs), Docker Compose. Target host: a single DigitalOcean Droplet.
- H3. Every feature ID below has at least one automated test (unit, integration, or Playwright e2e) whose name starts with the ID, e.g. `test("R3.2 posts inline comments...")`.
- H4. LLM calls go through one provider abstraction (`lib/llm`) so models are swappable (Anthropic default, OpenAI-compatible and self-hosted endpoints supported). Tests use a recorded/fake provider, never live keys.
- H5. No secrets in the repo. `.env.example` lists every variable.
- H6. `pnpm verify:parity` runs typecheck, lint, all tests, and `next build`, then prints one line per feature ID as `PASS <ID>` or `FAIL <ID> <reason>`, then a final line `PARITY <phase>: <passed>/<total> PASS`. It exits 0 only if every ID in the requested phase passes.

---

## Phase 1 — Core review loop

- R1.1 GitHub App install flow: org connects GitHub, selects repos; installation stored per Clerk org (multi-tenant isolation enforced in every query).
- R1.2 Webhook receiver verifies signatures and enqueues jobs for `pull_request` (opened, synchronize, reopened) and `issue_comment` events; idempotent on redelivery.
- R1.3 Repo indexer: clones repo, parses with tree-sitter (at least TS/JS, Python, Go, Java, Rust, C#), builds a graph of files → symbols → call/import edges in Postgres, plus pgvector embeddings for symbol chunks. Incremental re-index on push to default branch.
- R1.4 Review engine: for a PR diff, retrieves impacted symbols beyond the diff via the graph (callers, callees, importers), then runs parallel reviewer agents (logic/bugs, security, style/conventions) and a final dedupe/ranking pass.
- R1.5 Output to the PR: one summary comment (what changed, risk level, a confidence score 1–5, a Mermaid sequence diagram when the change spans 3+ components) plus inline comments on specific lines with suggested fixes as GitHub suggestion blocks.
- R1.6 Re-review on new commits updates the summary in place and does not duplicate already-posted inline comments.
- R1.7 `@tracewise` mention in a PR comment triggers a reply that answers the question with codebase context.
- R1.8 Dashboard: list of repos (index status), list of reviews (PR, status, comment count, credits used), review detail page.

## Phase 2 — Personalization

- R2.1 Custom rules written in plain English, scoped org-wide or per repo (glob paths supported); rules are injected into review prompts and cited in comments that enforce them.
- R2.2 Repo config file (`tracewise.json` in repo root) for rules, ignore paths, strictness, and comment types; repo file overrides dashboard settings.
- R2.3 Context files: users can point to docs in the repo (e.g. `CONTRIBUTING.md`, ADRs) that are always included as review context.
- R2.4 Learning: thumbs-up/down reactions and reply text on Tracewise comments are recorded; suppressed patterns stop recurring; accepted patterns raise priority. A "Learned" page shows inferred conventions and lets users edit/delete them.
- R2.5 Learning from human reviewers: comments by teammates on PRs are mined into candidate rules that a user can approve.

## Phase 3 — Developer integrations

- R3.1 "Fix in IDE" link on every inline comment: copies a ready-to-paste prompt (file, line, issue, suggested fix) for Claude Code / Cursor / Codex.
- R3.2 MCP server exposing tools: list open review comments for a PR, get comment detail, mark resolved, trigger re-review.
- R3.3 Claude Code plugin (slash command + skill) that pulls unresolved Tracewise comments for the current branch and fixes them.
- R3.4 `/traceloop` command: agent loop that pushes, waits for review, fixes comments, repeats until no unresolved comments or a max-iteration cap.
- R3.5 `tracewise` CLI (npm package): auth, `review` on local diff against base branch, `status` for a PR.
- R3.6 GitLab support (MR webhooks, inline discussions) and Bitbucket Cloud support behind the same provider interface as GitHub.
- R3.7 Public "Paste a PR" page: paste a public GitHub PR URL, get a rate-limited demo review (no account required, abuse-protected).

## Phase 4 — Review tiers, billing, enterprise

- R4.1 Review depth tiers (Tracewise names, e.g. Standard / Deep / Max) with different agent counts, context budgets, and models; each consumes a configurable number of credits.
- R4.2 Stripe billing: free plan (1 active developer, monthly credit allowance), paid per-seat plan with included credits per seat, metered overage credits. "Active developer" = PR author reviewed in the billing period.
- R4.3 Usage page: credits used per repo/author/day; hard cap and alert thresholds.
- R4.4 Security review mode: dedicated scan profile (injection, authz gaps, secrets, unsafe deserialization, dependency risks) runnable on demand per PR or per repo.
- R4.5 Runtime validation (beta): optionally runs the PR branch's test command in an isolated container with no network and resource limits; failures are attached to the review.
- R4.6 Enterprise: SAML/OIDC SSO via Clerk, audit log of admin actions and review events (exportable CSV), BYO LLM endpoint per org, self-host bundle (Docker Compose + docs) that runs with no outbound calls except the configured LLM and git host.

## Phase 5 — Marketing site and docs (original Tracewise design)

- R5.1 Landing page with original copy and visuals: hero, how-it-works (index → parallel review → learning), example findings (from Tracewise's own runs on public open-source PRs, linked), personalization, integrations, security/enterprise, FAQ, CTA. Passes H1.
- R5.2 Pricing page driven by the same plan config Stripe uses (single source of truth).
- R5.3 Docs site (MDX) covering install, `tracewise.json`, rules, learning, CLI, MCP, self-hosting.
- R5.4 Lighthouse ≥ 90 performance and accessibility on landing and pricing (checked in CI via `@lhci/cli`), responsive at 375px and 1440px (Playwright screenshots).
