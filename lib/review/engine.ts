import { z } from "zod";
import type { Db } from "@/lib/db";
import type { GitClient, PullRequest } from "@/lib/git/types";
import { addUsage, ZERO_USAGE, type EmbeddingProvider, type LlmProvider, type Usage } from "@/lib/llm";
import { REVIEWERS, reviewPrompt, runReviewers, type AgentRun, type ReviewerAgent } from "./agents";
import { buildReviewContext, type ReviewContext } from "./context";
import { isReviewablePath, parsePatch, renderDiff, type FileDiff } from "./diff";
import type { Finding } from "./findings";
import { rankFindings } from "./rank";
import { applicableRules, globMatch, renderRulesSection, type ReviewRule } from "@/lib/rules";
import type { Severity } from "./findings";
import { renderContextSection, type ContextDoc } from "./context-files";
import { renderLearnedSection, type LearnedPattern } from "@/lib/learning";

export const summarySchema = z.object({
  whatChanged: z.array(z.string()).describe("3-6 short bullets describing what the PR changes, most important first"),
  riskLevel: z.enum(["low", "medium", "high"]),
  riskRationale: z.string().describe("One or two sentences on why the risk level was chosen"),
  confidence: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Confidence the PR is safe to merge as-is: 5 = safe, 1 = will almost certainly cause problems"),
});

export type ReviewSummary = z.infer<typeof summarySchema>;

export interface ReviewResult {
  pr: PullRequest;
  /** Rules that were in scope for this PR. */
  rules: ReviewRule[];
  notices: string[];
  diffs: FileDiff[];
  context: ReviewContext;
  findings: Finding[];
  summary: ReviewSummary;
  agentRuns: AgentRun[];
  usage: Usage;
}

export interface ReviewOptions {
  agents?: ReviewerAgent[];
  maxComments?: number;
  minConfidence?: number;
  budgetChars?: number;
  maxFiles?: number;
  ignore?: RegExp[];
  extraInstructions?: string[];
  model?: string;
  /** Active custom rules for the repo (R2.1); filtered to those whose paths the PR touches. */
  rules?: ReviewRule[];
  /** Glob paths never reviewed (R2.2). */
  ignoreGlobs?: string[];
  minSeverity?: Severity;
  /** Messages shown at the top of the summary comment (e.g. config problems). */
  notices?: string[];
  /** Context files always included in the review prompt (R2.3). */
  contextDocs?: ContextDoc[];
  /** Patterns learned from feedback (R2.4). */
  learned?: LearnedPattern[];
}

const SUMMARY_SYSTEM = `You summarize pull requests for OpenReview. Given the diff, the impacted code beyond it, and the
issues reviewers found, describe what changed and judge merge risk. Weigh findings by severity; a PR with a
critical or high finding cannot have confidence above 3.`;

/**
 * Review engine (R1.4): fetches the PR, retrieves impacted code beyond the diff
 * through the repository graph, runs the reviewer agents in parallel, then
 * dedupes and ranks their findings and summarizes the change.
 */
export async function reviewPullRequest(
  deps: { db: Db; llm: LlmProvider; embedder?: EmbeddingProvider },
  input: { orgId: string; repoId: number; repoFullName: string; prNumber: number; client: GitClient; pr?: PullRequest },
  opts: ReviewOptions = {},
): Promise<ReviewResult> {
  const { client, repoFullName } = input;
  const pr = input.pr ?? (await client.getPullRequest(repoFullName, input.prNumber));
  const prFiles = await client.listPullRequestFiles(repoFullName, input.prNumber);
  const diffs = prFiles
    .filter((f) => f.status !== "removed" && f.patch && isReviewablePath(f.path, opts.ignore))
    .filter((f) => !(opts.ignoreGlobs?.length && globMatch(opts.ignoreGlobs, f.path)))
    .slice(0, opts.maxFiles ?? 60)
    .map((f) => parsePatch(f.path, f.status, f.patch));

  const headContent = new Map<string, string>();
  await Promise.all(
    diffs.map(async (d) => {
      const content = await client.getFileContent(repoFullName, d.path, pr.headSha);
      if (content !== null) headContent.set(d.path, content);
    }),
  );

  const context = await buildReviewContext(deps, {
    orgId: input.orgId,
    repoId: input.repoId,
    diffs,
    headContent,
    budgetChars: opts.budgetChars,
  });

  const rules = applicableRules(opts.rules ?? [], diffs.map((d) => d.path));
  const prompt = reviewPrompt(pr, diffs, context, {
    sections: [renderContextSection(opts.contextDocs ?? []), renderRulesSection(rules), renderLearnedSection(opts.learned ?? [])],
  });
  const agentRuns = await runReviewers(deps.llm, prompt, opts.agents ?? REVIEWERS, {
    extraInstructions: opts.extraInstructions,
    model: opts.model,
  });
  const findings = rankFindings(
    agentRuns.flatMap((r) => r.findings.map((finding) => ({ agent: r.agent, category: r.category, finding }))),
    diffs,
    { maxComments: opts.maxComments, minConfidence: opts.minConfidence, minSeverity: opts.minSeverity, rules, learned: opts.learned },
  );

  const findingsText = findings.length
    ? findings.map((f) => `- [${f.severity}] ${f.path}:${f.line} ${f.title}`).join("\n")
    : "(no issues found)";
  const { data: summary, usage: summaryUsage } = await deps.llm.json({
    system: SUMMARY_SYSTEM,
    prompt: `# PR #${pr.number}: ${pr.title}\n\n${diffs.map(renderDiff).join("\n\n").slice(0, 40_000)}\n\n## Components touched\n${context.components.join(", ")}\n\n## Reviewer findings\n${findingsText}`,
    schema: summarySchema,
    schemaName: "review_summary",
    model: opts.model,
    effort: "medium",
  });

  const usage = [...agentRuns.map((r) => r.usage), summaryUsage].reduce(addUsage, ZERO_USAGE);
  return { pr, rules, notices: opts.notices ?? [], diffs, context, findings, summary, agentRuns, usage };
}
