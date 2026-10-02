import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { edges, files, installations, repos, symbols } from "@/lib/db/schema";
import type { GitHost } from "@/lib/git/types";
import { toStoredEmbedding, type EmbeddingProvider } from "@/lib/llm";
import { checkout, listFiles } from "./git";
import { languageForPath } from "./languages";
import { parseSource } from "./parser";
import { resolveImport } from "./resolve";

export interface IndexDeps {
  db: Db;
  host: GitHost;
  embedder: EmbeddingProvider;
  cacheDir: string;
}

export interface IndexResult {
  sha: string;
  filesParsed: number;
  filesRemoved: number;
  filesUnchanged: number;
  symbols: number;
  edges: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.next|__pycache__)\//;
const CHUNK = 500;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function hash(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export function isIndexable(p: string) {
  return !SKIP_DIRS.test(p) && !/\.min\.(js|css)$/.test(p) && languageForPath(p) !== undefined;
}

/**
 * Repo indexer (R1.3). Checks out the default branch (or `afterSha`), parses
 * every supported file with tree-sitter into files → symbols → call/import
 * edges, and embeds symbol chunks into pgvector. Re-runs are incremental:
 * only files whose content hash changed are re-parsed and re-embedded; removed
 * files are dropped; edges are then re-resolved across the whole repo.
 */
export async function indexRepo(
  deps: IndexDeps,
  job: { orgId: string; repoId: number; afterSha?: string },
): Promise<IndexResult> {
  const { db } = deps;
  const [row] = await db
    .select({ repo: repos, installation: installations })
    .from(repos)
    .innerJoin(installations, eq(repos.installationId, installations.id))
    .where(and(eq(repos.orgId, job.orgId), eq(repos.id, job.repoId)));
  if (!row) throw new Error(`repo ${job.repoId} not found for org ${job.orgId}`);
  const { repo } = row;

  await db.update(repos).set({ indexStatus: "indexing", indexError: null }).where(eq(repos.id, repo.id));
  try {
    const dir = path.join(deps.cacheDir, String(repo.id));
    const client = deps.host.client(row.installation.externalId);
    const sha = await checkout(await client.cloneUrl(repo.fullName), dir, job.afterSha ?? repo.defaultBranch);
    const result = await indexCheckout(deps, { orgId: repo.orgId, repoId: repo.id, dir });
    await db
      .update(repos)
      .set({
        indexStatus: "ready",
        indexedSha: sha,
        indexedAt: new Date(),
        fileCount: result.fileCount,
        symbolCount: result.symbols,
      })
      .where(eq(repos.id, repo.id));
    return { sha, ...result };
  } catch (err) {
    await db
      .update(repos)
      .set({ indexStatus: "failed", indexError: err instanceof Error ? err.message.slice(0, 2000) : String(err) })
      .where(eq(repos.id, repo.id));
    throw err;
  }
}

async function indexCheckout(deps: IndexDeps, ctx: { orgId: string; repoId: number; dir: string }) {
  const { db } = deps;
  const { orgId, repoId } = ctx;

  const current = new Map<string, string>();
  for (const p of (await listFiles(ctx.dir)).filter(isIndexable)) {
    const abs = path.join(ctx.dir, p);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > MAX_FILE_BYTES) continue;
    const text = await readFile(abs, "utf8");
    if (text.includes("\0")) continue;
    current.set(p, text);
  }

  const existing = await db
    .select({ id: files.id, path: files.path, contentHash: files.contentHash })
    .from(files)
    .where(eq(files.repoId, repoId));
  const existingByPath = new Map(existing.map((f) => [f.path, f]));

  const changed = [...current.entries()].filter(([p, text]) => existingByPath.get(p)?.contentHash !== hash(text));
  const removed = existing.filter((f) => !current.has(f.path) || changed.some(([p]) => p === f.path));
  for (const ids of chunks(removed.map((f) => f.id))) await db.delete(files).where(inArray(files.id, ids));

  // Parse and insert changed files with their symbols and unresolved edges.
  const newSymbols: { id: number; text: string }[] = [];
  for (const [p, text] of changed) {
    const parsed = await parseSource(p, text);
    if (!parsed) continue;
    const [file] = await db
      .insert(files)
      .values({ orgId, repoId, path: p, language: parsed.language, contentHash: hash(text) })
      .returning({ id: files.id });
    const symbolIds: number[] = [];
    for (const batch of chunks(parsed.symbols)) {
      const rows = await db
        .insert(symbols)
        .values(batch.map((s) => ({ orgId, repoId, fileId: file!.id, ...s })))
        .returning({ id: symbols.id });
      symbolIds.push(...rows.map((r) => r.id));
    }
    parsed.symbols.forEach((s, i) =>
      newSymbols.push({ id: symbolIds[i]!, text: `${p}\n${s.kind} ${s.name}\n${s.content}` }),
    );
    const edgeRows = [
      ...parsed.calls.map((c) => ({
        orgId,
        repoId,
        kind: "call" as const,
        fromFileId: file!.id,
        fromSymbolId: c.from === null ? null : symbolIds[c.from]!,
        targetName: c.name,
        line: c.line,
      })),
      ...parsed.imports.map((i) => ({
        orgId,
        repoId,
        kind: "import" as const,
        fromFileId: file!.id,
        fromSymbolId: null,
        targetName: i.target,
        line: i.line,
      })),
    ];
    for (const batch of chunks(edgeRows)) await db.insert(edges).values(batch);
  }

  // Embed only symbols that are new in this run.
  for (const batch of chunks(newSymbols, 64)) {
    const vectors = await deps.embedder.embed(batch.map((s) => s.text));
    const values = batch.map((s, i) => sql`(${s.id}::int, ${`[${toStoredEmbedding(vectors[i]!).join(",")}]`}::vector)`);
    await db.execute(
      sql`update symbols set embedding = v.e from (values ${sql.join(values, sql`, `)}) as v(id, e) where symbols.id = v.id`,
    );
  }

  const graph = await resolveEdges(db, repoId);
  return {
    filesParsed: changed.length,
    filesRemoved: removed.length - changed.filter(([p]) => existingByPath.has(p)).length,
    filesUnchanged: current.size - changed.length,
    fileCount: current.size,
    ...graph,
  };
}

