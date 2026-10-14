# Quickstart

OpenReview reviews pull requests using an index of your whole repository. It runs on your own infrastructure: a Next.js web app plus a Convex backend.

## Run it locally

You need Node.js 24 and pnpm 11.

```sh
pnpm install
CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once
pnpm setup:local
pnpm backend
# in another terminal
pnpm dev
```

Then open http://localhost:3000. `pnpm setup:local` generates the session, service and webhook secrets and copies them to the local backend without printing them.

## Connect a repository

1. Register a GitHub App. See [GitHub App setup](github-app.md). Other providers are listed under Providers.
2. Sign in, create a workspace, and install the app on the repositories you want reviewed.
3. Enable a repository. OpenReview indexes its default branch: files, symbols, the call/import graph and optional embeddings.
4. Open a pull request. The review appears as a summary comment and inline findings, and on the dashboard.

Repositories added to the installation later start disabled. To enable and index them automatically, turn on **Enable newly installed repositories** on the Teams page. You can set it for the workspace and override it per team. It is off unless an admin turns it on, and each change and each automatic enable is recorded in the audit log.

To share context across related repositories, open Memory → Cross-repo context and select **Suggest clusters**. OpenReview proposes groups from the repositories' indexed root manifests (`package.json`, `go.mod`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`): one repository using a package another publishes, or uncommon dependencies they share. It also groups repositories whose names share a distinctive word. Each suggestion lists its reasons. Nothing is applied until an admin creates the cluster. Dismissed suggestions are not proposed again.

## Choose a model

Set `LLM_PROVIDER` (`anthropic`, `openai` or `compatible`) and `LLM_API_KEY` on the backend. Optionally set `LLM_MODEL` and per-task overrides. Every model call counts against the workspace inference budget.

## Next steps

- Tune reviews with [repository configuration](../repo-config.md) and [custom rules](rules.md).
- Ask questions about your code in [Chat](chat.md), from the [API](api.md) or over [MCP](mcp.md).
- Run reviews locally with the [CLI](cli.md).
