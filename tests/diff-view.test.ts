import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, placeFindings } from "../src/diff-view";

const patch = "@@ -1,3 +1,4 @@ export function total\n const a = 1;\n-const t = p * 100;\n+const t = Math.round(p * 100);\n+const u = t;\n export { a };\n\\ No newline at end of file\n@@ -20,2 +21,2 @@\n-old();\n+next();\n tail();";
test("unified diff hunks carry old and new line numbers", () => {
  const hunks = parsePatch(patch);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].header, "@@ -1,3 +1,4 @@ export function total");
  assert.deepEqual(hunks[0].lines, [{ kind: "ctx", old: 1, new: 1, text: "const a = 1;" }, { kind: "del", old: 2, text: "const t = p * 100;" }, { kind: "add", new: 2, text: "const t = Math.round(p * 100);" }, { kind: "add", new: 3, text: "const u = t;" }, { kind: "ctx", old: 3, new: 4, text: "export { a };" }]);
  assert.deepEqual(hunks[1].lines.map((l) => [l.kind, l.old, l.new]), [["del", 20, undefined], ["add", undefined, 21], ["ctx", 21, 22]]);
  assert.deepEqual(parsePatch(""), []);
});
test("findings sit after their new-side line; others are listed as outside the hunks", () => {
  const { at, outside } = placeFindings(parsePatch(patch), [{ startLine: 2, id: "a" }, { startLine: 22, id: "b" }, { startLine: 99, id: "c" }, { startLine: 2, id: "d" }]);
  assert.deepEqual([...at].map(([line, fs]) => [line, fs.map((f) => f.id)]), [[2, ["a", "d"]], [22, ["b"]]]);
  assert.deepEqual(outside.map((f) => f.id), ["c"]);
});
