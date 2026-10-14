# Parity ledger
Updated: 2026-10-14 · Branch: parity · Baseline: c62023e

## Items
- [x] H1 Baseline — done
  evidence: verified locally; commands: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all exit 0 | notes: no H1a fix needed (2 pre-existing lint warnings in tests/index-skips.spec.ts, not errors).
- [x] H2 Git baseline — done
  evidence: verified locally; `.gitignore` covers `.env*` (!.env.example), output/, .convex/, .vercel/, node_modules/, .next/, *.tsbuildinfo; secret scan of 413 files (private-key blocks, sk-/ghp_/ghs_/gho_/github_pat_/xox*/AKIA/whsec_/JWT/Convex deploy keys/assigned secrets, long tokens) found only image digests, commit SHAs, deployment IDs and test fixture literals; commit: c62023e on main; branch `parity` created.
- [ ] H3 Model layer modernization — todo
- [ ] H4 Production-readiness runbook — todo
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

## Decisions (date — decision — reason)
- 2026-10-14 — The baseline commit includes `.claude/skills/greptile-parity/` — the plan must travel with the repo so any agent can resume.

## Baseline (H1 results, test counts)
- Node 24.7.0, pnpm 11.1.2. `pnpm install --frozen-lockfile` OK.
- lint: 0 errors, 2 warnings (tests/index-skips.spec.ts:26 unused destructured `_id`, `_creationTime`).
- typecheck: OK.
- test: 198 Node tests (tsx --test) + 160 vitest tests in 13 files = 358, all pass.
- build: `next build` OK (dashboard route 58.4 kB first-load 164 kB).
