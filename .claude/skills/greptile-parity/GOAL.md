# Running the parity plan with `/goal`

Claude Code's built-in `/goal <condition>` keeps Claude working turn after turn until a judge model decides the condition is met. The condition is capped at 4,000 characters, so it points at the `greptile-parity` skill, which holds the full spec (`SKILL.md`, `CONTEXT.md`, `ITEMS.md`). Progress persists in `docs/parity/PROGRESS.md`, so any session or agent can resume.

## Paste this into Claude Code, opened at the repository root

```
/goal Bring this repository (OpenReview) to Greptile-level functionality by completing every item H1–F3 in .claude/skills/greptile-parity/ITEMS.md. At the start of each turn, invoke the greptile-parity skill (or read .claude/skills/greptile-parity/SKILL.md) and follow its ground rules exactly; resume from the ledger docs/parity/PROGRESS.md (create it on the first turn). Work one item at a time in order: plan in the ledger, implement with tests, pass `pnpm lint && pnpm typecheck && pnpm test` (plus `pnpm build` for UI changes and at each phase end), then commit locally on branch `parity` and record evidence in the ledger. Never push, deploy, change GitHub/Vercel/Stripe/Slack/Azure settings, run live model or eval calls, or print secret values; write those as exact steps under "Needs human" and continue with unblocked items. Make reversible decisions yourself and log them under "Decisions" instead of waiting for me. End every turn with the line: PARITY STATUS — done: N | needs-human: N | blocked: N | remaining: N | gate: lint ✓|✗ typecheck ✓|✗ test ✓|✗ build ✓|✗ | next: <id>. The goal is met only when the latest PARITY STATUS shows remaining: 0 with every gate ✓, every blocked item has a documented reason and two attempted approaches, and docs/parity/REPORT.md has been written and committed. Or stop after 150 turns.
```

## Controls
- **Show goal status:** `/goal`.
- **Stop:** `/goal clear`.
- **Ledger summary without changing anything:** `/greptile-parity status`.
- **Smaller runs without `/goal`:** `/greptile-parity H` (one phase) or `/greptile-parity B3` (one item).
- **Headless run:** `claude -p "/goal …"` with the same text. `--continue` / `--resume` restore an active goal.
- **Turn limit:** "150 turns" is a safety cap. Raise it, or narrow the goal to one phase ("…completing every item in phase A…"), to control spend.

## Other agents (Codex, Cursor, etc.)
Paste the text after `/goal` as the task prompt. The skill files are plain Markdown that any agent with repository access can read. The `$ARGUMENTS` placeholder in `SKILL.md` counts as empty when the file is pasted rather than invoked.

## Before you start
- Expect a long, token-heavy run. Opus-class models do best on phases A, B and D.
- Permission prompts pause autonomous runs; choose a permission mode you're comfortable with.
- The agent stops short of anything outward-facing (push, deploy, account settings, live model spend). Those collect under "Needs human" in the ledger for you to do.