/** Re-resolves every edge in the repo against the current files and symbols. */
export async function resolveEdges(db: Db, repoId: number) {
  const fileRows = await db.select({ id: files.id, path: files.path, language: files.language }).from(files).where(eq(files.repoId, repoId));
  const fileById = new Map(fileRows.map((f) => [f.id, f]));
  const idByPath = new Map(fileRows.map((f) => [f.path, f.id]));
  const paths = new Set(idByPath.keys());
  const symbolRows = await db.select({ id: symbols.id, name: symbols.name, fileId: symbols.fileId }).from(symbols).where(eq(symbols.repoId, repoId));
  const byName = new Map<string, { id: number; fileId: number }[]>();
  for (const s of symbolRows) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);

  const edgeRows = await db.select().from(edges).where(eq(edges.repoId, repoId));
  const importsOf = new Map<number, Set<number>>();
  const importUpdates: { id: number; toFileId: number | null }[] = [];
  const extraImports: (typeof edges.$inferInsert)[] = [];

  for (const e of edgeRows.filter((x) => x.kind === "import")) {
    const from = fileById.get(e.fromFileId)!;
    const targets = resolveImport(from.language as never, from.path, e.targetName, paths).map((p) => idByPath.get(p)!);
    const set = importsOf.get(e.fromFileId) ?? new Set<number>();
    targets.forEach((t) => set.add(t));
    importsOf.set(e.fromFileId, set);
    importUpdates.push({ id: e.id, toFileId: targets[0] ?? null });
    // A Go/C# import can resolve to several files of one package; record one edge per extra file.
    for (const t of targets.slice(1)) {
      if (!edgeRows.some((x) => x.kind === "import" && x.fromFileId === e.fromFileId && x.toFileId === t)) {
        extraImports.push({ ...e, id: undefined, toFileId: t });
      }
    }
  }

  const callUpdates: { id: number; toSymbolId: number | null; toFileId: number | null }[] = [];
  for (const e of edgeRows.filter((x) => x.kind === "call")) {
    const candidates = byName.get(e.targetName) ?? [];
    const imported = importsOf.get(e.fromFileId);
    const pick =
      candidates.find((c) => c.fileId === e.fromFileId && c.id !== e.fromSymbolId) ??
      candidates.find((c) => imported?.has(c.fileId)) ??
      (candidates.length === 1 ? candidates[0] : undefined) ??
      candidates.find((c) => c.id !== e.fromSymbolId);
    callUpdates.push({ id: e.id, toSymbolId: pick?.id ?? null, toFileId: pick?.fileId ?? null });
  }

  const updates = [
    ...importUpdates.map((u) => ({ id: u.id, toFileId: u.toFileId, toSymbolId: null })),
    ...callUpdates,
  ];
  for (const batch of chunks(updates)) {
    const values = batch.map((u) => sql`(${u.id}::int, ${u.toFileId}::int, ${u.toSymbolId}::int)`);
    await db.execute(
      sql`update edges set to_file_id = v.f, to_symbol_id = v.s
          from (values ${sql.join(values, sql`, `)}) as v(id, f, s) where edges.id = v.id`,
    );
  }
  for (const batch of chunks(extraImports)) await db.insert(edges).values(batch);
  return { symbols: symbolRows.length, edges: edgeRows.length + extraImports.length };
}
