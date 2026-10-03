/**
 * The review engine (S39, R1.4, R6.5, R6.7, R6.8, R6.9, R4.1, R4.4, S12). `runReview` is the one place reviews
 * happen: GitHub pull requests, the CLI, the API, MCP, and demo mode all call it. It is independent of any git host:
 * it works from `req.files`, `req.readFile`, and the repository index in `deps.db`.
 *
 * Stages: ingesting (diff parsing, skips, secret scan) → retrieving_context (R6.5 retrieval, R6.7 classification) →
 * reviewing (specialized agents in parallel) → verifying (R6.8 deterministic checks and judge, R6.9 identity and
 * resolution) → summarizing (S12).
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import { fileChunks, files, symbols } from "@/lib/db/schema";
import { parseSource, type ParsedFile } from "@/lib/indexer/parser";
import { textArray } from "@/lib/indexer/sql";
import { retrieveContext, type ContextBundle } from "@/lib/retrieval";
import { isReviewablePath, parsePatch, type FileDiff } from "@/lib/review/diff";
import { applicableRules, globMatch } from "@/lib/rules";
import { applyRedactions, isSecretFilePath, redactSecrets, scanForSecrets, type SecretFinding } from "@/lib/security/secret-scan";
import { runAgents, type Candidate } from "./agents";
import { createContext, isCancellation, mapLimit, throwIfCancelled, toCancelled, totals, type EngineContext } from "./calls";
import { classifyChange, type SecretHit } from "./classify";
import { resolvePriorFindings } from "./identity";
import { modeProfile } from "./modes";
import { reviewNonce } from "./prompt";
import { buildReviewPrompt } from "./review-prompt";
import { summarize } from "./summary";
import { locate, verifyCandidates, type RawCandidate } from "./verify";
import { AGENT_IDS, type AgentId, type ChangedFileInput, type EngineDeps, type EngineStage, type ReviewOutput, type ReviewRequest } from "./types";

export * from "./types";
export { creditsFor, modeProfile, MODE_PROFILES, type ModeProfile } from "./modes";
export { fingerprint, normalizeCode, anchorCodeOf, matchPrior } from "./identity";
export { renderFindingMarkdown, renderSummaryMarkdown, SUMMARY_MARKER, fingerprintMarker, fingerprintFromMarkdown, confidenceLabel } from "./markdown";
export { renderFlowDiagram } from "./summary";
export { AGENTS, agentOutputSchema, candidateSchema, type Candidate } from "./agents";
export { heuristicClassification } from "./classify";
export { reviewNonce, neutralize, dataBlock } from "./prompt";

const READ_CONCURRENCY = 8;

interface Ingested {
  /** Every changed file with a textual diff (reviewed, context-only, and removed). */
  diffs: FileDiff[];
  reviewPaths: Set<string>;
  filesSkipped: { path: string; reason: string }[];
  head: Map<string, string>;
  base: Map<string, string>;
  secretHits: SecretHit[];
}

function skipReason(f: ChangedFileInput, req: ReviewRequest): string | null {
  if (isSecretFilePath(f.path)) return "secret file (never read)";
  if (!isReviewablePath(f.path)) return "generated, vendored, lockfile, or binary";
  if (req.settings.ignoredPaths.length && globMatch(req.settings.ignoredPaths, f.path)) return "ignored by repository settings";
  if (!f.patch) return "no textual diff (binary or too large)";
  return null;
}

/**
 * Redacts the diff's lines in place (R4.4). Secrets can span lines (a private key block), so a line cannot be judged
 * on its own: a line is redacted when the whole-file scan of its side (head for added and context lines, base for
 * removed lines) flags it, or when a scan of the hunk lines of that side, read in order, flags it. The second scan
 * covers files whose content could not be read.
 */
