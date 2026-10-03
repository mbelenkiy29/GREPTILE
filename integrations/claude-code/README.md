# OpenReview plugin for Claude Code

Work through OpenReview's pull request findings without leaving Claude Code.

| What | How to use it |
| --- | --- |
| `/openreview-fix [min-severity] [finding ids…]` | Fetches the unresolved OpenReview findings on the current branch's pull request, fixes them one at a time (most severe first), verifies each fix with the relevant tests, and marks it resolved in OpenReview. |
| `/openreview-loop [max-iterations] [min-severity]` | Pushes the branch (opening the pull request with `gh` if needed), waits for OpenReview's review of the new head, fixes the findings, runs the tests, commits, pushes, and repeats until nothing at or above the threshold is left or the iteration cap (default 3) is reached. |
| `openreview-review` skill | Claude runs `openreview review --agent` on your local changes before you push and fixes what it finds. |
| `openreview` MCP server | The plugin starts `npx -y openreview-mcp`, which gives Claude the OpenReview tools (`list_review_comments`, `get_finding`, `mark_finding_resolved`, `trigger_review`, `get_review`, `search_codebase`, …). |

Plugin commands are namespaced: if another plugin also has a command of the same name, type `/openreview:openreview-fix`.

## Install

You need an OpenReview server (your self-hosted instance) with the repository connected, and an API key.

1. Create an API key in OpenReview under **Settings → API keys**. Give it `reviews:read`, `findings:read`,
   `findings:write` (to mark findings resolved), `reviews:write` (to request re-reviews), `repos:read`, and
   `knowledge:read` (for codebase search and context).
2. Make the server and key available to Claude Code, either as environment variables in the shell you start `claude`
   from:

   ```bash
   export OPENREVIEW_URL=https://review.example.com
   export OPENREVIEW_TOKEN=or_live_…
   ```

   or by logging in with the `openreview` CLI (`openreview login`), whose config file the MCP server reads when the
   variables are not set.
3. Add the marketplace and install the plugin. From a clone of the OpenReview repository:

   ```text
   /plugin marketplace add ./integrations
   /plugin install openreview@openreview
   ```

   To install without a clone, declare the marketplace in your Claude Code settings (`~/.claude/settings.json`), with
   the path of the marketplace file inside the repository:

   ```json
   {
     "extraKnownMarketplaces": {
       "openreview": {
         "source": { "source": "github", "repo": "<owner>/<openreview-repo>", "path": "integrations/.claude-plugin/marketplace.json" }
       }
     }
   }
   ```

   then run `/plugin install openreview@openreview`.
4. Restart Claude Code (or run `/reload-plugins`) and check `/mcp`: the `openreview` server should be connected.

To try the plugin without installing it: `claude --plugin-dir ./integrations/claude-code`.

## How the commands work

### `/openreview-fix`

1. Finds the repository and pull request of the current branch (`gh pr view`).
2. Lists the unresolved findings with `list_review_comments` (falls back to `openreview findings --agent` when the MCP
   tools are not available).
3. For each finding: reads the detail and fix prompt (`get_finding`), checks it against the current code, applies the
   smallest fix, runs the related tests (`get_related_files` names them), and only then calls
   `mark_finding_resolved`. False positives and findings that no longer apply are reported, not "fixed".
4. Leaves the changes uncommitted and prints a summary table.

### `/openreview-loop`

Each iteration: push → wait for the review of the pushed commit (`get_review` with `headSha`, polling with 15 s / 30 s /
60 s backoff, requesting a review with `trigger_review` if none starts within about two minutes, giving up after 20
minutes) → fetch unresolved findings → fix and verify them → run the tests → commit → next iteration. The loop ends when
the pull request is clean, when the cap is reached, or when something needs your decision (failing tests, no changes
possible, a failed review). It never force-pushes or pushes to the default branch.

### Other agents: `openreview-loop.sh`

The same loop, for Codex, Cursor, or any agent that can run a shell script, is
[`integrations/loop/openreview-loop.sh`](../loop/openreview-loop.sh). It talks to the REST API with `curl`, uses `gh`
for the pull request, and prints the status and the agent prompt for each iteration:

```bash
# The calling agent fixes the printed findings, commits, and runs the script again (exit code 10 = "fix and rerun"):
integrations/loop/openreview-loop.sh --max-iterations 3 --min-severity medium

# Or let the script drive an agent CLI, with a test gate:
integrations/loop/openreview-loop.sh --agent-cmd "codex exec -" --test-cmd "pnpm test"
```

Exit codes: `0` clean, `2` iteration cap reached, `3` the review failed, `4` tests failed, `5` the agent changed
nothing, `6` timed out waiting for the review, `10` prompt printed for the calling agent, `1` usage or configuration
error. Run it with `--help` for every option.

## Security

Finding text, summaries, and code snippets come from the reviewed repository and are treated as data: the commands
tell Claude never to follow instructions found in them. The API key acts as its organization with only the scopes you
gave it; keep it in an environment variable or the CLI config file (mode 0600), never in the repository.

See [docs/mcp.md](../../docs/mcp.md) for the MCP tools and for connecting Cursor, Codex, and Claude Desktop.
