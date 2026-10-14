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
- [ ] A1 Resilience and scale — todo
- [ ] A2 Agentic reviewer — todo
- [ ] A3 Multi-language code graph — todo
- [ ] A4 Semantic retrieval — todo
- [ ] B1 Committable suggestions — todo
- [ ] B2 Multi-line comments — todo
- [ ] B3 Summary redesign, edited in place — todo
- [ ] B4 Sequence diagrams — todo
- [ ] B5 Incremental review and thread hygiene — todo
- [ ] B6 Check runs — todo
- [ ] B7 Triggers and comment types — todo
- [ ] B8 Repo config as code — todo
- [ ] C1 Reaction feedback — todo
- [ ] C2 Learn from human reviewers — todo
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

## Decisions (date — decision — reason)
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
