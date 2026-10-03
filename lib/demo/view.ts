/** What the public demo result page (`/try/[id]`, R3.7) may show: never the client key or the proof-of-work nonce. */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { demoReviews, type DemoResultData } from "@/lib/db/schema";
import { DEMO_ORG_ID } from "./org";
import { prUrl } from "./url";

/** Demo ids are 16 random bytes, base64url. */
export const DEMO_ID = /^[A-Za-z0-9_-]{22}$/;

export interface DemoReviewView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "rejected";
  pr: { owner: string; repo: string; number: number; url: string; title: string | null; author: string | null; headSha: string | null };
  reason: string | null;
  result: DemoResultData | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export async function getDemoReview(db: Db, id: string): Promise<DemoReviewView | null> {
  if (!DEMO_ID.test(id)) return null;
  const [row] = await db
    .select({
      id: demoReviews.id,
      status: demoReviews.status,
      owner: demoReviews.owner,
      repo: demoReviews.repo,
      prNumber: demoReviews.prNumber,
      prTitle: demoReviews.prTitle,
      prAuthor: demoReviews.prAuthor,
      headSha: demoReviews.headSha,
      reason: demoReviews.reason,
      result: demoReviews.result,
      createdAt: demoReviews.createdAt,
      finishedAt: demoReviews.finishedAt,
    })
    .from(demoReviews)
    .where(and(eq(demoReviews.orgId, DEMO_ORG_ID), eq(demoReviews.id, id)));
  if (!row) return null;
  const ref = { owner: row.owner, repo: row.repo, number: row.prNumber };
  return {
    id: row.id,
    status: row.status,
    pr: { ...ref, url: prUrl(ref), title: row.prTitle, author: row.prAuthor, headSha: row.headSha },
    reason: row.reason,
    result: row.status === "completed" ? row.result : null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}
