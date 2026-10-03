/**
 * Verification (R6.8). Every candidate passes deterministic checks, then an LLM judge, before it can be published;
 * every dropped candidate is kept in `rejected` with the stage and reason.
 *
 * Deterministic stages, in order: anchor (path is in the reviewed diff; line snapped to a commentable line within
 * ±3), evidence grounding (snippets must exist in the head content or the index; ungrounded evidence is dropped and a
 * finding with none left is rejected), introduced-by-PR, rule citations, thresholds, learned suppressions, prior
 * finding matching (R6.9), existing PR comments, and duplicate merging. The judge (`task: "verify"`, batches of at
 * most 6) returns a verdict, reasons, adjusted severity and confidence, and six checks per candidate. Survivors are
 * ranked by severity × confidence × agreement (with rule and learned-boost multipliers) and capped at `maxComments`.
 */
import { z } from "zod";
import type { ParsedFile } from "@/lib/indexer/parser";
import { truncateToTokens } from "@/lib/llm/budget";
import { errorMessage } from "@/lib/log";
import type { ContextItem } from "@/lib/retrieval";
import type { FileDiff } from "@/lib/review/diff";
import { similarity, tokens } from "@/lib/review/text";
import { ruleApplies, type ReviewRule } from "@/lib/rules";
import type { Candidate } from "./agents";
import { callJson, mapLimit, record, type EngineContext } from "./calls";
import { anchorCodeOf, enclosingSymbol, fingerprint, matchPrior } from "./identity";
import { dataBlock, dataHandlingInstructions } from "./prompt";
import {
  SEVERITIES,
  type AgentId,
  type EngineFinding,
  type EngineSettings,
  type Evidence,
  type ExistingComment,
  type LearnedPreference,
  type PriorFinding,
  type RejectedCandidate,
  type Severity,
  type Verification,
} from "./types";

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 8, high: 4, medium: 2, low: 1 };
export const MAX_JUDGE_BATCH = 6;

export interface RawCandidate {
  agent: AgentId;
  candidate: Candidate;
}

export interface VerifyInput {
  candidates: RawCandidate[];
  /** Diffs of every changed file in the PR (context-only files included). */
  diffs: ReadonlyMap<string, FileDiff>;
  /** Files agents reviewed in this run; comments elsewhere are rejected at the anchor stage. */
  reviewPaths: ReadonlySet<string>;
  /** Redacted head content of changed files. */
  head: ReadonlyMap<string, string>;
  parsedHead: ReadonlyMap<string, ParsedFile>;
  contextItems: readonly ContextItem[];
  /** Looks up a snippet in the index for files outside the diff (whitespace-insensitive). */
  groundInIndex: (path: string, snippetLines: string[]) => Promise<{ startLine: number; endLine: number } | null>;
  rules: readonly ReviewRule[];
  /** Repository instruction files a rules finding may cite as `instructions:<path>`. */
  instructionPaths: ReadonlySet<string>;
  existingComments: readonly ExistingComment[];
  learned: readonly LearnedPreference[];
  priorFindings: readonly PriorFinding[];
  settings: EngineSettings;
  judgeBatch: number;
}

export interface VerifyOutput {
  findings: EngineFinding[];
  rejected: RejectedCandidate[];
  /** Prior findings some candidate re-reported (they stay open). */
  reReported: Set<number>;
}

