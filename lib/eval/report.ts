/** Rendering and saving evaluation reports (R6.24): Markdown, JSON, and a console table. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaseResult, EvalReport } from "./run";

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null) => (v === null ? "unpriced" : `$${v.toFixed(4)}`);
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** What produced the numbers, stated at the top of every report. */
export function sourceNote(report: EvalReport): string {
  const s = report.source;
  if (s.kind === "live") return `Live run against ${s.provider} (${s.model}).`;
  if (s.origin === "scripted") {
    return "Replayed **hand-written (scripted) responses** from `eval/recordings/`. These exercise the harness and the engine's deterministic stages; they are not a measurement of any model's review quality.";
  }
  if (s.origin === "recorded") return "Replayed responses recorded from a real model (see each recording's `model` and `recordedAt`).";
  return "Replayed a mix of recorded and hand-written (scripted) responses; per-case origin is listed below.";
}

export function toMarkdown(report: EvalReport): string {
  const t = report.totals;
  const lines = [
    `# OpenReview evaluation — ${report.generatedAt}`,
    "",
    sourceNote(report),
    "",
    `Mode: \`${report.mode}\` · cases: ${t.cases}${t.errors ? ` (${t.errors} failed to run)` : ""}`,
    "",
    "## Totals",
    "",
    "| Expected | True positives | False positives | Missed | Duplicates | Precision | Recall | Latency | Tokens (in / out) | Estimated cost |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${t.expected} | ${t.truePositives} | ${t.falsePositives} | ${t.missed} | ${t.duplicates} | ${pct(t.precision)} | ${pct(t.recall)} | ${ms(t.latencyMs)} | ${t.tokens.input} / ${t.tokens.output} | ${usd(t.costUsd)} |`,
    "",
    "## Cases",
    "",
    "| Case | Kind | Origin | Expected | TP | FP | Missed | Dup | Latency | Tokens (in / out) | Cost | Status |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.cases.map(
      (r) =>
        `| \`${r.id}\` | ${r.kind} | ${r.origin} | ${r.counts.expected} | ${r.counts.truePositives} | ${r.counts.falsePositives} | ${r.counts.missed} | ${r.counts.duplicates} | ${ms(r.latencyMs)} | ${r.tokens.input} / ${r.tokens.output} | ${usd(r.costUsd)} | ${r.status === "ok" ? "ok" : `error: ${cell(r.error ?? "")}`} |`,
    ),
    "",
    "## Details",
    "",
  ];
  for (const r of report.cases) {
    lines.push(`### ${r.id} — ${r.title}`, "");
    if (r.status === "error") lines.push(`Failed to run: ${r.error ?? "unknown error"}`, "");
    for (const tp of r.truePositives) lines.push(`- ✅ \`${tp.issue}\` found: ${tp.title} (\`${tp.path}:${tp.line}\`)`);
    for (const d of r.duplicates) lines.push(`- ♻️ duplicate of \`${d.issue}\`: ${d.title} (\`${d.path}:${d.line}\`)`);
    for (const fp of r.falsePositives) lines.push(`- ❌ false positive${fp.nonIssue ? ` (documented non-issue \`${fp.nonIssue}\`)` : ""}: ${fp.title} (\`${fp.path}:${fp.line}\`)`);
    for (const m of r.missed) lines.push(`- ⚠️ missed \`${m.issue}\` (\`${m.file}:${m.lines[0]}-${m.lines[1]}\`): ${m.description}`);
    if (!r.truePositives.length && !r.duplicates.length && !r.falsePositives.length && !r.missed.length && r.status === "ok") lines.push("- No findings, none expected.");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** A compact table for the terminal. */
export function consoleTable(report: EvalReport): string {
  const rows: string[][] = [["case", "origin", "exp", "tp", "fp", "miss", "dup", "latency", "tokens in/out", "cost", "status"]];
  const row = (r: CaseResult) => [
    r.id,
    r.origin,
    String(r.counts.expected),
    String(r.counts.truePositives),
    String(r.counts.falsePositives),
    String(r.counts.missed),
    String(r.counts.duplicates),
    ms(r.latencyMs),
    `${r.tokens.input}/${r.tokens.output}`,
    usd(r.costUsd),
    r.status === "ok" ? "ok" : "ERROR",
  ];
  rows.push(...report.cases.map(row));
  const t = report.totals;
  rows.push(["TOTAL", report.source.origin, String(t.expected), String(t.truePositives), String(t.falsePositives), String(t.missed), String(t.duplicates), ms(t.latencyMs), `${t.tokens.input}/${t.tokens.output}`, usd(t.costUsd), t.errors ? `${t.errors} errors` : "ok"]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === 0 || i === 1 || i === r.length - 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [fmt(rows[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1, -1).map(fmt), widths.map((w) => "-".repeat(w)).join("  "), fmt(rows.at(-1)!), "", `precision ${pct(t.precision)} · recall ${pct(t.recall)}`, sourceNote(report).replace(/\*\*/g, "").replace(/`/g, "")].join("\n");
}

/** Writes `<dir>/<timestamp>.md` and `.json`; returns their paths. */
export async function saveReport(report: EvalReport, dir: string): Promise<{ markdown: string; json: string }> {
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const markdown = path.join(dir, `${stamp}.md`);
  const json = path.join(dir, `${stamp}.json`);
  await writeFile(markdown, toMarkdown(report));
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  return { markdown, json };
}
