/**
 * Index query primitives for the retrieval engine (R6.4). Every function is scoped to one org's repository; ids
 * passed in that belong to another org or repository simply match nothing.
 */
import picomatch from "picomatch";
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { edges, fileChunks, files, repoCommits, repoDependencies, symbols, type EdgeKind } from "@/lib/db/schema";
import { toStoredEmbedding } from "@/lib/llm";
import type { FileTag } from "./filetypes";
import { escapeLike, intArray, textArray } from "./sql";

export interface RepoScope {
  orgId: string;
  repoId: number;
}

export interface SymbolRef {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
}

export interface SymbolHit extends SymbolRef {
  content: string;
}

export interface FileRef {
  id: number;
  path: string;
  language: string;
  tags: string[];
}

export interface ChunkHit {
  id: number;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  kind: "code" | "doc" | "config";
  content: string;
}

const symbolRef = {
  id: symbols.id,
  name: symbols.name,
  qualifiedName: symbols.qualifiedName,
  kind: symbols.kind,
  fileId: symbols.fileId,
  path: files.path,
  startLine: symbols.startLine,
  endLine: symbols.endLine,
  signature: symbols.signature,
  exported: symbols.exported,
};

const fileRef = { id: files.id, path: files.path, language: files.language, tags: files.tags };

const chunkRef = {
  id: fileChunks.id,
  fileId: fileChunks.fileId,
  path: fileChunks.path,
  startLine: fileChunks.startLine,
  endLine: fileChunks.endLine,
  kind: fileChunks.kind,
  content: fileChunks.content,
};

const inRepo = (scope: RepoScope, ...conds: (SQL | undefined)[]) => scoped(symbols, scope.orgId, eq(symbols.repoId, scope.repoId), ...conds);