interface Working {
  agent: AgentId;
  agents: AgentId[];
  c: Candidate;
  evidence: Evidence[];
  symbol: string | null;
  anchorCode: string;
  fingerprint: string;
  priorFindingId: number | null;
  rule: { id: string; text: string } | null;
  boosted: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Grounding helpers

/** A snippet line as the model may have copied it from a rendered diff: strip `  12 + ` prefixes, collapse spaces. */
function normLine(l: string): string {
  return l
    .replace(/^\s*\d+\s+[+\- ]\s/, "")
    .replace(/^[+-](?=\s)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function snippetLines(snippet: string): string[] {
  return snippet
    .split("\n")
    .map(normLine)
    .filter((l) => l && !/^(?:\.\.\.|…|\/\/ \.\.\.|# \.\.\.)$/.test(l));
}

/** A snippet line matches a source line exactly, or as a fragment when it is long enough to be distinctive. */
function lineMatches(hay: string, needle: string): boolean {
  return hay === needle || (needle.length >= 12 && hay.includes(needle));
}

/**
 * Where `lines` occur (in order, contiguous after dropping blank lines) in `content`; null when absent. With several
 * matches, the one closest to `near` (the line the model claimed) wins.
 */
export function locate(content: string, lines: string[], near?: number): { startLine: number; endLine: number } | null {
  if (!lines.length) return null;
  const hay = content.split("\n").map((l, i) => ({ n: i + 1, t: normLine(l) })).filter((x) => x.t);
  let best: { startLine: number; endLine: number } | null = null;
  for (let i = 0; i + lines.length <= hay.length; i++) {
    if (!lines.every((l, k) => lineMatches(hay[i + k]!.t, l))) continue;
    const hit = { startLine: hay[i]!.n, endLine: hay[i + lines.length - 1]!.n };
    if (near === undefined) return hit;
    if (!best || Math.abs(hit.startLine - near) < Math.abs(best.startLine - near)) best = hit;
  }
  return best;
}

/** Text of removed lines in a diff (evidence may cite code the PR deletes). */
function removedText(d: FileDiff | undefined): string {
  return d ? d.lines.filter((l) => l.kind === "del").map((l) => l.text).join("\n") : "";
}

/** New-file lines the PR changed: added lines and the lines next to a deletion. */
function changedLines(d: FileDiff): Set<number> {
  const out = new Set(d.added);
  d.lines.forEach((l, i) => {
    if (l.kind !== "del") return;
    const before = d.lines.slice(0, i).reverse().find((x) => x.newLine !== undefined);
    const after = d.lines.slice(i + 1).find((x) => x.newLine !== undefined);
    if (before?.newLine !== undefined) out.add(before.newLine);
    if (after?.newLine !== undefined) out.add(after.newLine);
  });
  return out;
}

function intersects(lines: ReadonlySet<number>, start: number, end: number): boolean {
  for (let n = start; n <= end; n++) if (lines.has(n)) return true;
  return false;
}

/** Share of the title's words found in `body` (comment bodies are long, so Jaccard would understate). */
function titleContainment(title: string, body: string): number {
  const t = tokens(title);
  if (!t.size) return 0;
  const b = tokens(body);
  let hit = 0;
  for (const w of t) if (b.has(w)) hit++;
  return hit / t.size;
}

const LEGACY_CATEGORY: Record<string, string> = { logic: "correctness", style: "rules" };

export function learnedSignal(learned: readonly LearnedPreference[], f: { category: string; title: string }): "suppress" | "boost" | null {
  for (const p of learned) {
    if (p.signal === "neutral") continue;
    const cat = LEGACY_CATEGORY[p.category] ?? p.category;
    if (cat === f.category && similarity(p.description, f.title) >= 0.5) return p.signal;
  }
  return null;
}

function strength(w: { c: Candidate }): number {
  return SEVERITY_WEIGHT[w.c.severity] * w.c.confidence;
}

/** Rank score: severity × confidence × agreement, × 1.25 for a cited team rule, × 1.5 for a learned boost. */
export function rankScore(f: { severity: Severity; confidence: number; agents: readonly string[]; rule: unknown; boosted?: boolean }): number {
  return SEVERITY_WEIGHT[f.severity] * f.confidence * (1 + 0.5 * (f.agents.length - 1)) * (f.rule ? 1.25 : 1) * (f.boosted ? 1.5 : 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Judge

const CHECK_KEYS = ["grounded", "codeAccurate", "introducedByPr", "actionable", "nonTrivial", "notDuplicate"] as const;

const judgeSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string().describe("Candidate id, e.g. c1"),
      verdict: z.enum(["accept", "reject"]),
      reasons: z.array(z.string()).describe("Short reasons for the verdict"),
      severity: z.enum(SEVERITIES).describe("Adjusted severity"),
      confidence: z.number().min(0).max(1).describe("Adjusted probability the finding is real, 0..1"),
      checks: z.object({
        grounded: z.boolean().describe("The cited code exists and says what the finding claims"),
        codeAccurate: z.boolean().describe("The finding describes the code's behavior correctly"),
        introducedByPr: z.boolean().describe("The problem is introduced or exposed by this pull request"),
        actionable: z.boolean().describe("The author can fix it in this pull request"),
        nonTrivial: z.boolean().describe("It matters: not a nit, style preference, or speculation"),
        notDuplicate: z.boolean().describe("Not the same issue as another candidate or an existing comment"),
      }),
    }),
  ),
});

const JUDGE_SYSTEM = `You are OpenReview's verification judge. Reviewer agents proposed candidate findings on a pull request.
Check each candidate against the diff and the repository code you are given and decide whether it should be posted.

Accept only when all six checks hold: grounded (the cited code exists and shows what is claimed), codeAccurate (the
description of the code's behavior is correct), introducedByPr (the change introduces or exposes the problem),
actionable (the author can fix it here), nonTrivial (it matters; not a nit or speculation), notDuplicate (not the same
issue as another candidate). Rejecting is correct whenever you are unsure. Adjust severity and confidence to what the
evidence supports. Return one verdict per candidate id.

${dataHandlingInstructions()}`;

function hunkAround(d: FileDiff | undefined, start: number, end: number, radius = 12): string {
  if (!d) return "";
  const lines = d.lines.filter((l) => {
    const n = l.newLine ?? l.oldLine ?? 0;
    return l.newLine === undefined ? Math.abs(n - start) <= radius * 2 : n >= start - radius && n <= end + radius;
  });
  return lines.map((l) => `${String(l.newLine ?? "").padStart(5)} ${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`).join("\n");
}

function evidenceExcerpt(e: Evidence, head: ReadonlyMap<string, string>): string {
  const content = head.get(e.path);
  if (content === undefined) return e.snippet;
  const lines = content.split("\n");
  const from = Math.max(1, e.startLine - 3);
  const to = Math.min(lines.length, e.endLine + 3);
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
}

async function judge(ctx: EngineContext, items: Working[], input: VerifyInput): Promise<Map<Working, { verification: Verification; severity: Severity; confidence: number } | { error: string }>> {
  const out = new Map<Working, { verification: Verification; severity: Severity; confidence: number } | { error: string }>();
  const size = Math.max(1, Math.min(MAX_JUDGE_BATCH, input.judgeBatch));
  const batches: Working[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  await mapLimit(batches, 2, async (batch) => {
    const blocks = batch.map((w, i) => {
      const id = `c${i + 1}`;
      const finding = JSON.stringify(
        {
          id,
          title: w.c.title,
          description: w.c.description,
          impact: w.c.impact,
          severity: w.c.severity,
          confidence: w.c.confidence,
          path: w.c.path,
          lines: `${w.c.startLine}-${w.c.endLine}`,
          symbol: w.symbol,
          raisedBy: w.agents,
          suggestedFix: w.c.suggestedFix,
          suggestion: w.c.suggestion,
          rule: w.rule,
        },
        null,
        2,
      );
      return [
        dataBlock("finding", ctx.nonce, finding, { id }),
        dataBlock("diff", ctx.nonce, truncateToTokens(hunkAround(input.diffs.get(w.c.path), w.c.startLine, w.c.endLine), 1500), { id, path: w.c.path }),
        ...w.evidence.map((e) => dataBlock("evidence", ctx.nonce, truncateToTokens(`${e.note}\n${evidenceExcerpt(e, input.head)}`, 800), { id, path: e.path, lines: `${e.startLine}-${e.endLine}` })),
      ].join("\n");
    });
    const res = await callJson(ctx, "verifier", {
      task: "verify",
      cache: true,
      system: JUDGE_SYSTEM,
      prompt: `Judge these ${batch.length} candidate findings.\n\n${blocks.join("\n\n")}`,
      schema: judgeSchema,
      schemaName: "finding_verdicts",
      ...(ctx.req.settings.model ? { model: ctx.req.settings.model } : {}),
    });
    if (!res.ok) {
      for (const w of batch) out.set(w, { error: `verification failed: ${errorMessage(res.failure.error, 300)}` });
    } else {
      batch.forEach((w, i) => {
        const v = res.value.data.verdicts.find((x) => x.id.trim() === `c${i + 1}`);
        if (!v) {
          out.set(w, { error: "the judge returned no verdict" });
          return;
        }
        const failed = CHECK_KEYS.filter((k) => !v.checks[k]);
        const verdict = v.verdict === "accept" && failed.length === 0 ? "accept" : "reject";
        const reasons = [...v.reasons.map((r) => r.slice(0, 300))];
        if (v.verdict === "accept" && failed.length) reasons.push(`failed checks: ${failed.join(", ")}`);
        out.set(w, { verification: { verdict, reasons, checks: { ...v.checks } }, severity: v.severity, confidence: v.confidence });
      });
    }
    // Reported to the hook as soon as this batch finishes.
    await record(ctx, {
      agent: "verifier",
      status: res.ok ? "ok" : "error",
      model: res.ok ? res.value.model : res.failure.model,
      usage: res.ok ? res.value.usage : res.failure.usage,
      costUsd: res.ok ? res.value.costUsd : res.failure.costUsd,
      latencyMs: res.ok ? res.value.latencyMs : res.failure.latencyMs,
      candidates: batch.length,
      accepted: batch.filter((w) => {
        const r = out.get(w);
        return r && "verification" in r && r.verification.verdict === "accept";
      }).length,
      ...(res.ok ? {} : { error: errorMessage(res.failure.error) }),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

/** Runs both verification layers and ranks the survivors. */
export async function verifyCandidates(ctx: EngineContext, input: VerifyInput): Promise<VerifyOutput> {
  const { settings } = input;
  const rejected: RejectedCandidate[] = [];
  const reject = (w: { agent: AgentId; c: Candidate }, stage: RejectedCandidate["stage"], reason: string) =>
    rejected.push({
      title: w.c.title,
      category: w.agent,
      agent: w.agent,
      path: w.c.path,
      startLine: w.c.startLine,
      severity: w.c.severity,
      confidence: w.c.confidence,
      stage,
      reason,
    });
  const rulesById = new Map(input.rules.map((r) => [r.id, r]));
  const reReported = new Set<number>();
  const working: Working[] = [];

  for (const { agent, candidate } of input.candidates) {
    const c: Candidate = { ...candidate, path: candidate.path.replace(/^\.?\//, ""), evidence: [...candidate.evidence] };
    const w0 = { agent, c };

    // Anchor.
    const d = input.diffs.get(c.path);
    if (!d) {
      reject(w0, "anchor", "the file is not part of this pull request's diff");
      continue;
    }
    if (!input.reviewPaths.has(c.path)) {
      reject(w0, "anchor", "the file was not re-reviewed in this run (unchanged since the last review)");
      continue;
    }
    const requestedStart = c.startLine;
    const requestedEnd = Math.max(c.endLine, c.startLine);
    let start = requestedStart;
    if (!d.commentable.has(start)) {
      const near = [...d.commentable].filter((n) => Math.abs(n - start) <= 3).sort((a, b) => Math.abs(a - start) - Math.abs(b - start) || a - b);
      if (near[0] === undefined) {
        reject(w0, "anchor", `line ${start} is not near any line of the diff`);
        continue;
      }
      start = near[0];
    }
    let end = requestedEnd === requestedStart ? start : requestedEnd;
    const rangeOk = end >= start && end - start <= 50 && Array.from({ length: end - start + 1 }, (_, i) => start + i).every((n) => d.commentable.has(n));
    if (!rangeOk || start !== requestedStart) end = start;
    // A replacement written for a different range would clobber the wrong code.
    if (c.suggestion !== null && (start !== requestedStart || end !== requestedEnd)) c.suggestion = null;
    c.startLine = start;
    c.endLine = end;

    // Evidence grounding.
    const evidence: Evidence[] = [];
    for (const e of c.evidence) {
      const lines = snippetLines(e.snippet);
      if (!lines.length) continue;
      const path = e.path.replace(/^\.?\//, "");
      let at: { startLine: number; endLine: number } | null = null;
      const headContent = input.head.get(path);
      if (headContent !== undefined) at = locate(headContent, lines, e.startLine) ?? (locate(removedText(input.diffs.get(path)), lines) ? { startLine: e.startLine, endLine: e.endLine } : null);
      if (!at) {
        const item = input.contextItems.find((i) => i.path === path && i.startLine > 0 && locate(i.content, lines));
        if (item) {
          const rel = locate(item.content, lines)!;
          at = { startLine: item.startLine + rel.startLine - 1, endLine: item.startLine + rel.endLine - 1 };
        }
      }
      if (!at && headContent === undefined) at = await input.groundInIndex(path, lines);
      if (at) evidence.push({ path, startLine: at.startLine, endLine: at.endLine, snippet: e.snippet.replace(/\s+$/, ""), note: e.why });
    }
    if (!evidence.length) {
      reject(w0, "filter", c.evidence.length ? "none of the cited evidence exists in the repository" : "no evidence was given");
      continue;
    }

    // Introduced by the PR: the anchor touches changed lines, or evidence ties a changed line to the problem.
    const changed = changedLines(d);
    const tied = evidence.some((e) => {
      const ed = input.diffs.get(e.path);
      return ed ? intersects(changedLines(ed), e.startLine, e.endLine) : false;
    });
    if (!intersects(changed, start, end) && !tied) {
      reject(w0, "filter", "the problem is not in code this pull request changes");
      continue;
    }

    // Rule citations.
    let rule: Working["rule"] = null;
    const ruleId = c.ruleId?.trim().replace(/^\[|\]$/g, "") ?? null;
    if (ruleId) {
      const r = rulesById.get(ruleId);
      if (r && ruleApplies(r, c.path)) rule = { id: r.id, text: r.text };
      else if (ruleId.startsWith("instructions:") && input.instructionPaths.has(ruleId.slice("instructions:".length))) {
        rule = { id: ruleId, text: `Repository instructions in ${ruleId.slice("instructions:".length)}` };
      }
    }
    if (agent === "rules" && !rule) {
      reject(w0, "filter", "a team-rules finding must cite a rule or instructions file that applies to this file");
      continue;
    }

    // Thresholds.
    if (SEVERITY_WEIGHT[c.severity] < SEVERITY_WEIGHT[settings.minSeverity]) {
      reject(w0, "filter", `severity ${c.severity} is below the minimum (${settings.minSeverity})`);
      continue;
    }
    if (c.confidence < settings.minConfidence) {
      reject(w0, "filter", `confidence ${c.confidence.toFixed(2)} is below the minimum (${settings.minConfidence})`);
      continue;
    }

    // Learned preferences.
    const signal = learnedSignal(input.learned, { category: agent, title: c.title });
    if (signal === "suppress") {
      reject(w0, "learned", "the team has rejected comments like this before");
      continue;
    }

    // Identity and prior findings.
    const symbol = enclosingSymbol(input.parsedHead.get(c.path), start, end) ?? c.symbol;
    const anchorCode = anchorCodeOf(input.head.get(c.path), start, end);
    let fp = fingerprint({ category: agent, path: c.path, symbol, anchorCode, title: c.title });
    const prior = matchPrior({ fingerprint: fp, path: c.path, symbol, anchorCode, title: c.title, category: agent }, input.priorFindings);
    if (prior) fp = prior.fingerprint;

    // Existing comments that already say this. Prior matches, and a finding whose own earlier comment (same
    // fingerprint marker) is on the PR, are tracked by the pipeline instead: it links that comment, never reposts.
    const ownComment = input.existingComments.some((x) => x.fingerprint === fp);
    if (!prior && !ownComment) {
      const existing = input.existingComments.find(
        (x) =>
          x.path === c.path &&
          typeof x.line === "number" &&
          Math.abs(x.line - start) <= 5 &&
          (titleContainment(c.title, x.body) >= 0.6 || similarity(x.body, `${c.title} ${c.description}`) >= 0.3),
      );
      if (existing) {
        reject(w0, "existing_comment", `already covered by a comment from @${existing.author} (#${existing.id})`);
        continue;
      }
    }

    working.push({ agent, agents: [agent], c, evidence, symbol, anchorCode, fingerprint: fp, priorFindingId: prior?.id ?? null, rule, boosted: signal === "boost" });
  }

  // Duplicates: keep the strongest, record agreeing agents.
  const merged: Working[] = [];
  for (const w of [...working].sort((a, b) => strength(b) - strength(a))) {
    const dup = merged.find(
      (m) =>
        m.fingerprint === w.fingerprint ||
        (m.c.path === w.c.path && Math.abs(m.c.startLine - w.c.startLine) <= 3 && (similarity(m.c.title, w.c.title) >= 0.4 || similarity(m.c.description, w.c.description) >= 0.5)),
    );
    if (!dup) {
      merged.push(w);
      continue;
    }
    if (!dup.agents.includes(w.agent)) dup.agents.push(w.agent);
    for (const e of w.evidence) if (!dup.evidence.some((x) => x.path === e.path && x.startLine === e.startLine)) dup.evidence.push(e);
    dup.c.suggestion ??= w.c.suggestion;
    dup.rule ??= w.rule;
    dup.boosted ||= w.boosted;
    if (dup.priorFindingId === null && w.priorFindingId !== null) {
      // The merged finding is the prior finding w repeated: it takes over that finding's identity.
      dup.priorFindingId = w.priorFindingId;
      dup.fingerprint = w.fingerprint;
    }
    reject(w, "duplicate", `same issue as "${dup.c.title}" (${dup.agent}); merged`);
  }

  // LLM judge.
  const verdicts: Awaited<ReturnType<typeof judge>> = merged.length ? await judge(ctx, merged, input) : new Map();
  const accepted: { finding: EngineFinding; score: number }[] = [];
  for (const w of merged) {
    const v = verdicts.get(w);
    if (!v || "error" in v) {
      reject(w, "verifier", v?.error ?? "not verified");
      continue;
    }
    if (v.verification.verdict !== "accept") {
      reject(w, "verifier", v.verification.reasons.join("; ") || "rejected by the verification judge");
      continue;
    }
    if (v.confidence < settings.minConfidence) {
      reject({ agent: w.agent, c: { ...w.c, confidence: v.confidence } }, "verifier", `verified confidence ${v.confidence.toFixed(2)} is below the minimum (${settings.minConfidence})`);
      continue;
    }
    if (SEVERITY_WEIGHT[v.severity] < SEVERITY_WEIGHT[settings.minSeverity]) {
      reject({ agent: w.agent, c: { ...w.c, severity: v.severity } }, "filter", `verified severity ${v.severity} is below the minimum (${settings.minSeverity})`);
      continue;
    }
    const finding: EngineFinding = {
      fingerprint: w.fingerprint,
      title: w.c.title,
      description: w.c.description,
      impact: w.c.impact,
      severity: v.severity,
      confidence: Math.round(v.confidence * 1000) / 1000,
      category: w.agent,
      agents: w.agents,
      path: w.c.path,
      startLine: w.c.startLine,
      endLine: w.c.endLine,
      symbol: w.symbol,
      anchorCode: w.anchorCode,
      evidence: w.evidence,
      suggestedFix: w.c.suggestedFix,
      suggestion: w.c.suggestion,
      rule: w.rule,
      verification: v.verification,
      priorFindingId: w.priorFindingId,
    };
    accepted.push({ finding, score: rankScore({ ...finding, boosted: w.boosted }) });
    // A prior finding counts as re-reported (still open) only when a verified finding repeats it.
    if (w.priorFindingId !== null) reReported.add(w.priorFindingId);
  }

  accepted.sort(
    (a, b) =>
      b.score - a.score ||
      a.finding.path.localeCompare(b.finding.path) ||
      a.finding.startLine - b.finding.startLine ||
      a.finding.fingerprint.localeCompare(b.finding.fingerprint),
  );
  const kept = accepted.slice(0, Math.max(0, settings.maxComments)).map((a) => a.finding);
  for (const { finding: f } of accepted.slice(kept.length)) {
    rejected.push({ title: f.title, category: f.category, agent: f.agents[0]!, path: f.path, startLine: f.startLine, severity: f.severity, confidence: f.confidence, stage: "cap", reason: `over the limit of ${settings.maxComments} comments` });
  }
  return { findings: kept, rejected, reReported };
}
