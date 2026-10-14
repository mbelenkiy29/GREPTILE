import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeView } from "../src/knowledge-view";

test("Knowledge keeps successful entries when another repository fails without leaking its error", async () => {
  const repos = [{ _id: "visible" }, { _id: "offline" }];
  const view = await knowledgeView(repos, { q: "Money" }, async repo => {
    if (repo._id === "offline") throw new Error("private credential diagnostic");
    return [{ subsystem: "Money" }];
  });
  assert.equal(view.count, 1);
  assert.equal(view.incomplete, true);
  assert.equal(view.empty, false);
  assert.deepEqual(view.results[0].entries, [{ subsystem: "Money" }]);
  assert.equal(view.results[1].failed, true);
  assert.equal(JSON.stringify(view).includes("private credential"), false);
});

test("Knowledge reports empty only after successful reads, and retry can recover a failed read", async () => {
  let available = false;
  const read = async () => {
    if (!available) throw new Error("temporary failure");
    return ["recovered"];
  };
  const failed = await knowledgeView([{ _id: "repo" }], {}, read);
  assert.equal(failed.count, 0);
  assert.equal(failed.empty, false);
  assert.equal(failed.incomplete, true);
  available = true;
  const recovered = await knowledgeView([{ _id: "repo" }], {}, read);
  assert.equal(recovered.count, 1);
  assert.equal(recovered.incomplete, false);
  const empty = await knowledgeView([{ _id: "repo" }], {}, async () => []);
  assert.equal(empty.empty, true);
});

test("Knowledge refuses oversized searches before any read and never truncates valid searches", async () => {
  const searches: (string | undefined)[] = [];
  const read = async (_repo: { _id: string }, search: string | undefined) => { searches.push(search); return []; };
  const invalid = await knowledgeView([{ _id: "repo" }], { q: "x".repeat(201) }, read);
  assert.equal(invalid.searchError, true);
  assert.equal(invalid.empty, false);
  assert.deepEqual(searches, []);
  const search = "x".repeat(200);
  const valid = await knowledgeView([{ _id: "repo" }], { q: search }, read);
  assert.equal(valid.searchError, false);
  assert.deepEqual(searches, [search]);
});

test("Knowledge retries preserve scoped filters and safely encode search text", async () => {
  const seen: string[] = [];
  const filters = { team: "team", repository: "selected", q: "a & b/#?" };
  const view = await knowledgeView([{ _id: "selected" }, { _id: "other" }], filters, async repo => {
    seen.push(repo._id); return [];
  });
  assert.deepEqual(seen, ["selected"]);
  const retry = new URL(view.retryUrl, "https://openreview.test");
  assert.equal(retry.pathname, "/dashboard/memory/knowledge");
  assert.deepEqual(Object.fromEntries(retry.searchParams), filters);
  assert.equal((await knowledgeView([], {}, async () => [])).retryUrl, "/dashboard/memory/knowledge");
});
