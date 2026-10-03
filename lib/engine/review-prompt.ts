/**
 * The shared user prompt every specialized agent reviews (R6.7): team rules (instructions from the organization's
 * configuration) and then the pull request and retrieved repository context, each piece in a nonce-tagged data block
 * (H7). Diffs are rendered with new-file line numbers so agents can anchor findings.
 */
import { truncateToTokens } from "@/lib/llm/budget";
import type { ContextBundle, ContextItem } from "@/lib/retrieval";
import { renderDiff, type FileDiff } from "@/lib/review/diff";
import { renderRuleLine, type ReviewRule } from "@/lib/rules";
import type { SecretHit } from "./classify";
import { dataBlock, teamRulesBlock } from "./prompt";
import type { ChangeClassification, LearnedPreference, ReviewRequest } from "./types";

const DIFF_TOKENS = { fast: 20_000, standard: 50_000, deep: 120_000 } as const;
const PER_FILE_DIFF_TOKENS = 8_000;
const CODE_KINDS = new Set(["definition", "caller", "callee", "importer", "dependent", "test", "route", "schema_consumer", "config", "symbol_match", "path_match", "text_match", "similar_code"]);

export interface ReviewPromptInput {
  req: ReviewRequest;
  nonce: string;
  diffs: FileDiff[];
  reviewPaths: ReadonlySet<string>;
  bundle: ContextBundle;
  classification: ChangeClassification;
  rules: readonly ReviewRule[];
  secretHits: readonly SecretHit[];
}

/** The org-configured instructions: rules in scope, custom instructions, and preferences learned from feedback. */
export function teamRulesSections(rules: readonly ReviewRule[], customInstructions: string | null, learned: readonly LearnedPreference[]): string[] {
  const sections: string[] = [];
  if (rules.length) {
    sections.push(
      [
        "Team rules. Report violations in changed lines; set ruleId to the rule's id. A rule applies only to files matching its paths. Use at least the rule's severity for a violation; follow a rule's instructions when judging it.",
        ...rules.map(renderRuleLine),
      ].join("\n"),
    );
  }
  if (customInstructions?.trim()) sections.push(`Custom review instructions from the organization:\n${customInstructions.trim()}`);
  const patterns = learned.filter((l) => l.appliesTo !== "category");
  const categories = learned.filter((l) => l.appliesTo === "category");
  const suppress = patterns.filter((l) => l.signal === "suppress");
  const boost = patterns.filter((l) => l.signal === "boost");
  if (suppress.length) sections.push(["The team has rejected these kinds of comments; do not report them:", ...suppress.map((l) => `- (${l.category}) ${l.description}`)].join("\n"));
  if (boost.length) sections.push(["The team values these kinds of comments; look for them carefully:", ...boost.map((l) => `- (${l.category}) ${l.description}`)].join("\n"));
  const quiet = [...new Set(categories.filter((l) => l.signal === "suppress").map((l) => l.category))];
  const valued = [...new Set(categories.filter((l) => l.signal === "boost").map((l) => l.category))];
  if (quiet.length) sections.push(`The team rarely finds comments in these categories useful; report only findings you are highly confident in: ${quiet.join(", ")}`);
  if (valued.length) sections.push(`The team finds comments in these categories especially useful: ${valued.join(", ")}`);
  return sections;
}

