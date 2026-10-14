# How reviews work

When a pull request opens or updates, OpenReview:

1. **Builds context.** It combines the diff with indexed callers, callees, imports and tests, related past findings, repository rules and learned preferences. It also adds requirements from linked Linear, Jira, Confluence or Notion pages.
2. **Investigates.** The default pipeline runs specialists for correctness, security, data, compatibility, testing and performance. The optional agentic engine instead follows the code with read-only tools.
3. **Verifies.** Every finding must quote exact source lines at the reviewed revision, and an independent verification pass drops anything it cannot support. Findings never claim tests ran unless runtime evidence was recorded.
4. **Publishes:**
   - One summary comment that is edited in place. It opens with a verdict and the confidence score, followed by an overview, changed files, issues, findings outside the changed code and an optional sequence diagram.
   - Inline findings, with committable suggestions where a small exact fix exists.
   - An optional check run.

Later pushes are reviewed incrementally. Threads for findings fixed in the new commits are resolved automatically.

## Verdict

The first line of every summary is one of four verdicts. It is computed from recorded data only, never from model prose:

| Verdict | When |
| --- | --- |
| **Needs changes** | Any unresolved critical or high finding, or a confidence score of 0–2 |
| **Merge after fixes** | Any unresolved medium finding, or a confidence score of 3 |
| **Ready to merge** | Only low findings or none, and a score of 4–5 |
| **Review incomplete** | Would be ready, but some changed code was not reviewed (skipped files, a failed specialist, unavailable sources or an agent that ran out of budget), or no score was recorded |

The score is shown next to the verdict when the confidence-score summary section is enabled.

## Priorities and tags

Each finding carries a priority derived from its severity. Badges are text and emoji only, so they render the same on self-hosted installs, in Slack and in email:

| Priority | Severity |
| --- | --- |
| 🔴 P0 | critical |
| 🟠 P1 | high |
| 🟡 P2 | medium |
| 🔵 P3 | low |

Findings in the security category also carry a separate 🔒 Security tag. Priorities and tags appear on inline comments, in the summary's issue table, on the dashboard, in Slack and email notifications, in the CLI output and as additive `priority` and `tags` fields in the REST API (`GET /api/reviews/{id}`) and the MCP `get_review`, `get_findings` and `get_finding` tools. Existing fields, including `severity`, are unchanged.

## Findings outside the changed code

A change can break code it did not touch, such as a caller in another file that still expects the old behavior. OpenReview keeps such a finding only when its evidence quotes, exactly, a line the pull request changed that causes the problem. These findings are listed in an **Outside the changed code** section of the summary (always shown when there are any) and on the review page. They are never posted as inline comments, because providers only accept those on changed lines, and they carry no committable suggestion.

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
