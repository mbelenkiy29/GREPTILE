/**
 * PR summary (S12): one `summary`-task call describing the whole pull request (also in incremental runs), merge risk
 * and confidence (capped at 3 when any critical or high finding was published), architecture impact, the tests that
 * matter for the change, and a Mermaid diagram of how the change flows when it spans at least three components.
 */
import { z } from "zod";
import { truncateToTokens } from "@/lib/llm/budget";
import { errorMessage } from "@/lib/log";
import type { ContextBundle } from "@/lib/retrieval";
import { renderDiff, type FileDiff } from "@/lib/review/diff";
import { callJson, record, type EngineContext } from "./calls";
import { dataBlock, dataHandlingInstructions } from "./prompt";
import type { ChangeClassification, EngineFinding, OpenPriorFinding, ReviewSummary } from "./types";

export const MERMAID_MIN_COMPONENTS = 3;
const MAX_DIAGRAM_FLOWS = 15;

export const summarySchema = z.object({
  overview: z.string().describe("Two or three sentences: what the PR does and why it matters"),
  whatChanged: z.array(z.string()).describe("3-6 short bullets, most important first"),
  affectedAreas: z.array(z.string()).describe("Subsystems, user-facing features, or APIs affected"),
  riskLevel: z.enum(["low", "medium", "high"]),
  riskRationale: z.string().describe("One or two sentences on why"),
  confidence: z.number().int().min(1).max(5).describe("Confidence the PR is safe to merge: 5 = safe, 1 = will cause problems"),
  architectureImpact: z.string().nullable().describe("How the change affects module boundaries, data flow, or dependencies; null when it does not"),
});

const SUMMARY_SYSTEM = `You summarize pull requests for OpenReview. Given the PR description, the diff, the change
classification, and the verified findings, describe what changed, which areas it affects, and judge merge risk.
Weigh verified findings by severity: a PR with a critical or high finding cannot have confidence above 3. Mention
architecture impact only when the change alters module boundaries, data flow, public interfaces, or dependencies.

${dataHandlingInstructions()}`;

