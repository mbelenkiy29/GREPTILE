# Agentic review engine (experimental)

OpenReview has two review engines, selected per repository, team or workspace with the **Review engine** setting (`reviewEngine`):

- **`pipeline`** (default): retrieval, up to seven category specialists, then a verifier. Its cost and behaviour are predictable.
- **`agentic`**: a single investigator that calls read-only tools to follow data and control flow across files. It finds defects that only show at a caller several hops from the change.

Both engines share every publication gate: exact-quote grounding (`grounded()`), confidence and severity thresholds, dedup, the independent verifier, execution-claim checks, resolution checks and the summary validators. A finding the agent reports but cannot ground in real source lines is suppressed, exactly as in the pipeline.

The default stays `pipeline` until a live pipeline-vs-agentic evaluation has been approved and reviewed (see `docs/parity/REPORT.md`).

## Tools

All tools are read-only and bound server-side to the review's repository. The model supplies only paths, symbols or search text, never repository, tenant or budget arguments.

| Tool | Data | Revision label |
| --- | --- | --- |
| `read_file(path, startLine?, endLine?)` | PR head tree; indexed content reused only when its blob SHA matches head | head SHA |
| `search_code(query)` | Full-text code chunk index | indexed SHA |
| `find_definition(symbol)` / `find_references(symbol)` | Symbol table and code chunks | indexed SHA |
| `list_directory(path)`, `get_related_files(path)` | Indexed files and import/call edges | indexed SHA |
| `get_past_findings(path)` | Earlier OpenReview findings for the file | review history |
| `get_rules()` | Custom rules applicable to this change | settings |
| `report_finding(...)` | The standard finding schema | — |

Tool output is wrapped as untrusted data. Text inside files cannot add tools, raise budgets or change instructions: the loop is ordinary code, and the system prompt and tool list are identical on every turn. Paths containing `..` or absolute paths are rejected.

## Budgets

| Mode | Tool calls | Tokens* | Wall clock | Turns |
| --- | --- | --- | --- | --- |
| fast | 12 | 150k | 4 min | 8 |
| standard | 30 | 400k | 10 min | 16 |
| deep | 80 | 1.2M | 30 min | 40 |

\*Uncached input plus output tokens across all turns.

When a budget runs out, the loop stops gracefully. Findings already reported are still verified and published, and a coverage note records the early stop.

## Long investigations

The loop state (transcript, reported findings, files read and counters) is saved to Convex storage after every turn. Before the action time limit (`AGENT_STEP_SECONDS`, default 420), the review is set to `waiting_agent` and continues in a new action step from the saved state. No tool or model call is repeated. A resume does not consume a retry attempt; resumes are capped at six. Cancellation is checked between steps, and the saved state is deleted when the review reaches a final outcome.

## Requirements and fallback

The agentic engine needs a model adapter with native tool calling (OpenAI-compatible function calling or Anthropic tool use). Providers without it fall back to the pipeline, with a visible coverage note. Prompt caching keeps the shared review payload cheap across turns.

## Evaluation

`pnpm eval --validate` checks all fixtures offline, including three multi-hop fixtures (`multi-hop-*`) whose defect sits two hops from the change. A live comparison (`pnpm eval --engine=agentic` vs. `pnpm eval`) spends inference budget and must be approved first.
