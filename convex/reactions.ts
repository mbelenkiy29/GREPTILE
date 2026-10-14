import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { recordFindingFeedback } from "./feedbackCore";

const reaction = v.union(v.literal("+1"), v.literal("-1"));
// OpenReview finding comments on a pull request, with the finding each belongs to.
export const targets = internalQuery({ args: { repositoryId: v.id("repositories"), prNumber: v.number() }, handler: async (ctx, a) => {
  const out: { commentId: string; findingId: Id<"findings"> }[] = [];
  for (const review of await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", a.repositoryId).eq("prNumber", a.prNumber)).order("desc").take(50))
    for (const c of await ctx.db.query("reviewComments").withIndex("by_review", (q) => q.eq("reviewId", review._id)).take(200)) {
      if (!c.fingerprint || out.some((o) => o.commentId === String(c.githubId))) continue;
      const finding = await ctx.db.query("findings").withIndex("by_fingerprint", (q) => q.eq("repositoryId", a.repositoryId).eq("prNumber", a.prNumber).eq("fingerprint", c.fingerprint!)).first();
      if (finding) out.push({ commentId: String(c.githubId), findingId: finding._id });
    }
  return out.slice(0, 200);
} });
// Per user: only 👍 → useful, only 👎 → not useful; each user/value is recorded once as feedback.
async function deriveFeedback(ctx: MutationCtx, findingId: Id<"findings">, provider: string) {
  const finding = await ctx.db.get(findingId);
  if (!finding) return;
  const rows = await ctx.db.query("commentReactions").withIndex("by_finding", (q) => q.eq("findingId", findingId)).take(500);
  const existing = await ctx.db.query("findingFeedback").withIndex("by_finding", (q) => q.eq("findingId", findingId)).take(500);
  for (const user of new Set(rows.map((r) => r.user))) {
    const mine = new Set(rows.filter((r) => r.user === user).map((r) => r.reaction));
    if (mine.size !== 1) continue;
    const value = mine.has("+1") ? "useful" : "not_useful";
    if (existing.some((f) => f.githubLogin === user && f.value === value && f.comment.startsWith("Reaction"))) continue;
    await recordFindingFeedback(ctx, (await ctx.db.get(findingId))!, { value, comment: `Reaction ${value === "useful" ? "👍" : "👎"} from @${user} on ${provider}`, githubLogin: user });
  }
}
// Mirrors the current reactions for the given comments (removed reactions disappear) and derives feedback.
export const apply = internalMutation({
  args: { repositoryId: v.id("repositories"), prNumber: v.number(), provider: v.string(), targets: v.array(v.object({ commentId: v.string(), findingId: v.id("findings") })), observed: v.array(v.object({ commentId: v.string(), user: v.string(), reaction, createdAt: v.number() })) },
  handler: async (ctx, a) => {
    const repo = await ctx.db.get(a.repositoryId);
    if (!repo) return { added: 0, removed: 0 };
    let added = 0, removed = 0;
    const touched = new Set<Id<"findings">>();
    for (const target of a.targets.slice(0, 200)) {
      const current = await ctx.db.query("commentReactions").withIndex("by_comment", (q) => q.eq("repositoryId", repo._id).eq("commentId", target.commentId)).take(500);
      const seen = a.observed.filter((o) => o.commentId === target.commentId);
      for (const row of current) if (!seen.some((o) => o.user === row.user && o.reaction === row.reaction)) { await ctx.db.delete(row._id); removed++; touched.add(target.findingId); }
      for (const o of seen) if (!current.some((r) => r.user === o.user && r.reaction === o.reaction)) {
        await ctx.db.insert("commentReactions", { organizationId: repo.organizationId, repositoryId: repo._id, prNumber: a.prNumber, provider: a.provider, commentId: target.commentId, findingId: target.findingId, user: o.user.slice(0, 100), reaction: o.reaction, createdAt: o.createdAt });
        added++; touched.add(target.findingId);
      }
    }
    for (const findingId of touched) await deriveFeedback(ctx, findingId, a.provider);
    const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", repo._id).eq("number", a.prNumber)).unique();
    if (pr) await ctx.db.patch(pr._id, { reactionsSyncedAt: Date.now() });
    return { added, removed };
  },
});
// GitLab award-emoji webhook: one reaction added or revoked on a finding note.
export const emoji = internalMutation({
  args: { repositoryId: v.id("repositories"), prNumber: v.number(), noteId: v.string(), user: v.string(), reaction, award: v.boolean() },
  handler: async (ctx, a) => {
    const repo = await ctx.db.get(a.repositoryId);
    if (!repo) return false;
    const comment = (await ctx.db.query("reviewComments").withIndex("by_github", (q) => q.eq("githubId", Number(a.noteId))).take(10)).find((c) => c.fingerprint && c.organizationId === repo.organizationId);
    if (!comment?.fingerprint) return false;
    const finding = await ctx.db.query("findings").withIndex("by_fingerprint", (q) => q.eq("repositoryId", repo._id).eq("prNumber", a.prNumber).eq("fingerprint", comment.fingerprint!)).first();
    if (!finding) return false;
    const row = (await ctx.db.query("commentReactions").withIndex("by_comment", (q) => q.eq("repositoryId", repo._id).eq("commentId", a.noteId)).take(500)).find((r) => r.user === a.user && r.reaction === a.reaction);
    if (a.award && !row) await ctx.db.insert("commentReactions", { organizationId: repo.organizationId, repositoryId: repo._id, prNumber: a.prNumber, provider: "gitlab", commentId: a.noteId, findingId: finding._id, user: a.user.slice(0, 100), reaction: a.reaction, createdAt: Date.now() });
    else if (!a.award && row) await ctx.db.delete(row._id);
    else return true;
    await deriveFeedback(ctx, finding._id, "gitlab");
    return true;
  },
});
// Open pull requests with recent OpenReview reviews whose reactions were not synced in the last hour.
export const due = internalQuery({ args: { limit: v.number() }, handler: async (ctx, a) => {
  const since = Date.now() - 7 * 86400000, out: { repositoryId: Id<"repositories">; prNumber: number }[] = [];
  for (const review of await ctx.db.query("reviews").withIndex("by_status", (q) => q.eq("status", "completed")).order("desc").take(400)) {
    if (review.createdAt < since || review.nativeP4 || out.some((o) => o.repositoryId === review.repositoryId && o.prNumber === review.prNumber)) continue;
    const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", review.repositoryId).eq("number", review.prNumber)).unique();
    if (pr && pr.state !== "open") continue;
    if ((pr?.reactionsSyncedAt ?? 0) > Date.now() - 3600000) continue;
    out.push({ repositoryId: review.repositoryId, prNumber: review.prNumber });
    if (out.length >= Math.min(50, a.limit)) break;
  }
  return out;
} });