function redactDiff(d: FileDiff, headRaw: string | null, headHits: readonly SecretFinding[], baseRaw: string | null): void {
  const sideHits = (raw: string | null, hits: readonly SecretFinding[] | null) => {
    if (raw === null) return { lines: [] as string[], flagged: new Set<number>() };
    return { lines: raw.split("\n"), flagged: new Set((hits ?? scanForSecrets(raw)).map((x) => x.line)) };
  };
  const headSide = sideHits(headRaw, headHits);
  const baseSide = sideHits(baseRaw, null);
  const newSide = d.lines.filter((l) => l.kind !== "del");
  const oldSide = d.lines.filter((l) => l.kind !== "add");
  const flaggedInSequence = (seq: typeof d.lines) => new Set(scanForSecrets(seq.map((l) => l.text).join("\n")).map((x) => seq[x.line - 1]));
  const seqFlagged = new Set([...flaggedInSequence(newSide), ...flaggedInSequence(oldSide)]);
  const fileFlagged = (side: typeof headSide, n: number | undefined, text: string) =>
    n !== undefined && side.flagged.has(n) && side.lines[n - 1] === text;
  for (const l of d.lines) {
    const flagged =
      seqFlagged.has(l) ||
      (l.kind !== "del" && fileFlagged(headSide, l.newLine, l.text)) ||
      (l.kind !== "add" && fileFlagged(baseSide, l.oldLine, l.text)) ||
      scanForSecrets(l.text).length > 0;
    if (flagged) l.text = applyRedactions(l.text, [{ line: 1, rule: "private_key", preview: "" }]);
  }
}

