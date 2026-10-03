"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { reviews } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import { bullQueue } from "@/lib/jobs/queue";
import { cancelReview, requestReview } from "@/lib/pipeline/request";

/** Re-reviews a PR from the dashboard (R6.6); "full" ignores the incremental baseline. */
export async function rerunReview(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "reviews.trigger" });
  const reviewId = Number(formData.get("reviewId"));
  if (!Number.isSafeInteger(reviewId)) return;
  const [review] = await db()
    .select({ repoId: reviews.repoId, prNumber: reviews.prNumber })
    .from(reviews)
    .where(scoped(reviews, orgId, eq(reviews.id, reviewId)));
  if (!review) return;
  await requestReview(
    { db: db(), queue: bullQueue },
    {
      orgId,
      repoId: review.repoId,
      prNumber: review.prNumber,
      trigger: "manual",
      full: formData.get("full") === "true",
      requestedBy: userId,
      meta: { requestedBy: userId },
    },
  );
  revalidatePath(`/dashboard/reviews/${reviewId}`);
}

/** Cancels a queued or running review run (R6.16). */
export async function cancelReviewRun(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "reviews.trigger" });
  const runId = Number(formData.get("runId"));
  if (!Number.isSafeInteger(runId)) return;
  await cancelReview(db(), orgId, runId, userId);
  const reviewId = Number(formData.get("reviewId"));
  if (Number.isSafeInteger(reviewId)) revalidatePath(`/dashboard/reviews/${reviewId}`);
}
