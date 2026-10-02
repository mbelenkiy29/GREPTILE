/**
 * Graph resolution (R6.4). Per-file extraction stores edges with raw target names; this pass links them to files and
 * symbols, in batches and only where something could have changed:
 *
 * - edges inserted by this run,
 * - unresolved file edges (import/export) when any file was added, changed, or removed,
 * - imports resolved into a Go package or C# namespace directory that gained a file,
 * - symbol edges (resolved or not) whose target name belongs to a symbol added or removed by this run, so a better
 *   candidate (e.g. one in a file the caller imports) replaces a fallback.
 *
 * Derived relations that span files (tested_by, schema_consumer) are rebuilt from the stored graph when anything
 * changed.
 */
import path from "node:path/posix";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { edges, files, symbols, type EdgeKind } from "@/lib/db/schema";
import { languageForPath, type LanguageId } from "./languages";
import { PathIndex, resolveImport } from "./resolve";
import { chunked, intArray, rowsOf, textArray } from "./sql";

export interface GraphScope {
  orgId: string;
  repoId: number;
}

const BATCH = 2000;
const WRITE_BATCH = 500;

const FILE_EDGE_KINDS: EdgeKind[] = ["import", "export"];
const SYMBOL_EDGE_KINDS: EdgeKind[] = ["call", "reference", "extends", "implements", "route_handler", "depends_on"];

/** Symbol kinds each edge kind may point at. */
const TARGET_KINDS: Record<string, Set<string>> = {
  call: new Set(["function", "method", "class", "struct", "variable", "model"]),
  reference: new Set(["function", "method", "class", "interface", "type", "enum", "struct", "trait", "variable", "model", "table"]),
  extends: new Set(["class", "interface", "type", "struct", "trait", "model", "enum"]),
  implements: new Set(["class", "interface", "type", "struct", "trait", "model"]),
  route_handler: new Set(["function", "method", "variable"]),
  depends_on: new Set(["module"]),
};

/** Within one preference tier, prefer code definitions over the tables they declare. */
const KIND_RANK: Record<string, number> = { table: 1 };

interface FileMeta {
  id: number;
  path: string;
  language: string;
  tags: string[];
}

interface Candidate {
  id: number;
  name: string;
  fileId: number;
  kind: string;
}

export interface ResolveOptions {
  /** Edges with a larger id were inserted by this run. */
  newEdgesAfterId: number;
  /** Names of symbols added or removed by this run; null re-resolves only new edges (full runs). */
  affectedNames: readonly string[] | null;
  /** Whether any file was added, changed, or removed (re-resolve dangling file edges, rebuild derived edges). */
  changed: boolean;
  /** Paths of files this run added (not just changed). */
  addedPaths?: readonly string[];
}

async function loadFiles(db: Db, scope: GraphScope): Promise<FileMeta[]> {
  return db
    .select({ id: files.id, path: files.path, language: files.language, tags: files.tags })
    .from(files)
    .where(and(eq(files.orgId, scope.orgId), eq(files.repoId, scope.repoId)));
}

async function writeUpdates(db: Db, updates: { id: number; toFileId: number | null; toSymbolId: number | null; kind: EdgeKind }[]) {
  for (const batch of chunked(updates, WRITE_BATCH)) {
    const values = batch.map((u) => sql`(${u.id}::int, ${u.toFileId}::int, ${u.toSymbolId}::int, ${u.kind}::edge_kind)`);
    await db.execute(
      sql`update edges set to_file_id = v.f, to_symbol_id = v.s, kind = v.k
          from (values ${sql.join(values, sql`, `)}) as v(id, f, s, k) where edges.id = v.id`,
    );
  }
}

/** Languages whose imports name a package or namespace that can span several files of one directory. */
const PACKAGE_IMPORT_FILE = /\.(?:go|cs)$/;

async function maxEdgeId(db: Db, scope: GraphScope): Promise<number> {
  const [row] = await db
    .select({ id: sql<number>`coalesce(max(${edges.id}), 0)` })
    .from(edges)
    .where(and(eq(edges.orgId, scope.orgId), eq(edges.repoId, scope.repoId)));
  return Number(row?.id ?? 0);
}

