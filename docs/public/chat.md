# Codebase chat

**Dashboard → Chat** answers questions about up to five indexed repositories.

- **Investigation:** OpenReview uses read-only code tools (search, read file, definitions, references, related files) at each repository's indexed revision. You see each step as it happens.
- **Answers:** an answer is shown only after every claim marker `[n]` maps to a citation that exactly matches lines OpenReview read. Each citation links to the provider, pinned to that commit.
- **Threads:** threads are private to you, and follow-ups keep earlier turns as context. If you lose access to a repository, answers that used it are hidden.
- **Limits:** questions count against the inference budget and are rate-limited per member and per workspace.

The same engine powers [`POST /api/query`](api.md), the [`ask_codebase` MCP tool](mcp.md) and Slack Q&A ([notifications](../notifications.md)).
