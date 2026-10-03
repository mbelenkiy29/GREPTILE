# OpenReview MCP server

OpenReview exposes its reviews, findings, and codebase index to coding agents through the
[Model Context Protocol](https://modelcontextprotocol.io) (feature R3.2). An agent can list the unresolved review
comments on a pull request, read one with its evidence and a ready-made fix prompt, mark it resolved after fixing it,
request a re-review, and ask questions about the indexed codebase.

There are two ways to connect, with the same tools:

| | Remote (Streamable HTTP) | Local (stdio) |
| --- | --- | --- |
| Endpoint | `https://<your-server>/api/mcp` | `npx -y openreview-mcp` |
| Auth | `Authorization: Bearer or_live_…` | `OPENREVIEW_URL` + `OPENREVIEW_TOKEN` (or the `openreview` CLI's config) |
| Use when | the client supports remote MCP servers with custom headers | the client only runs local servers (Claude Desktop), or you prefer a local process |

Both authenticate with an OpenReview **API key** (Settings → API keys). The key acts as its organization and only with
its scopes; every tool goes through the REST API's own scope checks, tenant isolation, rate limit (`API_RATE_LIMIT_PER_MINUTE`
per key, shared with the REST API), and audit log.

## Tools

| Tool | What it does | Scope |
| --- | --- | --- |
| `list_reviews` | Reviews, newest first; filter by repository, pull request, status. | `reviews:read` |
| `get_review` | One review: summary, runs, open findings by severity. With `headSha`, whether that commit's review is `completed`, `in_progress`, `failed`, or `not_reviewed`. | `reviews:read` |
| `list_review_comments` | Unresolved findings (review comments) on a pull request, most severe first, with a severity threshold. | `findings:read` |
| `list_findings` | Finding search across the organization (repository, review, PR, status, severity, category). | `findings:read` |
| `get_finding` | One finding in full: description, impact, evidence, suggested fix, and a fix prompt for Claude Code, Cursor, or Codex. | `findings:read` |
| `mark_finding_resolved` | Records `resolved` feedback (source `mcp`) and closes the finding. | `findings:write` |
| `trigger_review` | Re-reviews a pull request (mode, security focus, `full`). | `reviews:write` |
| `get_fix_all` | One Markdown task that fixes every unresolved finding of a review. | `findings:read` |
| `search_codebase` | Ranked snippets (path:line, why each matched) from the repository index: named symbols and paths, full-text and semantic matches, knowledge notes. | `repos:read` |
| `get_related_files` | Callers, callees, importers, and tests of a file or symbol, from the code graph. | `repos:read` |
| `list_rules` | Review rules, org-wide and per repository. | `rules:read` |
| `get_repository_context` | Repository summary, architecture overview, and knowledge base entries for a path. | `knowledge:read` |

A repository is passed as `owner/name` or as its numeric OpenReview id (name lookup also needs `repos:read`). A pull
request is identified by `reviewId` or by `repository` + `prNumber`. Each review is also readable as the resource
`openreview://reviews/{id}` (JSON).

Errors are MCP tool errors with an actionable message, e.g. `This API key lacks the findings:write scope. Create an API
key with that scope…`. Text that comes from the reviewed repository (code, finding descriptions, summaries) is labelled
as data; agents must not treat it as instructions.

The tools call these REST endpoints, which you can also use directly (see `/api/v1/openapi.json`):
`GET /api/v1/repositories/{id}/search?q=&limit=`, `GET /api/v1/repositories/{id}/related?path=&symbol=`,
`GET /api/v1/repositories/{id}/knowledge?path=`, plus the existing review, finding, fix-prompt, Fix-all, and rule
endpoints. `GET /api/v1/reviews` accepts `prNumber`, and `POST /api/v1/findings/{id}/feedback` accepts
`source: "api" | "mcp" | "cli"`.

## Create an API key

In OpenReview, open **Settings → API keys** and create a key for your agent. Typical scopes:

- read-only assistant: `reviews:read`, `findings:read`, `repos:read`, `rules:read`, `knowledge:read`;
- fixing loop (`/openreview-fix`, `/openreview-loop`): add `findings:write` and `reviews:write`.

Keep the key out of the repository: put it in an environment variable or a secret store.

## Claude Code

The easiest way is the [OpenReview plugin](../integrations/claude-code/README.md), which registers the server and adds
`/openreview-fix`, `/openreview-loop`, and the `openreview-review` skill.

Remote server only:

```bash
claude mcp add --transport http openreview https://review.example.com/api/mcp \
  --header "Authorization: Bearer $OPENREVIEW_TOKEN"
```

Local stdio server:

```bash
claude mcp add openreview -e OPENREVIEW_URL=https://review.example.com -e OPENREVIEW_TOKEN=$OPENREVIEW_TOKEN \
  -- npx -y openreview-mcp
```

Or in a project's `.mcp.json` (variables are expanded from the environment, so the key is not committed):

```json
{
  "mcpServers": {
    "openreview": {
      "type": "http",
      "url": "${OPENREVIEW_URL}/api/mcp",
      "headers": { "Authorization": "Bearer ${OPENREVIEW_TOKEN}" }
    }
  }
}
```

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project). Remote:

