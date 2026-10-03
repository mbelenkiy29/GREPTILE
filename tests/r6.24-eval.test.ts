/**
 * The evaluation harness (R6.24): the matcher's TP / FP / missed / duplicate classification, the report shape, the
 * documented fixtures themselves, recording and replay, and a full `pnpm eval --provider fake --recorded` run (what CI
 * runs) producing the counts the committed scripted recordings imply.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { loadCases, type ExpectedIssue } from "@/lib/eval/cases";
import { evalMain, parseEvalArgs } from "@/lib/eval/cli";
import { findingMatches, matchFindings, type EvalFinding } from "@/lib/eval/match";
import { consoleTable, toMarkdown } from "@/lib/eval/report";
import { runEval, totalsOf, type EvalReport } from "@/lib/eval/run";
import { FakeLlm } from "@/lib/llm/fake";
import { callKey, RecordingLlm, ReplayLlm, ReplayMissError, recordingSchema } from "@/lib/llm/replay";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "or-eval-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const issue = (over: Partial<ExpectedIssue> = {}): ExpectedIssue => ({
  id: "bug",
  file: "src/a.ts",
  lines: [10, 12],
  category: "correctness",
  severity: "high",
  description: "The bug.",
  keywords: ["race"],
  ...over,
});

const finding = (over: Partial<EvalFinding> = {}): EvalFinding => ({
  path: "src/a.ts",
  startLine: 11,
  endLine: 11,
  category: "correctness",
  severity: "high",
  confidence: 0.9,
  title: "A problem",
  description: "Details.",
  ...over,
});

describe("matcher (R6.24)", () => {
  test("R6.24 matches on file, lines within ±5, and category or keyword", () => {
    const e = issue();
    expect(findingMatches(finding(), e)).toBe(true);
    expect(findingMatches(finding({ path: "./src/a.ts" }), e)).toBe(true);
    // ±5 lines around [10, 12]: 5..17.
    expect(findingMatches(finding({ startLine: 17, endLine: 17 }), e)).toBe(true);
    expect(findingMatches(finding({ startLine: 18, endLine: 20 }), e)).toBe(false);
    expect(findingMatches(finding({ startLine: 1, endLine: 5 }), e)).toBe(true);
    expect(findingMatches(finding({ startLine: 1, endLine: 4 }), e)).toBe(false);
    expect(findingMatches(finding({ path: "src/b.ts" }), e)).toBe(false);
    // Another category matches only through a keyword (case-insensitive, any text field).
    expect(findingMatches(finding({ category: "performance" }), e)).toBe(false);
    expect(findingMatches(finding({ category: "performance", description: "A RACE between two writers." }), e)).toBe(true);
    expect(findingMatches(finding({ category: "performance", suggestedFix: "avoid the race" }), e)).toBe(true);
  });

  test("R6.24 classifies true positives, duplicates, false positives (with non-issues), and missed bugs", () => {
    const expected = [issue({ id: "one" }), issue({ id: "two", file: "src/b.ts", lines: [40, 40] }), issue({ id: "three", file: "src/c.ts", lines: [1, 2] })];
    const res = matchFindings(
      [
        finding({ title: "weaker report of one", severity: "medium", startLine: 14, endLine: 14 }),
        finding({ title: "strong report of one" }),
        finding({ title: "two", path: "src/b.ts", startLine: 41, endLine: 41 }),
        finding({ title: "noise", path: "src/d.ts", startLine: 3, endLine: 3, description: "max is unchecked" }),
        finding({ title: "other noise", path: "src/e.ts" }),
      ],
      expected,
      [{ id: "max-ok", file: "src/d.ts", description: "Fine here.", keywords: ["max"] }],
    );
    // The strongest finding (by severity, then confidence) claims the issue; the weaker one is its duplicate.
    expect(res.truePositives.map((t) => [t.issue, t.finding.title])).toEqual([
      ["one", "strong report of one"],
      ["two", "two"],
    ]);
    expect(res.duplicates.map((d) => [d.issue, d.finding.title])).toEqual([["one", "weaker report of one"]]);
    expect(res.falsePositives.map((f) => [f.finding.title, f.nonIssue])).toEqual([
      ["noise", "max-ok"],
      ["other noise", null],
    ]);
    expect(res.missed.map((m) => m.id)).toEqual(["three"]);
    expect(res.counts).toEqual({ expected: 3, truePositives: 2, falsePositives: 2, duplicates: 1, missed: 1 });
    expect(res.precision).toBe(0.5);
    expect(res.recall).toBe(0.667);

    // Nothing expected and nothing found: no ratio to report.
    expect(matchFindings([], [])).toMatchObject({ precision: null, recall: null, counts: { expected: 0, truePositives: 0, falsePositives: 0, duplicates: 0, missed: 0 } });
  });
});

describe("fixtures and recordings (R6.24)", () => {
  test("R6.24 ships at least 12 documented cases, including two clean pull requests, whose patches apply and whose expected ranges exist", async () => {
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const kinds = cases.map((c) => c.kind);
    for (const k of ["authentication", "authorization", "null handling", "concurrency", "data loss", "breaking API change", "database query", "cross-file logic", "missing validation", "regression"]) {
      expect(kinds).toContain(k);
    }
    expect(cases.filter((c) => c.expected.length === 0)).toHaveLength(2);
    for (const c of cases) {
      const dir = temp();
      cpSync(c.baseDir, dir, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "base");
      git("apply", c.patchFile);
      const changed = git("status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3));
      for (const e of [...c.expected, ...c.nonIssues]) {
        // Every documented issue is on a file the pull request changes, within the file's head content.
        expect(changed, `${c.id}: ${e.id}`).toContain(e.file);
        const lines = readFileSync(path.join(dir, e.file), "utf8").split("\n").length;
        if (e.lines) expect(e.lines[1], `${c.id}: ${e.id}`).toBeLessThanOrEqual(lines);
      }
    }
  });

  test("R6.24 committed recordings are labelled: scripted ones say they are not model output", async () => {
    const cases = await loadCases();
    for (const c of cases) {
      const recording = recordingSchema.parse(JSON.parse(readFileSync(path.join(import.meta.dirname, "../eval/recordings/standard", `${c.id}.json`), "utf8")));
      if (recording.origin === "scripted") expect(recording.description).toContain("not produced by a model");
      else expect(recording.model, `${c.id} recorded without a model name`).toBeTruthy();
    }
  });

  test("R6.24 --record captures live answers with usage and model, and replay serves them back in order", async () => {
    const live = new FakeLlm((call) => (call.kind === "json" ? { n: call.req.meta?.agent === "a" ? 1 : 2 } : "text answer"));
    const recorder = new RecordingLlm(live, { provider: "anthropic", now: () => new Date("2026-10-01T00:00:00Z") });
    const schema = z.object({ n: z.number() });
    const req = (agent: string) => ({ system: "s", prompt: "p", task: "review" as const, meta: { agent }, schema, schemaName: "n" });
    await recorder.json(req("a"));
    await recorder.json(req("b"));
    await recorder.text({ system: "s", prompt: "q", task: "chat", meta: { agent: "conversation" } });
    const recording = recorder.recording();
    expect(recording).toMatchObject({ origin: "recorded", provider: "anthropic", model: "fake-model", recordedAt: "2026-10-01T00:00:00.000Z" });
    expect(recording.calls.map((c) => [c.key, c.response])).toEqual([
      ["review:a", { n: 1 }],
      ["review:b", { n: 2 }],
      ["chat:conversation", "text answer"],
    ]);
    expect(recording.calls[0]!.usage!.inputTokens).toBeGreaterThan(0);

    const replay = new ReplayLlm(recordingSchema.parse(JSON.parse(JSON.stringify(recording))));
    expect((await replay.json(req("b"))).data).toEqual({ n: 2 });
    const a = await replay.json(req("a"));
    expect(a).toMatchObject({ data: { n: 1 }, servedModel: "fake-model", usage: recording.calls[0]!.usage });
    expect((await replay.text({ system: "s", prompt: "other", task: "chat", meta: { agent: "conversation" } })).text).toBe("text answer");
    // A call the recording does not have fails clearly (never a made-up answer).
    await expect(replay.json(req("a"))).rejects.toThrow(ReplayMissError);
    expect(callKey({ task: "verify", meta: { agent: "verifier" } })).toBe("verify:verifier");
  });
});

describe("pnpm eval (R6.24)", () => {
  test("R6.24 `pnpm eval --provider fake --recorded` runs every case offline and reports the counts the recordings imply", async () => {
    const out = temp();
    const lines: string[] = [];
    const res = await evalMain(["--provider", "fake", "--recorded", "--out", out, "--concurrency", "2"], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(res.code).toBe(0);
    const report = res.report!;
    expect(report.source).toEqual({ kind: "replay", origin: "scripted", provider: "replay", model: "none (hand-written responses)" });
    expect(report.totals).toMatchObject({ cases: 12, errors: 0, expected: 10, truePositives: 9, falsePositives: 1, missed: 1, duplicates: 1, precision: 0.9, recall: 0.9, costUsd: null });
    expect(report.totals.tokens.input).toBeGreaterThan(0);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId["missing-validation"]!.missed.map((m) => m.issue)).toEqual(["unbounded-limit"]);
    expect(byId["regression-test-removed"]!.duplicates.map((d) => d.issue)).toEqual(["leap-year-regression"]);
    expect(byId["clean-feature"]!.falsePositives).toEqual([expect.objectContaining({ nonIssue: "clamp-bounds" })]);
    expect(byId["clean-refactor"]!.counts).toEqual({ expected: 0, truePositives: 0, falsePositives: 0, duplicates: 0, missed: 0 });
    expect(byId["cross-file-units"]!.truePositives).toEqual([expect.objectContaining({ issue: "timeout-units", path: "src/config/timeouts.ts" })]);
    for (const c of report.cases) {
      expect(c).toMatchObject({ status: "ok", origin: "scripted" });
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
      expect(c.modelCalls).toBeGreaterThan(0);
    }

    // Markdown and JSON reports were written; the JSON is the report.
    const saved = JSON.parse(readFileSync(res.files!.json, "utf8")) as EvalReport;
    expect(saved).toEqual(JSON.parse(JSON.stringify(report)));
    const md = readFileSync(res.files!.markdown, "utf8");
    expect(md).toContain("hand-written (scripted) responses");
    expect(md).toContain("| 10 | 9 | 1 | 1 | 1 | 90.0% | 90.0% |");
    expect(md).toContain("- ⚠️ missed `unbounded-limit`");
    expect(md).toContain("documented non-issue `clamp-bounds`");
    // The console table ends with totals and the source note.
    const table = lines.join("\n");
    expect(table).toMatch(/TOTAL\s+scripted\s+10\s+9\s+1\s+1\s+1/);
    expect(table).toContain("precision 90.0% · recall 90.0%");
    expect(table).toContain("not a measurement of any model's review quality");
  });

  test("R6.24 reports a case whose recording is missing as an error, and validates its options", async () => {
    const [one] = await loadCases(undefined, ["null-handling"]);
    const report = await runEval({ cases: [one!], mode: "deep", source: { kind: "replay", dir: temp() } });
    expect(report.cases[0]).toMatchObject({ status: "error", counts: { expected: 1, truePositives: 0, missed: 1 } });
    expect(report.cases[0]!.error).toContain("no usable recording for null-handling in deep mode");
    expect(totalsOf(report.cases)).toMatchObject({ errors: 1, recall: 0 });
    expect(toMarkdown(report)).toContain("Failed to run: no usable recording");
    expect(consoleTable(report)).toContain("ERROR");

    expect(() => parseEvalArgs(["--provider", "fake"])).toThrow(/needs --recorded/);
    expect(() => parseEvalArgs(["--mode", "turbo"])).toThrow(/--mode must be one of/);
    expect(() => parseEvalArgs(["--recorded", "--record"])).toThrow(/pick one/);
    expect(parseEvalArgs(["--recorded", "--case", "a,b", "--case", "c", "--concurrency", "3"])).toMatchObject({ replay: true, cases: ["a", "b", "c"], concurrency: 3, mode: "standard" });
    await expect(loadCases(undefined, ["nope"])).rejects.toThrow(/unknown case: nope/);
    const noModel = await evalMain(["--case", "null-handling"], { out: () => {}, err: () => {}, env: { LLM_PROVIDER: "anthropic" } });
    expect(noModel.code).toBe(2);
  });
});