function itemBlock(nonce: string, i: ContextItem): string {
  const attrs = {
    path: i.path,
    lines: i.startLine > 0 ? `${i.startLine}-${i.endLine}` : null,
    kind: i.kind,
    name: i.name,
    reasons: i.reasons.join("; "),
  };
  if (CODE_KINDS.has(i.kind)) return dataBlock("repo_code", nonce, i.content, attrs);
  if (i.kind === "history" || i.kind === "recent_change") return dataBlock("history", nonce, i.content, attrs);
  return dataBlock("repo_doc", nonce, i.content, attrs);
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { req, nonce, bundle } = input;
  const reviewed = input.diffs.filter((d) => input.reviewPaths.has(d.path));
  const contextOnly = input.diffs.filter((d) => !input.reviewPaths.has(d.path));
  const parts: string[] = [
    `Review the pull request below. ${reviewed.length} file${reviewed.length === 1 ? " is" : "s are"} under review (role="review")${contextOnly.length ? `; ${contextOnly.length} other changed file${contextOnly.length === 1 ? " is" : "s are"} included for context only (role="context")` : ""}. Repository code retrieved from the index follows the diff, each block with the reasons it was retrieved.`,
  ];
  const team = teamRulesBlock(nonce, teamRulesSections(input.rules, req.settings.customInstructions, req.learned));
  if (team) parts.push(team);

  parts.push(
    dataBlock(
      "review_request",
      nonce,
      JSON.stringify(
        {
          repository: req.repo.fullName,
          base: req.pr?.baseRef ?? req.baseSha.slice(0, 12),
          head: req.pr?.headRef ?? req.headSha.slice(0, 12),
          mode: req.mode,
          focus: req.focus ?? null,
          incremental: req.incremental ? { since: req.incremental.sinceSha.slice(0, 12) } : null,
          filesUnderReview: reviewed.map((d) => d.path),
          contextOnlyFiles: contextOnly.map((d) => d.path),
        },
        null,
        2,
      ),
    ),
  );
  if (req.pr) {
    const pr = req.pr;
    const commits = (pr.commits ?? []).slice(-20).map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split("\n")[0]}`).join("\n");
    const checks = (pr.checks ?? []).filter((c) => c.conclusion !== "success").map((c) => `- ${c.name}: ${c.conclusion ?? c.status}`).join("\n");
    parts.push(
      dataBlock("pr_description", nonce, truncateToTokens([`Title: ${pr.title}`, pr.body ? `\n${pr.body}` : "", commits ? `\nCommits:\n${commits}` : "", checks ? `\nCI checks not passing:\n${checks}` : ""].join("\n"), 2500), {
        number: pr.number,
        author: pr.author,
      }),
    );
  }
  const c = input.classification;
  parts.push(dataBlock("classification", nonce, JSON.stringify({ subsystems: c.subsystems, languages: c.languages, riskAreas: c.riskAreas, dependencyImpact: c.dependencyImpact }, null, 2)));
  parts.push(
    dataBlock(
      "changed_symbols",
      nonce,
      bundle.changed.map((s) => `- ${s.change} ${s.kind} ${s.qualifiedName} (${s.path}:${s.startLine}-${s.endLine})${s.baseSignature && s.baseSignature !== s.signature ? `\n    before: ${s.baseSignature}\n    after:  ${s.signature}` : ""}`).join("\n") || "(none detected)",
    ),
  );
  if (input.secretHits.length) {
    parts.push(
      dataBlock(
        "secret_scan",
        nonce,
        `Deterministic secret scan of added lines (values are redacted everywhere in this prompt):\n${input.secretHits.map((s) => `- ${s.path}:${s.line} ${s.rule} (${s.preview})`).join("\n")}`,
      ),
    );
  }

  let diffBudget: number = DIFF_TOKENS[req.mode];
  for (const d of [...reviewed, ...contextOnly]) {
    const rendered = truncateToTokens(renderDiff(d), Math.max(0, Math.min(PER_FILE_DIFF_TOKENS, diffBudget)));
    diffBudget -= Math.ceil(rendered.length / 4);
    parts.push(dataBlock("diff", nonce, rendered, { path: d.path, status: d.status, role: input.reviewPaths.has(d.path) ? "review" : "context" }));
  }

  for (const i of bundle.items) {
    if (i.kind === "rule") continue; // rules are instructions, rendered in <team_rules>
    parts.push(itemBlock(nonce, i));
  }
  return parts.join("\n\n");
}
