import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewFooter, reviewLinks, rerunCommand } from "../src/review-summary";
import { Github } from "../src/github";

test("the footer names the review number and each provider's re-run command", () => {
  assert.equal(reviewFooter(3, "other"), "\n\nReview 3 on this pull request · Comment `@openreview review` to re-run it.");
  // Perforce's native dispatch only accepts the whole-comment form; Azure DevOps service hooks take no commands.
  assert.equal(reviewFooter(1, "perforce"), "\n\nReview 1 on this pull request · Comment `@openreview review again` to re-run it.");
  assert.equal(reviewFooter(2, "azure-devops"), "\n\nReview 2 on this pull request · Re-run it from the dashboard.");
  assert.equal(reviewFooter(undefined, "other"), "\n\nComment `@openreview review` to re-run it.");
  assert.deepEqual((["other", "perforce", "azure-devops"] as const).map(rerunCommand), ["@openreview review", "@openreview review again", undefined]);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => reviewFooter(bad, "other"), /Invalid review number/);
  // Every advertised command matches the dispatch patterns that accept it.
  assert.match("@openreview review", /@openreview\s+review(?:\s+again|\s+security)?\b/i);
  assert.match("@openreview review again", /^@openreview\s+(?:re-review|rereview|review\s+again)[.!]?$/i);
});

test("GitHub renders the footer above the dashboard links and the last reviewed commit", async (t) => {
  t.mock.method(console, "log", () => {});
  process.env.APP_URL = "https://review.example.com";
  const head = "a".repeat(40);
  const comments: { id: number; body: string; user: { login: string } }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/repos/o/r/pulls/1") return Response.json({ state: "open", head: { sha: head } });
    if (path.endsWith("/reviews")) return Response.json([]);
    if (path === "/repos/o/r/issues/1/comments" && options.method === "POST") { const c = { id: 1, body: JSON.parse(String(options.body)).body, user: { login: "openreview[bot]" } }; comments.push(c); return Response.json(c); }
    if (path === "/repos/o/r/issues/1/comments") return Response.json(comments);
    throw new Error("Unexpected endpoint " + path);
  });
  try {
    await new Github("fixture", undefined, async () => "openreview").publish("o/r", 1, head, "Summary body" + reviewFooter(4, "other"), [], "review-4");
    assert.match(comments[0].body, /Summary body\n\nReview 4 on this pull request · Comment `@openreview review` to re-run it\.\n\n\[View review \/ Re-review\]\(https:\/\/review\.example\.com\/dashboard\/pulls\/review-4\)\n\n\*\*Last reviewed commit:\*\*/);
    assert.equal(reviewLinks("review-4", 0), "\n\n[View review / Re-review](https://review.example.com/dashboard/pulls/review-4)");
  } finally { delete process.env.APP_URL; }
});
