# Agent plugins

The repository includes one plugin package, `plugins/openreview`, for Claude Code and for Codex. It provides:

- The OpenReview MCP server (the remote endpoint at `/api/mcp`).
- The **review-status** skill: shows a pull request's review status and open findings.
- The **resolve-review-findings** skill: fixes open findings, commits locally, requests a re-review, and repeats until the pull request is clean or three rounds have run. It asks before every push unless you told it to push, and it never force-pushes or rewrites commits.

Sign-in uses OAuth (see [MCP](mcp.md)). Your client opens the browser the first time it connects.

## Claude Code

1. Set `OPENREVIEW_URL` to your server, for example `export OPENREVIEW_URL=https://review.example.com`. The plugin's MCP configuration reads it.
2. Install the plugin from the repository that holds this marketplace:

   ```text
   /plugin marketplace add <owner>/<repo>
   /plugin install openreview@openreview
   ```

   On Claude Code 2.1.275 or later, `/plugin install openreview --marketplace <owner>/<repo>` does both in one step. From a checkout, `claude --plugin-dir ./plugins/openreview` loads it for one session.
3. Run `/mcp` to sign in to OpenReview. Then ask Claude to check the review, or run `/openreview:resolve-review-findings`.

To use an API key instead of OAuth, add the server yourself with an `Authorization: Bearer or_…` header (see [MCP](mcp.md)).

## Codex

Codex reads the same package through its documented plugin format: the root `plugin.json` (Agent Plugins schema, OpenAI settings under `extensions.com.openai`), `skills/` and `mcp.json`.

1. Edit `plugins/openreview/mcp.json` so that `url` points at your server's `/api/mcp`. The file ships with `https://openreview.example.com/api/mcp`.
2. Add the marketplace with `codex plugin marketplace add <owner>/<repo>`, or use the repository marketplace file `.agents/plugins/marketplace.json` from a checkout.
3. Install **OpenReview** from the Plugins Directory, then start a new chat and ask Codex to fix the open OpenReview findings.

## The resolve loop from the command line

`openreview resolve` runs the same loop without an editor, using a local coding agent to make the fixes:

```bash
openreview resolve --pr 42 --fix-agent claude
```

- **Fixing.** Each round lists the pull request's open findings over MCP and hands them to the agent.
  - Claude Code runs as `claude -p … --permission-mode acceptEdits`.
  - Codex runs as `codex exec --sandbox workspace-write …`.
  - Both run in the repository root.
- **Committing.** The loop commits the agent's changes locally. It starts only from a clean working tree, so each commit holds nothing but the fixes.
- **Pushing.** Without `--push` it asks before each push, and in a non-interactive shell it stops after the local commit. With `--push` it runs a plain `git push`. It never force-pushes.
- **Re-review.** It requests a review of the new commit with `trigger_review` and waits up to 20 minutes for that commit's review to finish.
- **Stopping.** It stops when no findings remain, after `--max` rounds (default 3, at most 10), when the agent changes nothing, or when the re-review fails. The exit code is non-zero unless the pull request ends clean.

It needs a write-scoped API key from `openreview login`, and the checkout's `origin` must be a repository that key can see.
