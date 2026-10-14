import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverRuleFiles, importCandidates, parseRuleFile } from "../src/rule-files";

const tree: Record<string, string> = {
  "CLAUDE.md": "# Project\nYou are an expert TypeScript engineer.\n\n## Commands\n- Run `pnpm test` before you commit.\n- Always push to a feature branch.\n\n## Code style\n- Always use named exports for React components.\n- **Never** store currency as floating point; keep integer cents.\n- Short.\n\n```ts\n// Always do this in code blocks\nexport const x = 1;\n```\n",
  "AGENTS.md": "## Database\n1. Every new query must include an explicit LIMIT or cursor pagination.\n2. Always use named exports for React components.\n",
  ".cursorrules": "Prefer server components over client components in app/.\nThis repository is a Next.js app.\nAvoid default exports in shared libraries under src/lib.\n",
  ".cursor/rules/api.mdc": "---\ndescription: API routes\nglobs: app/api/**/*.ts, src/server/**\nalwaysApply: false\n---\n- API handlers must validate request bodies with zod before use.\n",
  ".cursor/rules/notes.txt": "- Always ignore this file because it is not a rule file.\n",
  ".github/copilot-instructions.md": "- Ensure every webhook handler verifies the provider signature first.\n",
};
const fs = { read: async (path: string) => tree[path] ?? null, list: async (directory: string) => Object.keys(tree).filter((p) => p.startsWith(directory + "/")).map((p) => p.slice(directory.length + 1)) };

test("discovery finds the supported AI rule files, including .cursor/rules/*.mdc", async () => {
  const found = await discoverRuleFiles(fs);
  assert.deepEqual(found.map((f) => f.path), ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md", ".cursor/rules/api.mdc"]);
  assert.deepEqual((await discoverRuleFiles({ read: async () => null, list: async () => { throw new Error("missing"); } })), []);
  assert.deepEqual((await discoverRuleFiles({ read: async (p) => p === "GEMINI.md" ? "x".repeat(200_001) : null, list: async () => [] })), [], "oversized files are skipped");
});

test("parsing keeps directive statements about code and drops workflow, persona, code blocks and fragments", () => {
  const claude = parseRuleFile("CLAUDE.md", tree["CLAUDE.md"]);
  assert.deepEqual(claude.map((r) => [r.title, r.instructions, r.source.line]), [
    ["Code style: Always use named exports for React components", "Always use named exports for React components.", 9],
    ["Code style: Never store currency as floating point; keep integer…", "Never store currency as floating point; keep integer cents.", 10],
  ]);
  // Plain-text files use their lines; non-directive lines drop out.
  assert.deepEqual(parseRuleFile(".cursorrules", tree[".cursorrules"]).map((r) => r.instructions), ["Prefer server components over client components in app/.", "Avoid default exports in shared libraries under src/lib."]);
  // Cursor frontmatter globs scope the imported rule; unsafe globs are dropped.
  const api = parseRuleFile(".cursor/rules/api.mdc", tree[".cursor/rules/api.mdc"]);
  assert.deepEqual(api.map((r) => [r.globs, r.source.line]), [[["app/api/**/*.ts", "src/server/**"], 6]]);
  assert.deepEqual(parseRuleFile("x.mdc", "---\nglobs: [\"../secrets/**\", \"src/**\"]\n---\n- Always validate inputs in src handlers.\n")[0].globs, ["src/**"]);
});

test("candidates across files are deduplicated and capped", async () => {
  const candidates = importCandidates(await discoverRuleFiles(fs));
  assert.equal(candidates.filter((c) => c.instructions.startsWith("Always use named exports")).length, 1);
  assert.deepEqual(candidates.map((c) => c.source.path), ["CLAUDE.md", "CLAUDE.md", "AGENTS.md", ".cursorrules", ".cursorrules", ".github/copilot-instructions.md", ".cursor/rules/api.mdc"]);
  const many = Array.from({ length: 80 }, (_, i) => `- Always check invariant number ${i} in the payments module.`).join("\n");
  assert.equal(importCandidates([{ path: "AGENTS.md", content: many }]).length, 50);
});
