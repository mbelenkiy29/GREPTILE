import { createHash } from "node:crypto";
import type { ReviewContext } from "./context";
import type { FileDiff } from "./diff";
import type { ReviewSummary } from "./engine";
import type { Finding } from "./findings";

export const SUMMARY_MARKER = "<!-- tracewise:summary -->";
const FP_MARKER = /<!-- tracewise:fp=([a-f0-9]{16}) -->/;

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;
const RISK_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;

export const MERMAID_MIN_COMPONENTS = 3;

function normalizeCode(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Stable identity of an inline finding across re-reviews (R1.6): file, category,
 * and the code on the anchored line. Line numbers are deliberately excluded so
 * the same issue still matches after unrelated lines shift.
 */
export function findingFingerprint(f: Pick<Finding, "path" | "category" | "line">, diff: FileDiff | undefined): string {
  const code = diff?.lines.find((l) => l.newLine === f.line && l.kind !== "del")?.text ?? String(f.line);
  return createHash("sha256").update(`${f.path}\0${f.category}\0${normalizeCode(code)}`).digest("hex").slice(0, 16);
}

export function fingerprintFromBody(body: string): string | null {
  return FP_MARKER.exec(body)?.[1] ?? null;
}

function fence(code: string) {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(longest + 1);
}

/** Inline comment body with a GitHub suggestion block when a fix is available (R1.5). */
export function renderInlineComment(f: Finding, fingerprint: string): string {
  const parts = [`**${SEVERITY_LABEL[f.severity]} · ${f.category}** — ${f.title}`, f.body.trim()];
  if (f.suggestion !== null) {
    const ticks = fence(f.suggestion);
    parts.push(`${ticks}suggestion\n${f.suggestion.replace(/\n$/, "")}\n${ticks}`);
  }
  parts.push(`<!-- tracewise:fp=${fingerprint} -->`);
  return parts.join("\n\n");
}

function mermaidText(s: string) {
  return s.replace(/[;#:\n\r]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Sequence diagram of how the change flows across components, drawn from the
 * graph's cross-component call/import relations. Only emitted when the change
 * spans at least three components.
 */
export function renderSequenceDiagram(ctx: ReviewContext): string | null {
  if (ctx.components.length < MERMAID_MIN_COMPONENTS) return null;
  const ids = new Map(ctx.components.map((c, i) => [c, `C${i + 1}`]));
  const lines = ["sequenceDiagram", "  participant PR as Pull request"];
  for (const [c, id] of ids) lines.push(`  participant ${id} as ${mermaidText(c)}`);
  for (const c of ctx.components) {
    const changedHere = ctx.changed.filter((s) => s.path.startsWith(`${c}/`)).map((s) => s.name);
    if (changedHere.length) lines.push(`  PR->>${ids.get(c)}: changes ${mermaidText(changedHere.join(", "))}`);
  }
  for (const f of ctx.flows) {
    const from = ids.get(f.from);
    const to = ids.get(f.to);
    if (from && to) lines.push(`  ${from}->>${to}: ${mermaidText(f.label)}`);
  }
  return lines.join("\n");
}

export function renderSummaryComment(input: {
  summary: ReviewSummary;
  findings: Finding[];
  context: ReviewContext;
  headSha: string;
  filesReviewed: number;
  runs: number;
}): string {
  const { summary, findings, context } = input;
  const count = (r: string) => context.impacted.filter((i) => i.relation === r).length;
  const out = [
    SUMMARY_MARKER,
    "## Tracewise review",
    `**Risk:** ${RISK_LABEL[summary.riskLevel]} · **Confidence:** ${summary.confidence}/5`,
    `> ${summary.riskRationale.replace(/\n/g, " ")}`,
    "### What changed",
    summary.whatChanged.map((w) => `- ${w}`).join("\n"),
  ];
  const diagram = renderSequenceDiagram(context);
  if (diagram) out.push("### How the change flows", "```mermaid\n" + diagram + "\n```");
  if (findings.length) {
    out.push(
      `### Findings (${findings.length})`,
      ["| Severity | Location | Issue |", "| --- | --- | --- |", ...findings.map((f) => `| ${SEVERITY_LABEL[f.severity]} | \`${f.path}:${f.line}\` | ${f.title.replace(/\|/g, "\\|")} |`)].join("\n"),
    );
  } else {
    out.push("### Findings", "No issues found.");
  }
  out.push(
    `<sub>Reviewed ${input.headSha.slice(0, 7)} · ${input.filesReviewed} files · impacted code beyond the diff: ${count("caller")} callers, ${count("callee")} callees, ${count("importer")} importers${input.runs > 1 ? ` · review #${input.runs}` : ""}</sub>`,
  );
  return out.join("\n\n");
}