function vectorLiteral(embedding: number[]): string {
  return `[${toStoredEmbedding(embedding).join(",")}]`;
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup

/** Symbols by name or qualified name (`Cart.total`); `prefix` matches names starting with each input. */
export async function findSymbolsByName(
  db: Db,
  scope: RepoScope,
  names: readonly string[],
  opts: { mode?: "exact" | "prefix"; kinds?: readonly string[]; limit?: number } = {},
): Promise<SymbolHit[]> {
  const wanted = [...new Set(names.filter(Boolean))];
  if (wanted.length === 0) return [];
  const match =
    opts.mode === "prefix"
      ? sql`(${sql.join(
          wanted.map((n) => sql`(${symbols.name} like ${`${escapeLike(n)}%`} or ${symbols.qualifiedName} like ${`${escapeLike(n)}%`})`),
          sql` or `,
        )})`
      : sql`(${symbols.name} = any(${textArray(wanted)}) or ${symbols.qualifiedName} = any(${textArray(wanted)}))`;
  return db
    .select({ ...symbolRef, content: symbols.content })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(inRepo(scope, match, opts.kinds?.length ? inArray(symbols.kind, [...opts.kinds]) : undefined))
    .orderBy(asc(sql`length(${symbols.name})`), asc(files.path), asc(symbols.startLine))
    .limit(opts.limit ?? 50);
}

const GLOB_CHARS = /[*?[\]{}!]/;

/**
 * Files whose path matches `pattern`: a glob (`src/**\/*.ts`) when it contains glob characters, otherwise a
 * case-insensitive substring.
 */
export async function searchPaths(db: Db, scope: RepoScope, pattern: string, opts: { limit?: number } = {}): Promise<FileRef[]> {
  const limit = opts.limit ?? 50;
  const base = scoped(files, scope.orgId, eq(files.repoId, scope.repoId));
  if (!GLOB_CHARS.test(pattern)) {
    return db
      .select(fileRef)
      .from(files)
      .where(and(base, sql`${files.path} ilike ${`%${escapeLike(pattern)}%`}`))
      .orderBy(asc(sql`length(${files.path})`), asc(files.path))
      .limit(limit);
  }
  const literalPrefix = pattern.slice(0, pattern.search(GLOB_CHARS));
  const isMatch = picomatch(pattern, { dot: true });
  const out: FileRef[] = [];
  let cursor = "";
  // Walk the candidate paths in pages so huge repositories are never loaded at once.
  for (;;) {
    const page = await db
      .select(fileRef)
      .from(files)
      .where(and(base, literalPrefix ? sql`${files.path} like ${`${escapeLike(literalPrefix)}%`}` : undefined, sql`${files.path} > ${cursor}`))
      .orderBy(asc(files.path))
      .limit(2000);
    for (const f of page) {
      if (isMatch(f.path)) out.push(f);
      if (out.length >= limit) return out;
    }
    if (page.length < 2000) return out;
    cursor = page[page.length - 1]!.path;
  }
}

/** Full-text search over chunks (`websearch_to_tsquery`, ranked by `ts_rank`). */
export async function searchFullText(
  db: Db,
  scope: RepoScope,
  query: string,
  limit = 20,
  opts: { kinds?: readonly ("code" | "doc" | "config")[] } = {},
): Promise<(ChunkHit & { rank: number })[]> {
  if (!query.trim()) return [];
  const tsq = sql`websearch_to_tsquery('simple', ${query})`;
  const rank = sql<number>`ts_rank(${fileChunks.tsv}, ${tsq})`;
  return db
    .select({ ...chunkRef, rank })
    .from(fileChunks)
    .where(
      scoped(
        fileChunks,
        scope.orgId,
        eq(fileChunks.repoId, scope.repoId),
        sql`${fileChunks.tsv} @@ ${tsq}`,
        opts.kinds?.length ? inArray(fileChunks.kind, [...opts.kinds]) : undefined,
      ),
    )
    .orderBy(desc(rank), asc(fileChunks.path), asc(fileChunks.startLine))
    .limit(limit);
}

/** Symbols nearest to `embedding` (cosine distance). */
export async function nearestSymbols(
  db: Db,
  scope: RepoScope,
  embedding: number[],
  limit = 10,
  opts: { kinds?: readonly string[] } = {},
): Promise<(SymbolHit & { distance: number })[]> {
  const distance = sql<number>`${symbols.embedding} <=> ${vectorLiteral(embedding)}::vector`;
  return db
    .select({ ...symbolRef, content: symbols.content, distance })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(inRepo(scope, isNotNull(symbols.embedding), opts.kinds?.length ? inArray(symbols.kind, [...opts.kinds]) : undefined))
    .orderBy(distance)
    .limit(limit);
}

/** Chunks (docs by default, the embedded kind) nearest to `embedding`. */
export async function nearestChunks(
  db: Db,
  scope: RepoScope,
  embedding: number[],
  limit = 10,
  opts: { kinds?: readonly ("code" | "doc" | "config")[] } = {},
): Promise<(ChunkHit & { distance: number })[]> {
  const distance = sql<number>`${fileChunks.embedding} <=> ${vectorLiteral(embedding)}::vector`;
  return db
    .select({ ...chunkRef, distance })
    .from(fileChunks)
    .where(
      scoped(
        fileChunks,
        scope.orgId,
        eq(fileChunks.repoId, scope.repoId),
        isNotNull(fileChunks.embedding),
        opts.kinds?.length ? inArray(fileChunks.kind, [...opts.kinds]) : undefined,
      ),
    )
    .orderBy(distance)
    .limit(limit);
}

/** Files carrying any of `tags`. */
export async function filesByTag(db: Db, scope: RepoScope, tags: readonly FileTag[], opts: { limit?: number } = {}): Promise<FileRef[]> {
  if (tags.length === 0) return [];
  return db
    .select(fileRef)
    .from(files)
    .where(scoped(files, scope.orgId, eq(files.repoId, scope.repoId), sql`${files.tags} && ${textArray(tags)}`))
    .orderBy(asc(files.path))
    .limit(opts.limit ?? 500);
}

// ---------------------------------------------------------------------------------------------------------------
// Graph traversal

const fromSym = alias(symbols, "from_sym");
const fromFile = alias(files, "from_file");
const toSym = alias(symbols, "to_sym");
const toFile = alias(files, "to_file");

const fromSymbolRef = {
  id: fromSym.id,
  name: fromSym.name,
  qualifiedName: fromSym.qualifiedName,
  kind: fromSym.kind,
  fileId: fromSym.fileId,
  path: fromFile.path,
  startLine: fromSym.startLine,
  endLine: fromSym.endLine,
  signature: fromSym.signature,
  exported: fromSym.exported,
};

const toSymbolRef = {
  id: toSym.id,
  name: toSym.name,
  qualifiedName: toSym.qualifiedName,
  kind: toSym.kind,
  fileId: toSym.fileId,
  path: toFile.path,
  startLine: toSym.startLine,
  endLine: toSym.endLine,
  signature: toSym.signature,
  exported: toSym.exported,
};

const edgeScope = (scope: RepoScope, kind: EdgeKind | EdgeKind[], ...conds: (SQL | undefined)[]) =>
  scoped(edges, scope.orgId, eq(edges.repoId, scope.repoId), Array.isArray(kind) ? inArray(edges.kind, kind) : eq(edges.kind, kind), ...conds);

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** A left-joined symbol, or null when the join found none. */
function symbolOrNull(ref: Nullable<SymbolRef> | null): SymbolRef | null {
  return ref && ref.id !== null ? (ref as SymbolRef) : null;
}

export interface CallerHit {
  /** The called symbol (one of the inputs). */
  symbolId: number;
  /** The calling symbol, or null for a module-level call. */
  caller: SymbolRef | null;
  file: { id: number; path: string };
  line: number;
}

/** Call sites of `symbolIds`. */
export async function callersOf(db: Db, scope: RepoScope, symbolIds: readonly number[], opts: { limit?: number } = {}): Promise<CallerHit[]> {
  if (symbolIds.length === 0) return [];
  const rows = await db
    .select({ symbolId: edges.toSymbolId, caller: fromSymbolRef, fileId: fromFile.id, filePath: fromFile.path, line: edges.line })
    .from(edges)
    .innerJoin(fromFile, eq(edges.fromFileId, fromFile.id))
    .leftJoin(fromSym, eq(edges.fromSymbolId, fromSym.id))
    .where(edgeScope(scope, "call", sql`${edges.toSymbolId} = any(${intArray(symbolIds)})`))
    .orderBy(asc(fromFile.path), asc(edges.line))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({
    symbolId: r.symbolId!,
    caller: symbolOrNull(r.caller),
    file: { id: r.fileId, path: r.filePath },
    line: r.line,
  }));
}

