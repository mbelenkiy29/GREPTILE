import type { PullRequest } from "@/lib/git/types";
import type { LlmProvider, Usage } from "@/lib/llm";
import { renderDiff, type FileDiff } from "./diff";
import { reviewerOutputSchema, type RawFinding } from "./findings";
import type { ReviewContext } from "./context";

export interface ReviewerAgent {
  id: string;
  category: string;
  focus: string;
}

export const REVIEWERS: ReviewerAgent[] = [
  {
    id: "logic",
    category: "logic",
    focus: `Correctness: logic errors, wrong conditions or off-by-one, unhandled null/undefined/error paths, race conditions,
resource leaks, broken invariants, and changes that break callers or callees shown under "Impacted code" (changed
signatures, return shapes, thrown errors, removed behavior). Only report defects that would actually misbehave.`,
  },
  {
    id: "security",
    category: "security",
    focus: `Security: injection (SQL, shell, path, template), missing authentication/authorization or tenant checks,
secrets or tokens in code or logs, unsafe deserialization, SSRF, XSS, weak crypto, and risky dependency use.
Report only issues reachable from the changed code.`,
  },
  {
    id: "style",
    category: "style",
    focus: `Conventions and maintainability: deviations from patterns the surrounding codebase uses (see "Impacted code"
for how similar code is written), misleading names, dead code, duplicated logic that already exists in the repo,
missing tests for new behavior. Skip pure formatting that a linter would catch.`,
  },
];

export function reviewerSystemPrompt(agent: ReviewerAgent, extraInstructions: string[] = []): string {
  return [
    `You are Tracewise's ${agent.id} reviewer, reviewing one pull request with context from the whole repository.`,
    `Focus: ${agent.focus}`,
    `Rules:
- Comment only on lines that appear in the diff, using the new-file line numbers printed at the left of each diff line.
- Every finding must be concrete and actionable; when a mechanical fix exists, give the exact replacement code for
  line..endLine in "suggestion" (plain code, no diff markers, same indentation).
- Prefer no finding over a speculative one. Use confidence 1-5 honestly.
- Cite impacted code by path when it is why something is wrong.`,
    ...extraInstructions,
  ].join("\n\n");
}

export interface ReviewGuidance {
  /** Extra prompt sections (team rules, context files, learned preferences), already rendered. */
  sections: string[];
}

export function reviewPrompt(pr: PullRequest, diffs: FileDiff[], ctx: ReviewContext, guidance: ReviewGuidance = { sections: [] }): string {
  const impacted = ctx.impacted
    .map((i) => `--- ${i.relation} of ${i.via}: ${i.path}:${i.startLine}-${i.endLine} (${i.name})\n${i.content}`)
    .join("\n\n");
  const changed = ctx.changed.map((s) => `- ${s.kind} ${s.name} (${s.path}:${s.startLine}-${s.endLine})`).join("\n");
  return [
    `# Pull request #${pr.number}: ${pr.title}`,
    pr.body ? `## Description\n${pr.body.slice(0, 4000)}` : "",
    ...guidance.sections.filter(Boolean),
    `## Changed symbols\n${changed || "(none detected)"}`,
    `## Diff\n${diffs.map(renderDiff).join("\n\n")}`,
    `## Impacted code beyond the diff (from the repository graph)\n${impacted || "(none found)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface AgentRun {
  agent: string;
  category: string;
  findings: RawFinding[];
  usage: Usage;
  error?: string;
}

/** Runs every reviewer agent concurrently; one agent failing does not sink the others. */
export async function runReviewers(
  llm: LlmProvider,
  prompt: string,
  agents: ReviewerAgent[] = REVIEWERS,
  opts: { extraInstructions?: string[]; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {},
): Promise<AgentRun[]> {
  return Promise.all(
    agents.map(async (agent): Promise<AgentRun> => {
      try {
        const { data, usage } = await llm.json({
          system: reviewerSystemPrompt(agent, opts.extraInstructions),
          prompt,
          schema: reviewerOutputSchema,
          schemaName: "review_findings",
          model: opts.model,
          effort: opts.effort,
        });
        return { agent: agent.id, category: agent.category, findings: data.findings, usage };
      } catch (err) {
        return {
          agent: agent.id,
          category: agent.category,
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
