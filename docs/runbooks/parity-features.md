# Runbook: Phase B–D capabilities

Each capability below passed automated tests with fakes. This runbook verifies each one live on GitHub, the reference provider, unless noted.

Use one disposable repository with a seeded defect:

```ts
export const total = (cents: number, qty: number) => (cents * qty) / 100;
export const charge = (cents: number) => provider.charge({ amount: total(cents, 1) });
```

Before starting, confirm that the inference budget covers about 15 reviews or questions.

## B1 Committable suggestions

1. Open a PR with the defect.
2. Confirm:
   - [ ] A finding shows a `suggestion` block covering exactly the finding's lines.
   - [ ] **Commit suggestion** applies cleanly.
   - [ ] A finding whose fix spans other lines has no block.

## B2 and B3 Summary and multi-line comments

1. Confirm:
   - [ ] One summary comment with Overview, Files changed, Issues, Confidence score and Skipped files.
   - [ ] A multi-line finding inside one hunk is anchored with `start_line`.
2. Push again. Confirm:
   - [ ] The summary is edited in place, not reposted.

## B4 Sequence diagram

1. Use a PR touching 3+ files in one call chain.
2. Confirm:
   - [ ] The summary contains a rendered Mermaid sequence diagram.
   - [ ] Every participant is a real file or symbol in the diff.

## B5 Incremental review

1. Fix the defect in a new commit.
2. Confirm:
   - [ ] The re-review covers only the new changes.
   - [ ] OpenReview resolves the fixed finding's thread.
   - [ ] Human threads are untouched.

## B6 Check runs

Requires Checks: Read and write (Needs human #11).

1. Confirm:
   - [ ] An `OpenReview` check is in progress during the review, then completes neutral.
2. Set **GitHub check run** to fail at high severity and re-review. Confirm:
   - [ ] The check fails while a high finding exists.

## B7 Triggers and filters

1. Turn off automatic reviews and set the trigger label `ai-review`.
2. Confirm:
   - [ ] A new PR is not reviewed until the label is added.
   - [ ] An excluded author's PR is skipped.
   - [ ] A PR over the line limit is skipped with a logged reason.

## B8 Configuration as code

1. On the base branch, commit `.openreview.json` with `{"settings":{"maxComments":1}}`.
2. In a PR, change the file to `maxComments: 30`. Confirm:
   - [ ] The base value (1) applies.
3. Lock `maxComments` in the dashboard. Confirm:
   - [ ] The dashboard value wins, and repository settings show `maxComments` as blocked by the lock.

## C1 Reactions

1. React 👎 to a finding as a human, then close the PR. Confirm:
   - [ ] Analytics shows the reaction.
   - [ ] A learned preference appears in Memory.
2. On GitLab (Emoji events enabled), confirm:
   - [ ] The same flow works through webhooks.

## C2 Learned conventions

1. Merge two PRs in which human reviewers left the same request, for example "paginate list endpoints".
2. After the daily job, or `npx convex run conventionJobs:sweep`, confirm:
   - [ ] A suggested convention cites both comments.
3. Approve it. Confirm:
   - [ ] It appears in the next review's guidance.

## C3 Memory management

1. In Memory → Learned preferences, edit a preference and set its scope to Workspace.
2. Confirm:
   - [ ] It applies to a second repository.
   - [ ] The audit log has one event per change.
   - [ ] A viewer sees no edit controls.

## C4 `@openreview fix this`

1. Reply `@openreview fix this` on a finding. Confirm:
   - [ ] A validated suggestion and a Fix link.
2. Enable Fix pull requests, grant Contents write (Needs human #14), and reply `@openreview fix this in a new PR`. Confirm:
   - [ ] A PR from `openreview/fix-*` targets the PR branch.
   - [ ] The PR branch itself is unchanged.

## D1 Codebase chat

1. Ask in Dashboard → Chat: "Where is the checkout amount computed?"
2. Confirm:
   - [ ] Investigation steps stream.
   - [ ] Every `[n]` citation links to the indexed commit and quotes real lines.
   - [ ] A follow-up keeps context.
   - [ ] A second member cannot see the thread.

## D2 Public API

1. Create read and write keys. Run the `curl` examples in [the API docs](../public/api.md). Confirm:
   - [ ] `POST /api/query` returns cited sources.
   - [ ] `stream: true` produces SSE.
   - [ ] `POST /api/search` ranks the defect file first.
   - [ ] The read key gets 403 on `POST /api/repositories`.

## D3 Remote MCP

1. Add the remote server to an MCP client (see [MCP](../public/mcp.md)). Confirm:
   - [ ] `tools/list` shows 11 tools.
   - [ ] `ask_codebase` returns a cited answer.
   - [ ] A request without a key gets 401.

## D4 Slack and email

Requires Needs human #15–16.

1. Add to Slack.
2. Link a channel with Q&A on, and with both notification events. Confirm:
   - [ ] A completed review posts.
   - [ ] A high-severity finding posts.
   - [ ] `@OpenReview where is the total computed?` answers in the thread with links.
   - [ ] `/openreview status` lists the repository.
3. Verify an email address and choose "My pull requests". Confirm:
   - [ ] An email arrives for your PR, and only once.

## D5 Notion and Confluence

Requires Needs human #17.

1. Connect Notion and share one spec page. Link it in a PR description. Confirm:
   - [ ] The review uses the requirements, cited with the page URL.
2. Revoke the page's connection in Notion and re-review. Confirm:
   - [ ] The page is skipped with a coverage note.
3. In Atlassian, select a few spaces using the filter and select-all. Confirm:
   - [ ] A linked Confluence page is used.
   - [ ] An unselected space is refused.

## Evidence and cleanup

For each section, record the PR or thread URL, the reviewed SHA and screenshots, then update the matching row in [the acceptance matrix](../acceptance-matrix.md). Revert test settings, revoke test keys and tokens, and close the disposable PRs.
