# MCP

OpenReview exposes the same tools over two Model Context Protocol transports.

- **Remote (Streamable HTTP):** point your client at `https://review.example.com/api/mcp` with `Authorization: Bearer or_...`. It needs no local install.

  ```json
  {"mcpServers":{"openreview":{"type":"http","url":"https://review.example.com/api/mcp","headers":{"Authorization":"Bearer or_..."}}}}
  ```

- **Local (stdio):** run it from a checkout of OpenReview.

  ```json
  {"mcpServers":{"openreview":{"command":"pnpm","args":["--dir","/path/to/openreview","--silent","mcp"],"env":{"OPENREVIEW_URL":"https://review.example.com","OPENREVIEW_API_KEY":"or_..."}}}}
  ```

## Tools

| Tool | Purpose |
| --- | --- |
| `ask_codebase` | Cited answers about up to five repositories |
| `search_code` | Hybrid semantic and full-text code search |
| `list_repositories` | Repositories and index status |
| `get_review`, `get_findings`, `get_finding` | Review results and evidence |
| `get_repository_context`, `search_codebase`, `get_related_files`, `get_custom_rules` | Repository graph, symbols and rules |
| `mark_finding_resolved` | Record a fix (needs a write-scoped key) |

Every tool call goes through the public API, so the key's scope and workspace apply.
