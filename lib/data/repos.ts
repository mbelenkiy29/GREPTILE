/** Repository list and detail data for the dashboard (R6.13): index state, review mode, findings, last review. */
import { and, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { resolveEffectiveSettings, type SettingSource } from "@/lib/config/settings";
import type { Db } from "@/lib/db";
import { findings, installations, orgs, repos, reviews } from "@/lib/db/schema";
import { escapeLike } from "@/lib/indexer/sql";
import { activeIndexJobs, type RepoIndexState } from "./overview";
import { pageWindow, toPage, type Page, type PageOptions } from "./paginate";
import { scoped } from "./tenant";

export interface RepoListItem {
  id: number;
  fullName: string;
  /** GitHub account (user or organization) the installation belongs to. */
  accountLogin: string;
  accountType: string | null;
  installationId: number;
  defaultBranch: string;
  private: boolean;
  enabled: boolean;
  archived: boolean;
  indexStatus: string;
  indexError: string | null;
  indexedSha: string | null;
  indexedAt: Date | null;
  fileCount: number;
  symbolCount: number;
  /** The queued or running index job and its progress. */
  indexJob: RepoIndexState["job"];
  /** Effective review mode (org ← repo dashboard settings) and where it came from. */
  reviewMode: string;
  reviewModeSource: SettingSource;
  openFindings: number;
  lastReview: { id: number; prNumber: number; status: string; updatedAt: Date } | null;
}

export interface RepoListFilter extends PageOptions {
  /** Case-insensitive substring of the repository's full name. */
  q?: string;
}

/** The org's repositories with index, review, and findings state, alphabetically, paginated. */
export async function listRepoOverview(db: Db, orgId: string, filter: RepoListFilter = {}): Promise<Page<RepoListItem>> {
  const win = pageWindow(filter, 25);
  const q = filter.q?.trim();
  const where = scoped(repos, orgId, q ? ilike(repos.fullName, `%${escapeLike(q)}%`) : undefined);
  const [rows, [total], [org]] = await Promise.all([
    db
      .select({ repo: repos, accountLogin: installations.accountLogin, accountType: installations.accountType })
      .from(repos)
      .innerJoin(installations, and(eq(installations.id, repos.installationId), eq(installations.orgId, orgId)))
      .where(where)
      .orderBy(repos.fullName, repos.id)
      .limit(win.pageSize)
      .offset(win.offset),
    db.select({ n: count() }).from(repos).where(where),
    db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId)),
  ]);
  const ids = rows.map((r) => r.repo.id);
  const [jobs, open, last] = await Promise.all([activeIndexJobs(db, orgId, ids), openFindingsByRepo(db, orgId, ids), lastReviewByRepo(db, orgId, ids)]);
  const items = rows.map(({ repo, accountLogin, accountType }) => {
    const { settings, sources } = resolveEffectiveSettings(org?.settings, repo.settings, undefined);
    return {
      id: repo.id,
      fullName: repo.fullName,
      accountLogin,
      accountType,
      installationId: repo.installationId,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      enabled: repo.enabled,
      archived: repo.archived,
      indexStatus: repo.indexStatus,
      indexError: repo.indexError,
      indexedSha: repo.indexedSha,
      indexedAt: repo.indexedAt,
      fileCount: repo.fileCount,
      symbolCount: repo.symbolCount,
      indexJob: jobs.get(repo.id) ?? null,
      reviewMode: settings.mode,
      reviewModeSource: sources.mode,
      openFindings: open.get(repo.id) ?? 0,
      lastReview: last.get(repo.id) ?? null,
    };
  });
  return toPage(items, Number(total?.n ?? 0), win);
}

