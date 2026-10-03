# openreview-mcp

The [OpenReview](../../README.md) MCP server for coding agents, over stdio. It forwards every tool call to your
OpenReview server's REST API with an API key, so the key's scopes and organization apply.

```bash
OPENREVIEW_URL=https://review.example.com OPENREVIEW_TOKEN=or_live_… npx -y openreview-mcp
```

Without the variables it reads the `openreview` CLI's config file (`~/.config/openreview/config.json`, written by
`openreview login`).

Tools: `list_reviews`, `get_review`, `list_review_comments`, `list_findings`, `get_finding`, `mark_finding_resolved`,
`trigger_review`, `get_fix_all`, `search_codebase`, `get_related_files`, `list_rules`, `get_repository_context`, and
the resource `openreview://reviews/{id}`.

Client setup for Claude Code, Cursor, Codex, and Claude Desktop, and the remote HTTP alternative (`/api/mcp`), are in
[docs/mcp.md](../../docs/mcp.md).

License: AGPL-3.0-only.
