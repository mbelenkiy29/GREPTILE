/** Knowledge entries for the files a review or question touches (R6.12); a leaf module so retrieval can import it. */
import { desc, eq, ne, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { knowledgeEntries, type KnowledgeKind, type KnowledgeRisk } from "@/lib/db/schema";
import { textArray } from "@/lib/indexer/sql";

export interface KnowledgeForPath {
  id: number;
  slug: string;
  title: string;
  kind: KnowledgeKind;
  description: string;
  conventions: string[];
  risks: KnowledgeRisk[];
  stale: boolean;
  lastCommitSha: string | null;
  /** The requested paths that belong to the entry's subsystem. */
  matchedPaths: string[];
}

/**
 * Generated knowledge entries whose subsystem contains any of `paths`, most overlapping first (R6.12). Entries not
 * generated yet (empty description) are skipped. Tenant-scoped: entries of another org never match.
 */
export async function knowledgeForPaths(db: Db, orgId: string, repoId: number, paths: readonly string[], opts: { limit?: number } = {}): Promise<KnowledgeForPath[]> {
  const unique = [...new Set(paths)].slice(0, 500);
  if (!unique.length) return [];
  const list = textArray(unique);
  const overlap = sql<number>`cardinality(array(select unnest(${knowledgeEntries.relatedFiles}) intersect select unnest(${list})))`.mapWith(Number);
  const rows = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      title: knowledgeEntries.title,
      kind: knowledgeEntries.kind,
      description: knowledgeEntries.description,
      conventions: knowledgeEntries.conventions,
      risks: knowledgeEntries.risks,
      stale: knowledgeEntries.stale,
      lastCommitSha: knowledgeEntries.lastCommitSha,
      relatedFiles: knowledgeEntries.relatedFiles,
      overlap,
    })
    .from(knowledgeEntries)
    .where(scoped(knowledgeEntries, orgId, eq(knowledgeEntries.repoId, repoId), ne(knowledgeEntries.description, ""), sql`${knowledgeEntries.relatedFiles} && ${list}`))
    // The architecture overview spans the repository: specific subsystems come first on equal overlap.
    .orderBy(desc(overlap), sql`${knowledgeEntries.kind} = 'architecture'`, knowledgeEntries.rank, knowledgeEntries.id)
    .limit(Math.min(10, Math.max(1, opts.limit ?? 3)));
  const wanted = new Set(unique);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    description: r.description,
    conventions: r.conventions,
    risks: r.risks,
    stale: r.stale,
    lastCommitSha: r.lastCommitSha,
    matchedPaths: r.relatedFiles.filter((p) => wanted.has(p)),
  }));
}
