# openreview CLI

Review the changes on your branch before you open a pull request, from the terminal or from a coding agent. The
CLI runs the same review engine as an OpenReview server, in one of two modes:

- **Server mode** (default when you are logged in and the repository is connected): the diff and the changed files are
  sent to your OpenReview server, which reviews them against its index of the whole repository, with your
  organization's settings, rules, and learned preferences. Nothing is posted to GitHub.
- **Local mode** (`--local`, or automatically when you are not logged in): the CLI indexes your checkout into an
  embedded database in `.openreview/` and runs the review on your machine with your own model key. No OpenReview
  server is involved.

Requires Node.js 22 or newer and `git`.

## Install

```sh
npm i -g openreview
# or run it without installing
pnpm dlx openreview review
npx openreview review
```

## Quick start

```sh
openreview login --server https://openreview.example.com   # approve in the browser
cd your-project
openreview review                                           # review this branch against main
```

Without a server:

```sh
export ANTHROPIC_API_KEY=…
openreview review --local
```

## Commands

### `openreview login [--server URL] [--token KEY|-] [--no-browser]`

Without `--token`, starts a device login: the CLI prints a short code and opens
`https://<server>/cli/activate?code=XXXX-XXXX`. Sign in, check the code matches your terminal, pick the organization,
and approve. The CLI then receives an API key named **CLI on &lt;your hostname&gt;** with the scopes your role allows
(valid for a year; revoke it any time under **Settings → API keys**).

With `--token`, saves an existing API key (`or_live_…`) after checking it with the server. `--token -` reads the key
from stdin, which keeps it out of your shell history:

```sh
echo "$OPENREVIEW_KEY" | openreview login --server https://openreview.example.com --token -
```

Credentials are stored in `~/.config/openreview/config.json` (or `$XDG_CONFIG_HOME/openreview/config.json`) with
permissions `0600`. `OPENREVIEW_URL` and `OPENREVIEW_TOKEN` override the file (useful in CI).

### `openreview logout`

Deletes the saved credentials. The key itself stays valid until it expires or you revoke it in the dashboard.

### `openreview whoami [--json]`

Shows the server, organization, API key, and scopes in use.

### `openreview status [--repo owner/name] [--pr N] [--json]`

Checks the connection (server reachable, key valid, organization, scopes) and shows the review of a pull request: by
default the pull request whose head is your current branch, or `--pr N`. It prints the latest review run's status,
finding counts by severity, and the open findings with their ids.

### `openreview review [options]`

Reviews the current branch against its base: the merge base of `HEAD` and `origin`'s default branch (falling back to
`origin/main`, `origin/master`, `main`, or `master`).

