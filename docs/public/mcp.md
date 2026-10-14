# MCP

OpenReview exposes the same tools over two Model Context Protocol transports.

- **Remote (Streamable HTTP):** point your client at `https://review.example.com/api/mcp` with `Authorization: Bearer or_...`. It needs no local install.

  ```json
  {"mcpServers":{"openreview":{"type":"http","url":"https://review.example.com/api/mcp","headers":{"Authorization":"Bearer or_..."}}}}
  ```

  Clients that support MCP authorization can connect without an API key. Configure just the URL (`{"type":"http","url":"https://review.example.com/api/mcp"}`) and sign in when the client opens the browser.

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
| `get_review_status` | Latest review of a pull request: status, verdict, whether it covers the current head, open findings |
| `list_unresolved_comments` | Open findings on your own open pull requests, with file, line, priority and fix |
| `trigger_review` | Request a review of a pull request at its current head (needs write) |
| `add_custom_context` | Suggest a custom rule; an admin approves it before reviews use it (needs write) |
| `report` | `pr_status`, `weekly_summary` (last 1–90 days) or `team_metrics` from the analytics report |

Every tool call goes through the public API, so the key's scope and workspace apply.

## Sign in with OAuth

The remote endpoint follows the MCP authorization specification (revision 2026-07-28). OpenReview acts as both the authorization server and the protected resource.

- **Discovery.** A request without credentials gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp", scope="read"`.
  - The resource metadata names this server as the authorization server.
  - `/.well-known/oauth-authorization-server` lists the endpoints. It supports `S256` only, and returns `iss` in authorization responses.
- **Client identity.** Clients identify themselves with a Client ID Metadata Document: an HTTPS URL that serves their name and redirect URIs.
  - OpenReview fetches that document only from public addresses, with no redirects, a 16 KB limit and a 5-second timeout, and caches it for an hour.
  - Clients that do not support these documents yet can use Dynamic Client Registration at `/api/oauth/register`. The specification deprecates registration but still allows it.
  - Only public clients with PKCE are supported. Redirect URIs must use HTTPS or a loopback `http://localhost` / `127.0.0.1` address.
- **Consent.** You sign in and see the client's name, the exact address the browser will return to (with a warning for loopback addresses) and the access requested. You then choose one workspace.
  - Access uses the API key scopes `read`, `write` and `admin`, and never exceeds your role in that workspace.
- **Tokens.** Authorization codes are single-use and expire after 10 minutes.
  - Access tokens last an hour and are accepted only at `/api/mcp`. The REST API refuses them; use API keys there.
  - Refresh tokens rotate on every use. Presenting an old refresh token, or replaying a code, revokes the connection.
  - Only hashes of codes and tokens are stored.
- **More access.** A tool that needs more access answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="write"`, so the client can ask you to approve the extra scope.
- **Revoking.** Settings → API keys lists connected MCP clients and lets you revoke them; admins see everyone's in the workspace. Clients can revoke their own tokens at `/api/oauth/revoke`.

API keys keep working at the same endpoint.
