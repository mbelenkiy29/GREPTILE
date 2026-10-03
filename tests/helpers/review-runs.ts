import type { Db } from "@/lib/db";
import { installations, orgs, repos, reviewRuns, reviews } from "@/lib/db/schema";

let externalIds = 9_000;

/**
 * Inserts `count` review runs (with the org, installation, repo, and PR review rows they need) so tests can attach
 * rows that reference `review_runs` (model calls, usage events). Returns the run ids.
 */
export async function seedReviewRuns(db: Db, orgId: string, count = 1): Promise<number[]> {
  await db.insert(orgs).values({ id: orgId, name: orgId }).onConflictDoNothing();
  const externalId = ++externalIds;
  const [installation] = await db.insert(installations).values({ orgId, externalId, accountLogin: `acct-${externalId}` }).returning();
  const [repo] = await db
    .insert(repos)
    .values({ orgId, installationId: installation!.id, externalId, fullName: `acct-${externalId}/repo` })
    .returning();
  const [review] = await db.insert(reviews).values({ orgId, repoId: repo!.id, prNumber: 1, headSha: "head" }).returning();
  const rows = await db
    .insert(reviewRuns)
    .values(Array.from({ length: count }, () => ({ orgId, repoId: repo!.id, reviewId: review!.id, prNumber: 1, trigger: "manual" as const })))
    .returning({ id: reviewRuns.id });
  return rows.map((r) => r.id);
}
