/**
 * Retrieval engine (R6.5). Composes the index primitives (`lib/indexer/query.ts`) into one ranked, deduplicated,
 * token-budgeted context bundle for a change: definitions of changed symbols, callers, callees, importers,
 * transitive dependents, related tests, routes and schema consumers, nearby manifests and config, exact symbol and
 * path search for identifiers the diff references, full-text search for new constants, embedding neighbors (code and
 * docs), repository instructions, recently co-changed files, historical findings, and team rules. Every item says
 * why it was retrieved; overlapping ranges of one file are merged and keep every reason. Output is deterministic for
 * the same inputs.
 */
import { asc, eq, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { fileChunks, files, symbols } from "@/lib/db/schema";
import type { ContextDoc, HistoricalFinding } from "@/lib/engine/types";
import { isTestPath } from "@/lib/indexer/filetypes";
import { parseSource, type ParsedFile } from "@/lib/indexer/parser";
import {
  calleesOf,
  callersOf,
  dependentsOf,
  filesByTag,
  findSymbolsByName,
  importersOf,
  nearestChunks,
  nearestSymbols,
  recentChanges,
  routesFor,
  schemaConsumers,
  searchFullText,
  searchPaths,
  testsFor,
  type RepoScope,
  type SymbolRef,
} from "@/lib/indexer/query";
import { intArray, textArray } from "@/lib/indexer/sql";
import { estimateTokens, fitItemsToBudget, truncateToTokens } from "@/lib/llm/budget";
import type { EmbeddingProvider, ReviewMode } from "@/lib/llm/types";
import { addedRanges, type FileDiff } from "@/lib/review/diff";
import { applicableRules, type ReviewRule } from "@/lib/rules";
import { redactSecrets } from "@/lib/security/secret-scan";
import { modeProfile } from "@/lib/engine/modes";
import {
  ancestorDirs,
  componentOf,
  configKeys,
  dependencyChanges,
  questionTerms,
  referencedIdentifiers,
  stringLiterals,
} from "./signals";
import type { ChangedSymbol, ContextBundle, ContextItem, ContextKind, Flow, RelevantTest } from "./types";

export * from "./types";
export { componentOf, dependencyChanges, referencedIdentifiers, type DependencyChange } from "./signals";

export interface RetrievalDeps {
  db: Db;
  embedder?: EmbeddingProvider;
  signal?: AbortSignal;
}

export interface RetrievalInput {
  orgId: string;
  repoId: number;
  mode: ReviewMode;
  /** Parsed diffs of the files under review. */
  diffs: FileDiff[];
  /** Head content of changed files (absent when deleted). */
  headContent: ReadonlyMap<string, string>;
  /** Base content of changed files (absent when added). */
  baseContent?: ReadonlyMap<string, string>;
  rules?: ReviewRule[];
  contextDocs?: ContextDoc[];
  historicalFindings?: HistoricalFinding[];
  /** Overrides the mode's token budget. */
  tokenBudget?: number;
}

/** Base score per source; merged items take the max plus a small bonus per extra source. */
const BASE_SCORE: Record<ContextKind, number> = {
  definition: 1,
  context_doc: 0.95,
  rule: 0.9,
  caller: 0.9,
  callee: 0.75,
  route: 0.72,
  schema_consumer: 0.72,
  importer: 0.7,
  test: 0.65,
  symbol_match: 0.6,
  dependent: 0.55,
  instructions: 0.5,
  path_match: 0.45,
  history: 0.45,
  config: 0.4,
  text_match: 0.4,
  similar_code: 0.35,
  doc: 0.35,
  recent_change: 0.3,
};

/** Kinds located at code in the index; these are merged by overlapping range and skipped inside changed files. */
const LOCATED: ReadonlySet<ContextKind> = new Set([
  "definition",
  "caller",
  "callee",
  "importer",
  "dependent",
  "test",
  "route",
  "schema_consumer",
  "config",
  "symbol_match",
  "path_match",
  "text_match",
  "similar_code",
  "doc",
  "instructions",
]);

type Draft = Omit<ContextItem, "tokens">;

/** Embedding neighbors farther than this (cosine distance) are noise. */
const MAX_SIMILAR_DISTANCE = 0.95;

class Collector {
  readonly drafts: Draft[] = [];
  constructor(
    private readonly changedPaths: ReadonlySet<string>,
    private readonly maxItemTokens: number,
  ) {}

  add(d: Omit<Draft, "score"> & { score?: number }) {
    if (!d.content.trim() && d.kind !== "rule") return;
    // The index holds the base version of changed files; their head content is in the diff already.
    if (LOCATED.has(d.kind) && d.kind !== "definition" && this.changedPaths.has(d.path)) return;
    const content = truncateToTokens(redactSecrets(d.content), this.maxItemTokens);
    this.drafts.push({ ...d, content, score: d.score ?? BASE_SCORE[d.kind], reasons: [...new Set(d.reasons)] });
  }
}

/** Joins two located items' contents when together they cover the union range line by line; else null. */
function unionContent(a: Draft, b: Draft): string | null {
  const lines = new Map<number, string>();
  for (const it of [a, b]) {
    const ls = it.content.split("\n");
    if (ls.length !== it.endLine - it.startLine + 1) return null; // truncated or not line-aligned
    ls.forEach((l, i) => lines.set(it.startLine + i, l));
  }
  const start = Math.min(a.startLine, b.startLine);
  const end = Math.max(a.endLine, b.endLine);
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const l = lines.get(n);
    if (l === undefined) return null;
    out.push(l);
  }
  return out.join("\n");
}

