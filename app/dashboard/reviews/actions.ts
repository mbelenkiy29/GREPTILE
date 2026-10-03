"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { reviews } from "@/lib/db/schema";
import { scoped } from "@/lib/data/tenant";
import { bullQueue } from "@/lib/jobs/queue";
import { REVIEW_MODES, type ReviewMode } from "@/lib/llm/types";
import { UsageLimitError } from "@/lib/billing/limits";
import { cancelReview, requestReview } from "@/lib/pipeline/request";
import { withToast } from "@/lib/ui/toast";

function reviewPath(reviewId: number) {
  return `/dashboard/reviews/${reviewId}`;
}

/**
 * Re-reviews a PR from the dashboard (R6.6): `mode` picks fast / standard / deep, `focus=security` runs the security
 * profile, and `full=true` ignores the incremental baseline.
 */
export async function rerunReview(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "reviews.trigger" });
  const reviewId = Number(formData.get("reviewId"));
  if (!Number.isSafeInteger(reviewId)) redirect(withToast("/dashboard/reviews", "review.not_found"));
  const [review] = await db()
    .select({ repoId: reviews.repoId, prNumber: reviews.prNumber })
    .from(reviews)
    .where(scoped(reviews, orgId, eq(reviews.id, reviewId)));
  if (!review) redirect(withToast("/dashboard/reviews", "review.not_found"));
  const modeRaw = String(formData.get("mode") ?? "");
  const mode = (REVIEW_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as ReviewMode) : undefined;
  let limited = false;
  try {
    await requestReview(
      { db: db(), queue: bullQueue },
      {
        orgId,
        repoId: review.repoId,
        prNumber: review.prNumber,
        trigger: "manual",
        ...(mode ? { mode } : {}),
        ...(formData.get("focus") === "security" ? { focus: "security" as const } : {}),
        full: formData.get("full") === "true",
        requestedBy: userId,
        meta: { requestedBy: userId },
      },
    );
  } catch (err) {
    // Over a usage cap or plan limit (R4.3, R4.2): nothing was queued; the banner and Usage & billing say why.
    if (!(err instanceof UsageLimitError)) throw err;
    limited = true;
  }
  revalidatePath(reviewPath(reviewId));
  redirect(withToast(reviewPath(reviewId), limited ? "review.usage_limit" : "review.queued"));
}

/** Cancels a queued or running review run (R6.16). */
export async function cancelReviewRun(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "reviews.trigger" });
  const runId = Number(formData.get("runId"));
  const reviewId = Number(formData.get("reviewId"));
  const back = Number.isSafeInteger(reviewId) ? reviewPath(reviewId) : "/dashboard/reviews";
  if (!Number.isSafeInteger(runId)) redirect(withToast(back, "review.not_found"));
  const outcome = await cancelReview(db(), orgId, runId, userId);
  revalidatePath(back);
  const code =
    outcome.status === "cancelled"
      ? "review.cancelled"
      : outcome.status === "cancel_requested"
        ? "review.cancel_requested"
        : outcome.status === "already_finished"
          ? "review.already_finished"
          : "review.not_found";
  redirect(withToast(back, code));
}
