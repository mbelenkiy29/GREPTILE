/**
 * Evaluation cases (R6.24). Each case is a directory under `eval/cases/<id>/`:
 *
 *   base/           the repository snapshot before the pull request
 *   pr.patch        the pull request, as a unified diff applied with `git apply`
 *   expected.json   the pull request's metadata, the issues a reviewer should report, and documented non-issues
 *
 * Expected issues name the file, a line range (new-file numbering), a category, a severity, a description, and
 * keywords; a finding matches when it is on the same file, within ±5 lines of the range, and has the category or one
 * of the keywords (see `./match.ts`).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AGENT_IDS, SEVERITIES } from "@/lib/engine/types";

export const EVAL_ROOT = path.resolve(import.meta.dirname, "../../eval");
export const CASES_DIR = path.join(EVAL_ROOT, "cases");

const lineRange = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([a, b]) => b >= a, "line range must be [start, end] with end >= start");

export const expectedIssueSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  lines: lineRange,
  category: z.enum(AGENT_IDS),
  severity: z.enum(SEVERITIES),
  description: z.string().min(1),
  /** Lowercase-insensitive words or phrases a finding about this issue would use. */
  keywords: z.array(z.string().min(2)).min(1),
});
export type ExpectedIssue = z.infer<typeof expectedIssueSchema>;

/** Something a reviewer might flag that is fine here; a finding matching it is a documented false positive. */
export const nonIssueSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  lines: lineRange.optional(),
  description: z.string().min(1),
  keywords: z.array(z.string().min(2)).default([]),
});
export type NonIssue = z.infer<typeof nonIssueSchema>;

export const caseSpecSchema = z.object({
  title: z.string().min(1),
  /** What the case covers, e.g. "authentication", "clean". */
  kind: z.string().min(1),
  pr: z.object({ title: z.string().min(1), body: z.string().default(""), author: z.string().default("eval") }),
  expected: z.array(expectedIssueSchema),
  nonIssues: z.array(nonIssueSchema).default([]),
});

export interface EvalCase extends z.infer<typeof caseSpecSchema> {
  id: string;
  dir: string;
  baseDir: string;
  patchFile: string;
}

const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;

export async function loadCase(dir: string): Promise<EvalCase> {
  const id = path.basename(dir);
  if (!CASE_ID.test(id)) throw new Error(`invalid case id "${id}" (lowercase letters, digits, dashes)`);
  const spec = caseSpecSchema.parse(JSON.parse(await readFile(path.join(dir, "expected.json"), "utf8")));
  const baseDir = path.join(dir, "base");
  const patchFile = path.join(dir, "pr.patch");
  for (const p of [baseDir, patchFile]) {
    if (!(await stat(p).catch(() => null))) throw new Error(`case ${id} is missing ${path.basename(p)}`);
  }
  return { ...spec, id, dir, baseDir, patchFile };
}

/** Every case under `root`, sorted by id; `only` keeps the named ones (an unknown id is an error). */
export async function loadCases(root = CASES_DIR, only: string[] = []): Promise<EvalCase[]> {
  const entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const unknown = only.filter((id) => !entries.includes(id));
  if (unknown.length) throw new Error(`unknown case${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (have: ${entries.join(", ")})`);
  const ids = only.length ? entries.filter((e) => only.includes(e)) : entries;
  return Promise.all(ids.map((id) => loadCase(path.join(root, id))));
}
