# How reviews work

When a pull request opens or updates, OpenReview:

1. **Builds context.** It combines the diff with indexed callers, callees, imports and tests, related past findings, repository rules and learned preferences. It also adds requirements from linked Linear, Jira, Confluence or Notion pages, and the knowledge base entries about the changed files (ranked, bounded by a per-mode token budget and labelled as background: they guide what to check but never count as evidence, and entries about deleted files are skipped). The summary's Coverage section lists the entries that were used. Changes that import a supported API also get matching guidance packs (webhook signatures, idempotency keys, SDK retries and timeouts, or the repository's own packs in `.openreview/guides/`); packs add checks to look for and never suppress findings.
2. **Investigates.** The default pipeline runs specialists for correctness, security, data, compatibility, testing and performance. The optional agentic engine instead follows the code with read-only tools, and the optional hypothesis engine plans specific suspected bugs and investigates each one in parallel.
3. **Verifies.** Every finding must quote exact source lines at the reviewed revision, and an independent verification pass drops anything it cannot support. Findings never claim tests ran unless runtime evidence was recorded.
4. **Publishes:**
   - One summary, edited in place on every review. It opens with a verdict and the confidence score, followed by an overview, the issues, findings outside the changed code and an optional sequence diagram. On GitHub it goes at the end of the pull request description by default (see [Where the summary goes](#where-the-summary-goes)); other providers use one comment.
   - Inline findings, with committable suggestions where a small exact fix exists. On GitHub each one also has a collapsed **Prompt for your coding agent** with the file, lines, problem and suggested fix, ready to paste into Claude Code, Codex or Cursor.
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

## Where the summary goes

On GitHub the summary is written to the end of the pull request description, between two hidden markers. Each review replaces only that block; anything the author writes above or below it is kept. Reviews never read the block back as part of the description. If GitHub refuses the edit, or the description would exceed GitHub's size limit, the summary goes to one comment instead. To always use a comment, set **Review summary location** to "one comment" under Settings → Review (or per workspace and team defaults). When a pull request moves from one location to the other, the old summary comment becomes a short pointer and an old description block is removed.

On GitHub the summary is laid out for scanning:
- The verdict and confidence score come first, with the score's one-sentence reason under them.
- Each row in **Issues** links to its inline thread.
- The sequence diagram is shown open.
- Changed files, the coding-agent prompt for all open findings, risk, resolved findings, skipped files, test source, test execution and coverage are collapsed.

The dashboard and the other providers show the same sections as plain headings.

The **Prompt for your coding agent** section lists every open finding (highest priority first, at most 20) as one copyable block. It asks the agent to confirm each problem in the current code before changing it. Turn it off by unchecking that summary section.

## Reactions

On GitHub, OpenReview reacts so people can see a request was picked up:
- 👀 on an `@openreview` comment, or on a reply in an OpenReview thread that it will answer.
- 👍 on an `@openreview review` comment once the requested review is published.
- 👍 on a bare acknowledgement ("thanks", "fixed") in an OpenReview thread, instead of a text reply.

Reactions follow the same permission rules as replies: only people with write access, never bots. A failed reaction never blocks the request.

## Check runs

With the Checks: read and write permission, each GitHub review has an "OpenReview" check. It shows as in progress while the review runs, then reports the files reviewed, the findings, the verdict and the confidence score. By default the check is neutral. Two settings under Settings → Review can make it fail:
- **GitHub check run:** fails when a finding reaches the chosen severity.
- **Check run minimum confidence:** fails when the confidence score is below the chosen value (1–5). The check says the review itself completed, and it is not applied when no score was recorded.

A review that stops because a newer commit arrived ends neutral as "Superseded by a newer revision".

## When the plan blocks a review

On the hosted cloud, if the workspace's plan does not cover another review, OpenReview posts one short comment on that pull request. The comment names no plan details and points admins to Settings → Billing. Later blocked reviews on the same pull request stay quiet, and reviews requested from the dashboard never post one.

## Agent-authored pull requests (experimental)

OpenReview recognises pull requests written by coding agents from explicit signals only, never from code style: a known agent bot author (for example `copilot-swe-agent[bot]` or `devin-ai-integration[bot]`), a `Co-Authored-By` trailer naming an agent with its address (Claude, Cursor Agent, Codex, Copilot, Devin, Aider), an agent branch prefix (`claude/`, `copilot/`, `cursor/`, `codex/`, `devin/`, `jules/`), or a marker the agent writes into the description. Set **Review model for agent-authored pull requests** (`aiAuthoredModel`, empty by default) to review those pull requests with a different model; it inherits from workspace and team settings like other review settings. The review page shows which signal matched and the model used. On GitHub, commit trailers are read from the pull request's commits; other providers use the author, branch and description.

## Requirements check

When a pull request references a Linear, Jira or Notion ticket that OpenReview can read, the summary gets a **Requirements** section. Each acceptance criterion is quoted exactly from the ticket and marked ✅ met, ❌ not met or ❔ unclear, with the code lines it relied on. Criteria the model cannot quote from the ticket are dropped, and "met" without matching code becomes "unclear". A "not met" criterion whose evidence includes a changed line becomes a finding, after the usual verification. Any "not met" criterion backed by code blocks automatic approval, and unclear criteria add a coverage note (which also blocks it). Turn the check off by unchecking the Requirements summary section.

## Generated reproduction tests

When the runtime worker is set up and an administrator opts in, OpenReview drafts a small test for up to three verified findings and runs each one in the isolated sandbox on a copy of the reviewed revision. A test that fails reproduces the defect and raises the finding's confidence; one that passes lowers it. Each finding's comment shows the recorded outcome, the command, the test code and the output. The tests are never committed. See [runtime validation](../runtime-worker.md#generated-reproduction-tests).

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

## Review tier per pull request

The tier (fast, standard or deep) comes from, in order: an `@openreview review fast|standard|deep` comment for that run, an `openreview:fast|standard|deep` label on the pull request (several labels: the highest wins; a tier label also starts reviews of labelled pull requests even when automatic reviews are off), then the configured tier, which touched `.openreview/` folders can raise. Admins can cap the tier with **Highest tier a request may use** (`maxReviewTier`); the cap applies to every source. The review page shows the tier used and where it came from.

## Commands in pull requests

Collaborators with write access can mention `@openreview`:

| Command | What it does |
| --- | --- |
| `@openreview review again` | Re-review the current revision |
| `@openreview review security` | Run a security-focused review |
| `@openreview review fast` / `standard` / `deep` | Re-review at that tier for this run (an admin cap may lower it) |
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

### Learning from commits

OpenReview also learns from what authors do with findings:

- **Addressed:** a later commit changed the flagged lines (within two lines), and the next review verified the fix against the new code. The commits are compared with the last reviewed commit. After a force-push or rebase, or when that comparison is unavailable or incomplete, fixes still count as resolved, but no commit is credited with them.
- **Ignored:** the pull request merged while a finding was still open and nobody had given feedback on it. This is recorded only when the last review covered the merged commit. If commits landed after that review, nothing is recorded, because they may have fixed the finding.

Each finding records at most one outcome. For each repository and category, OpenReview keeps one learned preference, built from the last 50 outcomes of the past 180 days:

- It needs at least five outcomes, and at least 70% of them must point the same way.
- When most findings in a category were fixed, the preference tells reviews to keep reporting that kind of issue.
- When most were merged unaddressed, it asks for a concrete defect and its impact before reporting. It never asks for silence.
- Security findings are never narrowed this way.
- The preference is withdrawn when the outcomes stop pointing clearly one way.
- An admin who disables it on the Memory page keeps it disabled, even as the counts update.

On the Analytics page, **Fixed before merge** shows the share of findings with an outcome that were fixed by a follow-up commit, with a daily chart of both counts.
