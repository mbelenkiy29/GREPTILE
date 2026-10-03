/**
 * Finding identity and lifecycle (R6.9, S11). A finding's fingerprint is derived from what it is about, never from
 * line numbers: category, path, enclosing symbol, the normalized code at its anchor, and the keywords of its title.
 * It is therefore stable when lines move or whitespace changes. New candidates are matched to open prior findings
 * so the same issue is not reposted after a push, and prior findings whose code changed are re-checked and resolved
 * when the new code fixes them.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { errorMessage } from "@/lib/log";
import type { ParsedFile } from "@/lib/indexer/parser";
import { truncateToTokens } from "@/lib/llm/budget";
import { similarity, tokens } from "@/lib/review/text";
import { callJson, mapLimit, record, type EngineContext } from "./calls";
import { dataBlock, dataHandlingInstructions } from "./prompt";
import type { FindingCategory, PriorFinding } from "./types";

/** Code with whitespace runs collapsed per line and blank lines dropped (how `anchorCode` is stored). */
export function normalizeCode(code: string): string {
  return code
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** The anchored lines of `content` (at most 20), normalized. */
export function anchorCodeOf(content: string | undefined, startLine: number, endLine: number): string {
  if (content === undefined) return "";
  const lines = content.split("\n");
  const end = Math.min(endLine, startLine + 19);
  return normalizeCode(lines.slice(Math.max(0, startLine - 1), Math.max(startLine, end)).join("\n"));
}

/** Title keywords: lowercased word tokens, deduplicated and sorted (so rewording order does not matter). */
export function titleKeywords(title: string): string {
  return [...tokens(title)].sort().join(" ");
}

/**
 * `sha256(category | path | symbol-or-"" | normalized anchor code | title keywords)`, first 16 hex characters.
 * Whitespace is removed from the anchor code entirely so reformatting does not change the identity.
 */
export function fingerprint(f: { category: FindingCategory | string; path: string; symbol: string | null; anchorCode: string; title: string }): string {
  const code = f.anchorCode.replace(/\s+/g, "");
  return createHash("sha256")
    .update([f.category, f.path, f.symbol ?? "", code, titleKeywords(f.title)].join("|"))
    .digest("hex")
    .slice(0, 16);
}

/** The innermost parsed symbol containing `line`, by qualified name. */
export function enclosingSymbol(parsed: ParsedFile | undefined, startLine: number, endLine = startLine): string | null {
  if (!parsed) return null;
  let best: { name: string; span: number } | null = null;
  for (const s of parsed.symbols) {
    if (s.kind === "test" && s.parent !== null) continue;
    if (s.startLine <= startLine && s.endLine >= endLine) {
      const span = s.endLine - s.startLine;
      if (!best || span < best.span) best = { name: s.qualifiedName, span };
    }
  }
  return best?.name ?? null;
}

/** Similarity of two pieces of normalized code (exact match = 1). */
export function codeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return 1;
  return similarity(a, b);
}

/**
 * The open prior finding a candidate repeats: same fingerprint, or same path and (same symbol, or anchor code
 * similarity ≥ 0.8) with title similarity ≥ 0.5.
 */
export function matchPrior(
  c: { fingerprint: string; path: string; symbol: string | null; anchorCode: string; title: string; category: string },
  priors: readonly PriorFinding[],
): PriorFinding | null {
  const exact = priors.find((p) => p.fingerprint === c.fingerprint);
  if (exact) return exact;
  let best: { p: PriorFinding; score: number } | null = null;
  for (const p of priors) {
    if (p.path !== c.path) continue;
    const titleSim = similarity(p.title, c.title);
    if (titleSim < 0.5) continue;
    const sameSymbol = !!c.symbol && !!p.symbol && c.symbol === p.symbol;
    const codeSim = codeSimilarity(p.anchorCode, c.anchorCode);
    if (!sameSymbol && codeSim < 0.8) continue;
    const score = titleSim + codeSim + (sameSymbol ? 0.5 : 0);
    if (!best || score > best.score) best = { p, score };
  }
  return best?.p ?? null;
}

/** Whether normalized `anchor` still appears in `content` (ignoring whitespace). */
export function anchorPresent(anchor: string, content: string): boolean {
  if (!anchor.trim()) return false;
  return content.replace(/\s+/g, "").includes(anchor.replace(/\s+/g, ""));
}

const resolutionSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().describe("The prior finding id"),
      fixed: z.boolean().describe("True only when the current code no longer has the problem"),
      reason: z.string().describe("One sentence: what in the current code fixes it, or why it still applies"),
    }),
  ),
});