```json
{
  "mcpServers": {
    "openreview": {
      "url": "https://review.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${env:OPENREVIEW_TOKEN}" }
    }
  }
}
```

Local:

```json
{
  "mcpServers": {
    "openreview": {
      "command": "npx",
      "args": ["-y", "openreview-mcp"],
      "env": { "OPENREVIEW_URL": "https://review.example.com", "OPENREVIEW_TOKEN": "${env:OPENREVIEW_TOKEN}" }
    }
  }
}
```

## Codex

`~/.codex/config.toml`. Remote (the key is read from the named environment variable):

```toml
[mcp_servers.openreview]
url = "https://review.example.com/api/mcp"
bearer_token_env_var = "OPENREVIEW_TOKEN"
```

Local:

```toml
[mcp_servers.openreview]
command = "npx"
args = ["-y", "openreview-mcp"]
env = { OPENREVIEW_URL = "https://review.example.com", OPENREVIEW_TOKEN = "or_live_…" }
```

## Claude Desktop

Claude Desktop runs local servers from `claude_desktop_config.json` (Settings → Developer → Edit Config). Its remote
connectors expect OAuth, so use the stdio package:

```json
{
  "mcpServers": {
    "openreview": {
      "command": "npx",
      "args": ["-y", "openreview-mcp"],
      "env": { "OPENREVIEW_URL": "https://review.example.com", "OPENREVIEW_TOKEN": "or_live_…" }
    }
  }
}
```

The config file is local to your machine; keep it private, and prefer a key with read scopes only for chat use.

## The local package (`openreview-mcp`)

`packages/mcp` in this repository, published as `openreview-mcp` (bin `openreview-mcp`, Node 20+). It serves the tools
over stdio and forwards each call to your server's REST API with the API key. Configuration:

- `OPENREVIEW_URL`: the server's origin (a trailing `/api/v1` is accepted);
- `OPENREVIEW_TOKEN`: the API key;
- otherwise `${XDG_CONFIG_HOME:-~/.config}/openreview/config.json` written by `openreview login` (each variable
  overrides the file).

Build it from the repository with `pnpm mcp:build` (output in `packages/mcp/dist`).

## Transport details

`POST /api/mcp` implements the MCP Streamable HTTP transport statelessly: no `Mcp-Session-Id`, every POST carries one
JSON-RPC message and gets a JSON response. `GET` (server-initiated SSE stream) and `DELETE` (session end)
answer `405 Method Not Allowed`, as the specification allows for servers without sessions. Requests with an `Origin`
header from another site are refused (403). Requests without a valid key answer `401` with
`WWW-Authenticate: Bearer realm="openreview"`; over the rate limit, `429` with `Retry-After`. Dashboard session cookies
are not accepted.

## The agent loop

`/openreview-loop` (Claude Code) and [`integrations/loop/openreview-loop.sh`](../integrations/loop/openreview-loop.sh)
(any agent) push the branch, wait for the review of the new head (`get_review` with `headSha`), fix the unresolved
findings, test, commit, and repeat until clean or the iteration cap (R3.4). See the
[plugin README](../integrations/claude-code/README.md#how-the-commands-work) for both.