const KIND_ORDER = Object.keys(BASE_SCORE) as ContextKind[];

function compareItems(a: Draft, b: Draft): number {
  return b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path) || a.startLine - b.startLine || (a.name ?? "").localeCompare(b.name ?? "");
}

/**
 * Merges items that reach the same code (same file, overlapping or adjacent ranges) and exact repeats of non-code
 * items. The merged item keeps the higher-scoring kind, every reason, and a small bonus for each extra source.
 */
export function mergeItems(drafts: Draft[]): Draft[] {
  const sorted = [...drafts].sort(compareItems);
  const out: (Draft & { sources: Set<ContextKind> })[] = [];
  for (const d of sorted) {
    const located = LOCATED.has(d.kind) && d.startLine > 0;
    // Base-version code (removed symbols) has base line numbers: it never merges with head-version code.
    const target = out.find((o) =>
      located
        ? LOCATED.has(o.kind) &&
          o.startLine > 0 &&
          o.version === d.version &&
          o.path === d.path &&
          o.startLine <= d.endLine + 1 &&
          d.startLine <= o.endLine + 1
        : o.kind === d.kind && o.path === d.path && o.name === d.name && o.startLine === d.startLine,
    );
    if (!target) {
      out.push({ ...d, reasons: [...d.reasons], sources: new Set([d.kind]) });
      continue;
    }
    for (const r of d.reasons) if (!target.reasons.includes(r)) target.reasons.push(r);
    target.sources.add(d.kind);
    if (located && (d.startLine < target.startLine || d.endLine > target.endLine)) {
      const joined = unionContent(target, d);
      if (joined !== null) {
        target.content = joined;
        target.startLine = Math.min(target.startLine, d.startLine);
        target.endLine = Math.max(target.endLine, d.endLine);
      } else if (d.endLine - d.startLine > target.endLine - target.startLine) {
        target.content = d.content;
        target.startLine = d.startLine;
        target.endLine = d.endLine;
      }
    }
    target.free = target.free || d.free;
  }
  return out.map(({ sources, ...item }) => ({ ...item, score: Math.round(Math.min(1.25, item.score + 0.05 * (sources.size - 1)) * 1000) / 1000 }));
}

/**
 * Fits ranked items to the budgets: definitions of changed code (`free`) fill their own cap, highest-ranked first,
 * and everything else is charged to `tokenBudget`. Items that do not fit are dropped, lowest scores first.
 */
function fitBundle(ranked: ContextItem[], tokenBudget: number, definitionTokens: number): { items: ContextItem[]; dropped: ContextItem[]; used: number } {
  const defs = fitItemsToBudget(
    ranked.filter((i) => i.free),
    definitionTokens,
    (i) => i.tokens,
  );
  const rest = fitItemsToBudget(
    ranked.filter((i) => !i.free),
    tokenBudget,
    (i) => i.tokens,
  );
  return { items: [...defs.kept, ...rest.kept].sort(compareItems), dropped: [...defs.dropped, ...rest.dropped].sort(compareItems), used: rest.used };
}

function checkAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("retrieval cancelled");
}

/**
 * One embedding, or null when the embedding provider fails: embeddings enrich the context but the review must not
 * depend on them. Cancellation still propagates.
 */
async function embedOne(deps: RetrievalDeps, text: string, scope: RepoScope): Promise<number[] | null> {
  if (!deps.embedder) return null;
  try {
    const [vec] = await deps.embedder.embed([text], { signal: deps.signal, meta: { orgId: scope.orgId, repoId: scope.repoId } });
    return vec ?? null;
  } catch (err) {
    checkAborted(deps.signal);
    if (err instanceof Error && (err.name === "LlmAbortError" || err.name === "AbortError")) throw err;
    return null;
  }
}

async function symbolContents(db: Db, scope: RepoScope, ids: readonly number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: symbols.id, content: symbols.content })
    .from(symbols)
    .where(scoped(symbols, scope.orgId, eq(symbols.repoId, scope.repoId), sql`${symbols.id} = any(${intArray([...new Set(ids)])})`));
  return new Map(rows.map((r) => [r.id, r.content]));
}

interface ChunkRow {
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  kind: "code" | "doc" | "config";
  content: string;
}

