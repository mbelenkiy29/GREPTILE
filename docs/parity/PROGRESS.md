# Parity ledger
Updated: 2026-10-14 · Branch: parity · Baseline: c62023e

## Items
- [x] H1 Baseline — done
  evidence: verified locally; commands: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all exit 0 | notes: no H1a fix needed (2 pre-existing lint warnings in tests/index-skips.spec.ts, not errors).
- [x] H2 Git baseline — done
  evidence: verified locally; `.gitignore` covers `.env*` (!.env.example), output/, .convex/, .vercel/, node_modules/, .next/, *.tsbuildinfo; secret scan of 413 files (private-key blocks, sk-/ghp_/ghs_/gho_/github_pat_/xox*/AKIA/whsec_/JWT/Convex deploy keys/assigned secrets, long tokens) found only image digests, commit SHAs, deployment IDs and test fixture literals; commit: c62023e on main; branch `parity` created.
- [x] H3 Model layer modernization — done
  plan: runTools on ModelProvider (optional member, Anthropic+OpenAI native); native structured output with zod fallback; context prefix + cache_control; reasoning token param + LLM_MAX_OUTPUT_TOKENS; price table w/ overrides & tiers; Claude defaults.
  evidence: tested with fakes; tests: tests/model-tools.test.ts (9: tool round trips both adapters, thinking replay, breakpoint placement, structured output + 400 fallback, prefix stability on repair, reasoning param, defaults, price table fail-closed/tiers/overrides, cache receipts), tests/inference-budget.spec.ts (+1 cache settle/idempotency), tests/engine.test.ts (+1 specialists share prefix); commands: lint/typecheck/test green (208 Node + 161 vitest); commit: 12b12b0
  notes: deliberately updated test accessors (engine/linear/perforce-depot/pipeline/p4-index) to read the specialist payload from `request.context`, and tests/model.test.ts now expects `json_schema` for provider openai. Prices/IDs checked against official docs 2026-10-14.
- [x] H4 Production-readiness runbook — done (prepare only)
  evidence: docs/production-checklist.md (Deployment Protection scope per current Vercel docs, APP_URL/GitHub App URLs, env names for Vercel+Convex, model-key rotation before 2026-11-01, inference budget, Convex backups with verified CLI flags, final verification); linked from docs/deployment.md; human steps 2–7 below.
- [x] A1 Resilience and scale — done
  plan: data() without inventory + filesByPath/filePage/filesUnder; sweep-then-finish indexing; GitHub subtree walk; omitted diffs → skipped; risk-ranked per-mode budgets + context trimming; allSettled specialists; skipped files in summary/dashboard.
  evidence: tested with fakes (+ convex-test at 33,000 files); tests: tests/scale.spec.ts (above-ceiling repo: bounded pages, path lookups, batch sweep, finishIndex), tests/resilience.test.ts (7: truncated tree walk, untruncated single call, omitted diffs, 600-file PR, context-budget trimming, one/all specialists failing + cancellation, ignored paths); commands: lint/typecheck/test (215 Node + 162 vitest)/build green; commit: db71bf0
  notes: convex-test doesn't enforce Convex read limits — the test proves every query is bounded by construction. Deliberately updated: finishIndex callers in tests use the sweep protocol (no `paths`); diagnostics toEqual includes new empty arrays. Grounding now uses the reviewed diff, so findings can't anchor on ignored/skipped files.
- [x] A2 Agentic reviewer — done (default stays pipeline)
  plan: engine tool loop + memory toolbox; reviewChange options; Convex tenant-scoped tool queries + head-consistent reads; persisted state, waiting_agent resume, checkpoints; reviewEngine setting; multi-hop fixtures.
  evidence: tested with fakes; tests: tests/agent.test.ts (7: multi-hop via find_references with evidence from a tool-read file, shared gates suppress ungrounded, budget exhaustion partial, cancellation mid-loop, suspend/resume without repeated calls + revision mismatch, injection cannot alter tools/budgets/permissions, provider fallback), tests/agent-tools.spec.ts (tenant isolation across 6 tool queries; state save/replace/stale/suspend/attempts/cleanup), tests/agent-toolbox.test.ts (head-consistent reads); `pnpm eval --validate` passes with 3 multi-hop fixtures (not run live); commands: lint/typecheck/test (223 Node + 164 vitest)/build green; commit: 5d5690d
  notes: tests/cli.test.ts now derives the fixture count from scripts/fixtures.ts (deliberate: 3 fixtures added). Pre-existing load-dependent flake seen once in tests/bridge.test.ts ("dispatch records agent exit failures…"), passes 3/3 in isolation.