export interface CalleeHit {
  /** The calling symbol (one of the inputs). */
  symbolId: number;
  callee: SymbolRef;
  line: number;
}

/** Resolved symbols called by `symbolIds`. */
export async function calleesOf(db: Db, scope: RepoScope, symbolIds: readonly number[], opts: { limit?: number } = {}): Promise<CalleeHit[]> {
  if (symbolIds.length === 0) return [];
  const rows = await db
    .select({ symbolId: edges.fromSymbolId, callee: toSymbolRef, line: edges.line })
    .from(edges)
    .innerJoin(toSym, eq(edges.toSymbolId, toSym.id))
    .innerJoin(toFile, eq(toSym.fileId, toFile.id))
    .where(edgeScope(scope, "call", sql`${edges.fromSymbolId} = any(${intArray(symbolIds)})`))
    .orderBy(asc(edges.line))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({ symbolId: r.symbolId!, callee: r.callee, line: r.line }));
}

export interface ImporterHit {
  /** The imported file (one of the inputs). */
  fileId: number;
  importer: FileRef;
  line: number;
}

/** Files importing (or re-exporting) any of `fileIds`. */
export async function importersOf(db: Db, scope: RepoScope, fileIds: readonly number[], opts: { limit?: number } = {}): Promise<ImporterHit[]> {
  if (fileIds.length === 0) return [];
  const rows = await db
    .selectDistinctOn([edges.toFileId, fromFile.id], {
      fileId: edges.toFileId,
      importer: { id: fromFile.id, path: fromFile.path, language: fromFile.language, tags: fromFile.tags },
      line: edges.line,
    })
    .from(edges)
    .innerJoin(fromFile, eq(edges.fromFileId, fromFile.id))
    .where(edgeScope(scope, ["import", "export"], sql`${edges.toFileId} = any(${intArray(fileIds)})`, sql`${edges.fromFileId} <> ${edges.toFileId}`))
    .orderBy(edges.toFileId, fromFile.id, asc(edges.line))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({ fileId: r.fileId!, importer: r.importer, line: r.line }));
}