async function chunksOf(db: Db, scope: RepoScope, by: { fileIds?: readonly number[]; paths?: readonly string[] }): Promise<ChunkRow[]> {
  const cond = by.fileIds?.length
    ? sql`${fileChunks.fileId} = any(${intArray([...new Set(by.fileIds)])})`
    : by.paths?.length
      ? sql`${fileChunks.path} = any(${textArray([...new Set(by.paths)])})`
      : undefined;
  if (!cond) return [];
  return db
    .select({ fileId: fileChunks.fileId, path: fileChunks.path, startLine: fileChunks.startLine, endLine: fileChunks.endLine, kind: fileChunks.kind, content: fileChunks.content })
    .from(fileChunks)
    .where(scoped(fileChunks, scope.orgId, eq(fileChunks.repoId, scope.repoId), cond))
    .orderBy(asc(fileChunks.path), asc(fileChunks.startLine));
}

/** Lines `from..to` of a chunk (clamped), with the range actually returned. */
function sliceChunk(c: ChunkRow, from: number, to: number): { startLine: number; endLine: number; content: string } {
  const lines = c.content.split("\n");
  const start = Math.max(c.startLine, from);
  const end = Math.min(c.startLine + lines.length - 1, to);
  return { startLine: start, endLine: end, content: lines.slice(start - c.startLine, end - c.startLine + 1).join("\n") };
}

function chunkAround(chunks: ChunkRow[], fileId: number, line: number, radius: number) {
  const c = chunks.find((x) => x.fileId === fileId && x.startLine <= line && x.endLine >= line);
  return c ? sliceChunk(c, line - radius, line + radius) : null;
}

const symLabel = (s: { qualifiedName: string | null; name: string }) => s.qualifiedName ?? s.name;

/** Changed symbols: head definitions overlapping added lines (innermost first), plus symbols the PR removes. */
async function changedSymbols(
  db: Db,
  scope: RepoScope,
  diffs: FileDiff[],
  head: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string> | undefined,
): Promise<{ changed: ChangedSymbol[]; parsedHead: Map<string, ParsedFile> }> {
  const parsedHead = new Map<string, ParsedFile>();
  const changed: ChangedSymbol[] = [];
  for (const d of diffs) {
    const src = head.get(d.path);
    const baseSrc = base?.get(d.path);
    const parsedBase = baseSrc !== undefined ? await parseSource(d.path, baseSrc) : null;
    const baseByName = new Map((parsedBase?.symbols ?? []).map((s) => [s.qualifiedName, s]));
    const headNames = new Set<string>();
    if (src !== undefined) {
      const parsed = await parseSource(d.path, src);
      if (parsed) {
        parsedHead.set(d.path, parsed);
        const ranges = addedRanges(d);
        const hits = parsed.symbols
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => ranges.some(([a, b]) => a <= s.endLine && b >= s.startLine));
        for (const s of parsed.symbols) headNames.add(s.qualifiedName);
        // Prefer the innermost symbols: skip a container when one of its members also changed.
        const innermost = hits.filter(({ s }) => !hits.some(({ s: o }) => o !== s && o.startLine >= s.startLine && o.endLine <= s.endLine && (o.startLine !== s.startLine || o.endLine !== s.endLine)));
        for (const { s, i } of innermost) {
          const before = baseByName.get(s.qualifiedName);
          changed.push({
            name: s.name,
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            path: d.path,
            startLine: s.startLine,
            endLine: s.endLine,
            signature: s.signature,
            exported: s.exported,
            content: s.content,
            indexId: null,
            baseSignature: before?.signature ?? null,
            change: before ? "modified" : "added",
            calls: [...new Set(parsed.calls.filter((c) => c.from === i).map((c) => c.name))].sort(),
          });
        }
      }
    }
    // Symbols the PR deletes still have callers elsewhere that will break.
    for (const s of parsedBase?.symbols ?? []) {
      if (headNames.has(s.qualifiedName) || (src === undefined && s.parent !== null)) continue;
      if (!["function", "method", "class", "interface", "type", "variable", "struct", "trait", "enum", "table", "model", "route"].includes(s.kind)) continue;
      changed.push({
        name: s.name,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        path: d.path,
        startLine: s.startLine,
        endLine: s.endLine,
        signature: s.signature,
        exported: s.exported,
        content: s.content,
        indexId: null,
        baseSignature: s.signature,
        change: "removed",
        calls: [],
      });
    }
  }
  // Link to the index (which holds the base version) by path + qualified name.
  const names = [...new Set(changed.map((c) => c.name))];
  if (names.length) {
    const rows = await findSymbolsByName(db, scope, names, { limit: 500 });
    for (const c of changed) {
      const samePath = rows.filter((r) => r.path === c.path && r.name === c.name);
      const hit =
        samePath.find((r) => r.kind === c.kind && (r.qualifiedName ?? r.name) === c.qualifiedName) ??
        samePath.find((r) => (r.qualifiedName ?? r.name) === c.qualifiedName) ??
        samePath[0];
      if (hit) c.indexId = hit.id;
    }
  }
  changed.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { changed, parsedHead };
}

