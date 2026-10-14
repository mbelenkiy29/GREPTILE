import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export const feedbackValues = ["useful", "not_useful", "resolved", "wont_fix", "false_positive"] as const;
// Records feedback on a finding and updates the learned preference it derives (dashboard
// buttons and provider reactions share this path). Preferences only add review guidance.
export async function recordFindingFeedback(ctx: MutationCtx, finding: Doc<"findings">, input: { value: string; comment: string; userId?: Id<"users">; githubLogin?: string }) {
  const feedbackId = await ctx.db.insert("findingFeedback", {
    organizationId: finding.organizationId,
    findingId: finding._id,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.githubLogin ? { githubLogin: input.githubLogin } : {}),
    value: input.value,
    comment: input.comment,
    createdAt: Date.now(),
  });
  await ctx.db.patch(finding._id, {
    lastFeedback: input.value,
    ...(["resolved", "wont_fix", "false_positive"].includes(input.value)
      ? { status: input.value }
      : input.value === "useful" && ["wont_fix", "false_positive"].includes(finding.status)
        ? { status: "open" }
        : {}),
    updatedAt: Date.now(),
  });
  const previousPreference = await ctx.db
    .query("learnedPreferences")
    .withIndex("by_source", (q) => q.eq("repositoryId", finding.repositoryId).eq("source", finding._id))
    .first();
  if (input.value === "resolved") {
    if (previousPreference) await ctx.db.patch(previousPreference._id, { enabled: false, updatedAt: Date.now(), feedbackId });
    return feedbackId;
  }
  const rejected = ["not_useful", "wont_fix", "false_positive"].includes(input.value);
  const instruction = rejected
    ? `Avoid repeating this ${input.value} finding pattern: ${finding.title}. ${input.comment}`
    : `Prioritize actionable issues like this accepted finding${finding.ruleId ? ` from rule ${finding.ruleId}` : ""}: ${finding.title}. ${input.comment}`;
  const preference = {
    organizationId: finding.organizationId,
    repositoryId: finding.repositoryId,
    category: finding.category,
    instruction: instruction.slice(0, 2000),
    source: finding._id,
    findingId: finding._id,
    sourceReviewId: finding.reviewId,
    feedbackId,
    enabled: true,
    createdAt: previousPreference?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  if (previousPreference) await ctx.db.patch(previousPreference._id, preference);
  else await ctx.db.insert("learnedPreferences", preference);
  return feedbackId;
}
