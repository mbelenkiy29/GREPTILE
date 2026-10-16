import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { commitLearning, commitPreference, ignoredAtMerge, type CommitSignal } from "../src/commit-signals";

// Learning from commits: records outcome signals and keeps one derived preference per repository and
// category (source `commits:<category>`). The preference text is a fixed template over counts, so no
// repository text reaches it; it is bounded by commitPreference and never narrows security review.
export async function recordSignals(ctx: MutationCtx, findings: Doc<"findings">[], signal: CommitSignal, commitSha: string) {
  const touched = new Map<string, Doc<"findings">>();
  let recorded = 0;
  for (const f of findings) {
    // One outcome per finding: the first recorded signal stands.
    if (await ctx.db.query("findingSignals").withIndex("by_finding", (q) => q.eq("findingId", f._id)).first()) continue;
    await ctx.db.insert("findingSignals", { organizationId: f.organizationId, repositoryId: f.repositoryId, findingId: f._id, prNumber: f.prNumber, signal, category: f.category, severity: f.severity, ...(f.author ? { author: f.author } : {}), commitSha, createdAt: Date.now() });
    touched.set(`${f.repositoryId}|${f.category}`, f);
    recorded++;
  }
  for (const f of touched.values()) await learn(ctx, f.organizationId, f.repositoryId, f.category);
  return recorded;
}

async function learn(ctx: MutationCtx, organizationId: Id<"organizations">, repositoryId: Id<"repositories">, category: string) {
  const since = Date.now() - commitLearning.maxAgeDays * 86400000;
  const recent = await ctx.db.query("findingSignals").withIndex("by_repo_category", (q) => q.eq("repositoryId", repositoryId).eq("category", category).gte("createdAt", since)).order("desc").take(commitLearning.recent);
  const instruction = commitPreference(category, { addressed: recent.filter((s) => s.signal === "addressed").length, ignored: recent.filter((s) => s.signal === "ignored").length });
  const source = "commits:" + category, now = Date.now();
  const existing = await ctx.db.query("learnedPreferences").withIndex("by_source", (q) => q.eq("repositoryId", repositoryId).eq("source", source)).first();
  if (!instruction) { if (existing) await ctx.db.delete(existing._id); return; }
  // An admin's enable/disable choice is kept; only the counts in the text change.
  if (existing) await ctx.db.patch(existing._id, { instruction, updatedAt: now });
  else await ctx.db.insert("learnedPreferences", { organizationId, repositoryId, category, instruction, source, enabled: true, createdAt: now, updatedAt: now });
}

// Merge: findings of the last completed review that are still open with no human feedback become
// "ignored", provided that review covered the merged head.
export const recordMerge = internalMutation({ args: { repositoryId: v.id("repositories"), prNumber: v.number() }, handler: async (ctx, a) => {
  const pr = await ctx.db.query("pullRequests").withIndex("by_repo_number", (q) => q.eq("repositoryId", a.repositoryId).eq("number", a.prNumber)).unique();
  const last = (await ctx.db.query("reviews").withIndex("by_pr", (q) => q.eq("repositoryId", a.repositoryId).eq("prNumber", a.prNumber)).collect())
    .filter((r) => r.status === "completed").sort((x, y) => y.createdAt - x.createdAt)[0];
  const rows = last ? await ctx.db.query("reviewFindings").withIndex("by_review", (q) => q.eq("reviewId", last._id)).take(500) : [];
  const findings = (await Promise.all(rows.map((r) => ctx.db.get(r.findingId)))).filter((f): f is Doc<"findings"> => !!f);
  const { ignored, reason } = ignoredAtMerge(findings, last?.headSha, pr?.headSha);
  const recorded = ignored.length ? await recordSignals(ctx, ignored, "ignored", pr!.headSha) : 0;
  console.log(JSON.stringify({ event: "learning.merge_signals", repositoryId: a.repositoryId, prNumber: a.prNumber, ignored: ignored.length, recorded, ...(reason ? { reason } : {}) }));
  return { ignored: ignored.length, ...(reason ? { reason } : {}) };
} });