/**
 * Retrieves the context a review of `input.diffs` needs (R6.5). See the module comment for the sources.
 */
export async function retrieveContext(deps: RetrievalDeps, input: RetrievalInput): Promise<ContextBundle> {
  const { db } = deps;
  const scope: RepoScope = { orgId: input.orgId, repoId: input.repoId };
  if (!scope.orgId) throw new Error("retrieval requires an orgId");
  const profile = modeProfile(input.mode);
  const limit = profile.perSourceLimit;
  const changedPaths = new Set(input.diffs.map((d) => d.path));
  const col = new Collector(changedPaths, profile.maxItemTokens);
  const flows: Flow[] = [];
  const tests: RelevantTest[] = [];
  const externalDependents = new Map<string, { symbol: string; path: string; dependents: Set<string> }>();
  const noteDependent = (c: ChangedSymbol, where: string) => {
    if (!c.exported || where === c.path) return;
    const key = `${c.path}:${c.qualifiedName}`;
    const e = externalDependents.get(key) ?? { symbol: c.qualifiedName, path: c.path, dependents: new Set<string>() };
    e.dependents.add(where);
    externalDependents.set(key, e);
  };

  const { changed } = await changedSymbols(db, scope, input.diffs, input.headContent, input.baseContent);
  checkAborted(deps.signal);

  // 1. Definitions of changed symbols (head content; free, since it is the change itself).
  for (const c of changed) {
    col.add({
      kind: "definition",
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      name: c.qualifiedName,
      content: c.content,
      reasons: [c.change === "removed" ? `symbol ${c.qualifiedName} removed by the PR (base definition)` : `${c.change} symbol ${c.qualifiedName} (head definition)`],
      free: true,
      ...(c.change === "removed" ? { version: "base" as const } : {}),
    });
  }

  const byIndexId = new Map(changed.filter((c) => c.indexId !== null).map((c) => [c.indexId!, c]));
  const indexIds = [...byIndexId.keys()];
  const fileRows = changedPaths.size
    ? await db
        .select({ id: files.id, path: files.path, tags: files.tags })
        .from(files)
        .where(scoped(files, scope.orgId, eq(files.repoId, scope.repoId), sql`${files.path} = any(${textArray([...changedPaths])})`))
        .orderBy(asc(files.path))
    : [];
  const fileIdToPath = new Map(fileRows.map((f) => [f.id, f.path]));
  const changedFileIds = fileRows.map((f) => f.id);

  // 2. Callers of changed (and removed) symbols.
  const callerHits = await callersOf(db, scope, indexIds, { limit: limit * 4 });
  const callerSymbolContent = await symbolContents(db, scope, callerHits.flatMap((h) => (h.caller ? [h.caller.id] : [])));
  const moduleCallChunks = await chunksOf(db, scope, { fileIds: callerHits.filter((h) => !h.caller).map((h) => h.file.id) });
  for (const h of callerHits) {
    const def = byIndexId.get(h.symbolId)!;
    const reason = `calls ${def.change === "removed" ? "removed" : "changed"} symbol ${def.qualifiedName} (${def.path})`;
    if (h.caller) {
      col.add({ kind: "caller", path: h.caller.path, startLine: h.caller.startLine, endLine: h.caller.endLine, name: symLabel(h.caller), content: callerSymbolContent.get(h.caller.id) ?? "", reasons: [reason] });
      flows.push({ from: componentOf(h.caller.path), to: componentOf(def.path), label: `${h.caller.name} → ${def.name}` });
    } else {
      const slice = chunkAround(moduleCallChunks, h.file.id, h.line, 4);
      if (slice) col.add({ kind: "caller", path: h.file.path, ...slice, name: null, reasons: [reason] });
      flows.push({ from: componentOf(h.file.path), to: componentOf(def.path), label: `${h.file.path.split("/").pop()} → ${def.name}` });
    }
    noteDependent(def, h.file.path);
  }
  checkAborted(deps.signal);

  // 3. Callees of changed symbols.
  const headCallers = changed.filter((c) => c.change !== "removed" && c.indexId !== null);
  const calleeHits = await calleesOf(db, scope, headCallers.map((c) => c.indexId!), { limit: limit * 4 });
  const calleeContent = await symbolContents(db, scope, calleeHits.map((h) => h.callee.id));
  for (const h of calleeHits) {
    const from = byIndexId.get(h.symbolId)!;
    // Only what the head version still calls.
    if (!from.calls.includes(h.callee.name)) continue;
    col.add({ kind: "callee", path: h.callee.path, startLine: h.callee.startLine, endLine: h.callee.endLine, name: symLabel(h.callee), content: calleeContent.get(h.callee.id) ?? "", reasons: [`called by changed symbol ${from.qualifiedName}`] });
    flows.push({ from: componentOf(from.path), to: componentOf(h.callee.path), label: `${from.name} → ${h.callee.name}` });
  }
  // Callees the head adds (not yet edges in the base index): resolve by name.
  const knownCallees = new Set(calleeHits.map((h) => h.callee.name));
  const newCalleeNames = [...new Set(changed.flatMap((c) => c.calls))].filter((n) => !knownCallees.has(n) && !changed.some((c) => c.name === n) && /^[A-Za-z_$][\w$]*$/.test(n));
  if (newCalleeNames.length) {
    const hits = await findSymbolsByName(db, scope, newCalleeNames, { limit: limit * 2, kinds: ["function", "method", "class"] });
    for (const s of hits) {
      const from = changed.find((c) => c.calls.includes(s.name))!;
      col.add({ kind: "callee", path: s.path, startLine: s.startLine, endLine: s.endLine, name: symLabel(s), content: s.content, reasons: [`called by changed symbol ${from.qualifiedName}`] });
      flows.push({ from: componentOf(from.path), to: componentOf(s.path), label: `${from.name} → ${s.name}` });
    }
  }
  checkAborted(deps.signal);

  // 4. Importers of changed files.
  const importerHits = await importersOf(db, scope, changedFileIds, { limit: limit * 4 });
  const importerChunks = await chunksOf(db, scope, { fileIds: importerHits.map((h) => h.importer.id) });
  for (const h of importerHits) {
    const target = fileIdToPath.get(h.fileId)!;
    const slice = chunkAround(importerChunks, h.importer.id, h.line, 2) ?? { startLine: h.line, endLine: h.line, content: `imports ${target}` };
    col.add({ kind: "importer", path: h.importer.path, ...slice, name: null, reasons: [`imports changed file ${target}`] });
    flows.push({ from: componentOf(h.importer.path), to: componentOf(target), label: "imports" });
    for (const c of changed) if (c.path === target) noteDependent(c, h.importer.path);
  }

  // 5. Transitive dependents of changed exported symbols (graph depth by mode).
  if (profile.dependentDepth > 0) {
    const roots = changed.filter((c) => c.indexId !== null && (c.exported || c.change === "removed")).slice(0, limit);
    const depSymbols: { dep: SymbolRef; depth: number; root: ChangedSymbol }[] = [];
    for (const root of roots) {
      for (const d of await dependentsOf(db, scope, root.indexId!, { depth: profile.dependentDepth, limit: limit * 3 })) {
        noteDependent(root, d.file.path);
        if (d.symbol) depSymbols.push({ dep: d.symbol, depth: d.depth, root });
      }
    }
    const depContent = await symbolContents(db, scope, depSymbols.map((d) => d.dep.id));
    for (const { dep, depth, root } of depSymbols) {
      col.add({
        kind: "dependent",
        path: dep.path,
        startLine: dep.startLine,
        endLine: dep.endLine,
        name: symLabel(dep),
        content: depContent.get(dep.id) ?? "",
        score: depth === 1 ? BASE_SCORE.dependent : BASE_SCORE.dependent - 0.15,
        reasons: [depth === 1 ? `depends on changed symbol ${root.qualifiedName}` : `depends transitively (depth ${depth}) on changed symbol ${root.qualifiedName}`],
      });
    }
  }
  checkAborted(deps.signal);

  // 6. Tests covering changed files.
  const changedTests = [...changedPaths].filter((p) => isTestPath(p)).sort();
  for (const p of changedTests) tests.push({ path: p, note: "changed in this PR" });
  const testHits = await testsFor(db, scope, changedFileIds, { limit: limit * 2, testsPerFile: 20 });
  const testChunks = await chunksOf(db, scope, { fileIds: testHits.map((t) => t.testFile.id) });
  for (const t of testHits) {
    const covers = fileIdToPath.get(t.fileId)!;
    if (!tests.some((x) => x.path === t.testFile.path)) tests.push({ path: t.testFile.path, note: `covers ${covers}${t.tests.length ? ` (${t.tests.length} test${t.tests.length === 1 ? "" : "s"})` : ""}` });
    const first = testChunks.find((c) => c.fileId === t.testFile.id);
    const listing = t.tests.map((c) => `- ${c.qualifiedName ?? c.name} (line ${c.startLine})`).join("\n");
    if (first) col.add({ kind: "test", path: t.testFile.path, startLine: first.startLine, endLine: first.endLine, name: null, content: first.content, reasons: [`tests ${covers}`] });
    else if (listing) col.add({ kind: "test", path: t.testFile.path, startLine: 0, endLine: 0, name: null, content: `Test cases:\n${listing}`, reasons: [`tests ${covers}`] });
  }

  // 7. Routes handled by changed code, and consumers of changed tables/models.
  const routeHits = await routesFor(db, scope, changedFileIds, { limit });
  const routeContent = await symbolContents(db, scope, routeHits.map((r) => r.route.id));
  for (const r of routeHits) {
    col.add({ kind: "route", path: r.route.path, startLine: r.route.startLine, endLine: r.route.endLine, name: r.route.name, content: routeContent.get(r.route.id) ?? r.route.signature ?? r.route.name, reasons: [`route ${r.route.name}${r.handler ? ` handled by ${symLabel(r.handler)}` : ""} touches changed code`] });
  }
  const schemaRoots = changed.filter((c) => c.indexId !== null && (c.kind === "table" || c.kind === "model"));
  const consumerHits = await schemaConsumers(db, scope, schemaRoots.map((c) => c.indexId!), { limit: limit * 2 });
  const consumerContent = await symbolContents(db, scope, consumerHits.flatMap((h) => (h.symbol ? [h.symbol.id] : [])));
  const consumerChunks = await chunksOf(db, scope, { fileIds: consumerHits.filter((h) => !h.symbol).map((h) => h.file.id) });
  for (const h of consumerHits) {
    const root = byIndexId.get(h.schemaSymbolId)!;
    const reason = `uses ${root.kind} ${root.name} changed by the PR`;
    if (h.symbol) col.add({ kind: "schema_consumer", path: h.file.path, startLine: h.symbol.startLine, endLine: h.symbol.endLine, name: symLabel(h.symbol), content: consumerContent.get(h.symbol.id) ?? "", reasons: [reason] });
    else {
      const slice = chunkAround(consumerChunks, h.file.id, h.line, 4);
      if (slice) col.add({ kind: "schema_consumer", path: h.file.path, ...slice, name: null, reasons: [reason] });
    }
  }
  checkAborted(deps.signal);

  // 8. Manifests and config files of the packages the change touches.
  const configFiles = await filesByTag(db, scope, ["manifest", "config"], { limit: 500 });
  const pickedConfig = new Map<number, string[]>();
  for (const p of [...changedPaths].sort()) {
    const dirs = ancestorDirs(p);
    const manifest = configFiles
      .filter((f) => f.tags.includes("manifest") && dirs.includes(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const siblings = configFiles.filter((f) => !f.tags.includes("manifest") && (f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "") === dirs[0]);
    if (manifest && !changedPaths.has(manifest.path)) pickedConfig.set(manifest.id, [...(pickedConfig.get(manifest.id) ?? []), `manifest of the package containing ${p}`]);
    for (const s of siblings.slice(0, 2)) if (!changedPaths.has(s.path)) pickedConfig.set(s.id, [...(pickedConfig.get(s.id) ?? []), `configuration next to ${p}`]);
  }
  const configIds = [...pickedConfig.keys()].slice(0, limit);
  const configChunks = await chunksOf(db, scope, { fileIds: configIds });
  for (const id of configIds) {
    const first = configChunks.find((c) => c.fileId === id);
    if (first) col.add({ kind: "config", path: first.path, startLine: first.startLine, endLine: first.endLine, name: null, content: first.content, reasons: pickedConfig.get(id)! });
  }
  const depChanges = dependencyChanges(input.diffs);
  for (const dc of depChanges.slice(0, limit)) {
    const hits = await searchFullText(db, scope, `"${dc.name}"`, 3, { kinds: ["code"] });
    for (const h of hits) col.add({ kind: "text_match", path: h.path, startLine: h.startLine, endLine: h.endLine, name: null, content: h.content, reasons: [`uses dependency ${dc.name} (${dc.change} in ${dc.manifest})`] });
  }

  // 9. Exact symbol search for identifiers the diff references, and path search for path literals.
  const changedNames = new Set(changed.map((c) => c.name));
  const ids = referencedIdentifiers(input.diffs).filter((n) => !changedNames.has(n));
  if (ids.length) {
    const hits = await findSymbolsByName(db, scope, ids, { limit: limit * 3 });
    for (const s of hits) {
      if (s.kind === "test") continue;
      col.add({ kind: "symbol_match", path: s.path, startLine: s.startLine, endLine: s.endLine, name: symLabel(s), content: s.content, reasons: [`defines ${s.name}, referenced in the diff`] });
    }
  }
  const literals = stringLiterals(input.diffs);
  for (const p of literals.paths.map((x) => x.replace(/^(?:\.{1,2}\/)+/, "")).filter((x) => x.length >= 3).slice(0, limit)) {
    const hits = await searchPaths(db, scope, p, { limit: 2 });
    const chunks = await chunksOf(db, scope, { fileIds: hits.map((h) => h.id) });
    for (const h of hits) {
      const first = chunks.find((c) => c.fileId === h.id);
      if (first) col.add({ kind: "path_match", path: h.path, startLine: first.startLine, endLine: first.endLine, name: null, content: first.content, reasons: [`matches path "${p}" referenced in the diff`] });
    }
  }

  // 10. Full-text search for new string constants and config keys.
  const terms = [...configKeys(input.diffs), ...literals.constants].slice(0, limit);
  for (const term of terms) {
    const hits = await searchFullText(db, scope, `"${term.replace(/"/g, " ")}"`, 3, { kinds: ["code", "config", "doc"] });
    const top = hits[0]?.rank ?? 0;
    for (const h of hits) {
      col.add({
        kind: "text_match",
        path: h.path,
        startLine: h.startLine,
        endLine: h.endLine,
        name: null,
        content: h.content,
        score: BASE_SCORE.text_match - 0.1 + (top > 0 ? 0.1 * (h.rank / top) : 0),
        reasons: [`mentions "${term}", introduced in the diff`],
      });
    }
  }
  checkAborted(deps.signal);

  // 11. Embedding neighbors: similar code and related docs.
  if (deps.embedder) {
    const text = changed
      .filter((c) => c.change !== "removed")
      .map((c) => `${c.kind} ${c.qualifiedName}\n${c.content}`)
      .join("\n\n")
      .slice(0, 8000);
    if (text.trim()) {
      const vec = await embedOne(deps, text, scope);
      if (vec) {
        for (const s of await nearestSymbols(db, scope, vec, limit)) {
          if (changedNames.has(s.name) || s.kind === "test" || s.distance > MAX_SIMILAR_DISTANCE) continue;
          col.add({ kind: "similar_code", path: s.path, startLine: s.startLine, endLine: s.endLine, name: symLabel(s), content: s.content, score: BASE_SCORE.similar_code * Math.max(0, 1 - s.distance / 2), reasons: [`similar to the changed code (cosine distance ${s.distance.toFixed(2)})`] });
        }
        for (const c of await nearestChunks(db, scope, vec, Math.ceil(limit / 2))) {
          if (c.distance > MAX_SIMILAR_DISTANCE) continue;
          col.add({ kind: "doc", path: c.path, startLine: c.startLine, endLine: c.endLine, name: null, content: c.content, score: BASE_SCORE.doc * Math.max(0, 1 - c.distance / 2), reasons: ["documentation related to the change"] });
        }
      }
    }
  }

  // 12. Repository instructions files and configured context docs.
  const instructionFiles = (await filesByTag(db, scope, ["instructions"], { limit: 20 })).filter((f) => !f.path.endsWith("openreview.json"));
  const instructionChunks = await chunksOf(db, scope, { fileIds: instructionFiles.slice(0, 5).map((f) => f.id) });
  for (const f of instructionFiles.slice(0, 5)) {
    const own = instructionChunks.filter((c) => c.fileId === f.id).slice(0, 3);
    for (const c of own) col.add({ kind: "instructions", path: c.path, startLine: c.startLine, endLine: c.endLine, name: null, content: c.content, reasons: ["repository instructions"] });
  }
  for (const doc of input.contextDocs ?? []) {
    const lines = doc.content.split("\n").length;
    col.add({ kind: "context_doc", path: doc.path, startLine: 1, endLine: lines, name: null, content: doc.content, reasons: ["context file configured for this repository"] });
  }

  // 13. Recently changed files near the change.
  const commits = await recentChanges(db, scope, { paths: [...changedPaths], limit: limit });
  const changedComponents = new Set([...changedPaths].map(componentOf));
  for (const c of commits) {
    const near = c.changedPaths.filter((p) => !changedPaths.has(p) && changedComponents.has(componentOf(p))).slice(0, 10);
    const touched = c.changedPaths.filter((p) => changedPaths.has(p));
    if (!near.length) continue;
    col.add({
      kind: "recent_change",
      path: near[0]!,
      startLine: 0,
      endLine: 0,
      name: c.sha.slice(0, 7),
      content: `commit ${c.sha.slice(0, 7)} by ${c.author} (${c.committedAt.toISOString().slice(0, 10)}): ${c.message.split("\n")[0]}\nchanged together: ${[...touched, ...near].join(", ")}`,
      reasons: [`changed together with ${touched.join(", ")} recently`],
    });
  }

  // 14. Historical findings on the same files or components.
  for (const h of input.historicalFindings ?? []) {
    const same = changedPaths.has(h.path);
    if (!same && !changedComponents.has(componentOf(h.path))) continue;
    col.add({
      kind: "history",
      path: h.path,
      startLine: 0,
      endLine: 0,
      name: h.title,
      content: `[${h.category}] ${h.title} — status: ${h.status}${h.feedback ? `, feedback: ${h.feedback}` : ""}`,
      score: same ? BASE_SCORE.history : BASE_SCORE.history - 0.15,
      reasons: [same ? "earlier finding on a changed file" : "earlier finding in the same component"],
    });
  }

  // 15. Team rules that apply to the changed files.
  for (const r of applicableRules(input.rules ?? [], [...changedPaths])) {
    col.add({ kind: "rule", path: r.paths.join(", "), startLine: 0, endLine: 0, name: r.id, content: r.text, reasons: [`team rule (${r.scope}) applies to changed files`] });
  }

  // Merge, rank, and fit the budget (definitions are free: they are the change itself).
  const merged = mergeItems(col.drafts)
    .map((d): ContextItem => ({ ...d, tokens: estimateTokens(d.content) }))
    .sort(compareItems);
  const tokenBudget = input.tokenBudget ?? profile.contextTokens;
  const { items, dropped, used } = fitBundle(merged, tokenBudget, profile.definitionTokens);

  const keptPaths = items.filter((i) => ["caller", "callee", "importer", "dependent", "route", "schema_consumer"].includes(i.kind)).map((i) => i.path);
  const components = [...new Set([...changedPaths, ...keptPaths].map(componentOf))].sort();
  const uniqueFlows = flows.filter((f, i) => f.from !== f.to && flows.findIndex((g) => g.from === f.from && g.to === f.to && g.label === f.label) === i);

  return {
    mode: input.mode,
    items,
    changed,
    components,
    flows: uniqueFlows,
    tests,
    changedTests,
    dependencyChanges: depChanges,
    externalDependents: [...externalDependents.values()]
      .map((e) => ({ symbol: e.symbol, path: e.path, dependents: [...e.dependents].sort() }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol)),
    tokensUsed: used,
    tokenBudget,
    dropped: dropped.length,
    droppedItems: dropped,
  };
}

export interface QuestionInput {
  orgId: string;
  repoId: number;
  question: string;
  /** The pull request the question is about, when there is one: adds its graph context. */
  prDiffs?: FileDiff[];
  headContent?: ReadonlyMap<string, string>;
  mode?: ReviewMode;
  tokenBudget?: number;
}

/**
 * Retrieval for a free-text question (conversations, the MCP search tool): symbols and paths the question names,
 * full-text and embedding matches for its wording, plus the PR's graph context when `prDiffs` is given.
 */
export async function retrieveForQuestion(deps: RetrievalDeps, input: QuestionInput): Promise<ContextBundle> {
  const mode = input.mode ?? "standard";
  const profile = modeProfile(mode);
  const scope: RepoScope = { orgId: input.orgId, repoId: input.repoId };
  const base = await retrieveContext(deps, {
    orgId: input.orgId,
    repoId: input.repoId,
    mode,
    diffs: input.prDiffs ?? [],
    headContent: input.headContent ?? new Map(),
    tokenBudget: input.tokenBudget,
  });
  const changedPaths = new Set((input.prDiffs ?? []).map((d) => d.path));
  const col = new Collector(changedPaths, profile.maxItemTokens);
  const terms = questionTerms(input.question);
  const limit = profile.perSourceLimit;

  if (terms.identifiers.length) {
    for (const s of await findSymbolsByName(deps.db, scope, terms.identifiers, { limit: limit * 2 })) {
      col.add({ kind: "symbol_match", path: s.path, startLine: s.startLine, endLine: s.endLine, name: symLabel(s), content: s.content, score: 0.95, reasons: [`named in the question (${s.name})`] });
    }
  }
  for (const p of terms.paths) {
    const hits = await searchPaths(deps.db, scope, p, { limit: 3 });
    const chunks = await chunksOf(deps.db, scope, { fileIds: hits.map((h) => h.id) });
    for (const h of hits) {
      const first = chunks.find((c) => c.fileId === h.id);
      if (first) col.add({ kind: "path_match", path: h.path, startLine: first.startLine, endLine: first.endLine, name: null, content: first.content, score: 0.8, reasons: [`path named in the question (${p})`] });
    }
  }
  if (terms.words.length) {
    const hits = await searchFullText(deps.db, scope, terms.words.join(" or "), limit);
    const top = hits[0]?.rank ?? 0;
    for (const h of hits) {
      col.add({ kind: h.kind === "doc" ? "doc" : "text_match", path: h.path, startLine: h.startLine, endLine: h.endLine, name: null, content: h.content, score: 0.3 + (top > 0 ? 0.2 * (h.rank / top) : 0), reasons: ["matches words in the question"] });
    }
  }
  if (deps.embedder) {
    const vec = await embedOne(deps, input.question, scope);
    if (vec) {
      for (const s of await nearestSymbols(deps.db, scope, vec, Math.ceil(limit / 2))) {
        col.add({ kind: "similar_code", path: s.path, startLine: s.startLine, endLine: s.endLine, name: symLabel(s), content: s.content, score: 0.5 * Math.max(0, 1 - s.distance / 2), reasons: ["semantically similar to the question"] });
      }
      for (const c of await nearestChunks(deps.db, scope, vec, Math.ceil(limit / 2))) {
        col.add({ kind: "doc", path: c.path, startLine: c.startLine, endLine: c.endLine, name: null, content: c.content, score: 0.5 * Math.max(0, 1 - c.distance / 2), reasons: ["documentation related to the question"] });
      }
    }
  }

  const all = mergeItems([...base.items, ...base.droppedItems, ...col.drafts])
    .map((d): ContextItem => ({ ...d, tokens: estimateTokens(d.content) }))
    .sort(compareItems);
  const tokenBudget = input.tokenBudget ?? profile.contextTokens;
  const { items, dropped, used } = fitBundle(all, tokenBudget, profile.definitionTokens);
  return { ...base, items, tokensUsed: used, tokenBudget, dropped: dropped.length, droppedItems: dropped };
}
