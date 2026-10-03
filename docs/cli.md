# CLI

The `openreview` command reviews the changes on your branch before you open a pull request, from a terminal or a
coding agent. It runs the same review engine as the server. The full reference (every command, option, environment
variable, the `--json` schema, and exit codes) is in [`packages/cli/README.md`](../packages/cli/README.md).

## Two modes

- **Server mode** (default when logged in and the repository is connected): the diff and the changed files' head
  contents go to `POST /api/v1/reviews/local` on your OpenReview server, which reviews them against its index of the
  whole repository with the organization's settings, rules, learned preferences, and model provider (including a
  bring-your-own provider configured in **Settings → Model provider**). Nothing is posted to the git host. Usage is
  recorded with trigger `cli`. The request may run for `LOCAL_REVIEW_TIMEOUT_MS` (default five minutes); each
  organization can run a limited number of CLI reviews at once.
- **Local mode** (`--local`, or automatically when not logged in): the CLI indexes your checkout into an embedded
  PGlite database in `.openreview/` and reviews on your machine with your own model key. No server is involved.

## Quick start

```sh
npm i -g openreview                                         # or: npx openreview …
openreview login --server https://openreview.example.com   # device login, approve in the browser
cd your-project
openreview review                                           # this branch against the default branch
openreview review --mode deep --fail-on high                # in CI: exit 1 on high or critical findings
openreview findings --pr 42 --agent                         # findings of a pull request, for a coding agent
openreview fix-prompt 1234 --for claude-code --copy         # a prompt that fixes one finding
```

`openreview login` creates an API key for the organization you pick (revocable under **Settings → API keys**). In CI,
set `OPENREVIEW_URL` and `OPENREVIEW_TOKEN` instead.

## Building from this repository

```sh
pnpm install
pnpm cli:build                     # packages/cli/dist/cli.js
node packages/cli/dist/cli.js --help
```

The MCP server for coding agents is a separate package (`pnpm mcp:build`); see [mcp.md](mcp.md). The Claude Code
plugin and the review-fix loop script are in [`integrations/`](../integrations/claude-code/README.md).
