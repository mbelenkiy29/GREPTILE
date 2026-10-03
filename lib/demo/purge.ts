/**
 * Demo retention (R3.7): demo reviews older than DEMO_RETENTION_HOURS are deleted, and so are demo repositories not
 * reviewed since (their index rows go with them through ON DELETE CASCADE) and their checkouts on disk. Runs hourly in
 * the worker.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { demoReviews, repos } from "@/lib/db/schema";
import { HOUR_MS } from "./limits";
import { DEMO_ORG_ID } from "./org";

export async function purgeDemoData(db: Db, opts: { retentionHours: number; cacheDir: string; now?: Date }): Promise<{ reviews: number; repos: number }> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.retentionHours * HOUR_MS);
  const deletedReviews = await db
    .delete(demoReviews)
    .where(and(eq(demoReviews.orgId, DEMO_ORG_ID), lt(demoReviews.createdAt, cutoff)))
    .returning({ id: demoReviews.id });
  // A repository still used by a remaining (newer) demo review stays.
  const deletedRepos = await db
    .delete(repos)
    .where(
      and(
        eq(repos.orgId, DEMO_ORG_ID),
        lt(repos.updatedAt, cutoff),
        sql`not exists (select 1 from ${demoReviews} where ${demoReviews.repoId} = ${repos.id} and ${demoReviews.orgId} = ${DEMO_ORG_ID})`,
      ),
    )
    .returning({ id: repos.id });
  for (const r of deletedRepos) await rm(path.join(opts.cacheDir, "demo", String(r.id)), { recursive: true, force: true });
  return { reviews: deletedReviews.length, repos: deletedRepos.length };
}