- [x] A3 Multi-language code graph — done
  plan: tree-sitter loader (lazy, fallback) + per-language extraction/resolution; resolved edge storage; ranked multi-hop neighborhood (Convex + memory); wire into retrieval and agent tools; bump index version.
  evidence: verified locally end-to-end for WASM loading (all 11 grammars load and parse inside a local Convex Node action via `npx convex run graphDiagnostics:status`); extraction tested with fakes; tests: tests/graph.test.ts (18: grammar load, one fixture per language with symbols + resolved edges, visibility, resolution edge cases, regex fallback, TS call resolution, multi-hop ranking/bounds/packages, agent related files), tests/graph.spec.ts (Convex neighborhood: 2 hops, package expansion, legacy raw calls ignored, tenant isolation); commands: lint/typecheck/test (241 Node + 165 vitest)/build green; commit: 2b1885e
  notes: web-tree-sitter ≥0.25 cannot load the tree-sitter-wasms builds (dylink format) → pinned 0.22.6. Node 24 crashes (Zone OOM) tiering up large grammar WASM → loader sets --no-wasm-tier-up --no-wasm-dynamic-tiering (stress-tested). Dashboard now imports fixPrompt from src/fix-prompt directly to keep the parser out of the web bundle.
- [x] A4 Semantic retrieval — done
  plan: semantic chunks from graph symbols; chunkEmbeddings table (1,536); idempotent backfill + model-change re-embed + removal cleanup; hybrid rank (vector/text/graph) in review retrieval and agent search; dashboard status.
  evidence: tested with fakes; tests: tests/hybrid.test.ts (3: chunk boundaries/coverage/windowing, hybrid ranking with fake cosine embeddings, embeddings-disabled ranking), tests/semantic.spec.ts (3: backfill once per blob+model with cost recorded, re-index makes no provider calls, model change re-embeds, file removal deletes vectors, embeddings-off indexing makes no calls + status off, chunk hits tenant filter); commands: lint/typecheck/test (244 Node + 168 vitest)/build green; commit: 97e1f8c
  notes: deliberately migrated tests/backend.spec.ts embedding assertions to the chunk API (same superseded-job and graph-only-upgrade properties). Legacy file-level `embeddings` rows are never written again and are deleted when their file is re-embedded or removed.
- Phase A end: `pnpm build` green; `pnpm test:e2e` not run — Playwright Chromium is not installed and downloading it needs approval (Needs human).
- [x] B1 Committable suggestions — done
  plan: optional finding.suggestion; validate range=finding range, inside changed lines, original==head; render GitHub/GitLab syntax; drop+note on failure.
  evidence: tested with fakes; tests: tests/suggestions.test.ts (4: validation incl. stale range, GitHub/GitLab rendering, engine keeps finding/drops stale suggestion, GitHub publish body); commit: ec1c95d
  notes: Gitea/Bitbucket/Perforce/Origin render no suggestion block (no native apply support). `changedLines` moved to src/engine/patch-lines.ts (pure) so default-runtime Convex modules stay Node-free.
- [x] B2 Multi-line comments — done
  plan: commentRange within one hunk's RIGHT side → start_line/start_side, else single line; mapping accepts start_line.
  evidence: tested with fakes; tests: tests/multiline.test.ts (2: hunk range rules incl. context lines/cross-hunk/out-of-hunk; GitHub publish with multi-line + fallback + suggestion rendering + mapping); commands: lint/typecheck/test (250 Node + 168 vitest) green; commit: see git log feat(B2)
  notes: GitLab keeps single-line positions (its suggestion syntax already spans lines relative to the commented line).
- [x] B3 Summary redesign, edited in place — done
  plan: GitHub upsertSummary (issue comment by marker, PATCH) + review only for findings; GitLab note PUT; new section renderers + skipped key + Last reviewed commit; per-file summaries in schema; preview/label updates.
  evidence: tested with fakes; tests: tests/summary.test.ts (4: full-markdown snapshot, toggles + coverage fallback + link safety + row cap, file-summary validation, GitHub edit-in-place replay across runs/retries/spoofed/legacy duplicates); updated tests/publication.test.ts (one summary across run+replay), tests/providers.test.ts (GitLab second run edits note), tests/github.test.ts, engine/pipeline/resilience label tests; commands: lint/typecheck/test (254 Node + 168 vitest)/build green; commit: 6f3cfc4
  notes: deliberate label changes ("Overview", "Files changed", "Issues", "Confidence score", new "Skipped files"); saved settings without "skipped" still list skipped files inside Coverage. Gitea/Bitbucket/Perforce/Origin keep per-run summaries. Known pre-existing flake (Node child SIGSEGV under parallel spawns) in tests/bridge.test.ts flagged as a separate task.