const RESOLVE_SYSTEM = `You check whether earlier code review findings are fixed. For each <prior_finding>, compare the code it
was raised on (anchor) with the current code of the same file region (<current_code>) and decide whether the problem
described is gone. Answer fixed=true only when the current code clearly no longer has the problem; moved or
reformatted code with the same problem is not fixed. Answer for every finding id.

${dataHandlingInstructions()}`;

export interface ResolutionInput {
  priors: readonly PriorFinding[];
  /** Prior finding ids some candidate in this run re-reported (left open). */
  reReported: ReadonlySet<number>;
  /** Paths changed since the last reviewed commit; prior findings elsewhere are left alone. */
  changedSince: ReadonlySet<string>;
  /** Redacted head content per path, or null when the file no longer exists. */
  headOf: (path: string) => Promise<string | null>;
  parsedHead: (path: string) => Promise<ParsedFile | undefined>;
  batchSize: number;
}

/** Decides which prior findings the new commits resolved (R6.9). */
export async function resolvePriorFindings(ctx: EngineContext, input: ResolutionInput): Promise<{ id: number; reason: string }[]> {
  const resolved: { id: number; reason: string }[] = [];
  const toCheck: { prior: PriorFinding; current: string }[] = [];
  for (const prior of input.priors) {
    if (input.reReported.has(prior.id) || !input.changedSince.has(prior.path)) continue;
    const head = await input.headOf(prior.path);
    if (head === null) {
      resolved.push({ id: prior.id, reason: "the file was deleted" });
      continue;
    }
    const parsed = await input.parsedHead(prior.path);
    const symbol = prior.symbol ? parsed?.symbols.find((s) => s.qualifiedName === prior.symbol || s.name === prior.symbol) : undefined;
    const present = anchorPresent(prior.anchorCode, head);
    if (!present && !symbol) {
      resolved.push({ id: prior.id, reason: prior.symbol ? `the anchored code and ${prior.symbol} were removed` : "the anchored code was removed" });
      continue;
    }
    const lines = head.split("\n");
    const current = symbol
      ? symbol.content
      : lines.slice(Math.max(0, prior.startLine - 21), Math.min(lines.length, prior.endLine + 20)).join("\n");
    toCheck.push({ prior, current: truncateToTokens(current, 1500) });
  }

  if (toCheck.length) {
    const batches: (typeof toCheck)[] = [];
    for (let i = 0; i < toCheck.length; i += input.batchSize) batches.push(toCheck.slice(i, i + input.batchSize));
    await mapLimit(batches, 2, async (batch) => {
      const prompt = batch
        .map(({ prior, current }) =>
          [
            dataBlock("prior_finding", ctx.nonce, `${prior.title}\n\n${prior.description}\n\nAnchor (when raised):\n${prior.anchorCode}`, { id: String(prior.id), path: prior.path, category: prior.category }),
            dataBlock("current_code", ctx.nonce, current, { id: String(prior.id), path: prior.path }),
          ].join("\n"),
        )
        .join("\n\n");
      const res = await callJson(ctx, "resolver", {
        task: "verify",
        cache: true,
        system: RESOLVE_SYSTEM,
        prompt: `Decide for each prior finding whether it is fixed.\n\n${prompt}`,
        schema: resolutionSchema,
        schemaName: "finding_resolution",
        ...(ctx.req.settings.model ? { model: ctx.req.settings.model } : {}),
      });
      if (res.ok) {
        for (const r of res.value.data.results) {
          const hit = batch.find((b) => String(b.prior.id) === r.id.trim());
          if (hit && r.fixed) resolved.push({ id: hit.prior.id, reason: r.reason.slice(0, 500) });
        }
      }
      // Reported to the hook as soon as this batch finishes.
      await record(ctx, {
        agent: "resolver",
        status: res.ok ? "ok" : "error",
        model: res.ok ? res.value.model : res.failure.model,
        usage: res.ok ? res.value.usage : res.failure.usage,
        costUsd: res.ok ? res.value.costUsd : res.failure.costUsd,
        latencyMs: res.ok ? res.value.latencyMs : res.failure.latencyMs,
        candidates: batch.length,
        accepted: res.ok ? res.value.data.results.filter((r) => r.fixed && batch.some((b) => String(b.prior.id) === r.id.trim())).length : 0,
        ...(res.ok ? {} : { error: errorMessage(res.failure.error) }),
      });
    });
  }
  return resolved.sort((a, b) => a.id - b.id);
}
