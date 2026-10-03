/**
 * GitHub-flavored markdown for engine output (S12): the summary comment and one inline comment per finding. The
 * summary carries `<!-- openreview:summary -->` so it can be found and updated in place; every finding carries its
 * fingerprint marker `<!-- openreview:fp=… -->` so it is never reposted.
 */
import type { EngineFinding, ReviewOutput, Severity } from "./types";

export const SUMMARY_MARKER = "<!-- openreview:summary -->";
/** Engine fingerprints are 16 hex characters; the marker accepts any short id so stored identities stay recognizable. */
const FP_MARKER = /<!-- openreview:fp=([A-Za-z0-9:_-]{6,128}) -->/g;

export function fingerprintMarker(fp: string): string {
  return `<!-- openreview:fp=${fp} -->`;
}

/** The fingerprint of a finding comment: the last marker (the engine always writes it last). */
export function fingerprintFromMarkdown(body: string): string | null {
  const all = [...body.matchAll(FP_MARKER)];
  return all.at(-1)?.[1] ?? null;
}

/**
 * Model-written text with HTML comment delimiters defused, so content steered by repository text cannot plant an
 * `openreview:` marker (or hide text) in a comment.
 */
export function safeText(s: string): string {
  return s.replace(/<!--/g, "&lt;!--").replace(/--!?>/g, "--&gt;");
}

export interface MarkdownOptions {
  commentStyle?: "concise" | "detailed";
}

export interface SummaryMarkdownOptions extends MarkdownOptions {
  /** Short notes shown at the top (configuration problems and the like). */
  notices?: string[];
  headSha?: string;
  /** Ordinal of this review on the pull request (1 for the first); shown from the second review on. */
  reviewNumber?: number;
}

const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const RISK_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;
const CATEGORY_LABEL: Record<string, string> = {
  correctness: "Correctness",
  security: "Security",
  data: "Data",
  api_compat: "API compatibility",
  testing: "Testing",
  performance: "Performance",
  rules: "Team rules",
};

export function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  return `${confidence >= 0.85 ? "high" : confidence >= 0.6 ? "medium" : "low"} confidence (${pct}%)`;
}

function fence(code: string, lang = ""): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function lines(start: number, end: number): string {
  return end > start ? `${start}-${end}` : `${start}`;
}

/** A suggestion block is offered only for an exact, single-range replacement GitHub can apply safely. */
function suggestionSafe(f: EngineFinding): boolean {
  return f.suggestion !== null && f.endLine >= f.startLine && f.endLine - f.startLine <= 50 && !f.suggestion.includes("[REDACTED SECRET]");
}

/** Inline comment for one finding. */
export function renderFindingMarkdown(f: EngineFinding, opts: MarkdownOptions = {}): string {
  const detailed = (opts.commentStyle ?? "detailed") === "detailed";
  const parts = [
    `**${SEVERITY_LABEL[f.severity]} · ${CATEGORY_LABEL[f.category] ?? f.category}** · ${confidenceLabel(f.confidence)}`,
    `**${safeText(f.title.trim())}**`,
    safeText(f.description.trim()),
  ];
  if (f.impact.trim()) parts.push(`**Why it matters:** ${safeText(detailed ? f.impact.trim() : oneLine(f.impact))}`);
  const evidence = f.evidence.filter((e) => !(e.path === f.path && e.startLine === f.startLine && !detailed));
  if (evidence.length) {
    const items = evidence.map((e) => {
      const head = `- \`${e.path}:${lines(e.startLine, e.endLine)}\`${e.note.trim() ? ` — ${safeText(oneLine(e.note))}` : ""}`;
      return detailed && e.snippet.trim() ? `${head}\n\n${fence(e.snippet).replace(/^/gm, "  ")}` : head;
    });
    parts.push(`**Evidence**\n${items.join("\n")}`);
  }
  if (f.suggestedFix.trim()) parts.push(`**Suggested fix:** ${safeText(f.suggestedFix.trim())}`);
  if (suggestionSafe(f)) parts.push(fence(f.suggestion!, "suggestion"));
  if (f.rule) parts.push(`**Rule** (\`${safeText(f.rule.id)}\`): ${safeText(oneLine(f.rule.text))}`);
  if (f.agents.length > 1) parts.push(`<sub>Independently raised by: ${f.agents.map((a) => CATEGORY_LABEL[a] ?? a).join(", ")}</sub>`);
  parts.push(fingerprintMarker(f.fingerprint));
  return parts.join("\n\n");
}

