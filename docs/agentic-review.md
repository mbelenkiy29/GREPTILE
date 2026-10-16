# Agentic review engine (experimental)

OpenReview has three review engines, selected per repository, team or workspace with the **Review engine** setting (`reviewEngine`) or `.openreview.json`:

- **`pipeline`** (default): retrieval, up to seven category specialists, then a verifier. Its cost and behaviour are predictable.
- **`agentic`**: a single investigator that calls read-only tools to follow data and control flow across files. It finds defects that only show at a caller several hops from the change.
- **`hypotheses`**: a planner proposes concrete bug hypotheses about the change, and each one is investigated by a small, separately budgeted agent, several at a time. See [Hypothesis engine](#hypothesis-engine).

Both engines share every publication gate: exact-quote grounding (`grounded()`), confidence and severity thresholds, dedup, the independent verifier, execution-claim checks, resolution checks and the summary validators. A finding the agent reports but cannot ground in real source lines is suppressed, exactly as in the pipeline.

The default stays `pipeline` until a live three-way evaluation (pipeline, agentic, hypotheses) has been approved and reviewed (see `docs/parity/REPORT.md`).

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

Turns and tool calls are configurable per workspace, team or repository under Settings → Review → Agent budgets (`agentTurns`, `agentToolCalls` for the agentic engine; `hypothesisTurns`, `hypothesisToolCalls` per hypothesis investigation; 0 keeps the tier's default). Values can lower or raise the defaults but are clamped to the operator's hard caps, `AGENT_MAX_TURNS` (default 60) and `AGENT_MAX_TOOL_CALLS` (default 150), set in the backend environment; the tier default is capped too. Token and wall-clock budgets stay per tier. The review's diagnostics show the budget it used.

When a budget runs out, the loop stops gracefully. Findings already reported are still verified and published, and a coverage note records the early stop.

## Long investigations

The loop state (transcript, reported findings, files read and counters) is saved to Convex storage after every turn. Before the action time limit (`AGENT_STEP_SECONDS`, default 420), the review is set to `waiting_agent` and continues in a new action step from the saved state. No tool or model call is repeated. A resume does not consume a retry attempt; resumes are capped at six. Cancellation is checked between steps, and the saved state is deleted when the review reaches a final outcome.

## Requirements and fallback

The agentic engine needs a model adapter with native tool calling (OpenAI-compatible function calling or Anthropic tool use). Providers without it fall back to the pipeline, with a visible coverage note. Prompt caching keeps the shared review payload cheap across turns.

## Hypothesis engine

1. **Plan.** One structured model call proposes up to N hypotheses. Each names a claim, an allowed category, a changed file and line from the diff, and what to check. Hypotheses on files outside the diff or in disabled categories are rejected; the plan is capped per mode and repeats are dropped. Repository text cannot raise the cap: it is fixed in code.
2. **Investigate.** Each hypothesis runs as its own tool-calling agent with the same read-only tools and system prompt, a brief that labels the hypothesis as untrusted, and its own budget. Up to the mode's concurrency run at once. An investigation that refutes its hypothesis replies `Refuted:` and stops.
3. **Verify.** Every reported finding goes through the same grounding, dedup (across hypotheses), verifier and thresholds as the other engines.

| Mode | Hypotheses | Concurrent | Per hypothesis (tool calls / tokens / wall / turns) | Total (tokens / wall) |
| --- | --- | --- | --- | --- |
| fast | 3 | 2 | 6 / 60,000 / 2 min / 5 | 180,000 / 3 min |
| standard | 6 | 3 | 10 / 100,000 / 3 min / 8 | 600,000 / 6 min |
| deep | 10 | 4 | 16 / 200,000 / 5 min / 12 | 2,000,000 / 8 min |

The total budget is shared: when it runs out, running investigations stop before their next turn (keeping what they reported) and the remaining hypotheses are skipped. One investigation failing never fails the review, and a failed plan falls back to the pipeline. Every case leaves a coverage note, and the review page and evaluation reports list each hypothesis with its status. Hypothesis runs fit within one Convex action, so unlike the agentic engine they do not suspend and resume.

## Evaluation

`pnpm eval --validate` checks all fixtures offline, including three multi-hop fixtures (`multi-hop-*`) whose defect sits two hops from the change. A live comparison (`pnpm eval`, `pnpm eval --engine=agentic` and `pnpm eval --engine=hypotheses`) spends inference budget and must be approved first. Agentic reports include the agent's tool trace and transcript; hypothesis reports include one per hypothesis (`hypothesisTranscripts`).