export interface TestHit {
  /** The source file (one of the inputs). */
  fileId: number;
  testFile: FileRef;
  /** Test cases declared in the test file. */
  tests: { id: number; name: string; qualifiedName: string | null; startLine: number }[];
}

/** Test files covering `fileIds` (tested_by edges), with their test cases. */
export async function testsFor(db: Db, scope: RepoScope, fileIds: readonly number[], opts: { limit?: number; testsPerFile?: number } = {}): Promise<TestHit[]> {
  if (fileIds.length === 0) return [];
  const rows = await db
    .select({ fileId: edges.fromFileId, testFile: { id: toFile.id, path: toFile.path, language: toFile.language, tags: toFile.tags } })
    .from(edges)
    .innerJoin(toFile, eq(edges.toFileId, toFile.id))
    .where(edgeScope(scope, "tested_by", sql`${edges.fromFileId} = any(${intArray(fileIds)})`))
    .orderBy(asc(toFile.path))
    .limit(opts.limit ?? 100);
  const testFileIds = [...new Set(rows.map((r) => r.testFile.id))];
  const cases = testFileIds.length
    ? await db
        .select({ id: symbols.id, fileId: symbols.fileId, name: symbols.name, qualifiedName: symbols.qualifiedName, startLine: symbols.startLine })
        .from(symbols)
        .where(inRepo(scope, eq(symbols.kind, "test"), sql`${symbols.fileId} = any(${intArray(testFileIds)})`))
        .orderBy(asc(symbols.startLine))
    : [];
  const perFile = opts.testsPerFile ?? 50;
  return rows.map((r) => ({
    fileId: r.fileId,
    testFile: r.testFile,
    tests: cases
      .filter((c) => c.fileId === r.testFile.id)
      .slice(0, perFile)
      .map(({ id, name, qualifiedName, startLine }) => ({ id, name, qualifiedName, startLine })),
  }));
}

export interface RouteHit {
  route: SymbolRef;
  handler: SymbolRef | null;
}

/** Routes declared in `fileIds` or handled by symbols in `fileIds`. */
export async function routesFor(db: Db, scope: RepoScope, fileIds: readonly number[], opts: { limit?: number } = {}): Promise<RouteHit[]> {
  if (fileIds.length === 0) return [];
  const ids = intArray(fileIds);
  const rows = await db
    .select({ route: symbolRef, handler: toSymbolRef })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .leftJoin(edges, and(eq(edges.fromSymbolId, symbols.id), eq(edges.kind, "route_handler")))
    .leftJoin(toSym, eq(edges.toSymbolId, toSym.id))
    .leftJoin(toFile, eq(toSym.fileId, toFile.id))
    .where(inRepo(scope, eq(symbols.kind, "route"), sql`(${symbols.fileId} = any(${ids}) or ${toSym.fileId} = any(${ids}))`))
    .orderBy(asc(files.path), asc(symbols.startLine))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({ route: r.route, handler: symbolOrNull(r.handler) }));
}