async function resolveFileEdges(db: Db, scope: GraphScope, fileMeta: FileMeta[], opts: ResolveOptions) {
  const byId = new Map(fileMeta.map((f) => [f.id, f]));
  const idByPath = new Map(fileMeta.map((f) => [f.path, f.id]));
  const index = new PathIndex(idByPath.keys());
  // Edges inserted below (one per extra file of a package) are complete; the scan never revisits them.
  const lastId = await maxEdgeId(db, scope);
  // A file added to a Go package or C# namespace directory joins every import already resolved into that directory.
  const packageDirs = new Set((opts.addedPaths ?? []).filter((p) => PACKAGE_IMPORT_FILE.test(p)).map((p) => path.dirname(p)));
  const grownPackages = packageDirs.size ? fileMeta.filter((f) => packageDirs.has(path.dirname(f.path))).map((f) => f.id) : [];
  const retry = opts.changed
    ? sql`(${edges.id} > ${opts.newEdgesAfterId} or ${edges.toFileId} is null${grownPackages.length ? sql` or ${edges.toFileId} = any(${intArray(grownPackages)})` : sql``})`
    : gt(edges.id, opts.newEdgesAfterId);
  let cursor = 0;
  for (;;) {
    const batch = await db
      .select({ id: edges.id, kind: edges.kind, fromFileId: edges.fromFileId, targetName: edges.targetName, line: edges.line, toFileId: edges.toFileId })
      .from(edges)
      .where(and(eq(edges.orgId, scope.orgId), eq(edges.repoId, scope.repoId), gt(edges.id, cursor), lte(edges.id, lastId), inArray(edges.kind, FILE_EDGE_KINDS), retry))
      .orderBy(edges.id)
      .limit(BATCH);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    // (importer, imported) file pairs already linked, so no file is linked twice by one package import.
    const fromIds = [...new Set(batch.map((e) => e.fromFileId))];
    const linked = new Set<string>();
    for (const r of await db
      .select({ from: edges.fromFileId, to: edges.toFileId })
      .from(edges)
      .where(
        and(
          eq(edges.orgId, scope.orgId),
          eq(edges.repoId, scope.repoId),
          eq(edges.kind, "import"),
          sql`${edges.fromFileId} = any(${intArray(fromIds)})`,
          sql`${edges.toFileId} is not null`,
        ),
      )) {
      linked.add(`${r.from}:${r.to}`);
    }

    const updates: { id: number; toFileId: number | null; toSymbolId: number | null; kind: EdgeKind }[] = [];
    const extra: (typeof edges.$inferInsert)[] = [];
    const redundant: number[] = [];
    for (const e of batch) {
      const from = byId.get(e.fromFileId);
      const lang = from ? (languageForPath(from.path)?.id as LanguageId | undefined) : undefined;
      if (!from || !lang) continue;
      const targets = resolveImport(lang, from.path, e.targetName, index)
        .map((p) => idByPath.get(p))
        .filter((id): id is number => id !== undefined);
      const key = (to: number) => `${e.fromFileId}:${to}`;
      if (e.kind === "import" && targets.length > 1) {
        // A Go package or C# namespace spanning several files: one edge per file. An edge that already points at one
        // of them stays; any other takes a file not yet linked, or is dropped when every file already is (its file
        // was removed and the remaining ones are linked by sibling edges).
        if (e.toFileId === null || !targets.includes(e.toFileId)) {
          const free = targets.find((t) => !linked.has(key(t)));
          if (free === undefined) {
            redundant.push(e.id);
            continue;
          }
          updates.push({ id: e.id, toFileId: free, toSymbolId: null, kind: e.kind });
          linked.add(key(free));
        }
        for (const t of targets) {
          if (linked.has(key(t))) continue;
          linked.add(key(t));
          extra.push({ orgId: scope.orgId, repoId: scope.repoId, kind: "import", fromFileId: e.fromFileId, fromSymbolId: null, targetName: e.targetName, toFileId: t, line: e.line });
        }
        continue;
      }
      const first = targets[0] ?? null;
      if (first !== e.toFileId) updates.push({ id: e.id, toFileId: first, toSymbolId: null, kind: e.kind });
      if (first !== null && e.kind === "import") linked.add(key(first));
    }
    await writeUpdates(db, updates);
    for (const b of chunked(extra, WRITE_BATCH)) await db.insert(edges).values(b);
    for (const ids of chunked(redundant, WRITE_BATCH)) {
      await db.delete(edges).where(and(eq(edges.orgId, scope.orgId), eq(edges.repoId, scope.repoId), inArray(edges.id, ids)));
    }
  }
}

