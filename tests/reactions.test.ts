import { test } from "node:test";
import assert from "node:assert/strict";
import { Github } from "../src/github";

test("GitHub reaction polling paginates, keeps 👍/👎 from people and ignores bots and other emoji", async (t) => {
  t.mock.method(console, "log", () => {});
  const pages: Record<string, unknown[][]> = {
    "10": [Array.from({ length: 100 }, (_, i) => ({ content: i % 2 ? "+1" : "heart", created_at: "2026-10-01T00:00:00Z", user: { login: "dev" + i, type: "User" } })), [{ content: "-1", created_at: "2026-10-02T00:00:00Z", user: { login: "carol", type: "User" } }]],
    "11": [[{ content: "-1", created_at: "2026-10-02T00:00:00Z", user: { login: "renovate[bot]", type: "Bot" } }, { content: "+1", created_at: "2026-10-03T00:00:00Z", user: null }]],
  };
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const u = new URL(url), id = /\/pulls\/comments\/(\d+)\/reactions$/.exec(u.pathname)![1], page = Number(u.searchParams.get("page"));
    seen.push(id + ":" + page);
    return Response.json(pages[id][page - 1] ?? []);
  });
  const rows = await new Github("fixture").reactions("o/r", [10, 11]);
  assert.deepEqual(seen, ["10:1", "10:2", "11:1"]);
  assert.equal(rows.length, 51);
  assert.ok(rows.every((r) => r.reaction === "+1" || r.reaction === "-1"));
  assert.deepEqual(rows.at(-1), { commentId: "10", user: "carol", reaction: "-1", createdAt: Date.parse("2026-10-02T00:00:00Z") });
  assert.ok(!rows.some((r) => r.user.endsWith("[bot]")));
});