/** The summary comment for a review. */
export function renderSummaryMarkdown(output: ReviewOutput, opts: SummaryMarkdownOptions = {}): string {
  const detailed = (opts.commentStyle ?? "detailed") === "detailed";
  const { summary, findings, metadata, context } = output;
  const security = metadata.focus === "security";
  const out: string[] = [SUMMARY_MARKER, security ? "## OpenReview security review" : "## OpenReview review"];
  for (const n of opts.notices ?? []) out.push(`> **Note:** ${safeText(oneLine(n))}`);
  if (summary.overview) out.push(safeText(summary.overview.trim()));
  out.push(`**Risk:** ${RISK_LABEL[summary.riskLevel]} · **Confidence:** ${summary.confidence}/5`, `> ${safeText(oneLine(summary.riskRationale))}`);

  if (summary.whatChanged.length) out.push("### What changed", summary.whatChanged.map((w) => `- ${safeText(oneLine(w))}`).join("\n"));
  if (summary.affectedAreas.length) out.push(`**Affected areas:** ${summary.affectedAreas.map((a) => safeText(oneLine(a))).join(", ")}`);

  // Earlier findings still open (incremental re-reviews) count too, so the summary describes the whole PR.
  const open = output.openPriorFindings ?? [];
  const all: { severity: Severity; path: string; startLine: number; title: string }[] = [...findings, ...open];
  const counts = (["critical", "high", "medium", "low"] as const).map((s) => [s, all.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  if (all.length) {
    const breakdown = counts.map(([s, n]) => `${n} ${SEVERITY_LABEL[s].toLowerCase()}`).join(" · ");
    out.push(`### Findings (${all.length})`, open.length ? `${breakdown}\n\n${findings.length} from this review, ${open.length} still open from earlier reviews` : breakdown);
    const important = all.filter((f) => f.severity === "critical" || f.severity === "high");
    const shown = (important.length ? important : all).slice(0, detailed ? 10 : 5);
    out.push(
      ["| Severity | Location | Issue |", "| --- | --- | --- |", ...shown.map((f) => `| ${SEVERITY_LABEL[f.severity]} | \`${f.path}:${f.startLine}\` | ${safeText(oneLine(f.title)).replace(/\|/g, "\\|")} |`)].join("\n"),
    );
  } else {
    out.push("### Findings", security ? "No security issues found." : "No issues found.");
  }

  if (summary.relevantTests.length) {
    out.push("### Relevant tests", summary.relevantTests.slice(0, detailed ? 10 : 5).map((t) => `- \`${safeText(t.path)}\` — ${safeText(oneLine(t.note))}`).join("\n"));
  }
  if (summary.architectureImpact) out.push("### Architecture impact", safeText(summary.architectureImpact.trim()));
  if (summary.diagram) out.push("### How the change flows", fence(summary.diagram, "mermaid"));

  const status = [
    `${metadata.mode} mode${security ? " · security focus" : ""}`,
    opts.headSha ? `reviewed ${opts.headSha.slice(0, 7)}` : null,
    opts.reviewNumber && opts.reviewNumber > 1 ? `review #${opts.reviewNumber}` : null,
    `${metadata.filesReviewed} file${metadata.filesReviewed === 1 ? "" : "s"} reviewed`,
    metadata.filesSkipped.length ? `${metadata.filesSkipped.length} skipped` : null,
    `context: ${context.items.length} items, ${context.tokensUsed.toLocaleString("en-US")}/${context.tokenBudget.toLocaleString("en-US")} tokens${context.dropped ? `, ${context.dropped} dropped` : ""}`,
    metadata.incremental ? "incremental re-review of new commits" : null,
    output.resolvedPriorFindings.length ? `${output.resolvedPriorFindings.length} earlier finding${output.resolvedPriorFindings.length === 1 ? "" : "s"} resolved` : null,
  ].filter(Boolean);
  out.push(`<sub>${status.join(" · ")}</sub>`);
  return out.join("\n\n");
}
