import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, unifiedPatch } from "../src/text-diff";
import { changedLines } from "../src/engine/patch-lines";
import { parsePatch } from "../src/diff-view";

test("computed unified patches match git's hunks and anchor changed lines", () => {
  const a = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", b = "a\nb\nX\nd\ne\nf\ng\nh\ni\nj\nk\n";
  assert.equal(unifiedPatch(a, b), "@@ -1,6 +1,6 @@\n a\n b\n-c\n+X\n d\n e\n f\n@@ -8,3 +8,4 @@\n h\n i\n j\n+k");
  assert.deepEqual([...changedLines(unifiedPatch(a, b))], [3, 11]);
  assert.equal(unifiedPatch("", "x\ny\n"), "@@ -0,0 +1,2 @@\n+x\n+y");
  assert.equal(unifiedPatch("x\ny\n", ""), "@@ -1,2 +0,0 @@\n-x\n-y");
  assert.equal(unifiedPatch("same\n", "same\n"), "");
  assert.equal(unifiedPatch("a\r\nb\r\n", "a\nb\n"), "", "line endings are normalised");
});
test("nearby changes merge into one hunk; parsed hunks round-trip line numbers", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 5\n", "line five\n").replace("line 9\n", "line nine\n").replace("line 18\n", "");
  const patch = unifiedPatch(before, after);
  const hunks = parsePatch(patch);
  assert.equal(hunks.length, 2, "changes 4 lines apart share a hunk; a distant one gets its own");
  assert.deepEqual(hunks[0].lines.filter((l) => l.kind === "add").map((l) => [l.new, l.text]), [[5, "line five"], [9, "line nine"]]);
  assert.deepEqual(hunks[1].lines.filter((l) => l.kind === "del").map((l) => [l.old, l.text]), [[18, "line 18"]]);
});
test("the edit bound falls back to a whole-file replacement instead of running unbounded", () => {
  const ops = lineDiff(["a", "b", "c"], ["x", "y", "z"], 1);
  assert.deepEqual(ops.map((o) => o.op + o.text), ["-a", "-b", "-c", "+x", "+y", "+z"]);
  assert.deepEqual(lineDiff(["a", "b"], ["a", "c", "b"]).map((o) => o.op + o.text), [" a", "+c", " b"]);
});
