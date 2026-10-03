/**
 * Knowledge base data for the dashboard (R6.12, R6.13): repository picker, paginated entry lists, entry detail, the
 * latest refresh run, and the edits people make (description, accept / reject a proposed regeneration). Every
 * function is tenant-scoped: entries, runs, and repositories of another org never match.
 */
import { asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { knowledgeEntries, knowledgeRuns, repos } from "@/lib/db/schema";
import { knowledgeEnv } from "@/lib/env";
import { MAX_DESCRIPTION_WORDS } from "@/lib/knowledge/generate";
import type { KnowledgeEntry, KnowledgeRun } from "@/lib/knowledge/refresh";
import { redactSecrets } from "@/lib/security/secret-scan";
import { pageWindow, toPage, type Page, type PageOptions } from "./paginate";
import { scoped } from "./tenant";

export type { KnowledgeEntry, KnowledgeRun };

export interface KnowledgeRepo {
  id: number;
  fullName: string;
  indexStatus: string;
  indexedSha: string | null;
  entries: number;
  stale: number;
}

/** Repositories of the org with their entry counts, for the repository picker (at most 200, by name). */
export async function listKnowledgeRepos(db: Db, orgId: string): Promise<KnowledgeRepo[]> {
  const counts = db
    .select({
      repoId: knowledgeEntries.repoId,
      entries: sql<number>`count(*)`.as("entries"),
      stale: sql<number>`count(*) filter (where ${knowledgeEntries.stale})`.as("stale"),
    })
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.orgId, orgId))
    .groupBy(knowledgeEntries.repoId)
    .as("k");
  const rows = await db
    .select({
      id: repos.id,
      fullName: repos.fullName,
      indexStatus: repos.indexStatus,
      indexedSha: repos.indexedSha,
      entries: sql<number>`coalesce(${counts.entries}, 0)`.mapWith(Number),
      stale: sql<number>`coalesce(${counts.stale}, 0)`.mapWith(Number),
    })
    .from(repos)
    .leftJoin(counts, eq(counts.repoId, repos.id))
    .where(scoped(repos, orgId))
    .orderBy(asc(repos.fullName), asc(repos.id))
    .limit(200);
  return rows;
}

export type KnowledgeListItem = Pick<
  KnowledgeEntry,
  "id" | "slug" | "title" | "kind" | "stale" | "source" | "lastCommitSha" | "lastUpdatedAt" | "lastError" | "rank"
> & { summary: string; fileCount: number; risks: number; hasProposal: boolean };

/** The first paragraph of an entry's Markdown, as plain text (for cards). */
export function summaryOf(markdown: string, max = 220): string {
  const para = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```"));
  const text = (para ?? "").replace(/[*_`>#]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Entries of one repository, by discovery rank (most significant subsystem first). */
export async function listKnowledgeEntries(db: Db, orgId: string, repoId: number, opts: PageOptions = {}): Promise<Page<KnowledgeListItem>> {
  const win = pageWindow(opts, 24);
  const where = scoped(knowledgeEntries, orgId, eq(knowledgeEntries.repoId, repoId));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(knowledgeEntries)
      .where(where)
      .orderBy(asc(knowledgeEntries.rank), asc(knowledgeEntries.id))
      .limit(win.pageSize)
      .offset(win.offset),
    db.select({ n: count() }).from(knowledgeEntries).where(where),
  ]);
  const items = rows.map((e) => ({
    id: e.id,
    slug: e.slug,
    title: e.title,
    kind: e.kind,
    stale: e.stale,
    source: e.source,
    lastCommitSha: e.lastCommitSha,
    lastUpdatedAt: e.lastUpdatedAt,
    lastError: e.lastError,
    rank: e.rank,
    summary: summaryOf(e.description),
    fileCount: e.facts.fileCount || e.relatedFiles.length,
    risks: e.risks.length,
    hasProposal: e.proposedDescription !== null,
  }));
  return toPage(items, total?.n ?? 0, win);
}

export interface KnowledgeEntryDetail {
  entry: KnowledgeEntry;
  repo: { id: number; fullName: string; indexedSha: string | null; defaultBranch: string };
}