async function ingest(ctx: EngineContext): Promise<Ingested> {
  const { req } = ctx;
  const profile = modeProfile(req.mode);
  const filesSkipped: Ingested["filesSkipped"] = [];
  const candidates: ChangedFileInput[] = [];
  for (const f of [...req.files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (f.status === "unchanged") continue;
    const reason = skipReason(f, req);
    if (reason) filesSkipped.push({ path: f.path, reason });
    else candidates.push(f);
  }
  // Deletions are context (their callers break) but cannot carry comments; they do not count against the file cap.
  const removed = candidates.filter((f) => f.status === "removed");
  const live = candidates.filter((f) => f.status !== "removed");
  for (const f of live.slice(profile.maxFiles)) filesSkipped.push({ path: f.path, reason: `over the ${req.mode} mode limit of ${profile.maxFiles} files` });
  const kept = [...live.slice(0, profile.maxFiles), ...removed];
  for (const f of removed) filesSkipped.push({ path: f.path, reason: "file removed (used as context)" });

  const head = new Map<string, string>();
  const base = new Map<string, string>();
  const secretHits: SecretHit[] = [];
  const diffs: FileDiff[] = [];
  await mapLimit(kept, READ_CONCURRENCY, async (f) => {
    throwIfCancelled(req.signal);
    const d = parsePatch(f.path, f.status, f.patch);
    const [h, b] = await Promise.all([
      f.status === "removed" ? Promise.resolve(null) : req.readFile(f.path, "head"),
      f.status === "added" ? Promise.resolve(null) : req.readFile(f.previousPath ?? f.path, "base"),
    ]);
    const headHits = h === null ? [] : scanForSecrets(h);
    if (h !== null) {
      for (const s of headHits) if (d.added.has(s.line)) secretHits.push({ path: f.path, line: s.line, rule: s.rule, preview: s.preview });
      head.set(f.path, applyRedactions(h, headHits));
    }
    if (b !== null) base.set(f.path, redactSecrets(b));
    // Redact the diff lines too (they are what the agents read).
    redactDiff(d, h, headHits, b);
    diffs.push(d);
  });
  diffs.sort((a, b) => a.path.localeCompare(b.path));
  secretHits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  const reviewable = diffs.filter((d) => d.status !== "removed").map((d) => d.path);
  const reviewPaths = new Set(req.incremental ? reviewable.filter((p) => req.incremental!.changedPaths.includes(p)) : reviewable);
  return { diffs, reviewPaths, filesSkipped: filesSkipped.sort((a, b) => a.path.localeCompare(b.path)), head, base, secretHits };
}

/** Whitespace-insensitive lookup of a snippet in indexed content of `path` (chunks and symbols). */
async function groundInIndex(ctx: EngineContext, path: string, lines: string[]): Promise<{ startLine: number; endLine: number } | null> {
  const { db } = ctx.deps;
  const scope = { orgId: ctx.req.orgId, repoId: ctx.req.repo.id };
  const chunks = await db
    .select({ startLine: fileChunks.startLine, content: fileChunks.content })
    .from(fileChunks)
    .where(scoped(fileChunks, scope.orgId, eq(fileChunks.repoId, scope.repoId), eq(fileChunks.path, path)))
    .orderBy(fileChunks.startLine);
  const syms = await db
    .select({ startLine: symbols.startLine, content: symbols.content })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(scoped(symbols, scope.orgId, eq(symbols.repoId, scope.repoId), eq(files.path, path)))
    .orderBy(symbols.startLine);
  for (const c of [...chunks, ...syms]) {
    const at = locate(c.content, lines);
    if (at) return { startLine: c.startLine + at.startLine - 1, endLine: c.startLine + at.endLine - 1 };
  }
  return null;
}

async function fileTagsOf(ctx: EngineContext, paths: string[]): Promise<Map<string, string[]>> {
  if (!paths.length) return new Map();
  const rows = await ctx.deps.db
    .select({ path: files.path, tags: files.tags })
    .from(files)
    .where(and(scoped(files, ctx.req.orgId, eq(files.repoId, ctx.req.repo.id)), sql`${files.path} = any(${textArray(paths)})`));
  return new Map(rows.map((r) => [r.path, r.tags]));
}

function emptyBundle(req: ReviewRequest): ContextBundle {
  const profile = modeProfile(req.mode);
  return { mode: req.mode, items: [], changed: [], components: [], flows: [], tests: [], changedTests: [], dependencyChanges: [], externalDependents: [], tokensUsed: 0, tokenBudget: profile.contextTokens, dropped: 0, droppedItems: [] };
}

/**
 * Reviews a change (S39). Calls `deps.hooks.onStage` at each stage boundary (a thrown `CancelledError` stops the
 * review and propagates) and `deps.hooks.onAgentRun` as each model-backed step finishes. Agent records reported
 * through the hook carry `accepted: 0` for reviewer agents (verification has not run yet); the returned
 * `agentRuns` carry the final accepted counts.
 */
export async function runReview(deps: EngineDeps, req: ReviewRequest): Promise<ReviewOutput> {
  const nonce = reviewNonce(
    req.orgId,
    String(req.repo.id),
    req.baseSha,
    req.headSha,
    req.mode,
    req.focus ?? "",
    createHash("sha256")
      .update(req.files.map((f) => `${f.path}\0${f.patch ?? ""}`).join("\0"))
      .digest("hex"),
  );
  const ctx = createContext(deps, req, nonce);
  const started = ctx.now();
  const stageTimings: Partial<Record<EngineStage, number>> = {};
  let current: { stage: EngineStage; at: number } | null = null;
  const closeStage = () => {
    if (current) stageTimings[current.stage] = ctx.now() - current.at;
    current = null;
  };
  const enter = async (stage: EngineStage) => {
    closeStage();
    throwIfCancelled(req.signal);
    await deps.hooks?.onStage?.(stage);
    current = { stage, at: ctx.now() };
  };

  try {
    // Ingesting.
    await enter("ingesting");
    const ing = await ingest(ctx);
    const parsedCache = new Map<string, Promise<ParsedFile | undefined>>();
    const parsedHead = (path: string) => {
      let p = parsedCache.get(path);
      if (!p) {
        const content = ing.head.get(path);
        p = content === undefined ? Promise.resolve(undefined) : parseSource(path, content).then((x) => x ?? undefined);
        parsedCache.set(path, p);
      }
      return p;
    };

    // Retrieving context and classifying.
    await enter("retrieving_context");
    const rules = applicableRules(req.rules, [...ing.reviewPaths]);
    const bundle = ing.diffs.length
      ? await retrieveContext(
          { db: deps.db, embedder: deps.embedder, signal: req.signal },
          {
            orgId: req.orgId,
            repoId: req.repo.id,
            mode: req.mode,
            diffs: ing.diffs,
            headContent: ing.head,
            baseContent: ing.base,
            rules,
            contextDocs: req.contextDocs,
            historicalFindings: req.historicalFindings,
          },
        )
      : emptyBundle(req);
    const instructionPaths = new Set(bundle.items.filter((i) => i.kind === "instructions" || i.kind === "context_doc").map((i) => i.path));
    const reviewDiffs = ing.diffs.filter((d) => ing.reviewPaths.has(d.path));
    const { classification, plan } = await classifyChange(ctx, {
      mode: req.mode,
      focus: req.focus ?? null,
      diffs: reviewDiffs,
      bundle,
      fileTags: await fileTagsOf(ctx, reviewDiffs.map((d) => d.path)),
      allowed: req.settings.categories.filter((c): c is AgentId => (AGENT_IDS as readonly string[]).includes(c)),
      hasRules: rules.length > 0 || !!req.settings.customInstructions?.trim(),
      hasInstructions: instructionPaths.size > 0,
      secretHits: ing.secretHits,
    });

    // Reviewing.
    await enter("reviewing");
    const raw: RawCandidate[] = [];
    if (reviewDiffs.length && plan.length) {
      const prompt = buildReviewPrompt({ req, nonce, diffs: ing.diffs, reviewPaths: ing.reviewPaths, bundle, classification, rules, secretHits: ing.secretHits });
      const results = await runAgents(ctx, plan, prompt, { securityFocus: req.focus === "security" });
      for (const r of results) for (const candidate of r.candidates) raw.push({ agent: r.agent, candidate: candidate as Candidate });
    }

    // Verifying. Prior findings on files this PR renamed are tracked under the new path.
    await enter("verifying");
    const renamed = new Map(req.files.filter((f) => f.previousPath && f.previousPath !== f.path).map((f) => [f.previousPath!, f.path]));
    const priorFindings = req.priorFindings.map((p) => (renamed.has(p.path) ? { ...p, path: renamed.get(p.path)! } : p));
    const parsedMap = new Map<string, ParsedFile>();
    for (const d of reviewDiffs) {
      const p = await parsedHead(d.path);
      if (p) parsedMap.set(d.path, p);
    }
    const verified = await verifyCandidates(ctx, {
      candidates: raw,
      diffs: new Map(ing.diffs.map((d) => [d.path, d])),
      reviewPaths: ing.reviewPaths,
      head: ing.head,
      parsedHead: parsedMap,
      contextItems: bundle.items,
      groundInIndex: (path, lines) => groundInIndex(ctx, path, lines),
      rules,
      instructionPaths,
      existingComments: req.existingComments,
      learned: req.learned,
      priorFindings,
      settings: req.settings,
      judgeBatch: modeProfile(req.mode).judgeBatch,
    });
    const changedSince = new Set(req.incremental ? req.incremental.changedPaths : ing.diffs.map((d) => d.path));
    const resolvedPriorFindings = priorFindings.length
      ? await resolvePriorFindings(ctx, {
          priors: priorFindings,
          reReported: verified.reReported,
          changedSince,
          headOf: async (path) => {
            if (ing.head.has(path)) return ing.head.get(path)!;
            if (ing.diffs.some((d) => d.path === path && d.status === "removed")) return null;
            const content = await req.readFile(path, "head");
            if (content === null) return null;
            const redacted = redactSecrets(content);
            ing.head.set(path, redacted);
            return redacted;
          },
          parsedHead,
          batchSize: modeProfile(req.mode).judgeBatch,
        })
      : [];

    // Prior findings still open that this run's output does not carry (the summary covers the whole PR).
    const closedOrCarried = new Set([...resolvedPriorFindings.map((r) => r.id), ...verified.findings.flatMap((f) => (f.priorFindingId === null ? [] : [f.priorFindingId]))]);
    const openPriorFindings = priorFindings
      .filter((p) => !closedOrCarried.has(p.id))
      .map((p) => ({ id: p.id, title: p.title, severity: p.severity, category: p.category, path: p.path, startLine: p.startLine }));

    // Summarizing.
    await enter("summarizing");
    const summary = await summarize(ctx, {
      diffs: ing.diffs,
      bundle,
      classification,
      findings: verified.findings,
      openPriors: openPriorFindings,
      resolvedCount: resolvedPriorFindings.length,
      securityFocus: req.focus === "security",
    });
    closeStage();

    const agentRuns = ctx.records.map((r) =>
      (AGENT_IDS as readonly string[]).includes(r.agent) ? { ...r, accepted: verified.findings.filter((f) => f.agents.includes(r.agent as AgentId)).length } : r,
    );
    const models: Record<string, string> = {};
    for (const r of agentRuns) if (r.model && !(r.agent in models)) models[r.agent] = r.model;

    return {
      summary,
      findings: verified.findings,
      rejected: verified.rejected,
      resolvedPriorFindings,
      openPriorFindings,
      classification,
      context: {
        items: bundle.items.map((i) => ({ kind: i.kind, path: i.path, startLine: i.startLine, endLine: i.endLine, name: i.name, reasons: i.reasons, tokens: i.tokens, score: i.score })),
        tokensUsed: bundle.tokensUsed,
        tokenBudget: bundle.tokenBudget,
        dropped: bundle.dropped,
      },
      agentRuns,
      usage: totals(agentRuns),
      metadata: {
        mode: req.mode,
        focus: req.focus ?? null,
        models,
        filesReviewed: ing.reviewPaths.size,
        filesSkipped: ing.filesSkipped,
        durationMs: ctx.now() - started,
        stageTimings,
        incremental: !!req.incremental,
      },
    };
  } catch (err) {
    if (isCancellation(err, req.signal)) throw toCancelled(err);
    throw err;
  }
}
