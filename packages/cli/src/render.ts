/**
 * Output formats of `openreview review` and `openreview findings` (R3.5):
 *
 * - human: summary, then each finding with a code frame (colors on a TTY);
 * - `--agent`: one compact block per finding (`path:line`, severity, title, why, fix) and a final "Fix all" checklist,
 *   for coding agents (Claude Code, Cursor, Codex) to act on;
 * - `--json`: {@link cliReviewJsonSchema}.
 */
import { z } from "zod";
import { SEVERITIES, type Severity } from "@/lib/engine/types";
import { localReviewResultSchema, type LocalFinding, type LocalReviewResult } from "@/lib/review/local";

/** Schema of `openreview review --json` (documented in the README). */
export const cliReviewJsonSchema = localReviewResultSchema.extend({
  version: z.literal(1),
  /** Where the review ran. */
  source: z.enum(["server", "local"]),
  baseRef: z.string(),
  headRef: z.string().nullable(),
  /** Findings beyond `--max-findings` are left out of `findings` (counts still include them). */
  truncated: z.number(),
  failOn: z.enum(SEVERITIES).nullable(),
  exitCode: z.number(),
});
export type CliReviewJson = z.infer<typeof cliReviewJsonSchema>;

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function sortFindings<T extends { severity: Severity; path: string; startLine: number }>(findings: T[]): T[] {
  return [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.startLine - b.startLine);
}

/** Whether any finding is at or above `failOn`. */
export function failsOn(findings: { severity: Severity }[], failOn: Severity | null): boolean {
  if (!failOn) return false;
  return findings.some((f) => RANK[f.severity] <= RANK[failOn]);
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  severity(sev: Severity, s: string): string;
  green(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => wrap(1, 22)(wrap(31, 39)(s)),
  high: wrap(31, 39),
  medium: wrap(33, 39),
  low: wrap(36, 39),
};

export function style(color: boolean): Style {
  if (!color) return { bold: (s) => s, dim: (s) => s, severity: (_v, s) => s, green: (s) => s };
  return { bold: wrap(1, 22), dim: wrap(2, 22), severity: (sev, s) => SEVERITY_COLOR[sev](s), green: wrap(32, 39) };
}

function countsLine(counts: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Lines around a finding, numbered, with the finding's lines marked. */
export function codeFrame(content: string | undefined, start: number, end: number, s: Style): string[] {
  if (content === undefined) return [];
  const lines = content.split("\n");
  const from = Math.max(1, start - 2);
  const to = Math.min(lines.length, end + 2, start + 12);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const inside = n >= start && n <= end;
    const text = (lines[n - 1] ?? "").replace(/\t/g, "  ");
    const gutter = `${inside ? ">" : " "} ${String(n).padStart(width)} │ `;
    out.push(inside ? `${s.bold(gutter)}${text}` : s.dim(`${gutter}${text}`));
  }
  return out;
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => (l ? by + l : l))
    .join("\n");
}

export interface HumanOptions {
  color: boolean;
  quiet: boolean;
  /** Head contents of files with findings (for code frames). */
  files: Map<string, string>;
  maxFindings?: number;
  source: "server" | "local";
  baseRef: string;
}