- [x] B4 Sequence diagrams — done
  plan: eligibility (≥2 components or graph-related context); structured diagram schema with exact-quote evidence; OpenReview renders restricted Mermaid + validator; "diagram" summary key (default on); dashboard renders via lazily loaded mermaid@11.17.2 (strict) with source fallback; stub removed.
  evidence: tested with fakes; tests: tests/diagrams.test.ts (4: grounded schema accept/reject, sanitization + validator rejects injected directives, eligibility, engine generation/omission/null/toggle); updated engine FixtureModel (answers diagram:null), section-count assertions; commands: lint/typecheck/test (258 Node + 168 vitest)/build green; commit: see git log feat(B4)
- [x] B5 Incremental review and thread hygiene — done
  plan: Scm.compare + incrementalDiff (ahead → new commits ∩ PR files; diverged/behind/incomplete → full) + fullDiff anchoring; Scm.resolveFindingThreads via GraphQL reviewThreads + REST reply (marker) + resolveReviewThread for bot-started threads; reviews.previousHead / findingCommentIds queries.
  evidence: tested with fakes; tests: tests/incremental.test.ts (4: scope decisions, fullDiff anchoring + summary uses full PR, compare parsing/completeness, thread hygiene bot-only + idempotent), tests/review-history.spec.ts (previous head + scoped comment ids); commands: lint/typecheck/test (262 Node + 169 vitest) green; commit: see git log feat(B5)
  notes: GitLab/Gitea/Bitbucket keep full re-reviews and leave threads open (no compare capability wired); documented in README.
- [x] B6 Check runs — done
  plan: capture granted permissions from the installation token; start/complete check run only with checks:write; checkFailureSeverity setting (off → neutral; threshold → failure/success); store check id per review; complete on success, resumed publication and failure.
  evidence: tested with fakes; tests: tests/check-runs.test.ts (3: conclusion mapping, write vs read permission behaviour, installation validation unchanged + permissions exposed); commands: lint/typecheck/test (265 Node + 169 vitest)/build green; commit: see git log feat(B6)
- [x] B7 Triggers and comment types — done
  plan: pure pullRequestTrigger (automatic/label/excluded authors/branch/draft) wired into webhookJobs incl. `labeled`; review.trigger field (automatic/label/mention/manual); size limits cancel automatic reviews; strictness presets → thresholds; style/syntax opt-in categories with conditional prompt; settings across scopes/forms/UI.
  evidence: tested with fakes; tests: tests/triggers.test.ts (7: automatic, mention-only, labels, excluded authors/branches/drafts, size limits, strictness, inheritance), tests/trigger-dispatch.spec.ts (signed webhook → label trigger, labelled synchronize, excluded author, unlabelled synchronize); commands: lint/typecheck/test (272 Node + 170 vitest)/build green; commit: see git log feat(B7)
  notes: "only on @mention" = Automatic reviews off (existing `@openreview review` command) — UI label clarified. GitHub-only wiring; other providers unchanged (documented).
- [x] B8 Repo config as code — done
  plan: shared src/repo-config.ts (strict schema, rules.md, nested scoped overrides, 64 KB cap) loaded at the PR base sha (server) / base commit (CLI); applyRepoConfig with admin lockedKeys; warnings → summary coverage + repository.configFile snapshot; settings page shows effective value + source; lock controls on scopes and repo.
  evidence: tested with fakes; tests: tests/repo-config.test.ts (4: base-branch sourcing, precedence + locks + scoped instructions, invalid/oversized files, rules.md parsing), tests/repo-config.spec.ts (Convex review job: base config applied, head edits ignored, lock respected, invalid file warning in summary, snapshot + provenance); commands: lint/typecheck/test (276 Node + 171 vitest)/build green; commit: see git log feat(B8)