function mermaidText(s: string): string {
  return s.replace(/[;#:\n\r"`]/g, " ").replace(/[<>{}[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * Sequence diagram of the change across components, drawn from the graph's cross-component call and import
 * relations. Only when the change spans at least three components; otherwise null.
 */
export function renderFlowDiagram(bundle: Pick<ContextBundle, "components" | "changed" | "flows">): string | null {
  if (bundle.components.length < MERMAID_MIN_COMPONENTS) return null;
  const ids = new Map(bundle.components.map((c, i) => [c, `C${i + 1}`]));
  const lines = ["sequenceDiagram", "  participant PR as Pull request"];
  for (const [c, id] of ids) lines.push(`  participant ${id} as ${mermaidText(c)}`);
  for (const c of bundle.components) {
    const here = [...new Set(bundle.changed.filter((s) => s.path.startsWith(`${c}/`) || (c === "(root)" && !s.path.includes("/"))).map((s) => s.name))];
    if (here.length) lines.push(`  PR->>${ids.get(c)}: changes ${mermaidText(here.slice(0, 4).join(", "))}${here.length > 4 ? " …" : ""}`);
  }
  // Calls first (they carry names), then imports not already explained by a call between the same components.
  const calls = bundle.flows.filter((f) => f.label !== "imports");
  const imports = bundle.flows.filter((f) => f.label === "imports" && !calls.some((c) => c.from === f.from && c.to === f.to));
  for (const f of [...calls, ...imports].slice(0, MAX_DIAGRAM_FLOWS)) {
    const from = ids.get(f.from);
    const to = ids.get(f.to);
    if (from && to && from !== to) lines.push(`  ${from}->>${to}: ${mermaidText(f.label)}`);
  }
  return lines.join("\n");
}

export interface SummaryInput {
  diffs: FileDiff[];
  bundle: ContextBundle;
  classification: ChangeClassification;
  findings: EngineFinding[];
  /** Earlier findings that remain open and were not re-reported in this run (they still count toward risk). */
  openPriors: OpenPriorFinding[];
  resolvedCount: number;
  securityFocus: boolean;
}

function capConfidence(confidence: number, findings: readonly { severity: string }[]): number {
  const severe = findings.some((f) => f.severity === "critical" || f.severity === "high");
  return Math.max(1, Math.min(5, severe ? Math.min(3, confidence) : confidence));
}

/** Writes the PR summary. A failed model call yields a summary derived from the verified findings and classification. */
export async function summarize(ctx: EngineContext, input: SummaryInput): Promise<ReviewSummary> {
  const { req, nonce } = ctx;
  const relevantTests = input.bundle.tests.slice(0, 10).map((t) => ({ path: t.path, note: t.note }));
  const diagram = renderFlowDiagram(input.bundle);
  const all = [...input.findings, ...input.openPriors];
  const findingsText = all.length
    ? [
        ...input.findings.map((f) => `- [${f.severity}] ${f.path}:${f.startLine} ${f.title}`),
        ...input.openPriors.map((f) => `- [${f.severity}] ${f.path}:${f.startLine} ${f.title} (raised in an earlier review, still open)`),
      ].join("\n")
    : "(no verified findings)";
  const pr = req.pr;
  const prompt = [
    input.securityFocus ? "This is a dedicated security review; summarize the change with security in mind." : "Summarize this pull request.",
    pr ? dataBlock("pr_description", nonce, truncateToTokens(`${pr.title}\n\n${pr.body}`, 1500), { number: pr.number, author: pr.author }) : "",
    dataBlock("classification", nonce, JSON.stringify({ subsystems: input.classification.subsystems, riskAreas: input.classification.riskAreas, dependencyImpact: input.classification.dependencyImpact, components: input.bundle.components }, null, 2)),
    dataBlock("changed_symbols", nonce, input.bundle.changed.map((c) => `${c.change} ${c.kind} ${c.qualifiedName} (${c.path}:${c.startLine})`).join("\n") || "(none detected)"),
    dataBlock("diff", nonce, truncateToTokens(input.diffs.map(renderDiff).join("\n\n"), 10_000)),
    dataBlock("finding", nonce, `${findingsText}${input.resolvedCount ? `\n\n${input.resolvedCount} earlier finding(s) were resolved by new commits.` : ""}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await callJson(ctx, "summarizer", { task: "summary", cache: true, system: SUMMARY_SYSTEM, prompt, schema: summarySchema, schemaName: "review_summary" });
  await record(ctx, {
    agent: "summarizer",
    status: res.ok ? "ok" : "error",
    model: res.ok ? res.value.model : res.failure.model,
    usage: res.ok ? res.value.usage : res.failure.usage,
    costUsd: res.ok ? res.value.costUsd : res.failure.costUsd,
    latencyMs: res.ok ? res.value.latencyMs : res.failure.latencyMs,
    candidates: 0,
    accepted: 0,
    ...(res.ok ? {} : { error: errorMessage(res.failure.error) }),
  });

  if (res.ok) {
    const s = res.value.data;
    return {
      overview: s.overview.trim(),
      whatChanged: s.whatChanged.slice(0, 8),
      affectedAreas: s.affectedAreas.slice(0, 10),
      riskLevel: s.riskLevel,
      riskRationale: s.riskRationale.trim(),
      confidence: capConfidence(s.confidence, all),
      architectureImpact: s.architectureImpact?.trim() ? s.architectureImpact.trim() : null,
      relevantTests,
      diagram,
    };
  }

  const worst = all.find((f) => f.severity === "critical" || f.severity === "high") ? "high" : all.length ? "medium" : "low";
  return {
    overview: `Changes ${input.diffs.length} file${input.diffs.length === 1 ? "" : "s"} in ${input.classification.subsystems.join(", ") || "the repository"}. The written summary is unavailable because the summary model call failed.`,
    whatChanged: input.diffs.slice(0, 6).map((d) => `${d.status} \`${d.path}\``),
    affectedAreas: input.classification.subsystems,
    riskLevel: worst,
    riskRationale: `Derived from ${all.length} open finding${all.length === 1 ? "" : "s"} and the change classification (risk areas: ${input.classification.riskAreas.join(", ") || "none detected"}).`,
    confidence: capConfidence(worst === "high" ? 2 : worst === "medium" ? 3 : 4, all),
    architectureImpact: null,
    relevantTests,
    diagram,
  };
}
