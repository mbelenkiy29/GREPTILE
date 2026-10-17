import test from "node:test";
import assert from "node:assert/strict";
import { analyticsView, answerFor, revealWords, severityOrder, triggerFlags, triggerKey, wordCount } from "../app/landing/demo-logic";
import { analytics, chat, diffFiles, findings, sources } from "../app/landing/sample";
import { severities } from "../src/engine/types";
import { parsePatch } from "../src/diff-view";

test("the demo's severity order is the review engine's", () => {
  assert.deepEqual([...severityOrder], [...severities]);
});

test("analytics totals add up for every repository and period", () => {
  const all = analyticsView(14, "all");
  assert.deepEqual(all.metrics.slice(0, 3), [["Total PRs", "24"], ["Total Reviews", "37"], ["Verified findings", "19"]]);
  for (const days of [7, 14]) {
    const views = ["all", ...Object.keys(analytics.repositories)].map((r) => analyticsView(days, r));
    for (const v of views) {
      assert.equal(v.days.length, days);
      assert.equal(v.severity.reduce((n, [, c]) => n + c, 0), v.findings.reduce((a, b) => a + b, 0), "severities cover every finding");
    }
    const [total, ...parts] = views;
    total.reviews.forEach((n, i) => assert.equal(n, parts.reduce((m, p) => m + p.reviews[i], 0)));
    total.findings.forEach((n, i) => assert.equal(n, parts.reduce((m, p) => m + p.findings[i], 0)));
  }
  assert.deepEqual(analyticsView(7, "acme/shop").days, analytics.days.slice(7));
  assert.equal(analyticsView(14, "acme/nothing").metrics[1][1], "0", "an unknown repository is empty, not an error");
});

test("typed chat questions find the matching sample answer, or none", () => {
  for (const a of chat.answers) assert.equal(answerFor(a.question), a, a.question);
  assert.equal(answerFor("which tests cover the billing code?"), chat.answers[1]);
  assert.equal(answerFor("do payment webhooks get retried?"), chat.answers[2]);
  assert.equal(answerFor("What is the meaning of life?"), undefined);
  assert.equal(answerFor(""), undefined);
});

test("answers reveal word by word as plain text", () => {
  const text = "Totals are computed by `total()` in cents.";
  assert.equal(revealWords(text, 0), "");
  assert.equal(revealWords(text, 4), "Totals are computed by ");
  assert.equal(revealWords(text, 5), "Totals are computed by total() ");
  assert.equal(revealWords(text, wordCount(text)), text.replaceAll("`", ""));
});

test("each combination of trigger switches has its own key", () => {
  const keys = new Set(Array.from({ length: 2 ** triggerFlags.length }, (_, n) => triggerKey(Object.fromEntries(triggerFlags.map((k, i) => [k, Boolean(n & (1 << i))])))));
  assert.equal(keys.size, 16);
  assert.equal(triggerKey({ automatic: true, threadReplies: true }), "1001");
});

test("sample evidence quotes the reviewed files exactly, like a real finding must", () => {
  for (const f of findings) for (const e of f.evidence) assert.equal(sources[e.filePath]?.[e.startLine - 1], e.quote, `${e.filePath}:${e.startLine}`);
  for (const file of diffFiles) for (const hunk of parsePatch(file.patch)) for (const line of hunk.lines) {
    if (line.new !== undefined) assert.equal(sources[file.path]?.[line.new - 1], line.text, `${file.path}:${line.new}`);
  }
});
