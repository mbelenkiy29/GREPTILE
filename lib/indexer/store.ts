/** Writes one analyzed file (R6.3) and embeds pending symbols and doc chunks. */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { edges, fileChunks, files, repoDependencies, symbols } from "@/lib/db/schema";
import { toStoredEmbedding, type EmbeddingProvider } from "@/lib/llm";
import type { FileAnalysis } from "./analyze";
import { chunked } from "./sql";

export interface StoreScope {
  orgId: string;
  repoId: number;
}

/**
 * Replaces a file's rows (file, symbols, edges, chunks, dependencies) in one transaction: the old file row is deleted
 * (cascading to everything hanging off it) and the new analysis inserted.
 */
export async function writeFile(
  db: Db,
  scope: StoreScope,
  file: { path: string; contentHash: string; sizeBytes: number; existingId: number | null },
  analysis: FileAnalysis,
): Promise<number> {
  const { orgId, repoId } = scope;
  return db.transaction(async (tx) => {
    if (file.existingId !== null) await tx.delete(files).where(and(eq(files.orgId, orgId), eq(files.repoId, repoId), eq(files.id, file.existingId)));
    const [row] = await tx
      .insert(files)
      .values({
        orgId,
        repoId,
        path: file.path,
        language: analysis.language,
        contentHash: file.contentHash,
        tags: analysis.tags,
        sizeBytes: file.sizeBytes,
        lineCount: analysis.lineCount,
      })
      .returning({ id: files.id });
    const fileId = row!.id;

    const ids: number[] = [];
    for (const batch of chunked(analysis.symbols, 500)) {
      const inserted = await tx
        .insert(symbols)
        .values(
          batch.map((s) => ({
            orgId,
            repoId,
            fileId,
            name: s.name,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            content: s.content,
            signature: s.signature,
            qualifiedName: s.qualifiedName,
            exported: s.exported,
          })),
        )
        .returning({ id: symbols.id });
      ids.push(...inserted.map((r) => r.id));
    }
    const parents = analysis.symbols.flatMap((s, i) => (s.parent === null ? [] : [[ids[i]!, ids[s.parent]!] as const]));
    for (const batch of chunked(parents, 500)) {
      const values = batch.map(([id, parent]) => sql`(${id}::int, ${parent}::int)`);
      await tx.execute(sql`update symbols set parent_id = v.p from (values ${sql.join(values, sql`, `)}) as v(id, p) where symbols.id = v.id`);
    }

    const edgeRows = analysis.edges.map((e) => ({
      orgId,
      repoId,
      kind: e.kind,
      fromFileId: fileId,
      fromSymbolId: e.from === null ? null : ids[e.from]!,
      targetName: e.target,
      line: e.line,
    }));
    for (const batch of chunked(edgeRows, 1000)) await tx.insert(edges).values(batch);

    for (const batch of chunked(analysis.chunks, 100)) {
      await tx.insert(fileChunks).values(
        batch.map((c) => ({ orgId, repoId, fileId, path: file.path, startLine: c.startLine, endLine: c.endLine, kind: c.kind, content: c.content })),
      );
    }

    for (const batch of chunked(analysis.dependencies, 500)) {
      await tx
        .insert(repoDependencies)
        .values(batch.map((d) => ({ orgId, repoId, fileId, manifestPath: file.path, ecosystem: d.ecosystem, name: d.name, versionSpec: d.versionSpec, kind: d.kind })))
        .onConflictDoNothing();
    }
    return fileId;
  });
}

const EMBED_BATCH = 64;

async function storeVectors(db: Db, table: "symbols" | "file_chunks", ids: number[], vectors: number[][]) {
  if (vectors.length !== ids.length) throw new Error(`embedding provider returned ${vectors.length} vectors for ${ids.length} inputs`);
  const values = ids.map((id, i) => sql`(${id}::int, ${`[${toStoredEmbedding(vectors[i]!).join(",")}]`}::vector)`);
  await db.execute(sql`update ${sql.identifier(table)} set embedding = v.e from (values ${sql.join(values, sql`, `)}) as v(id, e) where ${sql.identifier(table)}.id = v.id`);
}

/**
 * Embeds every symbol and doc chunk of the repository that has no embedding yet (new rows from this run, or rows a
 * failed run left behind), in batches, without holding more than one batch in memory.
 */
export async function embedPending(db: Db, embedder: EmbeddingProvider, scope: StoreScope, onBatch?: (n: number) => Promise<void>) {
  let embedded = 0;
  for (let cursor = 0; ; ) {
    const rows = await db
      .select({ id: symbols.id, name: symbols.name, kind: symbols.kind, content: symbols.content, path: files.path })
      .from(symbols)
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(symbols.orgId, scope.orgId), eq(symbols.repoId, scope.repoId), isNull(symbols.embedding), gt(symbols.id, cursor)))
      .orderBy(symbols.id)
      .limit(EMBED_BATCH);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const vectors = await embedder.embed(rows.map((s) => `${s.path}\n${s.kind} ${s.name}\n${s.content}`));
    await storeVectors(db, "symbols", rows.map((r) => r.id), vectors);
    embedded += rows.length;
    await onBatch?.(embedded);
  }
  for (let cursor = 0; ; ) {
    const rows = await db
      .select({ id: fileChunks.id, path: fileChunks.path, content: fileChunks.content })
      .from(fileChunks)
      .where(
        and(
          eq(fileChunks.orgId, scope.orgId),
          eq(fileChunks.repoId, scope.repoId),
          eq(fileChunks.kind, "doc"),
          isNull(fileChunks.embedding),
          gt(fileChunks.id, cursor),
        ),
      )
      .orderBy(fileChunks.id)
      .limit(EMBED_BATCH);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const vectors = await embedder.embed(rows.map((c) => `${c.path}\n${c.content}`));
    await storeVectors(db, "file_chunks", rows.map((r) => r.id), vectors);
    embedded += rows.length;
    await onBatch?.(embedded);
  }
  return embedded;
}