export interface SchemaConsumerHit {
  /** The table/model symbol (one of the inputs). */
  schemaSymbolId: number;
  file: FileRef;
  /** The consuming symbol, when the use is attributed to one. */
  symbol: SymbolRef | null;
  line: number;
}

/** Files and symbols that use the tables/models `symbolIds`. */
export async function schemaConsumers(db: Db, scope: RepoScope, symbolIds: readonly number[], opts: { limit?: number } = {}): Promise<SchemaConsumerHit[]> {
  if (symbolIds.length === 0) return [];
  const rows = await db
    .select({
      schemaSymbolId: edges.fromSymbolId,
      file: { id: toFile.id, path: toFile.path, language: toFile.language, tags: toFile.tags },
      symbol: { ...toSymbolRef, path: toFile.path },
      line: edges.line,
    })
    .from(edges)
    .innerJoin(toFile, eq(edges.toFileId, toFile.id))
    .leftJoin(toSym, eq(edges.toSymbolId, toSym.id))
    .where(edgeScope(scope, "schema_consumer", sql`${edges.fromSymbolId} = any(${intArray(symbolIds)})`))
    .orderBy(asc(toFile.path), asc(edges.line))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({
    schemaSymbolId: r.schemaSymbolId!,
    file: r.file,
    symbol: symbolOrNull(r.symbol),
    line: r.line,
  }));
}

export interface Dependent {
  kind: "symbol" | "file";
  /** 1 = direct dependent, 2 = dependent of a dependent. */
  depth: number;
  /** The relation that reached it: call/reference/extends/implements/route_handler for symbols, import for files. */
  via: EdgeKind;
  symbol: SymbolRef | null;
  file: { id: number; path: string };
}

const SYMBOL_DEPENDENCY_KINDS: EdgeKind[] = ["call", "reference", "extends", "implements", "route_handler"];

/**
 * What depends on `symbolId`, transitively up to `depth` (at most 2): symbols that call, reference, extend,
 * implement, or route to it, and files that import its file — then the same for each of those. A visited set keeps
 * cycles and diamonds from repeating work.
 */
