import test from "node:test";
import assert from "node:assert/strict";
import { fixtures } from "../scripts/fixtures";
import { scanChanges } from "../src/security-scan";
import { isRequirementSource } from "../src/requirements-check";

// The round-2 fixtures must exercise the feature they were written for; quality is measured only by an
// approved live `pnpm eval` run.
const byId = (id: string) => { const f = fixtures.find((x) => x.id === id); assert.ok(f, id); return f; };

test("hypothesis fixture: the defect is two hops from the change, reachable only through agent tools", () => {
  const f = byId("hypothesis-page-offset");
  assert.deepEqual(f.repositoryFiles?.map((s) => s.path), ["src/api.ts"]);
  assert.ok(!f.input.files.some((s) => s.path === "src/api.ts"), "the 1-based caller is not in the pipeline payload");
  assert.match(f.repositoryFiles![0].content, /1-based/);
  assert.deepEqual(f.expected, { path: "src/change.ts", category: "correctness", terms: ["page", "offset", "skip", "first", "1-based"] });
});

test("security fixture: the deterministic scan flags the shell command built from request input", () => {
  const f = byId("security-command-injection");
  assert.deepEqual(scanChanges(f.input.diff).map((s) => [s.checkId, s.filePath, s.category]), [["shell-injection", "src/change.ts", "security"]]);
  assert.equal(f.expected?.category, "security");
});

test("requirements fixture: one linked ticket with provenance whose criterion the change breaks", () => {
  const f = byId("requirements-soft-delete");
  const tickets = f.input.files.filter(isRequirementSource);
  assert.deepEqual(tickets.map((t) => [t.path, t.provenance?.sourceUrl]), [["requirements/linear/evaluation/PAY-7.md", "https://linear.app/evaluation/issue/PAY-7"]]);
  assert.match(tickets[0].content, /must never appear in the export/);
  assert.match(f.input.title, /^PAY-7: /);
  assert.ok(f.input.diff[0].patch?.includes("-export function exportRows(customers) { return customers.filter((c) => !c.deletedAt)"));
});
