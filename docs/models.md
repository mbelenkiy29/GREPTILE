# Model configuration

Every model call OpenReview makes (reviews, verification, summaries, conversations, the knowledge base, rule mining)
goes through one gateway, [`lib/llm`](../lib/llm/index.ts). It picks the provider and model for each call, applies
timeouts and retries, records every call (model, tokens, latency, estimated cost) in the `model_calls` table, and
serves the opt-in response cache. Swapping models is configuration only.

## Providers

| `LLM_PROVIDER` | Endpoint | Key | Model |
| --- | --- | --- | --- |
| `anthropic` (default) | Anthropic's API, or `LLM_BASE_URL` | `LLM_API_KEY`, falling back to `ANTHROPIC_API_KEY` | optional: built-in per-task routes |
| `openai` | `https://api.openai.com/v1` | `LLM_API_KEY` (required) | `LLM_MODEL` (or per-task variables) required |
| `openrouter` | `https://openrouter.ai/api/v1` | `LLM_API_KEY` (required) | `LLM_MODEL` required (OpenRouter ids look like `vendor/model`) |
| `openai-compatible` | `LLM_BASE_URL` (required) | `LLM_API_KEY` if the server wants one | `LLM_MODEL` required |

`openai-compatible` covers self-hosted and other OpenAI-style servers: vLLM, Ollama, LM Studio, TGI, and gateways that
speak the Chat Completions API. `LLM_PROVIDER=openai` with an `LLM_BASE_URL` that is not `api.openai.com` is treated as
`openai-compatible`. Structured output (findings, verdicts, summaries) is requested as JSON and validated with zod; a
model that cannot follow a JSON schema reliably will produce failed calls, which show up in the review's model
failures and in `model_calls`.

Examples:

```sh
# Anthropic (default): one key is enough
ANTHROPIC_API_KEY=...

# OpenAI
LLM_PROVIDER=openai
LLM_API_KEY=...
LLM_MODEL=<model id>

# OpenRouter
LLM_PROVIDER=openrouter
LLM_API_KEY=...
LLM_MODEL=<provider/model id>

# A self-hosted model behind vLLM or Ollama on the same network
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://vllm.internal:8000/v1
LLM_MODEL=<served model name>
```

## Tasks and routing

Each call names a task. The model for a call is chosen in this order (`lib/llm/routing.ts`):

1. the organization's own provider settings (bring your own model, below), if any;
2. for `review` and `verify` in fast or deep mode: `LLM_MODEL_FAST` / `LLM_MODEL_DEEP`;
3. the task's variable, `LLM_MODEL_<TASK>`;
4. `LLM_MODEL`;
5. with `anthropic`, the built-in route for the task and review mode.

| Task | What uses it | Variable | Built-in Anthropic route |
| --- | --- | --- | --- |
| `review` | the specialized review agents | `LLM_MODEL_REVIEW` | fast: `claude-sonnet-5-5` (low effort); standard: `claude-opus-5-5` (medium); deep: `claude-opus-5-5` (xhigh) |
| `verify` | the verification judge and prior-finding matching | `LLM_MODEL_VERIFY` | fast: `claude-sonnet-5-5` (low); standard: `claude-opus-5-5` (medium); deep: `claude-opus-5-5` (high) |
| `summary` | the pull request summary comment | `LLM_MODEL_SUMMARY` | `claude-sonnet-5-5` (low) |
| `classify` | change classification (standard and deep modes), conversation intent, the connection test | `LLM_MODEL_CLASSIFY` | `claude-haiku-4-5` |
| `chat` | answers to `@openreview` questions in pull requests | `LLM_MODEL_CHAT` | `claude-opus-5-5` (medium) |
| `knowledge` | knowledge base entries | `LLM_MODEL_KNOWLEDGE` | `claude-sonnet-5-5` (medium) |
| `rules` | mining teammates' review comments into candidate rules | `LLM_MODEL_RULES` | `claude-sonnet-5-5` (low) |
| `context` | has a route and a variable (`LLM_MODEL_CONTEXT`), but no current call uses it: context retrieval is deterministic | `LLM_MODEL_CONTEXT` | `claude-haiku-4-5` |

Review modes (fast, standard, deep) also change how many agents run, how much repository context they get, and how
many credits a review costs (`CREDITS_FAST`, `CREDITS_STANDARD`, `CREDITS_DEEP`). A repository's mode is set in its
settings or `openreview.json`; the CLI takes `--mode`.

## Timeouts, retries, and cost

- `LLM_TIMEOUT_MS` (default 180 s) per attempt, stretched for calls allowed many output tokens
  (`LLM_MIN_OUTPUT_TOKENS_PER_SEC`), because calls are not streamed.
- `LLM_MAX_RETRIES` (default 3) retries for 429, 5xx, 529, timeouts, and network errors, with exponential backoff and
  jitter that honors `retry-after`. Other errors are not retried.
- Cost is estimated from a built-in price table plus `LLM_PRICING_JSON`; models without a price are recorded with an
  unknown cost and excluded from cost totals. The Usage page and `GET /api/orgs/current/usage/export` report it.
- Deterministic calls (classification, verification, summaries, prior-finding matching) may be served from the
  response cache (`llm_response_cache`, per organization, `LLM_CACHE_TTL_HOURS`).

## Embeddings

Indexing embeds every symbol and documentation chunk for semantic search, so an embedding endpoint is required for
indexing to succeed:

```sh
# OpenAI (default provider): text-embedding-3-small
EMBEDDING_API_KEY=...

# Any OpenAI-compatible embedding server
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://embeddings.internal:8080/v1
EMBEDDING_MODEL=<model name>
```

Vectors are stored with 1536 dimensions (smaller ones are zero-padded), so the model must return at most 1536
dimensions. After changing the embedding model, run a **Full re-index** of each repository (repository menu) so old and new
vectors are not mixed.
Embeddings are cached by model and content hash and shared across organizations; the cache stores vectors only.

## Bring your own model, per organization

Owners and admins can point their organization's calls at their own provider in **Settings → Model provider**:
Anthropic, OpenAI, OpenRouter, or an OpenAI-compatible endpoint, with a base URL, an API key (encrypted at rest, never
shown again), a default model, and optional per-task models. **Test connection** sends one small `classify` call.
From then on reviews, conversations, rule mining, the knowledge base, and CLI reviews run against it (the worker and
the API use `gatewayForOrg` in `lib/llm/org.ts`); embeddings keep using the server's embedding model. The operator's
API key is never sent to an organization's endpoint. Organization endpoints must be public https hosts unless
`LLM_ALLOW_PRIVATE_ORG_ENDPOINTS=true`.

If an organization's stored key cannot be decrypted (for example after `ENCRYPTION_KEY` changed), its calls fail with a
message asking to save the settings again; they never silently fall back to the operator's model.

## The CLI's local mode

`openreview review --local` runs the same engine on your machine with your own key and reads the same variables
(`ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_MODEL_<TASK>`, and the
`EMBEDDING_*` variables, which are optional there). See [the CLI](cli.md).

## Tests

Tests never call a real model: they use the fake provider (`lib/llm/fake.ts`) or an injected `fetch` that records
requests and returns canned responses.