export async function dependentsOf(
  db: Db,
  scope: RepoScope,
  symbolId: number,
  opts: { depth?: number; limit?: number } = {},
): Promise<Dependent[]> {
  const maxDepth = Math.min(2, Math.max(1, opts.depth ?? 2));
  const limit = opts.limit ?? 200;
  const [start] = await db
    .select({ id: symbols.id, fileId: symbols.fileId })
    .from(symbols)
    .where(inRepo(scope, eq(symbols.id, symbolId)));
  if (!start) return [];

  const seenSymbols = new Set<number>([start.id]);
  const seenFiles = new Set<number>([start.fileId]);
  const out: Dependent[] = [];
  let frontierSymbols = [start.id];
  let frontierFiles = [start.fileId];

  for (let depth = 1; depth <= maxDepth && out.length < limit; depth++) {
    const nextSymbols: number[] = [];
    const nextFiles: number[] = [];
    if (frontierSymbols.length) {
      const rows = await db
        .select({ via: edges.kind, symbol: fromSymbolRef, fileId: fromFile.id, filePath: fromFile.path })
        .from(edges)
        .innerJoin(fromFile, eq(edges.fromFileId, fromFile.id))
        .leftJoin(fromSym, eq(edges.fromSymbolId, fromSym.id))
        .where(edgeScope(scope, SYMBOL_DEPENDENCY_KINDS, sql`${edges.toSymbolId} = any(${intArray(frontierSymbols)})`))
        .orderBy(asc(edges.id));
      for (const r of rows) {
        const sym = symbolOrNull(r.symbol);
        if (sym) {
          if (seenSymbols.has(sym.id)) continue;
          seenSymbols.add(sym.id);
          nextSymbols.push(sym.id);
          out.push({ kind: "symbol", depth, via: r.via, symbol: sym, file: { id: r.fileId, path: r.filePath } });
        } else {
          // Module-level use: the file itself depends on the symbol.
          if (seenFiles.has(r.fileId)) continue;
          seenFiles.add(r.fileId);
          nextFiles.push(r.fileId);
          out.push({ kind: "file", depth, via: r.via, symbol: null, file: { id: r.fileId, path: r.filePath } });
        }
      }
    }
    if (frontierFiles.length) {
      const rows = await db
        .selectDistinct({ fileId: fromFile.id, filePath: fromFile.path })
        .from(edges)
        .innerJoin(fromFile, eq(edges.fromFileId, fromFile.id))
        .where(edgeScope(scope, "import", sql`${edges.toFileId} = any(${intArray(frontierFiles)})`))
        .orderBy(asc(fromFile.path));
      for (const r of rows) {
        if (seenFiles.has(r.fileId)) continue;
        seenFiles.add(r.fileId);
        nextFiles.push(r.fileId);
        out.push({ kind: "file", depth, via: "import", symbol: null, file: { id: r.fileId, path: r.filePath } });
      }
    }
    frontierSymbols = nextSymbols;
    frontierFiles = nextFiles;
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// History and manifests

export interface RecentCommit {
  sha: string;
  parentSha: string | null;
  message: string;
  author: string;
  committedAt: Date;
  changedPaths: string[];
}

/** Latest indexed commits, optionally only those touching any of `paths`. */
export async function recentChanges(db: Db, scope: RepoScope, opts: { paths?: readonly string[]; limit?: number } = {}): Promise<RecentCommit[]> {
  return db
    .select({
      sha: repoCommits.sha,
      parentSha: repoCommits.parentSha,
      message: repoCommits.message,
      author: repoCommits.author,
      committedAt: repoCommits.committedAt,
      changedPaths: repoCommits.changedPaths,
    })
    .from(repoCommits)
    .where(
      scoped(
        repoCommits,
        scope.orgId,
        eq(repoCommits.repoId, scope.repoId),
        opts.paths?.length ? sql`${repoCommits.changedPaths} && ${textArray(opts.paths)}` : undefined,
      ),
    )
    .orderBy(desc(repoCommits.committedAt), desc(repoCommits.id))
    .limit(opts.limit ?? 20);
}

export type RepoDependency = Pick<typeof repoDependencies.$inferSelect, "manifestPath" | "ecosystem" | "name" | "versionSpec" | "kind">;

/** Declared dependencies across the repository's manifests. */
export async function repoDependenciesOf(
  db: Db,
  scope: RepoScope,
  opts: { ecosystem?: RepoDependency["ecosystem"]; kind?: RepoDependency["kind"]; names?: readonly string[] } = {},
): Promise<RepoDependency[]> {
  return db
    .select({
      manifestPath: repoDependencies.manifestPath,
      ecosystem: repoDependencies.ecosystem,
      name: repoDependencies.name,
      versionSpec: repoDependencies.versionSpec,
      kind: repoDependencies.kind,
    })
    .from(repoDependencies)
    .where(
      scoped(
        repoDependencies,
        scope.orgId,
        eq(repoDependencies.repoId, scope.repoId),
        opts.ecosystem ? eq(repoDependencies.ecosystem, opts.ecosystem) : undefined,
        opts.kind ? eq(repoDependencies.kind, opts.kind) : undefined,
        opts.names?.length ? inArray(repoDependencies.name, [...opts.names]) : undefined,
      ),
    )
    .orderBy(asc(repoDependencies.manifestPath), asc(repoDependencies.name));
}

export { repoDependenciesOf as repoDependencies };