async function importMap(db: Db, scope: GraphScope): Promise<Map<number, Set<number>>> {
  const map = new Map<number, Set<number>>();
  const rows = await db
    .select({ from: edges.fromFileId, to: edges.toFileId })
    .from(edges)
    .where(and(eq(edges.orgId, scope.orgId), eq(edges.repoId, scope.repoId), eq(edges.kind, "import"), sql`${edges.toFileId} is not null`));
  for (const r of rows) {
    const set = map.get(r.from) ?? new Set<number>();
    set.add(r.to!);
    map.set(r.from, set);
  }
  return map;
}

function pick(cands: Candidate[], e: { fromFileId: number; fromSymbolId: number | null }, imported: Set<number> | undefined): Candidate | undefined {
  const best = (list: Candidate[]) => list.sort((a, b) => (KIND_RANK[a.kind] ?? 0) - (KIND_RANK[b.kind] ?? 0) || a.id - b.id)[0];
  const notSelf = (c: Candidate) => c.id !== e.fromSymbolId;
  return (
    best(cands.filter((c) => c.fileId === e.fromFileId && notSelf(c))) ??
    best(cands.filter((c) => imported?.has(c.fileId))) ??
    (cands.length === 1 ? cands[0] : undefined) ??
    best(cands.filter(notSelf))
  );
}

