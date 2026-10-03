/**
 * Codebase questions for coding agents (R3.2): ranked code search, the graph neighborhood of a file or symbol, and the
 * knowledge base context of a path. All reads go through the index of one org's repository; ids and names of another
 * org's code never match. Repository content returned here is data for the caller, never instructions (H7).
 */
import { asc, eq, like } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import { listKnowledgeEntries, type KnowledgeListItem } from "@/lib/data/knowledge";
import type { Db } from "@/lib/db";
import { files, knowledgeEntries, symbols, type repos } from "@/lib/db/schema";
import { callersOf, calleesOf, findSymbolsByName, importersOf, searchPaths, testsFor, type RepoScope, type SymbolHit } from "@/lib/indexer/query";
import { escapeLike } from "@/lib/indexer/sql";
import { knowledgeForPaths, type KnowledgeForPath } from "@/lib/knowledge/retrieve";
import type { EmbeddingProvider } from "@/lib/llm/types";
import { retrieveForQuestion, type ContextKind } from "@/lib/retrieval";
import { redactSecrets } from "@/lib/security/secret-scan";

type RepoRow = typeof repos.$inferSelect;

/** Kinds of retrieved context that answer a search (rules, past findings, and repo-wide instructions do not). */
const SEARCH_KINDS: ReadonlySet<ContextKind> = new Set([
  "symbol_match",
  "path_match",
  "text_match",
  "similar_code",
  "doc",
  "definition",
  "caller",
  "callee",
  "importer",
  "dependent",
  "test",
  "route",
  "schema_consumer",
  "config",
  "knowledge",
]);

export const MAX_SNIPPET_LINES = 60;
export const MAX_SNIPPET_CHARS = 4_000;

export interface CodeSearchHit {
  rank: number;
  kind: ContextKind;
  path: string;
  startLine: number;
  endLine: number;
  name: string | null;
  score: number;
  /** Why the snippet matched, e.g. "named in the question (computeTotal)". */
  reasons: string[];
  snippet: string;
  truncated: boolean;
}

/** A snippet capped at {@link MAX_SNIPPET_LINES} lines / {@link MAX_SNIPPET_CHARS} characters, secrets redacted. */
export function snippetOf(content: string): { snippet: string; truncated: boolean } {
  const lines = redactSecrets(content).split("\n");
  let text = lines.slice(0, MAX_SNIPPET_LINES).join("\n");
  let truncated = lines.length > MAX_SNIPPET_LINES;
  if (text.length > MAX_SNIPPET_CHARS) {
    text = text.slice(0, MAX_SNIPPET_CHARS);
    truncated = true;
  }
  return { snippet: text, truncated };
}

/**
 * Ranked snippets answering `query` (symbols and paths it names, full-text and embedding matches, knowledge notes),
 * best first, through the retrieval engine's question mode.
 */
export async function searchCodebase(
  deps: { db: Db; embedder?: EmbeddingProvider },
  scope: RepoScope,
  query: string,
  opts: { limit?: number } = {},
): Promise<CodeSearchHit[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const bundle = await retrieveForQuestion({ db: deps.db, ...(deps.embedder ? { embedder: deps.embedder } : {}) }, { orgId: scope.orgId, repoId: scope.repoId, question: query, mode: "standard" });
  return bundle.items
    .filter((i) => SEARCH_KINDS.has(i.kind))
    .slice(0, limit)
    .map((i, n) => ({
      rank: n + 1,
      kind: i.kind,
      path: i.path,
      startLine: i.startLine,
      endLine: i.endLine,
      name: i.name,
      score: Math.round(i.score * 1000) / 1000,
      reasons: i.reasons,
      ...snippetOf(i.content),
    }));
}

const RELATED_LIMIT = 50;

export interface RelatedSymbol {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string | null;
}

export interface RelatedCode {
  /** The file asked about (null when only a symbol was given or the path is not indexed). */
  file: { path: string; language: string; tags: string[] } | null;
  /** Symbols the question resolved to: the named symbol(s), or the file's exported symbols. */
  symbols: RelatedSymbol[];
  callers: { symbol: string; path: string; line: number; caller: string | null }[];
  callees: { symbol: string; path: string; line: number; callee: string }[];
  importers: { path: string; line: number }[];
  tests: { path: string; cases: string[] }[];
  /** Indexed paths resembling an unknown `path`. */
  suggestions: string[];
}

function symbolOut(s: Pick<SymbolHit, "id" | "name" | "qualifiedName" | "kind" | "path" | "startLine" | "endLine" | "signature">): RelatedSymbol {
  return { id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, path: s.path, startLine: s.startLine, endLine: s.endLine, signature: s.signature };
}

