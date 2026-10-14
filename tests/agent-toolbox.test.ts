import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewToolbox } from "../convex/agentToolbox";
import type { ActionCtx } from "../convex/_generated/server";
import type { Doc } from "../convex/_generated/dataModel";

const headSha = "h".repeat(40);
const repo = { _id: "repo1", fullName: "acme/app", indexedSha: "i".repeat(40) } as unknown as Doc<"repositories">;
test("toolbox file reads resolve to the PR head tree and reuse indexed content only for matching blobs", async () => {
  const fetched: string[] = [];
  const indexed: Record<string, { path: string; sha: string; storageId: string }> = { "src/same.ts": { path: "src/same.ts", sha: "s1", storageId: "blob-same" }, "src/moved.ts": { path: "src/moved.ts", sha: "old", storageId: "blob-old" } };
  const ctx = {
    runQuery: async (_ref: unknown, args: { paths?: string[] }) => (args.paths ?? []).flatMap((p) => (indexed[p] ? [indexed[p]] : [])),
    storage: { get: async (id: string) => new Blob([id === "blob-same" ? "indexed same" : "STALE INDEX"]) },
  } as unknown as ActionCtx;
  const head = new Map([["src/same.ts", { sha: "s1" }], ["src/moved.ts", { sha: "new" }], ["src/pre.ts", { sha: "p1" }], ["huge.bin", { sha: "x", size: 900_000 }]]);
  const toolbox = reviewToolbox(ctx, repo, headSha, head, async (_r, path, sha) => { fetched.push(path + "@" + sha); return { path, sha, content: "head content " + sha }; }, [{ path: "src/pre.ts", sha: "p1", content: "preloaded head" }, { path: "context/other/src/pre.ts", sha: "p1", content: "cross repo", provenance: { repository: "other", revision: "r", sourceUrl: "https://example.com/x" } }]);
  assert.deepEqual(await toolbox.readFile("src/same.ts"), { path: "src/same.ts", content: "indexed same", revision: headSha });
  assert.deepEqual(await toolbox.readFile("src/moved.ts"), { path: "src/moved.ts", content: "head content new", revision: headSha });
  assert.deepEqual(await toolbox.readFile("src/pre.ts"), { path: "src/pre.ts", content: "preloaded head", revision: headSha });
  assert.equal(await toolbox.readFile("src/missing.ts"), null);
  assert.equal(await toolbox.readFile("huge.bin"), null);
  assert.equal(await toolbox.readFile("context/other/src/pre.ts"), null, "cross-repository context is not readable as this repository's head");
  assert.deepEqual(fetched, ["src/moved.ts@new"]);
  assert.deepEqual(toolbox.revisions, { head: headSha, index: "i".repeat(40) });
});
