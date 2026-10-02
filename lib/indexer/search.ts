import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { files, symbols } from "@/lib/db/schema";
import { toStoredEmbedding } from "@/lib/llm";

export interface SymbolHit {
  id: number;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  distance: number;
}

/** Nearest symbol chunks by cosine distance (pgvector `<=>`), scoped to one org's repo. */
export async function searchSymbols(
  db: Db,
  scope: { orgId: string; repoId: number },
  embedding: number[],
  limit = 10,
): Promise<SymbolHit[]> {
  const vec = `[${toStoredEmbedding(embedding).join(",")}]`;
  const distance = sql<number>`${symbols.embedding} <=> ${vec}::vector`;
  return db
    .select({
      id: symbols.id,
      name: symbols.name,
      kind: symbols.kind,
      path: files.path,
      startLine: symbols.startLine,
      endLine: symbols.endLine,
      content: symbols.content,
      distance,
    })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(and(eq(symbols.orgId, scope.orgId), eq(symbols.repoId, scope.repoId), isNotNull(symbols.embedding)))
    .orderBy(distance)
    .limit(limit);
}
