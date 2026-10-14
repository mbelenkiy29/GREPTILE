import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { audit, authorizeRepository } from "./auth";
import { effectiveSettings } from "./scopes";
import { conventionProblem, similarConvention } from "../src/conventions";

const evidence = v.object({ url: v.string(), author: v.string(), excerpt: v.string() });
// Merges extracted conventions into the repository's learned rules. Guardrail-failing text is
// dropped; rejected rules stay rejected; new ones are suggestions unless auto-approve is on.
export const record = internalMutation({
  args: { repositoryId: v.id("repositories"), cursor: v.number(), candidates: v.array(v.object({ text: v.string(), category: v.string(), frequency: v.number(), evidence: v.array(evidence) })) },
  handler: async (ctx, a) => {
    const repo = await ctx.db.get(a.repositoryId);
    if (!repo) return { added: 0, merged: 0, rejected: 0 };
    const auto = (await effectiveSettings(ctx, repo)).autoApproveConventions === true;
    const existing = await ctx.db.query("learnedRules").withIndex("by_repo_status", (q) => q.eq("repositoryId", repo._id)).take(500);
    let added = 0, merged = 0, rejected = 0;
    for (const c of a.candidates.slice(0, 20)) {
      if (conventionProblem(c.text)) { rejected++; continue; }
      const urls = c.evidence.filter((e) => /^https:\/\//.test(e.url)).slice(0, 5).map((e) => ({ url: e.url.slice(0, 500), author: e.author.slice(0, 100), excerpt: e.excerpt.slice(0, 300) }));
      const match = existing.find((r) => r.category === c.category && similarConvention(r.text, c.text));
      if (match) {
        const all = [...match.evidence, ...urls.filter((e) => !match.evidence.some((x) => x.url === e.url))];
        // Frequency counts supporting comments, including ones beyond the five stored evidence links.
        const overlap = urls.filter((e) => match.evidence.some((x) => x.url === e.url)).length;
        const update = { evidence: all.slice(0, 5), frequency: Math.min(100000, match.frequency + Math.max(0, Math.max(c.frequency, urls.length) - overlap)), updatedAt: Date.now(), ...(auto && match.status === "suggested" ? { status: "approved" } : {}) };
        await ctx.db.patch(match._id, update);
        Object.assign(match, update);
        merged++;
        continue;
      }
      const row = { organizationId: repo.organizationId, repositoryId: repo._id, text: c.text.trim(), category: c.category, status: auto ? "approved" : "suggested", scope: "repo", frequency: Math.max(1, Math.min(100000, c.frequency), new Set(urls.map((e) => e.url)).size), evidence: urls, createdAt: Date.now(), updatedAt: Date.now() };
      const id = await ctx.db.insert("learnedRules", row);
      existing.push({ ...row, _id: id, _creationTime: Date.now() });
      added++;
    }
    await ctx.db.patch(repo._id, { conventionsCursor: Math.max(repo.conventionsCursor ?? 0, a.cursor), conventionsSyncedAt: Date.now() });
    return { added, merged, rejected };
  },
});
// Approved conventions applied to reviews of this repository (as review guidance).
export const approvedForRepo = internalQuery({ args: { repositoryId: v.id("repositories") }, handler: async (ctx, a) =>
  (await ctx.db.query("learnedRules").withIndex("by_repo_status", (q) => q.eq("repositoryId", a.repositoryId).eq("status", "approved")).take(200)).map((r) => ({ category: r.category, instruction: `Team convention learned from ${r.frequency} human review comment${r.frequency === 1 ? "" : "s"}: ${r.text}` })),
});
export const list = query({ args: { token: v.string(), repositoryId: v.id("repositories") }, handler: async (ctx, a) => {
  const { repo } = await authorizeRepository(ctx, a.token, a.repositoryId);
  return (await ctx.db.query("learnedRules").withIndex("by_repo_status", (q) => q.eq("repositoryId", repo._id)).take(500)).sort((x, y) => (x.status === "suggested" ? -1 : 0) - (y.status === "suggested" ? -1 : 0) || y.frequency - x.frequency);
} });
// Admin approval flow; every decision is audit-logged.
export const decide = mutation({ args: { token: v.string(), ruleId: v.id("learnedRules"), decision: v.union(v.literal("approved"), v.literal("rejected"), v.literal("disabled"), v.literal("suggested")) }, handler: async (ctx, a) => {
  const rule = await ctx.db.get(a.ruleId);
  if (!rule) throw new Error("Learned rule not found");
  const { user } = await authorizeRepository(ctx, a.token, rule.repositoryId, true, true);
  await ctx.db.patch(rule._id, { status: a.decision, decidedBy: user._id, updatedAt: Date.now() });
  await audit(ctx, rule.organizationId, user._id, "learned_rule." + a.decision, rule._id);
} });
// Enabled GitHub repositories whose review comments were least recently ingested.
export const due = internalQuery({ args: { limit: v.number() }, handler: async (ctx, a) => {
  const out: { repositoryId: Id<"repositories">; cursor: number }[] = [];
  for (const repo of await ctx.db.query("repositories").take(2000))
    if (repo.enabled && repo.installationId !== undefined && !repo.connectionId && (repo.conventionsSyncedAt ?? 0) < Date.now() - 20 * 3600000) out.push({ repositoryId: repo._id, cursor: repo.conventionsCursor ?? 0 });
  return out.sort((x, y) => x.cursor - y.cursor).slice(0, Math.min(20, a.limit));
} });
