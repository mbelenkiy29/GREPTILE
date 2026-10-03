/**
 * "What went wrong recently" (R6.13): failed webhook deliveries, index jobs, and review runs of one org in a single
 * feed, newest first.
 */
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { indexJobs, repos, reviewRuns, webhookDeliveries } from "@/lib/db/schema";
import { MAX_PAGE_SIZE, pageWindow, toPage, type Page, type PageOptions } from "./paginate";
import { scoped } from "./tenant";

/** Deepest position the merged feed serves (each source is read up to here). */
export const MAX_FEED_DEPTH = 1_000;

export type FailureKind = "delivery" | "index" | "review";

export interface FailureItem {
  kind: FailureKind;
  /** Delivery id, index job id, or review run id. */
  id: string;
  at: Date;
  repoId: number | null;
  repoFullName: string | null;
  title: string;
  error: string | null;
  /** Dashboard page with the details. */
  href: string;
  /** Failed deliveries with a stored payload can be replayed. */
  replayable: boolean;
}

export interface FailureFilter extends PageOptions {
  kind?: FailureKind;
  repoId?: number;
}

/** Failures across deliveries, index jobs, and review runs, newest first, paginated. */
export async function listFailures(db: Db, orgId: string, filter: FailureFilter = {}): Promise<Page<FailureItem>> {
  const win = pageWindow(filter, 25);
  const depth = Math.min(win.offset + win.pageSize, MAX_FEED_DEPTH);
  const want = (k: FailureKind) => !filter.kind || filter.kind === k;
  const repo = filter.repoId;

  const deliveryWhere = scoped(
    webhookDeliveries,
    orgId,
    eq(webhookDeliveries.status, "failed"),
    repo !== undefined ? eq(webhookDeliveries.repoId, repo) : undefined,
  );
  const indexWhere = scoped(indexJobs, orgId, eq(indexJobs.status, "failed"), repo !== undefined ? eq(indexJobs.repoId, repo) : undefined);
  const runWhere = scoped(reviewRuns, orgId, eq(reviewRuns.status, "failed"), repo !== undefined ? eq(reviewRuns.repoId, repo) : undefined);

  const [deliveries, jobs, runs, totals] = await Promise.all([
    want("delivery")
      ? db
          .select({
            id: webhookDeliveries.deliveryId,
            event: webhookDeliveries.event,
            action: webhookDeliveries.action,
            repoId: webhookDeliveries.repoId,
            repoFullName: webhookDeliveries.repoFullName,
            error: webhookDeliveries.error,
            at: webhookDeliveries.receivedAt,
            replayable: sql<boolean>`(${webhookDeliveries.payload} is not null)`,
          })
          .from(webhookDeliveries)
          .where(deliveryWhere)
          .orderBy(desc(webhookDeliveries.receivedAt))
          .limit(depth)
      : [],
    want("index")
      ? db
          .select({
            id: indexJobs.id,
            kind: indexJobs.kind,
            repoId: indexJobs.repoId,
            repoFullName: repos.fullName,
            error: indexJobs.error,
            at: indexJobs.queuedAt,
            finishedAt: indexJobs.finishedAt,
          })
          .from(indexJobs)
          .innerJoin(repos, and(eq(repos.id, indexJobs.repoId), eq(repos.orgId, orgId)))
          .where(indexWhere)
          .orderBy(desc(sql`coalesce(${indexJobs.finishedAt}, ${indexJobs.queuedAt})`), desc(indexJobs.id))
          .limit(depth)
      : [],
    want("review")
      ? db
          .select({
            id: reviewRuns.id,
            reviewId: reviewRuns.reviewId,
            prNumber: reviewRuns.prNumber,
            repoId: reviewRuns.repoId,
            repoFullName: repos.fullName,
            error: reviewRuns.error,
            statusReason: reviewRuns.statusReason,
            at: reviewRuns.queuedAt,
            finishedAt: reviewRuns.finishedAt,
          })
          .from(reviewRuns)
          .innerJoin(repos, and(eq(repos.id, reviewRuns.repoId), eq(repos.orgId, orgId)))
          .where(runWhere)
          .orderBy(desc(sql`coalesce(${reviewRuns.finishedAt}, ${reviewRuns.queuedAt})`), desc(reviewRuns.id))
          .limit(depth)
      : [],
    Promise.all([
      want("delivery") ? db.select({ n: count() }).from(webhookDeliveries).where(deliveryWhere) : [{ n: 0 }],
      want("index") ? db.select({ n: count() }).from(indexJobs).where(indexWhere) : [{ n: 0 }],
      want("review") ? db.select({ n: count() }).from(reviewRuns).where(runWhere) : [{ n: 0 }],
    ]),
  ]);

  const items: FailureItem[] = [
    ...deliveries.map((d) => ({
      kind: "delivery" as const,
      id: d.id,
      at: d.at,
      repoId: d.repoId,
      repoFullName: d.repoFullName,
      title: `Webhook ${d.event}${d.action ? `.${d.action}` : ""}`,
      error: d.error,
      href: `/dashboard/activity/${encodeURIComponent(d.id)}`,
      replayable: Boolean(d.replayable),
    })),
    ...jobs.map((j) => ({
      kind: "index" as const,
      id: String(j.id),
      at: j.finishedAt ?? j.at,
      repoId: j.repoId,
      repoFullName: j.repoFullName,
      title: `${j.kind === "full" ? "Full" : "Incremental"} index #${j.id}`,
      error: j.error,
      href: `/dashboard/repos/${j.repoId}?tab=overview`,
      replayable: false,
    })),
    ...runs.map((r) => ({
      kind: "review" as const,
      id: String(r.id),
      at: r.finishedAt ?? r.at,
      repoId: r.repoId,
      repoFullName: r.repoFullName,
      title: `Review of #${r.prNumber} (run ${r.id})`,
      error: r.error ?? r.statusReason,
      href: `/dashboard/reviews/${r.reviewId}`,
      replayable: false,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || a.kind.localeCompare(b.kind) || b.id.localeCompare(a.id));

  const total = totals.reduce((n, [t]) => n + Number(t?.n ?? 0), 0);
  return toPage(items.slice(win.offset, win.offset + win.pageSize), Math.min(total, MAX_FEED_DEPTH), {
    page: win.page,
    pageSize: Math.min(win.pageSize, MAX_PAGE_SIZE),
  });
}
