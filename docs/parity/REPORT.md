# Parity plan report

October 14, 2026 · branch `parity` (local only, not pushed) · baseline `c62023e` · ledger: [PROGRESS.md](PROGRESS.md)

This plan closed the feature gaps listed in `.claude/skills/greptile-parity/ITEMS.md` (H1–F3). It added equivalent functionality, built from public descriptions of how comparable review products behave. No code, prompts, copy or branding were copied. User-facing docs describe OpenReview on its own terms.

## Outcome

| | Count | Items |
|---|---|---|
| Done | 32 | H1–H4, A1–A4, B1–B8, C1–C4, D1–D5, E1–E4, F1–F3 |
| Needs human | 0 | |
| Blocked | 0 | |
| Remaining | 0 | |

Final gate on the last commit:

| Check | Result |
|---|---|
| `pnpm lint` | ✓ (only the 2 pre-existing warnings) |
| `pnpm typecheck` | ✓ |
| `pnpm test` | ✓ 326 Node + 222 vitest tests across 81 `*.test.ts` and 34 `*.spec.ts` files |
| `pnpm build` | ✓ |
| `pnpm test:e2e` | ✓ Playwright Chromium against local Convex and a production `next start`: landing, docs, changelog, onboarding, 25 dashboard pages, saved settings and rules, Memory filters, Chat, 390 px mobile and dark theme, with no console errors |
| `pnpm test:smoke` | ✓ All 23 dashboard routes plus the landing, docs and invite pages server-render against local Convex and a production `next start` |
| `docker build -t openreview:local .` | ✓ on the second approach (see [Docker](#docker)). The built container served `/docs/quickstart`, `/api/health` and `/robots.txt` with 200 |

The baseline had 198 Node and 160 vitest tests.

### What the evidence levels mean

- **Tested with fakes:** automated tests against fake providers, fake models and `convex-test`. No real service was contacted.
- **Verified locally end-to-end:** exercised against a real local Convex backend and a production Next.js server.
- **Verified live:** confirmed against a real provider. No item reached this level in this plan, because live runs spend money or change outward-facing settings, and those are human steps.

### Rules followed throughout

- No live model or embedding calls.
- No pushes, deploys or remote settings changes.
- No secret values read or printed.
- Every new integration is hidden or disabled when its configuration is absent.

### Known flaky test

One test fails intermittently under parallel load and is not a regression: `tests/bridge.test.ts` "dispatch records agent exit failures". It was flaky before this plan (a Node child process SIGSEGVs during parallel spawns), so failing runs were simply rerun. It is flagged as a separate task.

## Per item

Each item lists what shipped, its evidence level, its tests and its known limits. Commit SHAs are in the ledger and in `git log c62023e..parity`.

### Phase H: Foundations

**H1 Baseline** (verified locally)
- Shipped: install, lint, typecheck, test and build all pass on the untouched baseline.
- Tests: the existing suite, 198 Node + 160 vitest.
- Limits: none.

**H2 Git baseline** (verified locally)
- Shipped:
  - `.gitignore` audited.
  - A secret-pattern scan of 413 files found only digests, SHAs and test fixtures.
  - Baseline commit `c62023e` and branch `parity`.
- Tests: none (no code changed).
- Limits: there is no remote yet (checklist step 1).

**H3 Model layer** (tested with fakes)
- Shipped:
  - Native tool calling for Anthropic and OpenAI.
  - JSON-schema structured output, with zod validation and a fallback.
  - Prompt-cache prefixes and breakpoints.
  - Reasoning-token parameters and `LLM_MAX_OUTPUT_TOKENS`.
  - A built-in price table with tiers and operator overrides that fails closed for unknown models.
  - Claude defaults: `claude-sonnet-5-5`, with `claude-haiku-5-5` for summaries.
- Tests:
  - `tests/model-tools.test.ts` (9).
  - +1 each in `tests/inference-budget.spec.ts` and `tests/engine.test.ts`.
- Limits: prices and model IDs were checked against vendor docs on October 14, 2026, and will drift.

**H4 Production runbook** (documentation)
- Shipped: [production-checklist.md](../production-checklist.md), covering:
  - Deployment Protection.
  - URLs and environment variable names.
  - Key rotation.
  - The inference budget.
  - Backups.
  - Final verification.
- Tests: none (documentation only).
- Limits: every step is a human action (checklist steps 2–7).

### Phase A: Engine

**A1 Resilience and scale** (tested with fakes)
- Shipped:
  - Bounded reads and indexing that sweeps first, then finishes.
  - A subtree walk for truncated GitHub trees.
  - Omitted diffs are skipped and the reason is shown.
  - Large pull requests are reviewed risk-first within each mode's budget.
  - Specialists run with `allSettled`, so one failure doesn't sink the review.
  - Skipped files are listed in the summary and the dashboard.
- Tests:
  - `tests/scale.spec.ts`, which covers 33,000 files.
  - `tests/resilience.test.ts` (7).
- Limits: convex-test doesn't enforce Convex read limits, so the bound is proven by construction.

**A2 Agentic reviewer** (tested with fakes)
- Shipped:
  - A tool loop over a tenant-scoped toolbox, with reads consistent with the head commit.
  - Persisted state with checkpoints, so a review suspends and resumes.
  - Per-mode budgets and a `reviewEngine` setting. The default stays `pipeline`.
  - Three multi-hop eval fixtures.
- Tests:
  - `tests/agent.test.ts` (7).
  - `tests/agent-tools.spec.ts`.
  - `tests/agent-toolbox.test.ts`.
- Limits: there is no live quality comparison yet (see [the evaluation plan](#proposed-live-evaluation-pipeline-vs-agentic)).

**A3 Multi-language code graph** (verified locally end-to-end for grammar loading; extraction tested with fakes)
- Shipped:
  - Tree-sitter for 11 languages, with resolved call and import edges.
  - A ranked multi-hop neighbourhood.
  - A regex fallback.
- Tests:
  - `tests/graph.test.ts` (18).
  - `tests/graph.spec.ts`.
- Limits:
  - `web-tree-sitter` is pinned to 0.22.6.
  - WASM tier-up is disabled for Node 24 stability.
  - Hosted loading has not been confirmed yet (checklist step 10).

**A4 Semantic retrieval** (tested with fakes)
- Shipped:
  - Graph-aligned chunks with 1,536-dimension embeddings.
  - An idempotent backfill, with re-embedding when the model changes and cleanup when files are removed.
  - Hybrid ranking across vector, text and graph signals.
  - Embedding status in the dashboard.
- Tests:
  - `tests/hybrid.test.ts` (3).
  - `tests/semantic.spec.ts` (3).
- Limits: embeddings are optional (checklist step 18). Without them, ranking uses text and graph signals only.

### Phase B: Review output

**B1 Committable suggestions** (tested with fakes)
- Shipped: suggestion blocks, validated so that their range matches the finding, sits inside changed lines and matches the head revision.
- Tests: `tests/suggestions.test.ts` (4).
- Limits:
  - Gitea, Bitbucket, Perforce and Origin have no suggestion block.
  - Files with CRLF line endings never get one.

**B2 Multi-line comments** (tested with fakes)
- Shipped: on GitHub, `start_line` is used when a range stays inside one hunk. Otherwise the comment falls back to a single line.
- Tests: `tests/multiline.test.ts` (2).
- Limits: GitLab keeps single-line positions.

**B3 Summary edited in place** (tested with fakes)
- Shipped:
  - One summary comment, found by its marker and PATCHed on later runs.
  - Sections: overview, files changed, issues, confidence score and skipped files.
  - GitLab notes are edited in place.
- Tests:
  - `tests/summary.test.ts` (4).
  - Updated publication, provider and label tests.
- Limits: Gitea, Bitbucket, Perforce and Origin still post one summary per run.

**B4 Sequence diagrams** (tested with fakes)
- Shipped:
  - A grounded diagram schema.
  - Mermaid rendered only by OpenReview, through a validator that rejects directives.
  - Strict client-side rendering, with the source shown as a fallback.
- Tests: `tests/diagrams.test.ts` (4).
- Limits: diagrams appear only for eligible pull requests (2+ components, or related context from the graph).

**B5 Incremental review** (tested with fakes)
- Shipped:
  - Compare-based scoping that falls back to a full review when the branch diverged.
  - Findings anchored against the full diff.
  - Threads started by the bot are resolved through GraphQL once fixed.
- Tests:
  - `tests/incremental.test.ts` (4).
  - `tests/review-history.spec.ts`.
- Limits: GitHub only. Other providers re-review in full and leave threads open.

**B6 Check runs** (tested with fakes)
- Shipped:
  - The `checks:write` permission is detected at runtime.
  - The check is in progress during the review, then completes.
  - The conclusion is configurable: neutral by default, or failure at a severity threshold.
- Tests: `tests/check-runs.test.ts` (3).
- Limits: needs the app permission (checklist step 13).

**B7 Triggers and filters** (tested with fakes)
- Shipped:
  - Automatic, label and mention triggers.
  - Excluded authors and branches, and draft handling.
  - Size limits.
  - Strictness presets and opt-in style and syntax categories.
- Tests:
  - `tests/triggers.test.ts` (7).
  - `tests/trigger-dispatch.spec.ts`.
- Limits: trigger wiring is GitHub-only.

**B8 Configuration as code** (tested with fakes)
- Shipped:
  - `.openreview.json` and `rules.md`, read from the base branch.
  - Nested scoped overrides.
  - Admin `lockedKeys`.
  - Warnings in the summary, and the provenance of each value in settings.
- Tests:
  - `tests/repo-config.test.ts` (4).
  - `tests/repo-config.spec.ts`.
- Limits: 64 KB file cap.

### Phase C: Learning

**C1 Reaction feedback** (tested with fakes)
- Shipped:
  - GitHub reaction polling, on close or merge and in an hourly bounded sweep.
  - GitLab emoji webhooks.
  - Reactions become learned preferences and appear in analytics.
- Tests:
  - `tests/reactions.test.ts`.
  - `tests/reactions.spec.ts` (4).
- Limits:
  - Reactions on the summary comment aren't polled.
  - GitLab needs Emoji events enabled (checklist step 19).

**C2 Learned conventions** (tested with fakes)
- Shipped:
  - Human comments from merged pull requests are ingested.
  - Model extraction with evidence indexes.
  - Clustering, with guardrails.
  - An approval flow, with optional auto-approve.
  - A daily sweep.
- Tests:
  - `tests/conventions.test.ts` (3).
  - `tests/conventions.spec.ts` (2).
- Limits:
  - GitHub only.
  - Extraction makes a real model call in production, which was not run here.

**C3 Memory management** (tested with fakes)
- Shipped:
  - Scopes for repository, team and workspace.
  - Audited admin edits, approval, rejection and deletion.
  - Search and filters.
  - Read-only for viewers.
- Tests: `tests/memory.spec.ts` (4).
- Limits: team scope uses the source repository's team at the time of the edit.

**C4 `@openreview fix this`** (tested with fakes)
- Shipped:
  - A validated suggestion reply with a Fix link.
  - Opt-in fix pull requests from a new `openreview/fix-*` branch that targets the PR branch. Contents write is detected at runtime.
- Tests:
  - `tests/fix-command.test.ts` (6).
  - `tests/fix-command.spec.ts` (4).
- Limits:
  - Fix pull requests are GitHub-only and need Contents write (checklist step 20).
  - Forks are skipped.

### Phase D: Ask your codebase

**D1 Codebase chat** (tested with fakes)
- Shipped:
  - Multi-repository chat. Only the thread owner can see it, and visibility is re-checked on every read.
  - Citations must quote exact lines read in the same run and are pinned to the indexed commit.
  - Investigation steps stream over SSE.
- Tests:
  - `tests/chat.test.ts` (4).
  - `tests/chat.spec.ts` (3).
- Limits: the answer text arrives as one validated block. Only the investigation steps stream.

**D2 Public API** (tested with fakes)
- Shipped:
  - Scoped API keys: read ⊂ write ⊂ admin. Legacy keys keep full access.
  - `POST /api/query` (JSON or SSE) and `GET /api/query/:id`.
  - `POST /api/search`.
  - Repository enable and status endpoints.
  - An OpenAPI document with 11 paths.
- Tests: `tests/public-api.spec.ts` (5).
- Limits: existing routes now return 401 or 403 instead of a generic status. This was a deliberate change.

**D3 Remote MCP** (tested with fakes)
- Shipped: a stateless Streamable HTTP endpoint at `/api/mcp`. Its 11 tools dispatch to the REST handlers, so scopes and tenancy are identical.
- Tests:
  - `tests/mcp.spec.ts` (4).
  - `tests/mcp.test.ts` (updated).
- Limits: JSON responses only, with no server-initiated streams.

**D4 Slack and email** (tested with fakes)
- Shipped:
  - Signed Slack events and commands.
  - OAuth install with an encrypted bot token.
  - Channel notifications, delivered exactly once.
  - Q&A in threads, and `/openreview status`.
  - Email through Resend, sent only to verified addresses.
- Tests:
  - `tests/slack.test.ts` (5).
  - `tests/notifications.spec.ts` (6).
- Limits:
  - Disconnecting deletes the token locally and does not revoke it at Slack.
  - Needs checklist steps 14–15.

**D5 Notion and Confluence** (tested with fakes)
- Shipped:
  - Notion OAuth with refresh and revoke.
  - Shared pages used as requirements, capped at 10 pages and 100 KB.
  - A finished Confluence and Jira resource picker.
- Tests:
  - `tests/notion.test.ts` (3).
  - `tests/notion.spec.ts` (3).
- Limits: needs checklist step 16.

### Phase E: Product

**E1 Billing** (tested with fakes)
- Shipped:
  - Seat-based quotas: a trial, a team plan, a past-due grace period, and lapsed accounts.
  - Signed, idempotent webhooks that tolerate events arriving out of order.
  - Checkout, the customer portal and seat sync.
  - Off unless `BILLING_ENABLED=true`. Live keys are refused unless `BILLING_ALLOW_LIVE=true`.
- Tests:
  - `tests/billing.test.ts` (5).
  - `tests/billing.spec.ts` (4).
- Limits:
  - Stripe was never contacted.
  - Needs checklist step 17.

**E2 Identity** (tested with fakes)
- Shipped:
  - Sign-in with GitHub, GitLab or Google, or by email link.
  - Identities link only through verified email on both sides.
  - Server-side sessions with revoke and sign-out-everywhere.
  - Email invitations.
  - Removing a member revokes their sessions, keys and bridges.
- Tests:
  - `tests/identity.test.ts` (4).
  - `tests/identity.spec.ts` (5).
- Limits:
  - SSO and SAML are deferred.
  - Needs the backfill run (checklist step 9) and OAuth apps (step 21).

**E3 Marketing and docs** (verified locally end-to-end)
- Shipped:
  - A landing page.
  - `/docs`, built from a manifest.
  - `/changelog`.
  - SEO metadata, robots, sitemap and an OG image.
  - Internal QA logs moved to `docs/internal/`.
- Tests: `tests/docs-links.test.ts` (3).
- Limits: docs use Markdown, not MDX.

**E4 UI polish** (verified locally end-to-end)
- Shipped:
  - The dashboard split into one module per section, plus a UI kit.
  - Loading and not-found states.
  - Toast notifications.
  - Analytics rollups and SVG charts.
  - A diff viewer with inline findings.
  - A browserless smoke test.
  - A browser acceptance run in Playwright Chromium. It walks every main and secondary navigation page and checks mobile and dark layouts.
- Evidence: tested with fakes, plus verified locally end-to-end by `pnpm test:smoke` and `pnpm test:e2e`.
- Tests:
  - `tests/charts.test.ts`.
  - `tests/analytics-trends.spec.ts` (3).
  - `tests/diff-view.test.ts` (2).
  - `tests/review-diff.spec.ts` (2).
- Fixed during acceptance: the Analytics chart's screen-reader table made the page 2 px wider than a 390 px phone screen. Tables ignore the width that `.sr-only` sets, so the class now sits on a wrapping element.
- Test changes, both deliberate:
  - The e2e script's navigation walk had used the dashboard's nav names from before the baseline. It now walks the current navigation.
  - Screenshots now wait for page content instead of the loading skeleton.
- Limits: GitHub OAuth sign-in and real indexing aren't exercised in the browser run. They need external credentials.

### Phase F: Providers and handoff

**F1 Azure DevOps** (tested with fakes)
- Shipped:
  - PAT or Entra service-principal auth.
  - Diffs computed locally with Myers.
  - Positioned threads.
  - A single closed summary thread, edited in place.
  - Pull request statuses.
  - Service hooks with a shared secret.
- Tests:
  - `tests/text-diff.test.ts` (3).
  - `tests/azure-devops.test.ts` (4).
  - `tests/azure-devops.spec.ts` (2).
- Limits:
  - No `@openreview` follow-ups or approvals on Azure DevOps.
  - Live run pending (checklist step 23).

**F2 Live-verification runbooks** (documentation)
- Shipped:
  - [docs/runbooks/](../runbooks/README.md) for GitHub Enterprise, GitLab.com, Bitbucket Cloud (Forge), Bitbucket Data Center, Azure DevOps, the Origin fix loop, and every Phase B–D feature.
  - Parity rows in [the acceptance matrix](../acceptance-matrix.md).
- Tests: `tests/docs-links.test.ts` checks that every relative link resolves.
- Limits: the live runs themselves are checklist step 24.

**F3 Fix handoff** (tested with fakes)
- Shipped:
  - "Open in Cursor / Claude Code / Codex" links, using only each agent's documented prompt deep link. The prompt is pre-filled but never sent, and an over-limit prompt falls back to copy.
  - Copy fix prompt on every finding and on the `/fix` page.
  - Bridge protocol registration that can be tested for Linux and Windows.
- Tests:
  - `tests/agent-links.test.ts` (3).
  - `tests/bridge-install.test.ts` (3).
- Limits: real-OS clicks are unverified (checklist step 25).

## Docker

`docker build -t openreview:local .` was attempted twice:

1. **Plain build.** It failed while loading metadata for the pinned `node:24-bookworm-slim` base image (`DeadlineExceeded`). Docker runs on Colima, and the registry was reachable from both the host and the VM (HTTP 401 challenge in about 0.07 s). The cause was `~/.docker/config.json`, which sets `credsStore: desktop`. Docker Desktop isn't running, so the credential helper hangs every pull.
2. **Temporary anonymous Docker config.** This build set `DOCKER_CONFIG` to a scratch directory with no credential store, and `DOCKER_HOST` to the Colima socket, leaving `~/.docker` untouched. It succeeded. A container from the image then served `/docs/quickstart`, `/api/health` and `/robots.txt` with 200.

To build on this machine yourself, either start Docker Desktop or remove `"credsStore": "desktop"` from `~/.docker/config.json`, then run `docker build -t openreview:local .`. This only affects this machine; the Dockerfile is fine.

## Needs-human checklist (priority order)

Steps are grouped by when they're needed. The ledger number for each step is in brackets. Never paste secret values into chat, logs or commits.

### Before anything else

1. **Back up the work** [#1]. The parity commits (`git log c62023e..parity`) exist only on this machine. Create a private remote and push: `git remote add origin <private-url> && git push -u origin main parity`.
2. **Rotate the model key before November 1, 2026** [#2]. Follow production-checklist §4: rotate `LLM_API_KEY` in Convex production. Optionally switch to `LLM_PROVIDER=anthropic` and leave `LLM_MODEL` empty.
3. **Back up Convex before deploying the parity changes** [#7]. Use the dashboard's **Backup Now** with files, or run `npx convex export --prod --include-file-storage --path <private-dir>`.

### Deploy safely

4. **Deployment Protection** [#3]. Apply Standard Protection, or add a custom production domain. Then check that `/api/health` responds while signed out.
5. **URLs** [#4]. Set `APP_URL` to the same value in Vercel and Convex. Update the GitHub App callback, setup and webhook URLs. Redeploy, and confirm a webhook delivery returns 2xx.
6. **Environment variable names** [#5]. Confirm them against production-checklist §3 and `.env.example`. Use a private terminal, because `convex env list --prod` prints values.
7. **Inference budget** [#6]. About $0.12 was unreserved at the audit. Raise it or reconcile it before reviews resume.

### Right after deploying

8. ~~**Install Playwright locally, then run the browser acceptance**~~ [#10, #20]. **Done on October 14, 2026**, and `pnpm test:e2e` passes. Rerun it after UI changes: start `pnpm backend` and `pnpm dev`, run `pnpm test:e2e`, then inspect `output/playwright/*.png`.
9. **Backfill identities** [#19]. Run `npx convex run identity:backfillIdentities --prod` once.
10. **Check the code graph** [#8]. Run `npx convex run graphDiagnostics:status --prod` once to confirm the grammars load. Then re-index repositories.

### Turn on review features

11. **Approve and run the live evaluation** [#13]. See the next section. Do this before changing any engine default.
12. **Run the live runbooks** [#22]. Start with `parity-features.md` on GitHub, then do each provider. Record the results in the acceptance matrix.
13. **Checks permission** [#11]. In the GitHub App, set Checks to Read and write. Installation owners must accept the change; until they do, check runs are skipped.

### Optional integrations

Enable only the ones you want:

14. **Slack** [#15].
15. **Resend email** [#16]. Steps 21's email sign-in and invitations depend on this.
16. **Notion** [#17].
17. **Stripe** [#18]. Cloud deployments only. Use test mode first.
18. **Embeddings** [#9]. Set `EMBEDDING_MODEL` and `EMBEDDING_API_KEY`, then re-index.
19. **GitLab reactions** [#12]. Enable Emoji events on GitLab webhooks.
20. **Fix pull requests** [#14]. In the GitHub App, set Contents to Read and write, then enable "Fix pull requests" for each repository.
21. **More sign-in methods** [#19]. Set up the GitLab and Google OAuth apps, and set `EMAIL_SIGN_IN=true` once step 15 is done.

### Wider acceptance

22. **This machine's Docker** (see [Docker](#docker)). Optional. Start Docker Desktop, or remove the `desktop` credential store from `~/.docker/config.json`, so plain `docker build` works without the workaround.
23. **Azure DevOps live run** [#21].
24. **The remaining provider runbooks** [#22].
25. **Real-OS fix handoff** [#23]. Verify bridge registration on Windows 11 and Ubuntu, and click the "Open in" links on each OS.

The exact sub-steps for each item are in the ledger's "Needs human" section.

## Proposed live evaluation: pipeline vs agentic

**Purpose.** Decide whether the agentic engine (A2) should become the default for any review mode. Today the default is `pipeline` and agentic is opt-in. **Every live step below spends inference budget and needs your explicit approval before it runs.**

### What exists

- `pnpm eval` runs 15 fixtures:
  - 10 seeded single-file and cross-file defects.
  - 2 behaviour-preserving changes, which should produce no findings.
  - 3 multi-hop defects that need cross-file investigation. These were added in A2.
- Fixtures run in `standard` mode.
- `--engine=agentic` switches engines, and `--fixture=<id>` runs a single fixture.
- `pnpm eval --validate` was re-run today. It is free, and all 15 fixtures are valid.
- The last live baseline was a pipeline run on October 3, 2026, with `gpt-4.1` on the 12 original fixtures, recorded in `reports/evaluation-matrix.json`:
  - 10/10 seeded defects matched.
  - Both clean changes produced no findings.
  - It cost $0.33 across all runs.

### Cost estimate

Estimates use the built-in prices for `claude-sonnet-5-5`: $2 per million input tokens and $10 per million output tokens.

| Run | Estimate |
|---|---|
| One pipeline pass (15 fixtures) | About $0.40–0.70 |
| One agentic pass (15 fixtures) | About $1–4 typical. The hard ceiling is about $15, set by the standard budget of 400k tokens and 30 tool calls per review |
| Recommended total (three passes per engine) | **$5–15**. Approve a ceiling of **$20** |

The CLI evaluation does not go through the Convex inference budget. Use a model key with a provider-side spending limit.

### Steps

Each step needs approval before it runs.

1. **Prerequisites.**
   - Checklist step 2 (rotated key).
   - Set `LLM_PROVIDER`, `LLM_MODEL` and `LLM_API_KEY` in `.env.local`. Use the same model for both engines.
   - Commit or stash your work. `reports/evaluation.json` is tracked, and a live run overwrites it.
2. **Pilot (about $1).** Run:
   - `pnpm eval --fixture=multi-hop-currency`
   - `pnpm eval --fixture=multi-hop-currency --engine=agentic`

   Check that the reports are well formed and look at the cost per fixture before you continue.
3. **Full passes.** Run `pnpm eval`, then `pnpm eval --engine=agentic`. After each run, move `reports/evaluation.json` to `reports/eval-<engine>-run<n>.json`. Repeat 3 times per engine to see run-to-run variance.
4. **Measure each engine on:**
   - Recall on seeded defects.
   - Multi-hop recall.
   - Findings on clean changes (false positives).
   - Duplicate findings.
   - Unscored provider or schema failures.
   - Partial agentic runs that exhausted their budget.
   - Cost per fixture and wall time.
5. **Adjudicate by hand.** The automated score is only a keyword and location heuristic. Read every finding, and record whether it's real, which line it's on and whether its evidence quote is accurate.
6. **Decide.** Make agentic the default for a mode only if all of these hold:
   - It matches every seeded defect the pipeline matches.
   - It finds at least 2 of the 3 multi-hop defects that the pipeline misses.
   - It adds no false positives on the clean changes.
   - Its median cost is at most 3× the pipeline's.

   Otherwise keep `pipeline` as the default and document agentic as an opt-in for `deep` mode. Record the decision under Decisions in the ledger and in the acceptance matrix.

Do not describe review quality publicly until step 5 is done.
