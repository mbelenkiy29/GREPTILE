# Runbook: round-2 capabilities

Automated tests cover these capabilities with fakes, local servers and convex-test only. Each one also
needs a run against real services. Follow the general rules in the [runbooks index](README.md):
disposable repositories and test accounts, no secrets in screenshots, and an approved inference budget
before any step that runs a review.

Prerequisites for every section: a deployed OpenReview whose web and Convex HTTP origins the provider
can reach, the GitHub App installed on a test repository (or the provider named in the section), and a
workspace admin account. Record each outcome in the [acceptance matrix](../acceptance-matrix.md) as
*verified live on a real provider*, with links to the comments or screenshots.

## G3 Replies without a mention (GitHub)

1. Confirm the GitHub App subscribes to **Pull request review comment** events (App settings →
   Permissions & events).
2. Open a pull request with an obvious defect, then wait for the review and its inline finding.
3. As a collaborator with write access, reply in the finding's thread without mentioning OpenReview,
   for example "Why is this a problem here?". Expect one grounded answer in the same thread within a
   minute or two.
4. Reply "thanks". Expect no answer, because bare acknowledgements are skipped.
5. Reply from an account with read access only. Expect no answer.
6. Post a question in a thread that a human started. Expect no answer.
7. Ask three more questions in the original thread within an hour. Only three answers per thread per
   hour are expected, and the fourth question gets no answer.
8. In the repository's review settings, clear **Answer replies to OpenReview's inline findings without
   an @openreview mention**, reply again, and expect no answer. Then select it again.

## J1 Three-engine evaluation (Needs human #25)

This step spends inference budget. Run it only after the spend is approved.

1. Run `pnpm eval --validate`. It makes no model calls and must list 18 fixtures, including
   `hypothesis-page-offset`, `security-command-injection` and `requirements-soft-delete`.
2. Run `pnpm eval`, `pnpm eval --engine=agentic` and `pnpm eval --engine=hypotheses`. After each run,
   rename `reports/evaluation.json` so it is not overwritten.
3. Compare recall on the multi-hop fixtures, false positives on the clean fixtures, cost and latency.
   Agentic and hypothesis reports include transcripts that explain any misses.
4. Record the default-engine decision and the numbers in `docs/parity/REPORT.md`.

## J2 Vulnerability advisories (OSV)

1. Leave `OSV_ENABLED` unset, or set it to `true`, in the Convex environment. Leave
   `OPENREVIEW_OFFLINE` unset.
2. In a test repository, open a pull request that pins a dependency version with a published
   advisory. For example, change `package.json` and its lockfile to `lodash@4.17.20`. Before you start,
   confirm the advisory exists on https://osv.dev.
3. Expect a Security-tagged finding that names the advisory ID and the fixed version, anchored on the
   changed lockfile or manifest line.
4. Add a hard-coded test token, for example `api_key = "sk_test_…"`, in a non-test file. Expect a
   pattern finding whose published evidence masks the value.
5. Set `OSV_ENABLED=false` and re-run the review. Expect a coverage note saying that advisory lookups
   are off, and no advisory finding.

## J3 Generated tests in the sandbox (Needs human #26)

Follow the steps in Needs human #26 and [runtime-worker.md](../runtime-worker.md). Record whether each
generated test reproduced the defect, and confirm that nothing was pushed to the pull request branch.

## L3 MCP sign-in with a real client

1. In Claude Code, run `claude mcp add --transport http openreview https://<host>/api/mcp`, then run
   `/mcp` and choose OpenReview to authenticate. A client that supports Client ID Metadata Documents
   uses one. Older clients register themselves first.
2. The browser opens the consent page. Check that the client name, redirect host, workspace and scopes
   are right, then approve.
3. Ask the client to list OpenReview tools and call `get_review_status` for a pull request. Expect only
   that workspace's data.
4. In Settings → API Keys, find the client under **Connected MCP clients** and revoke it. The next tool call
   must ask you to sign in again.
5. Repeat with a client that uses Dynamic Client Registration, if one is available.

## L4 Plugins and the resolve loop

1. Claude Code: set `OPENREVIEW_URL`, run `/plugin marketplace add <owner>/<repo>` and then
   `/plugin install openreview@openreview`, and sign in with `/mcp`. Run
   `/openreview:review-status` on a pull request that has open findings.
2. Run `/openreview:resolve-review-findings`. Expect local commits, a prompt before every push, a
   re-review of the pushed commit, and a stop when the pull request is clean or after three rounds.
   Expect no force-push.
3. Codex: point `plugins/openreview/mcp.json` at the server, run
   `codex plugin marketplace add <owner>/<repo>`, install **OpenReview** from the Plugins Directory,
   then ask Codex to fix the open OpenReview findings.
4. From the command line, run `openreview resolve --pr <n> --fix-agent claude`, and again with
   `--fix-agent codex`.

## L5 Send to Devin (optional)

1. Under Personal agents, save a Devin API key for a test organization.
2. On a fixable finding, choose **Send to Devin**. Expect a new, unlisted Devin session that opens with
   the finding's prompt.
3. Remove the key. The button must disappear.

## M1 Credits, free plan and spending caps (Needs human #27)

Held back from main on 2026-10-16: it conflicts with the live Starter plan (unlimited reviews under fair use, docs/billing.md and docs/roadmap/pricing-tiers.md). The code stays on the `parity` branch (commit bcdebaa). Skip this section on main.

Use Stripe test mode only. Follow Needs human #27 and [billing.md](../billing.md). Then confirm:

- A credit-pack checkout adds credits once, even when the webhook is replayed.
- A capped team pauses reviews at the cap and shows the reason.
- The admin receives the 80% and 100% notices once each.
- The meter shows events whose identifiers match the review's meter rows.

## M2 SSO with a real identity provider (Needs human #28)

Follow Needs human #28 and [sso.md](../sso.md) with a test tenant. Test SAML and OIDC each once.

- An expired or replayed assertion must be refused.
- With **Require SSO** on, a member's GitHub session is refused while an owner keeps access.

## M4 Cluster install and offline mode (Needs human #30)

Follow Needs human #30 and [self-hosting-kit.md](../self-hosting-kit.md). For offline acceptance,
capture the egress logs for one full review. They must show only the model, embedding, code-host and
identity-provider hosts.

## M5 Self-managed GitLab behind a proxy (Needs human #31)

Follow Needs human #31 and [gitlab.md](../gitlab.md#behind-proxies-and-private-certificate-authorities).
Also confirm that a redirect to another host is refused: point the internal API URL at a host that
answers with a 302 to a different host, and expect an error. The proxy log must show no request to that
other host.

## Evidence and cleanup

Record the date, deployment, provider, the evidence links and any deviation for each section. Then:

- revoke test tokens, the MCP client and the Devin key,
- delete the test IdP app and the DNS TXT record,
- archive the test pull requests and repositories.
