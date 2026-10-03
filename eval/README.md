# Evaluation harness

`pnpm eval` runs OpenReview's real review pipeline — the indexer, retrieval, classification, the specialized agents,
and the verifier — over a set of small pull requests with documented bugs, and reports how many of those bugs the
review found.

This directory ships **no benchmark results**. The numbers you get depend entirely on the model you run it with, so
run it yourself (below) and read the report it writes.

## Layout

```
eval/
  cases/<id>/
    base/            repository snapshot before the pull request
    pr.patch         the pull request (unified diff, applied with `git apply`)
    expected.json    PR title/body, the issues a reviewer should report, and documented non-issues
  recordings/<mode>/<id>.json   model answers replayed by `--recorded` (see "Recordings")
  reports/           written by every run (git-ignored)
```

The cases cover: authentication (`auth-session-expiry`), authorization / missing org check
(`authz-missing-org-check`), null handling (`null-handling`), concurrency (`concurrency-race`), data loss from a
destructive migration (`data-loss-migration`), a breaking API change with a downstream consumer outside the diff
(`breaking-api-change`), a database query bug (`query-n-plus-one`), cross-file logic (`cross-file-units`), missing
input validation (`missing-validation`), a regression of a fixed bug whose test is removed
(`regression-test-removed`), and two clean pull requests with nothing to report (`clean-refactor`, `clean-feature`),
which measure false positives.

## Running it

With a real model (the same variables as the app; see `.env.example`):

```sh
LLM_PROVIDER=anthropic LLM_API_KEY=... pnpm eval
pnpm eval --mode deep --case cross-file-units --case data-loss-migration
pnpm eval --concurrency 4 --out /tmp/eval-reports
```

Each case is indexed into its own throwaway in-process Postgres (PGlite); nothing touches `DATABASE_URL`. Without an
embedding key, retrieval uses the code graph and full-text search only (as the app does).

Offline and deterministic (what CI runs as a test):

```sh
pnpm eval --provider fake --recorded
```

Options: `--mode fast|standard|deep` (default `standard`), `--case <id>` (repeatable or comma-separated),
`--concurrency <n>` (default 2), `--out <dir>` (default `eval/reports`), `--recordings <dir>`.

The exit code is 1 when a case fails to run (a broken fixture, a missing recording, a model error), never because of
the scores.

## Recordings

`--record` runs live and saves every model answer (with its token usage and the model that served it) to
`eval/recordings/<mode>/<id>.json`, labelled `"origin": "recorded"`. `--recorded` replays them without network access;
calls are matched by task and agent in order, and a call the recording does not have fails the case instead of
inventing an answer.

The recordings committed under `eval/recordings/standard/` are **`"origin": "scripted"`: hand-written answers** that
make the harness itself testable in CI. They are not model output and their scores (by design: one missed bug, one
duplicate, one false positive on a clean PR) say nothing about review quality; every report replaying them says so at
the top. Replace them with `pnpm eval --record` when you want a reproducible baseline for a specific model.

## Reading the report

Every run writes `reports/<timestamp>.md` and `.json` and prints a table:

- **True positive (TP)** — the first finding that matches a documented issue.
- **Duplicate** — another finding about an issue that was already matched (noise, not a wrong claim).
- **False positive (FP)** — a finding that matches no documented issue; if it hits a documented non-issue (something
  a reviewer might flag that is fine in context), the report names it.
- **Missed** — a documented issue no finding matched.
- **Precision** = TP / (TP + FP); **recall** = TP / expected issues. Shown as `—` when undefined.
- **Latency** is the review engine's wall-clock time per case (indexing excluded); **tokens** and **estimated cost**
  come from the engine's per-call accounting and the price table (`LLM_PRICING_JSON` extends it). Models without a
  known price — including replayed scripted answers — show as `unpriced`.

A finding matches an issue when it is on the same file, its lines overlap the issue's range widened by 5 lines on
each side, and it has the issue's category or mentions one of its keywords. Findings are matched strongest first
(severity, then confidence). The matcher is in `lib/eval/match.ts`.

Small case counts make single runs noisy: compare runs of the same mode and model, look at the per-case details, and
treat a change of one case as one case, not a percentage.

## Adding a case

1. Create `cases/<id>/base/` with the files before the change (keep it small, but include the code outside the diff
   that the bug depends on — that is what tests retrieval).
2. Make the change in a scratch copy and save `git diff` as `cases/<id>/pr.patch`.
3. Write `cases/<id>/expected.json`: `title`, `kind`, `pr` (`title`, `body`), `expected` (each with `id`, `file`,
   `lines` in new-file numbering, `category` — one of the reviewer agents — `severity`, `description`, `keywords`), and
   optional `nonIssues`.
4. Run it live with `--case <id>`, check the report, and `--record` it if you want it in the replayed set.
   `tests/r6.24-eval.test.ts` checks that every patch applies and every documented range exists.