/** Callers, callees, importers, and tests of a file and/or symbol, from the code graph (R6.4 primitives). */
export async function relatedCode(db: Db, scope: RepoScope, input: { path?: string; symbol?: string }): Promise<RelatedCode> {
  const out: RelatedCode = { file: null, symbols: [], callers: [], callees: [], importers: [], tests: [], suggestions: [] };
  let fileRow: { id: number; path: string; language: string; tags: string[] } | undefined;
  if (input.path) {
    [fileRow] = await db
      .select({ id: files.id, path: files.path, language: files.language, tags: files.tags })
      .from(files)
      .where(scoped(files, scope.orgId, eq(files.repoId, scope.repoId), eq(files.path, input.path)));
    if (!fileRow) {
      out.suggestions = (await searchPaths(db, scope, input.path.split("/").pop() || input.path, { limit: 10 })).map((f) => f.path);
      if (!input.symbol) return out;
    } else {
      out.file = { path: fileRow.path, language: fileRow.language, tags: fileRow.tags };
    }
  }

  let syms: RelatedSymbol[] = [];
  if (input.symbol) {
    const hits = await findSymbolsByName(db, scope, [input.symbol], { limit: 20 });
    syms = hits.filter((h) => !fileRow || h.fileId === fileRow.id).map(symbolOut);
  } else if (fileRow) {
    const rows = await db
      .select({
        id: symbols.id,
        name: symbols.name,
        qualifiedName: symbols.qualifiedName,
        kind: symbols.kind,
        startLine: symbols.startLine,
        endLine: symbols.endLine,
        signature: symbols.signature,
      })
      .from(symbols)
      .where(scoped(symbols, scope.orgId, eq(symbols.repoId, scope.repoId), eq(symbols.fileId, fileRow.id), eq(symbols.exported, true)))
      .orderBy(asc(symbols.startLine))
      .limit(RELATED_LIMIT);
    syms = rows.map((r) => ({ ...r, path: fileRow.path }));
  }
  out.symbols = syms;

  const byId = new Map(syms.map((s) => [s.id, s]));
  const symbolIds = syms.map((s) => s.id);
  // The files whose importers and tests matter: the asked-about file, or the files defining the named symbol.
  const fileIds = fileRow ? [fileRow.id] : [...new Set((await symbolFiles(db, scope, symbolIds)).values())];

  const [callers, callees, importers, tests] = await Promise.all([
    callersOf(db, scope, symbolIds, { limit: RELATED_LIMIT }),
    input.symbol ? calleesOf(db, scope, symbolIds, { limit: RELATED_LIMIT }) : Promise.resolve([]),
    importersOf(db, scope, fileIds, { limit: RELATED_LIMIT }),
    testsFor(db, scope, fileIds, { limit: RELATED_LIMIT, testsPerFile: 20 }),
  ]);
  out.callers = callers.map((c) => ({ symbol: byId.get(c.symbolId)?.name ?? String(c.symbolId), path: c.file.path, line: c.line, caller: c.caller?.qualifiedName ?? c.caller?.name ?? null }));
  out.callees = callees.map((c) => ({ symbol: byId.get(c.symbolId)?.name ?? String(c.symbolId), path: c.callee.path, line: c.callee.startLine, callee: c.callee.qualifiedName ?? c.callee.name }));
  const seenImporters = new Set<string>();
  for (const i of importers) {
    if (seenImporters.has(i.importer.path)) continue;
    seenImporters.add(i.importer.path);
    out.importers.push({ path: i.importer.path, line: i.line });
  }
  const seenTests = new Set<string>();
  for (const t of tests) {
    if (seenTests.has(t.testFile.path)) continue;
    seenTests.add(t.testFile.path);
    out.tests.push({ path: t.testFile.path, cases: t.tests.map((c) => c.qualifiedName ?? c.name) });
  }
  return out;
}

async function symbolFiles(db: Db, scope: RepoScope, symbolIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const id of symbolIds) {
    const [row] = await db
      .select({ fileId: symbols.fileId })
      .from(symbols)
      .where(scoped(symbols, scope.orgId, eq(symbols.repoId, scope.repoId), eq(symbols.id, id)));
    if (row) out.set(id, row.fileId);
  }
  return out;
}

export interface RepositoryContext {
  repository: {
    id: number;
    fullName: string;
    defaultBranch: string;
    indexStatus: string;
    indexedSha: string | null;
    fileCount: number;
    languages: Record<string, number>;
  };
  /** The generated architecture overview of the repository, when there is one. */
  overview: { title: string; description: string; stale: boolean; lastCommitSha: string | null } | null;
  /** Knowledge entries covering `path` (full descriptions), when a path was given. */
  entries: KnowledgeForPath[];
  /** Every entry's summary, when no path was given. */
  subsystems: KnowledgeListItem[];
}

/** Indexed files at `path` or under it (a directory), at most 200. */
async function pathsUnder(db: Db, scope: RepoScope, path: string): Promise<string[]> {
  const clean = path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  const rows = await db
    .select({ path: files.path })
    .from(files)
    .where(scoped(files, scope.orgId, eq(files.repoId, scope.repoId), clean ? like(files.path, `${escapeLike(clean)}/%`) : undefined))
    .orderBy(asc(files.path))
    .limit(200);
  return [clean, ...rows.map((r) => r.path)].filter(Boolean);
}

/** The repository's summary and the knowledge base context of a path (or of every subsystem). */
export async function repositoryContext(db: Db, orgId: string, repo: RepoRow, opts: { path?: string } = {}): Promise<RepositoryContext> {
  const scope = { orgId, repoId: repo.id };
  const [overview] = await db
    .select({ title: knowledgeEntries.title, description: knowledgeEntries.description, stale: knowledgeEntries.stale, lastCommitSha: knowledgeEntries.lastCommitSha })
    .from(knowledgeEntries)
    .where(scoped(knowledgeEntries, orgId, eq(knowledgeEntries.repoId, repo.id), eq(knowledgeEntries.kind, "architecture")))
    .orderBy(asc(knowledgeEntries.rank))
    .limit(1);
  const entries = opts.path ? await knowledgeForPaths(db, orgId, repo.id, await pathsUnder(db, scope, opts.path), { limit: 5 }) : [];
  const subsystems = opts.path ? [] : (await listKnowledgeEntries(db, orgId, repo.id, { pageSize: 50 })).items;
  return {
    repository: {
      id: repo.id,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      indexStatus: repo.indexStatus,
      indexedSha: repo.indexedSha,
      fileCount: repo.fileCount,
      languages: repo.languages,
    },
    overview: overview && overview.description ? overview : null,
    entries,
    subsystems,
  };
}