async function openFindingsByRepo(db: Db, orgId: string, repoIds: number[]): Promise<Map<number, number>> {
  if (!repoIds.length) return new Map();
  const rows = await db
    .select({ repoId: findings.repoId, n: count() })
    .from(findings)
    .where(scoped(findings, orgId, inArray(findings.repoId, repoIds), eq(findings.visibility, "published"), eq(findings.status, "open")))
    .groupBy(findings.repoId);
  return new Map(rows.map((r) => [r.repoId, Number(r.n)]));
}

async function lastReviewByRepo(db: Db, orgId: string, repoIds: number[]) {
  const out = new Map<number, NonNullable<RepoListItem["lastReview"]>>();
  if (!repoIds.length) return out;
  const rows = await db
    .selectDistinctOn([reviews.repoId], { repoId: reviews.repoId, id: reviews.id, prNumber: reviews.prNumber, status: reviews.status, updatedAt: reviews.updatedAt })
    .from(reviews)
    .where(scoped(reviews, orgId, inArray(reviews.repoId, repoIds)))
    .orderBy(reviews.repoId, desc(reviews.updatedAt), desc(reviews.id));
  for (const r of rows) out.set(r.repoId, { id: r.id, prNumber: r.prNumber, status: r.status, updatedAt: r.updatedAt });
  return out;
}

export interface RepoDetail {
  repo: typeof repos.$inferSelect;
  installation: { id: number; accountLogin: string; accountType: string | null; suspended: boolean; missingPermissions: string[] };
  reviewMode: string;
  stats: { reviews: number; openFindings: number; resolvedFindings: number };
}

/** One of the org's repositories with its installation's health and headline stats, or undefined. */
export async function getRepoDetail(db: Db, orgId: string, repoId: number): Promise<RepoDetail | undefined> {
  if (!Number.isSafeInteger(repoId)) return undefined;
  const [row] = await db
    .select({ repo: repos, installation: installations, orgSettings: orgs.settings })
    .from(repos)
    .innerJoin(installations, and(eq(installations.id, repos.installationId), eq(installations.orgId, orgId)))
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .where(scoped(repos, orgId, eq(repos.id, repoId)));
  if (!row) return undefined;
  const [[reviewCount], findingRows] = await Promise.all([
    db.select({ n: count() }).from(reviews).where(scoped(reviews, orgId, eq(reviews.repoId, repoId))),
    db
      .select({ status: findings.status, n: count() })
      .from(findings)
      .where(scoped(findings, orgId, eq(findings.repoId, repoId), eq(findings.visibility, "published")))
      .groupBy(findings.status),
  ]);
  const by = (s: string) => Number(findingRows.find((r) => r.status === s)?.n ?? 0);
  const { settings } = resolveEffectiveSettings(row.orgSettings, row.repo.settings, undefined);
  return {
    repo: row.repo,
    installation: {
      id: row.installation.id,
      accountLogin: row.installation.accountLogin,
      accountType: row.installation.accountType,
      suspended: row.installation.suspended,
      missingPermissions: row.installation.missingPermissions,
    },
    reviewMode: settings.mode,
    stats: { reviews: Number(reviewCount?.n ?? 0), openFindings: by("open"), resolvedFindings: by("resolved") },
  };
}

/** Repository options (id + name) for filter menus, alphabetically. */
export async function repoOptions(db: Db, orgId: string): Promise<{ id: number; fullName: string }[]> {
  return db
    .select({ id: repos.id, fullName: repos.fullName })
    .from(repos)
    .where(scoped(repos, orgId))
    .orderBy(repos.fullName)
    .limit(500);
}

/** Installations of the org that lack required permissions or are suspended (for health banners). */
export async function unhealthyInstallations(db: Db, orgId: string) {
  return db
    .select({
      id: installations.id,
      accountLogin: installations.accountLogin,
      suspended: installations.suspended,
      missingPermissions: installations.missingPermissions,
    })
    .from(installations)
    .where(scoped(installations, orgId, sql`(${installations.suspended} or cardinality(${installations.missingPermissions}) > 0)`))
    .orderBy(installations.accountLogin);
}