/** One entry with its repository, or null when it does not belong to the org. */
export async function getKnowledgeEntry(db: Db, orgId: string, id: number): Promise<KnowledgeEntryDetail | null> {
  const [row] = await db
    .select({ entry: knowledgeEntries, repo: { id: repos.id, fullName: repos.fullName, indexedSha: repos.indexedSha, defaultBranch: repos.defaultBranch } })
    .from(knowledgeEntries)
    .innerJoin(repos, eq(repos.id, knowledgeEntries.repoId))
    .where(scoped(knowledgeEntries, orgId, eq(knowledgeEntries.id, id), eq(repos.orgId, orgId)));
  return row ?? null;
}

/** The latest refresh run of a repository, and the latest one that finished. */
export async function latestKnowledgeRuns(db: Db, orgId: string, repoId: number): Promise<{ latest: KnowledgeRun | null; lastFinished: KnowledgeRun | null }> {
  const where = scoped(knowledgeRuns, orgId, eq(knowledgeRuns.repoId, repoId));
  const [[latest], [lastFinished]] = await Promise.all([
    db.select().from(knowledgeRuns).where(where).orderBy(desc(knowledgeRuns.id)).limit(1),
    db
      .select()
      .from(knowledgeRuns)
      .where(scoped(knowledgeRuns, orgId, eq(knowledgeRuns.repoId, repoId), isNotNull(knowledgeRuns.finishedAt)))
      .orderBy(desc(knowledgeRuns.id))
      .limit(1),
  ]);
  return { latest: latest ?? null, lastFinished: lastFinished ?? null };
}

/** Whether the knowledge base is turned on for this deployment (KNOWLEDGE_ENABLED). */
export function knowledgeEnabled(source: Record<string, string | undefined> = process.env): boolean {
  return knowledgeEnv(source).KNOWLEDGE_ENABLED;
}

export class KnowledgeEditError extends Error {}

const MAX_DESCRIPTION_CHARS = 20_000;

/** A person's description: Markdown, non-empty, at most ~1,500 words. */
export const descriptionSchema = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1, "The description can't be empty.")
      .max(MAX_DESCRIPTION_CHARS, `Keep the description under ${MAX_DESCRIPTION_CHARS.toLocaleString("en-US")} characters.`)
      .refine((s) => s.split(/\s+/).filter(Boolean).length <= MAX_DESCRIPTION_WORDS, `Keep the description under ${MAX_DESCRIPTION_WORDS.toLocaleString("en-US")} words.`),
  );

/**
 * Replaces an entry's description with a person's text and marks it `edited`: later regenerations store a proposal
 * instead of overwriting it. Secrets are redacted before storage (knowledge is shown to reviewers and the model).
 */
export async function editKnowledgeDescription(db: Db, orgId: string, input: { id: number; description: unknown; userId: string | null; now?: Date }) {
  const parsed = descriptionSchema.safeParse(input.description);
  if (!parsed.success) throw new KnowledgeEditError(parsed.error.issues[0]?.message ?? "Invalid description.");
  const [row] = await db
    .update(knowledgeEntries)
    .set({ description: redactSecrets(parsed.data), source: "edited", editedBy: input.userId, editedAt: input.now ?? new Date() })
    .where(scoped(knowledgeEntries, orgId, eq(knowledgeEntries.id, input.id)))
    .returning();
  return row ?? null;
}

/**
 * Accepts or rejects a regenerated description waiting on an edited entry. Accepting replaces the text with the
 * proposal and hands the entry back to automatic regeneration; rejecting keeps the person's text.
 */
export async function resolveKnowledgeProposal(db: Db, orgId: string, input: { id: number; accept: boolean }) {
  const where = scoped(knowledgeEntries, orgId, eq(knowledgeEntries.id, input.id), isNotNull(knowledgeEntries.proposedDescription));
  const [row] = input.accept
    ? await db
        .update(knowledgeEntries)
        .set({ description: sql`${knowledgeEntries.proposedDescription}`, source: "generated", proposedDescription: null, proposedAt: null })
        .where(where)
        .returning()
    : await db.update(knowledgeEntries).set({ proposedDescription: null, proposedAt: null }).where(where).returning();
  return row ?? null;
}
