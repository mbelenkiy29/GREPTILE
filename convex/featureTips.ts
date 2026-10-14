import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { eligibleTips, tipCooldown, tipKeys, type TicketKind, type TipKey } from "../src/feature-tips";

// Chooses at most one tip for a review and records it, so a publish retry shows the same tip and the
// repository cooldown (one tip every few days, the same tip at most monthly) holds across reviews.
export const choose = internalMutation({
  args: { reviewId: v.id("reviews"), references: v.string(), rules: v.number(), strictness: v.number(), engine: v.string(), agenticAvailable: v.boolean() },
  handler: async (ctx, a): Promise<{ key: TipKey; ticket?: TicketKind } | null> => {
    const review = await ctx.db.get(a.reviewId);
    if (!review) throw new Error("Review not found");
    const already = await ctx.db.query("featureTips").withIndex("by_review", (q) => q.eq("reviewId", review._id)).first();
    if (already) return (tipKeys as readonly string[]).includes(already.key) ? { key: already.key as TipKey, ...(already.ticket ? { ticket: already.ticket as TicketKind } : {}) } : null;
    const now = Date.now();
    const recent = await ctx.db.query("featureTips").withIndex("by_repo_time", (q) => q.eq("repositoryId", review.repositoryId).gt("shownAt", now - tipCooldown.sameTipMs)).take(200);
    if (recent.some((t) => t.shownAt > now - tipCooldown.anyTipMs)) return null;
    const findings = await ctx.db.query("findings").withIndex("by_repo", (q) => q.eq("repositoryId", review.repositoryId)).order("desc").take(200);
    const rated = findings.filter((f) => f.lastFeedback);
    const tip = eligibleTips({
      references: a.references.slice(0, 20000), connected: await connected(ctx, review), rules: a.rules,
      recentFindings: rated.length, dismissedFindings: rated.filter((f) => ["not_useful", "false_positive", "wont_fix"].includes(f.lastFeedback!)).length,
      strictness: a.strictness, engine: a.engine, agenticAvailable: a.agenticAvailable,
    }).find((t) => !recent.some((r) => r.key === t.key));
    if (!tip) return null;
    await ctx.db.insert("featureTips", { organizationId: review.organizationId, repositoryId: review.repositoryId, reviewId: review._id, key: tip.key, ...(tip.ticket ? { ticket: tip.ticket } : {}), shownAt: now });
    return tip;
  },
});
async function connected(ctx: MutationCtx, review: Doc<"reviews">) {
  const connections = await ctx.db.query("integrationConnections").withIndex("by_org", (q) => q.eq("organizationId", review.organizationId)).take(100);
  return { linear: connections.some((c) => c.active && c.kind === "linear"), atlassian: connections.some((c) => c.active && c.kind === "atlassian") };
}