- Phase B end: `pnpm build` green; `pnpm test:e2e` still blocked on the Playwright browser install (Needs human #10).
- [x] C1 Reaction feedback — done
  plan: commentReactions mirror; Github.reactions polling (on close/merge + hourly bounded sweep with reactionsSyncedAt); GitLab emoji webhook; shared recordFindingFeedback (dashboard + reactions) → learned preferences; analytics counts.
  evidence: tested with fakes; tests: tests/reactions.test.ts (GitHub pagination/bot/emoji filtering), tests/reactions.spec.ts (4: mirror + dedup + once-per-user feedback + removal, sync/sweep selection, GitLab award/revoke, analytics aggregation); commands: lint/typecheck/test (277 Node + 175 vitest)/build green; commit: see git log feat(C1)
  notes: summary-comment reactions are not polled (finding comments only). GitLab needs "Emoji events" enabled on the project webhook (Needs human).
- [x] C2 Learn from human reviewers — done
  plan: Github.mergedReviewComments (incremental cursor, ≤10 merged PRs/run, humans only); usableComments filter; model extraction with evidence indexes (fake-model tested); clusterConventions + similarity merge; conventionProblem guardrails; learnedRules (suggested/approved/rejected/disabled) with evidence + frequency; decide mutation (admin, audited); autoApproveConventions setting; approved conventions → review preferences; daily sweep.
  evidence: tested with fakes; tests: tests/conventions.test.ts (3: guardrails, clustering/similarity, input filtering + evidence validation), tests/conventions.spec.ts (2: ingestion → guarded suggestion with evidence/frequency + cursor + usage + merge on next batch; approval flow with viewer denial, audit, rejected stays rejected, auto-approve); commands: lint/typecheck/test (280 Node + 177 vitest)/build green; commit: see git log feat(C2)
  notes: extraction makes a real model call per batch in production (not run here). GitHub only; other providers lack mergedReviewComments.
- [ ] C3 Memory management — todo
- [ ] C4 `@openreview fix this` — todo
- [ ] D1 Codebase chat (web) — todo
- [ ] D2 Public query API — todo
- [ ] D3 Remote MCP — todo
- [ ] D4 Slack and notifications — todo
- [ ] D5 Notion and Confluence — todo
- [ ] E1 Billing — todo
- [ ] E2 Identity — todo
- [ ] E3 Marketing and docs — todo
- [ ] E4 UI polish — todo
- [ ] F1 Azure DevOps — todo
- [ ] F2 Live-verification runbooks — todo
- [ ] F3 Fix handoff — todo

## Needs human (ordered, exact steps)
1. (H2) Create a private Git remote and push: `git remote add origin <private-url> && git push -u origin main parity`.
2. (H4) Before 2026-11-01: rotate the model key in Convex production (`LLM_API_KEY`) per docs/production-checklist.md §4; optionally switch to `LLM_PROVIDER=anthropic` with empty `LLM_MODEL`.
3. (H4) Vercel → openreview → Settings → Deployment Protection → scope **Standard Protection** (or add a custom production domain) per §1; verify `/api/health` signed-out.
4. (H4) Set `APP_URL` identically in Vercel and Convex; set GitHub App callback/setup/webhook URLs per §2; redeploy; confirm a 2xx webhook delivery.
5. (H4) Confirm Vercel/Convex env var names per §3 (dashboard; `convex env list --prod` prints values — private terminal only).
6. (H4) Raise/reconcile the inference budget per §5 (≈$0.12 unreserved at audit).
7. (H4) Take a Convex backup (dashboard **Backup Now** with files, or `npx convex export --prod --include-file-storage --path <private-dir>`) before deploying parity changes (§6); then run §7 verification.
8. (A3) After deploying, run `npx convex run graphDiagnostics:status --prod` once to confirm tree-sitter grammars load in the hosted Node runtime; re-index repositories (INDEX_GRAPH_VERSION 4 reparses graph data automatically on the next index job).
9. (A4) Optional: set `EMBEDDING_MODEL` (e.g. `text-embedding-3-small`) and `EMBEDDING_API_KEY` in Convex production, then re-index enabled repositories to backfill chunk embeddings; the repository settings page shows the status.
10. (Phase A) Approve installing the Playwright browser so `pnpm test:e2e` can run locally: `pnpm exec playwright install chromium` (downloads Chromium, ~150 MB, from the Playwright CDN into ~/Library/Caches/ms-playwright).
11. (B6) GitHub App settings → Permissions → Repository permissions → **Checks: Read and write** → Save; each installation owner must accept the updated permissions (GitHub emails them / Settings → Applications → Configure). Until accepted, check runs are skipped silently.
12. (C1) GitLab connections: in each project's Settings → Webhooks, enable **Emoji events** on the OpenReview hook so 👍/👎 reactions arrive (GitHub reactions are polled automatically).
13. (A2) Approve and run a live pipeline-vs-agentic evaluation before switching any default: `pnpm eval` and `pnpm eval --engine=agentic` (spends inference budget; compare reports/evaluation*.json, adjudicate by hand).

## Decisions (date — decision — reason)
- 2026-10-14 — Grammar source: tree-sitter-wasms 0.1.13 on web-tree-sitter 0.22.6 (newest runtime that loads those builds) rather than 11 separate grammar packages — one pinned package covers every required language; revisit when a maintained multi-grammar build for the 0.25+ ABI exists.
- 2026-10-14 — Calls resolve at index time only via same-file definitions, named imports and imported qualifiers (no cross-file symbol table during per-file batches); Kotlin top-level functions and Go packages resolve to package directories that traversal expands.
- 2026-10-14 — Parser packages ship as Convex node externalPackages (installed, ~50 MB) and load through literal dynamic imports so the Convex bundler registers them.
- 2026-10-14 — Agentic resume uses a `waiting_agent` review status + per-review state blob (saved every turn) and a soft step deadline (AGENT_STEP_SECONDS=420) instead of a separate job table — reuses the existing review lifecycle, recovery sweep and retry semantics; resumes capped at 6.
- 2026-10-14 — Agent budgets count uncached input + output tokens (cache reads excluded) because every turn re-sends the cached review payload.
- 2026-10-14 — Agent tool results from the index are labelled with the indexed SHA; read_file always resolves to the PR head tree so cited evidence matches the reviewed revision.
- 2026-10-14 — Agentic CLI (`src/cli.ts`) support deferred; the engine is available to server reviews and `pnpm eval --engine=agentic`.
- 2026-10-14 — Review file limits per mode: fast 200, standard 350, deep 500 (was a hard failure above 500 for all modes); payload stays capped at 300 KB with lowest-risk trimming — keeps cost bounded while never failing outright.
- 2026-10-14 — Rules and learned preferences in repositories.data are capped at 1,000 rows each (newest preferences first) — bounded reads; real deployments are far below this.
- 2026-10-14 — `pnpm test:e2e` runs at the end of each phase rather than after every small dashboard change, since it needs both local dev servers.
- 2026-10-14 — Anthropic structured output uses `output_config.format` (GA, no beta header), not forced tool use — forced tool_choice conflicts with always-on adaptive thinking on Claude 5.x.
- 2026-10-14 — Specialists share one system prompt; the review payload moves to `ModelRequest.context` (a stable prefix) and the category goes in a small trailing `assignment` input — lets 7 specialist calls share one cache write instead of 7 full-price inputs. Repairs are appended after the prefix on Anthropic.
- 2026-10-14 — `runTools` is an optional `ModelProvider` member so existing fake providers compile; agentic callers must fall back when absent.
- 2026-10-14 — Haiku 5.5's >100k-token tier is chosen from the reservation ceiling (request bytes); settlement reuses the reserved price — may over-count budget for mid-size prompts, never under-count.
- 2026-10-14 — gpt-5.4/5.5 (context-tiered at 272k) are not built-in prices; operators can add them via INFERENCE_PRICES.
- 2026-10-14 — Display cost now falls back to the built-in price table when LLM_*_COST_PER_MILLION is 0 (previously reported 0).
- 2026-10-14 — Default output limit is 16000 for Claude/reasoning models because thinking tokens count toward max_tokens; 6000 otherwise (unchanged).
- 2026-10-14 — The baseline commit includes `.claude/skills/greptile-parity/` — the plan must travel with the repo so any agent can resume.

## Baseline (H1 results, test counts)
- Node 24.7.0, pnpm 11.1.2. `pnpm install --frozen-lockfile` OK.
- lint: 0 errors, 2 warnings (tests/index-skips.spec.ts:26 unused destructured `_id`, `_creationTime`).
- typecheck: OK.
- test: 198 Node tests (tsx --test) + 160 vitest tests in 13 files = 358, all pass.
- build: `next build` OK (dashboard route 58.4 kB first-load 164 kB).
