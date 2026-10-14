# How reviews work

When a pull request opens or updates, OpenReview:

1. **Builds context.** It combines the diff with indexed callers, callees, imports and tests, related past findings, repository rules and learned preferences. It also adds requirements from linked Linear, Jira, Confluence or Notion pages.
2. **Investigates.** The default pipeline runs specialists for correctness, security, data, compatibility, testing and performance. The optional agentic engine instead follows the code with read-only tools.
3. **Verifies.** Every finding must quote exact source lines at the reviewed revision, and an independent verification pass drops anything it cannot support. Findings never claim tests ran unless runtime evidence was recorded.
4. **Publishes:**
   - One summary comment that is edited in place, with an overview, changed files, issues, a confidence score and an optional sequence diagram.
   - Inline findings, with committable suggestions where a small exact fix exists.
   - An optional check run.

Later pushes are reviewed incrementally. Threads for findings fixed in the new commits are resolved automatically.

## Commands in pull requests

Collaborators with write access can mention `@openreview`:

| Command | What it does |
| --- | --- |
| `@openreview review again` | Re-review the current revision |
| `@openreview review security` | Run a security-focused review |
| `@openreview explain this` | Explain a finding or code, citing current source |
| `@openreview what code depends on this` | Show callers and dependents |
| `@openreview fix this` | In a finding thread: reply with a validated suggestion and a fix-with-your-agent link |
| `@openreview fix this in a new PR` | Also open a fix pull request on a new branch (opt-in) |
| `@openreview ignore this pattern` | Save a learned preference for this kind of finding |

## Learning

Reactions (👍/👎) on findings, dashboard feedback and conventions learned from human review comments become memory. Memory is guidance that admins can inspect, edit, scope or disable. It never weakens security review.