export function renderHuman(r: LocalReviewResult, o: HumanOptions): string {
  const s = style(o.color);
  const findings = sortFindings(r.findings);
  const shown = o.maxFindings === undefined ? findings : findings.slice(0, o.maxFindings);
  const out: string[] = [];
  if (!o.quiet) {
    out.push(s.bold(`OpenReview · ${r.repository.fullName} · ${r.headSha.slice(0, 7)} vs ${o.baseRef} (${r.baseSha.slice(0, 7)}) · ${r.mode}${r.focus ? `, ${r.focus} focus` : ""} · ${o.source}`));
    out.push("");
    out.push(r.summary.overview);
    if (r.summary.whatChanged.length) out.push("", ...r.summary.whatChanged.map((c) => `  • ${c}`));
    out.push("", `Risk: ${r.summary.riskLevel} — ${r.summary.riskRationale}`);
    out.push(`Findings: ${countsLine(r.counts)} · ${plural(r.filesReviewed, "file")} reviewed${r.filesSkipped.length ? `, ${r.filesSkipped.length} skipped` : ""}`);
    out.push("");
  }
  if (!findings.length) {
    out.push(s.green("No issues found."));
  }
  shown.forEach((f, i) => {
    const where = `${f.path}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ""}`;
    out.push(`${s.severity(f.severity, `${i + 1}. [${f.severity.toUpperCase()}]`)} ${s.bold(f.title)}`);
    out.push(`   ${s.dim(`${where} · ${f.category} · confidence ${Math.round(f.confidence * 100)}%`)}`);
    if (!o.quiet) {
      const frame = codeFrame(o.files.get(f.path), f.startLine, f.endLine, s);
      if (frame.length) out.push(...frame.map((l) => `   ${l}`));
      out.push(indent(f.description, "   "));
      if (f.impact) out.push(indent(`Impact: ${f.impact}`, "   "));
      if (f.suggestedFix) out.push(indent(`Fix: ${f.suggestedFix}`, "   "));
      if (f.suggestion) out.push("   Suggested replacement:", indent(f.suggestion, "     "));
    }
    out.push("");
  });
  if (shown.length < findings.length) out.push(s.dim(`… ${findings.length - shown.length} more (raise --max-findings to see them).`), "");
  if (!o.quiet) {
    const cost = r.usage.costUsd === null ? "" : ` · ~$${r.usage.costUsd.toFixed(3)}`;
    out.push(s.dim(`${(r.durationMs / 1000).toFixed(1)}s · ${r.usage.inputTokens + r.usage.outputTokens} tokens${cost}${r.usage.credits ? ` · ${plural(r.usage.credits, "credit")}` : ""}`));
  }
  return out.join("\n") + "\n";
}

/** A finding as `openreview findings` gets it from the server (a subset of the review's findings). */
export interface AgentFinding {
  id?: number;
  severity: Severity;
  title: string;
  category: string;
  path: string;
  startLine: number;
  endLine: number;
  description: string;
  impact?: string | null;
  suggestedFix?: string | null;
  suggestion?: string | null;
}

/**
 * Agent mode: one block per finding and a checklist, no colors or decoration. Designed to be pasted into (or piped
 * to) a coding agent: every block starts with `path:line`, so the agent can open the spot directly.
 */
export function renderAgent(input: { findings: AgentFinding[]; header: string; maxFindings?: number }): string {
  const findings = sortFindings(input.findings);
  const shown = input.maxFindings === undefined ? findings : findings.slice(0, input.maxFindings);
  const out: string[] = [input.header, ""];
  if (!shown.length) {
    out.push("No findings. Nothing to fix.");
    return out.join("\n") + "\n";
  }
  shown.forEach((f, i) => {
    const where = `${f.path}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ""}`;
    out.push(`## ${i + 1}. ${where}`);
    out.push(`severity: ${f.severity}${f.id !== undefined ? ` · id: ${f.id}` : ""} · category: ${f.category}`);
    out.push(`title: ${f.title}`);
    out.push(`why: ${[f.description, f.impact].filter(Boolean).join(" ").replace(/\s*\n\s*/g, " ")}`);
    out.push(`fix: ${(f.suggestedFix || "Address the issue described above.").replace(/\s*\n\s*/g, " ")}`);
    if (f.suggestion) out.push("replacement:", "```", f.suggestion, "```");
    out.push("");
  });
  if (shown.length < findings.length) out.push(`(${findings.length - shown.length} lower-severity findings omitted by --max-findings)`, "");
  out.push("## Fix all");
  for (const f of shown) out.push(`- [ ] ${f.path}:${f.startLine} — [${f.severity}] ${f.title}`);
  out.push("", "After fixing, re-run `openreview review --agent` to confirm.");
  return out.join("\n") + "\n";
}

export function agentHeader(r: LocalReviewResult, baseRef: string): string {
  return `# OpenReview: ${plural(r.findings.length, "finding")} (${countsLine(r.counts)}) in ${r.repository.fullName} at ${r.headSha.slice(0, 7)} vs ${baseRef}`;
}

export function findingsForAgent(findings: LocalFinding[]): AgentFinding[] {
  return findings.map((f) => ({
    severity: f.severity,
    title: f.title,
    category: f.category,
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    description: f.description,
    impact: f.impact,
    suggestedFix: f.suggestedFix,
    suggestion: f.suggestion,
  }));
}
