# Public API

Authenticate with a workspace API key, created under **Settings → API Keys**:

```http
Authorization: Bearer or_...
```

Each key has a scope:
- **read:** query, search, repositories and reviews.
- **write:** adds requesting reviews, feedback and enabling repositories.
- **admin:** adds administrator endpoints.

The key owner's role still applies.

| Endpoint | Scope | Purpose |
| --- | --- | --- |
| `POST /api/query` | read | Ask a question; returns an answer with exact-quote sources (JSON, or Server-Sent Events with `stream: true`) |
| `GET /api/query/{messageId}` | read | Fetch a query result later |
| `POST /api/search` | read | Hybrid full-text and semantic search with ranked snippets |
| `GET /api/workspace` | read | The key's workspace, your other workspaces, and onboarding links |
| `GET /api/repositories` | read | Repositories visible to the key |
| `POST /api/repositories` | write | Enable and index an installed repository |
| `GET /api/repositories/{id}` | read | Index status |
| `GET /api/reviews`, `GET /api/reviews/{id}` | read | Reviews and their findings |
| `POST /api/reviews` | write | Request a review of a revision |
| `POST /api/findings/{id}/feedback` | write | Record feedback on a finding |
| `GET /api/context` | read | Graph, knowledge, rules and source for coding agents |
| `POST /api/rules/import` | admin | Import candidate rules as suggestions that need approval |

The full contract is in the [OpenAPI document](/docs/openapi.yaml).

```sh
curl -s https://review.example.com/api/query \
  -H "authorization: Bearer $OPENREVIEW_API_KEY" -H "content-type: application/json" \
  -d '{"question":"Where is the checkout total computed?","repositoryIds":["<id>"]}'
```