| Option | |
| --- | --- |
| `--base <ref>` | compare against another branch, tag, or commit |
| `--include-uncommitted` | also review staged, unstaged, and untracked changes |
| `--local` / `--server` | force local mode / force server mode (no fallback) |
| `--repo <owner/name>` | repository on the server (default: from the `origin` remote) |
| `--mode fast\|standard\|deep` | review depth (default: the repository's setting, else standard) |
| `--security` | security-focused review |
| `--json` | structured output (schema below) |
| `--agent` | compact output for coding agents |
| `--fail-on <severity>` | exit 1 when a finding at or above `critical`, `high`, `medium`, or `low` exists |
| `--max-findings <n>` | show at most n findings, most severe first |
| `-q, --quiet` | print only the findings |

Progress goes to stderr; results go to stdout. `--json` and `--agent` keep stderr quiet apart from errors.

### `openreview findings [--pr N] [--json|--agent] [--max-findings n]`

Lists the unresolved findings of the pull request's review on the server.

### `openreview fix-prompt <findingId> [--for claude-code|cursor|codex] [--copy]`

Prints a ready-to-paste prompt that fixes one finding. `--copy` also copies it with `pbcopy`, `wl-copy`, `xclip`,
`xsel`, or `clip`, whichever is available.

### `openreview fix-all [--pr N] [--min-confidence 0-1] [--copy]`

Prints one task (Markdown) that fixes every unresolved finding of the pull request, ordered by severity, with a
checklist and verification steps.

## Local mode

The first local review indexes the repository (symbols, call graph, imports, tests, docs) into `.openreview/index`,
a PGlite (embedded Postgres + pgvector) database. Later runs re-index only files whose content changed. The CLI adds
`/.openreview/` to `.git/info/exclude`, so it never shows up in `git status`. Delete the directory to rebuild the
index from scratch. The index holds the code under review: the `HEAD` commit, or the working tree with
`--include-uncommitted`.

Settings and rules come from `openreview.json` at the base commit (as on the server), so a branch cannot weaken its own
review.

## Environment variables

| Variable | Used for |
| --- | --- |
| `OPENREVIEW_URL`, `OPENREVIEW_TOKEN` | server and API key (override `openreview login`) |
| `ANTHROPIC_API_KEY` | local mode: the key for the default Anthropic provider |
| `LLM_PROVIDER` | local mode: `anthropic` (default), `openai`, `openrouter`, or `openai-compatible` |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | local mode: provider key, model, and endpoint (for `openai-compatible` and self-hosted models) |
| `LLM_MODEL_REVIEW`, `LLM_MODEL_FAST`, `LLM_MODEL_DEEP`, … | local mode: per-task and per-mode model overrides, as on the server |
| `EMBEDDING_API_KEY` (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`) | local mode: semantic search in the index (optional; without it, retrieval uses the code graph and full-text search) |
| `XDG_CONFIG_HOME` | where `openreview/config.json` lives (default `~/.config`) |
| `NO_COLOR` | disable colors |

If no model is configured, local mode stops with: *set ANTHROPIC_API_KEY or LLM_PROVIDER/LLM_API_KEY, or run
`openreview login` to use your server*.

## `--json` output

`openreview review --json` prints one JSON object:

```jsonc
{
  "version": 1,
  "source": "server",                 // or "local"
  "repository": { "id": 12, "fullName": "acme/shop" },  // id is null in local mode
  "baseRef": "origin/main",
  "headRef": "feature/tax",           // null on a detached HEAD
  "baseSha": "…",                     // the merge base
  "headSha": "…",                     // "<sha>+dirty" with --include-uncommitted
  "mode": "standard",                 // fast | standard | deep
  "focus": null,                      // or "security"
  "summary": {
    "overview": "…",
    "whatChanged": ["…"],
    "affectedAreas": ["…"],
    "riskLevel": "high",              // low | medium | high
    "riskRationale": "…",
    "confidence": 4                   // 1 (will cause problems) … 5 (safe to merge)
  },
  "findings": [
    {
      "fingerprint": "…",
      "title": "Callers of computeTotal do not pass the new region argument",
      "description": "…",
      "impact": "…",
      "severity": "high",             // critical | high | medium | low
      "confidence": 0.9,              // 0..1
      "category": "correctness",      // correctness | security | data | api_compat | testing | performance | rules
      "path": "services/billing/pricing.ts",
      "startLine": 3,
      "endLine": 3,
      "symbol": "computeTotal",
      "suggestedFix": "…",
      "suggestion": null,             // exact replacement for startLine..endLine, when one exists
      "evidence": [{ "path": "…", "startLine": 4, "endLine": 4, "snippet": "…", "note": "…" }],
      "rule": null                    // { "id", "text" } when a review rule raised it
    }
  ],
  "counts": { "critical": 0, "high": 1, "medium": 0, "low": 0 },
  "truncated": 0,                     // findings left out by --max-findings
  "filesReviewed": 1,
  "filesSkipped": [{ "path": "…", "reason": "…" }],
  "rejected": 2,                      // candidates the verifier rejected
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": null, "calls": 0, "credits": 2 },
  "models": { "review": "…" },
  "durationMs": 41234,
  "failOn": "high",                   // the --fail-on threshold, or null
  "exitCode": 1
}
```

When a command run with `--json` fails, stdout carries the error instead (stderr has it too):

```json
{ "version": 1, "error": { "message": "No model is configured for local reviews (…).", "hint": "Set ANTHROPIC_API_KEY …" }, "exitCode": 2 }
```

## Agent mode

`--agent` prints one block per finding, starting with `path:line`, and a checklist at the end. Point your coding
agent at it, e.g. in Claude Code: *"Run `openreview review --agent` and fix what it reports."*

```text
# OpenReview: 1 finding (1 high) in acme/shop at 3f2a1bc vs origin/main

## 1. services/billing/pricing.ts:3
severity: high · category: correctness
title: Callers of computeTotal do not pass the new region argument
why: computeTotal now requires a region, but handleCheckout and renderSummary still call it with only the items. Checkout and the cart summary compute totals without a region.
fix: Pass the account's region from both callers, or give region a default.

## Fix all
- [ ] services/billing/pricing.ts:3 — [high] Callers of computeTotal do not pass the new region argument

After fixing, re-run `openreview review --agent` to confirm.
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done (findings may exist; use `--fail-on` to fail on them) |
| 1 | a finding at or above `--fail-on` exists |
| 2 | an error: not logged in, server unreachable, repository not connected or not indexed, not a git repository, no base branch, no model configured, … |

## Building from source

The CLI lives in `packages/cli` of the OpenReview repository and bundles the server's engine, indexer, and model
gateway (`lib/`) with `tsup`:

```sh
pnpm install
pnpm cli:build              # → packages/cli/dist/cli.js (+ dist/drizzle migrations for local mode)
node packages/cli/dist/cli.js --help
```

License: AGPL-3.0.