async function resolveSymbolEdges(db: Db, scope: GraphScope, fileMeta: FileMeta[], opts: ResolveOptions) {
  const imports = await importMap(db, scope);
  const csharpFiles = new Set(fileMeta.filter((f) => f.language === "csharp").map((f) => f.id));
  const retry =
    opts.affectedNames && opts.affectedNames.length > 0
      ? sql`(${edges.id} > ${opts.newEdgesAfterId} or ${edges.targetName} = any(${textArray(opts.affectedNames)}))`
      : gt(edges.id, opts.newEdgesAfterId);
  let cursor = 0;
  for (;;) {
    const batch = await db
      .select({ id: edges.id, kind: edges.kind, fromFileId: edges.fromFileId, fromSymbolId: edges.fromSymbolId, targetName: edges.targetName, toSymbolId: edges.toSymbolId })
      .from(edges)
      .where(and(eq(edges.orgId, scope.orgId), eq(edges.repoId, scope.repoId), gt(edges.id, cursor), inArray(edges.kind, SYMBOL_EDGE_KINDS), retry))
      .orderBy(edges.id)
      .limit(BATCH);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    const names = [...new Set(batch.map((e) => e.targetName))];
    const byName = new Map<string, Candidate[]>();
    for (const c of await db
      .select({ id: symbols.id, name: symbols.name, fileId: symbols.fileId, kind: symbols.kind })
      .from(symbols)
      .where(and(eq(symbols.orgId, scope.orgId), eq(symbols.repoId, scope.repoId), sql`${symbols.name} = any(${textArray(names)})`))) {
      const list = byName.get(c.name);
      if (list) list.push(c);
      else byName.set(c.name, [c]);
    }
    const heritageFrom = [...new Set(batch.filter((e) => (e.kind === "extends" || e.kind === "implements") && e.fromSymbolId !== null).map((e) => e.fromSymbolId!))];
    const fromKind = new Map<number, string>();
    if (heritageFrom.length) {
      for (const s of await db
        .select({ id: symbols.id, kind: symbols.kind })
        .from(symbols)
        .where(and(eq(symbols.orgId, scope.orgId), eq(symbols.repoId, scope.repoId), sql`${symbols.id} = any(${intArray(heritageFrom)})`))) {
        fromKind.set(s.id, s.kind);
      }
    }

    const updates: { id: number; toFileId: number | null; toSymbolId: number | null; kind: EdgeKind }[] = [];
    for (const e of batch) {
      const allowed = TARGET_KINDS[e.kind];
      const cands = (byName.get(e.targetName) ?? []).filter((c) => allowed?.has(c.kind));
      const target = pick(cands, e, imports.get(e.fromFileId));
      if (!target || target.id === e.toSymbolId) continue;
      let kind = e.kind;
      // C# base lists don't say which base is a class: fix the kind once the target is known.
      if (csharpFiles.has(e.fromFileId) && (kind === "extends" || kind === "implements") && e.fromSymbolId !== null) {
        const from = fromKind.get(e.fromSymbolId);
        if (from !== "interface" && (target.kind === "interface" || target.kind === "trait")) kind = "implements";
        else if (target.kind === "class") kind = "extends";
      }
      updates.push({ id: e.id, toFileId: target.fileId, toSymbolId: target.id, kind });
    }
    await writeUpdates(db, updates);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// tested_by

const FAMILY: Record<string, string> = {
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".mts": "js",
  ".cts": "js",
  ".py": "py",
  ".go": "go",
  ".java": "jvm",
  ".kt": "jvm",
  ".cs": "cs",
  ".rs": "rs",
  ".rb": "rb",
  ".php": "php",
};

function familyOf(p: string): string | undefined {
  return FAMILY[path.extname(p).toLowerCase()];
}

/** Subject stem a test file is named after (`cart.test.ts`, `test_cart.py`, `CartTest.java` → `cart`). */
export function testSubjectStem(testPath: string): string {
  let base = path.basename(testPath).replace(/\.[^.]+$/, "");
  base = base
    .replace(/\.(?:test|spec)$/i, "")
    .replace(/_(?:test|spec)$/i, "")
    .replace(/^test_/i, "")
    .replace(/(?:Tests?|IT)$/, "");
  return base.toLowerCase();
}

function sourceStem(p: string): string {
  return path.basename(p).replace(/\.d\.ts$/, "").replace(/\.[^.]+$/, "").toLowerCase();
}

function commonPrefix(a: string, b: string): number {
  const sa = a.split("/");
  const sb = b.split("/");
  let n = 0;
  while (n < sa.length && n < sb.length && sa[n] === sb[n]) n++;
  return n;
}

/** (source file, test file) pairs from imports by test files plus test/source naming conventions. */
export function testedByPairs(fileMeta: FileMeta[], imports: Map<number, Set<number>>): [number, number][] {
  const isTest = (f: FileMeta) => f.tags.includes("test");
  const isSource = (f: FileMeta) => !isTest(f) && f.tags.includes("source");
  const byId = new Map(fileMeta.map((f) => [f.id, f]));
  const sourcesByStem = new Map<string, FileMeta[]>();
  for (const f of fileMeta.filter(isSource)) {
    const stem = sourceStem(f.path);
    const list = sourcesByStem.get(stem);
    if (list) list.push(f);
    else sourcesByStem.set(stem, [f]);
  }
  const pairs = new Map<string, [number, number]>();
  const add = (source: number, test: number) => pairs.set(`${source}:${test}`, [source, test]);
  for (const t of fileMeta.filter(isTest)) {
    for (const target of imports.get(t.id) ?? []) {
      const s = byId.get(target);
      if (s && isSource(s)) add(s.id, t.id);
    }
    const family = familyOf(t.path);
    const stem = testSubjectStem(t.path);
    const cands = (sourcesByStem.get(stem) ?? []).filter((s) => familyOf(s.path) === family);
    if (cands.length === 0) continue;
    const scores = cands.map((s) => commonPrefix(path.dirname(s.path), path.dirname(t.path)));
    const top = Math.max(...scores);
    cands.forEach((s, i) => {
      if (scores[i] === top) add(s.id, t.id);
    });
  }
  return [...pairs.values()];
}

async function rebuildTestedBy(db: Db, scope: GraphScope, fileMeta: FileMeta[]) {
  await db.delete(edges).where(and(eq(edges.orgId, scope.orgId), eq(edges.repoId, scope.repoId), eq(edges.kind, "tested_by")));
  const pathOf = new Map(fileMeta.map((f) => [f.id, f.path]));
  const rows = testedByPairs(fileMeta, await importMap(db, scope)).map(([source, test]) => ({
    orgId: scope.orgId,
    repoId: scope.repoId,
    kind: "tested_by" as const,
    fromFileId: source,
    fromSymbolId: null,
    targetName: pathOf.get(test)!,
    toFileId: test,
    toSymbolId: null,
    line: 1,
  }));
  for (const b of chunked(rows, WRITE_BATCH)) await db.insert(edges).values(b);
}

// ---------------------------------------------------------------------------------------------------------------
// schema_consumer

/** Consumers kept per table/model, so very common names cannot explode the graph. */
const MAX_CONSUMERS = 200;

async function rebuildSchemaConsumers(db: Db, scope: GraphScope) {
  const { orgId, repoId } = scope;
  await db.delete(edges).where(and(eq(edges.orgId, orgId), eq(edges.repoId, repoId), eq(edges.kind, "schema_consumer")));
  // Symbols that reference or call a table/model (or the variable that declares a table).
  await db.execute(sql`
    insert into edges (org_id, repo_id, kind, from_file_id, from_symbol_id, target_name, to_file_id, to_symbol_id, line)
    select org_id, repo_id, 'schema_consumer', from_file_id, from_symbol_id, target_name, to_file_id, to_symbol_id, line from (
      select distinct on (t.id, e.from_file_id, e.from_symbol_id)
        t.org_id, t.repo_id, t.file_id as from_file_id, t.id as from_symbol_id, t.name as target_name,
        e.from_file_id as to_file_id, e.from_symbol_id as to_symbol_id, e.line,
        dense_rank() over (partition by t.id order by e.from_file_id, e.from_symbol_id) as rn
      from edges e
      join symbols t on (t.id = e.to_symbol_id or t.parent_id = e.to_symbol_id) and t.kind in ('table', 'model')
      where e.org_id = ${orgId} and e.repo_id = ${repoId} and t.repo_id = ${repoId}
        and e.kind in ('reference', 'call') and e.to_symbol_id is not null and e.from_file_id <> t.file_id
      order by t.id, e.from_file_id, e.from_symbol_id, e.line
    ) q where rn <= ${MAX_CONSUMERS}`);
  // Code (including SQL migrations) that names the table/model, via the full-text index.
  await db.execute(sql`
    insert into edges (org_id, repo_id, kind, from_file_id, from_symbol_id, target_name, to_file_id, to_symbol_id, line)
    select org_id, repo_id, 'schema_consumer', from_file_id, from_symbol_id, target_name, to_file_id, null, line from (
      select s.org_id, s.repo_id, s.file_id as from_file_id, s.id as from_symbol_id, s.name as target_name,
        c.file_id as to_file_id, min(c.start_line) as line,
        row_number() over (partition by s.id order by c.file_id) as rn
      from symbols s
      join file_chunks c on c.repo_id = s.repo_id and c.file_id <> s.file_id and c.kind = 'code'
        and c.tsv @@ phraseto_tsquery('simple', s.name)
      where s.org_id = ${orgId} and s.repo_id = ${repoId} and s.kind in ('table', 'model')
        and not exists (
          select 1 from edges x
          where x.repo_id = s.repo_id and x.kind = 'schema_consumer' and x.from_symbol_id = s.id and x.to_file_id = c.file_id
        )
      group by s.org_id, s.repo_id, s.file_id, s.id, s.name, c.file_id
    ) q where rn <= ${MAX_CONSUMERS}`);
}

/** Links stored edges to their targets and rebuilds derived relations. */
export async function resolveGraph(db: Db, scope: GraphScope, opts: ResolveOptions) {
  const fileMeta = await loadFiles(db, scope);
  await resolveFileEdges(db, scope, fileMeta, opts);
  await resolveSymbolEdges(db, scope, fileMeta, opts);
  if (opts.changed) {
    await rebuildTestedBy(db, scope, fileMeta);
    await rebuildSchemaConsumers(db, scope);
  }
}

/** Number of edges by kind for a repository. */
export async function edgeCounts(db: Db, scope: GraphScope): Promise<Record<string, number>> {
  const rows = rowsOf<{ kind: string; n: number | string }>(
    await db.execute(sql`select kind, count(*) as n from edges where org_id = ${scope.orgId} and repo_id = ${scope.repoId} group by kind`),
  );
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}
