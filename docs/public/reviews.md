# How reviews work

When a pull request opens or updates, OpenReview:

1. **Builds context.** It combines the diff with indexed callers, callees, imports and tests, related past findings, repository rules and learned preferences. It also adds requirements from linked Linear, Jira, Confluence or Notion pages.
2. **Investigates.** The default pipeline runs specialists for correctness, security, data, compatibility, testing and performance. The optional agentic engine instead follows the code with read-only tools, and the optional hypothesis engine plans specific suspected bugs and investigates each one in parallel.
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

The summary ends with a footer such as "Review 3 on this pull request · Comment `@openreview review` to re-run it.", followed by links to the dashboard. The number counts this pull request's published reviews and stays the same when a publication is retried. The command matches what each provider accepts: `@openreview review` on GitHub, GitHub Enterprise, GitLab, Gitea, Bitbucket and Origin, `@openreview review again` on Perforce, and the dashboard on Azure DevOps, which does not accept comment commands.

## Security checks

With **Security checks** on (the default, per repository under Settings → Review), every review whose categories include security adds deterministic checks to the model's review:
- **Pattern checks** on added lines: private keys and provider tokens, secrets assigned as string literals, SQL built by string concatenation, disabled TLS certificate verification, code evaluated from non-literal values, shell commands built from variables, and unsafe deserialization. Secret values are masked in the published evidence. Test fixtures are exempt from the secret checks.
- **Dependency advisories**: added or changed versions in `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements*.txt`, `poetry.lock`, `Pipfile.lock`, `go.mod`, `go.sum`, `Cargo.lock`, `Cargo.toml` and `pom.xml` are looked up in [OSV.dev](https://osv.dev). A match becomes a finding on the changed line with the advisory links, the affected version and the fixed versions. Lockfiles of other ecosystems are listed as not checked.

These findings carry the 🔒 Security tag. They are not sent to the model verifier and learned preferences never apply to them, so feedback cannot quietly switch them off; severity thresholds still apply. For security findings the model reports itself, an extra step judges whether an exploit path from untrusted input is shown; when it is not, confidence is lowered (never below the repository's threshold), so the finding ranks lower but is not removed. If OSV cannot be reached, the review says which dependency changes were not checked. Self-hosted installs can stop all outbound advisory requests with `OSV_ENABLED=false`, or use an internal mirror with `OSV_API_URL`.

## Feature tips

With the **Feature tips** summary section on, the footer can end with one 💡 tip when the review's data suggests a feature would help: a referenced Linear or Jira issue whose integration is not connected, many recently dismissed findings (try a higher strictness), no custom rules, or the agentic engine being available but off. A repository gets at most one tip every 3 days and never the same tip twice within 30 days, and a retried publication shows the same tip. Tips are on by default on the hosted cloud (`BILLING_ENABLED=true`) and off on self-hosted installs; turn them on or off under Settings → Review → Summary sections.

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

### Replies without a mention

On GitHub, a reply in a thread that OpenReview started (one of its inline findings) is answered without `@openreview`. The answer uses the same cited, revision-pinned conversation as a mention. OpenReview does not answer:
- replies from bots, including itself, or from people without write access;
- bare acknowledgements such as "thanks", "fixed" or 👍;
- threads that a person started (mention `@openreview` there);
- more than 3 replies per thread or 10 per pull request in an hour.

Commands such as `fix this` and `ignore this pattern` still need the mention. Turn this off per repository under Settings → Review → Replies in OpenReview threads.

### Questions for the author

When a change's intent is unclear, a finding can end with one short **Question for the author** (at most 300 characters). The question is part of that finding: it never counts as a finding by itself and never blocks approval on its own. Reply in the thread to answer it.

## Learning

Reactions (👍/👎) on findings, dashboard feedback and conventions learned from human review comments become memory. Memory is guidance that admins can inspect, edit, scope or disable. It never weakens security review.
