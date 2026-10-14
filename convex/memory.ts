import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { audit, authorize, authorizeRepository, visibleRepositories } from "./auth";
import { conventionProblem, preferenceProblem } from "../src/conventions";

// Memory management: workspace admins edit, scope, enable/disable, delete and approve learned
// preferences and conventions; every change is audit-logged. Viewers only read.
const scope = v.union(v.literal("repo"), v.literal("team"), v.literal("workspace"));
async function scoped(ctx: MutationCtx, repo: Doc<"repositories">, value: "repo" | "team" | "workspace" | undefined) {
  if (value === undefined) return {};
  if (value === "team" && !repo.teamId) throw new Error("This repository is not assigned to a team");
  return value === "team" ? { scope: value, teamId: repo.teamId } : { scope: value, teamId: undefined };
}
export const editPreference = mutation({
  args: { token: v.string(), preferenceId: v.id("learnedPreferences"), instruction: v.optional(v.string()), scope: v.optional(scope) },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.preferenceId);
    if (!p) throw new Error("Preference not found");
    const { repo, user } = await authorizeRepository(ctx, a.token, p.repositoryId, true, true);
    if (repo.organizationId !== p.organizationId) throw new Error("Preference scope mismatch");
    const instruction = a.instruction?.trim();
    if (instruction !== undefined) { const problem = preferenceProblem(instruction, p.category); if (problem) throw new Error("Preference rejected: " + problem); }
    await ctx.db.patch(p._id, { ...(instruction !== undefined ? { instruction } : {}), ...(await scoped(ctx, repo, a.scope)), updatedAt: Date.now() });
    await audit(ctx, p.organizationId, user._id, "preference.edited" + (a.scope ? ":" + a.scope : ""), p._id);
  },
});
export const editLearnedRule = mutation({
  args: { token: v.string(), ruleId: v.id("learnedRules"), text: v.optional(v.string()), scope: v.optional(scope), status: v.optional(v.union(v.literal("approved"), v.literal("rejected"), v.literal("disabled"), v.literal("suggested"))) },
  handler: async (ctx, a) => {
    const rule = await ctx.db.get(a.ruleId);
    if (!rule) throw new Error("Learned rule not found");
    const { repo, user } = await authorizeRepository(ctx, a.token, rule.repositoryId, true, true);
    if (repo.organizationId !== rule.organizationId) throw new Error("Learned rule scope mismatch");
    const text = a.text?.trim();
    if (text !== undefined) { const problem = conventionProblem(text); if (problem) throw new Error("Convention rejected: " + problem); }
    await ctx.db.patch(rule._id, { ...(text !== undefined ? { text } : {}), ...(a.status ? { status: a.status, decidedBy: user._id } : {}), ...(await scoped(ctx, repo, a.scope)), updatedAt: Date.now() });
    await audit(ctx, rule.organizationId, user._id, "learned_rule.edited" + (a.status ? ":" + a.status : "") + (a.scope ? ":" + a.scope : ""), rule._id);
  },
});
export const deleteLearnedRule = mutation({
  args: { token: v.string(), ruleId: v.id("learnedRules") },
  handler: async (ctx, a) => {
    const rule = await ctx.db.get(a.ruleId);
    if (!rule) throw new Error("Learned rule not found");
    const { repo, user } = await authorizeRepository(ctx, a.token, rule.repositoryId, true, true);
    if (repo.organizationId !== rule.organizationId) throw new Error("Learned rule scope mismatch");
    await ctx.db.delete(rule._id);
    await audit(ctx, rule.organizationId, user._id, "learned_rule.deleted", rule._id);
  },
});

// Learned conventions across visible repositories, with search and status filters (read access).
export const rules = query({
  args: { token: v.string(), organizationId: v.id("organizations"), teamId: v.optional(v.id("teams")), repositoryId: v.optional(v.id("repositories")), search: v.optional(v.string()), status: v.optional(v.string()) },
  handler: async (ctx, a) => {
    await authorize(ctx, a.token, a.organizationId);
    if ((a.search?.length ?? 0) > 200) throw new Error("Search is too long");
    const repos = await visibleRepositories(ctx, a.token, a.organizationId, a.teamId);
    if (a.repositoryId && !repos.some((r) => r._id === a.repositoryId)) throw new Error("Repository not accessible");
    const search = a.search?.trim().toLowerCase() ?? "";
    const groups = await Promise.all(repos.filter((r) => !a.repositoryId || r._id === a.repositoryId).map(async (repo) =>
      (await ctx.db.query("learnedRules").withIndex("by_repo_status", (q) => q.eq("repositoryId", repo._id)).take(500))
        .filter((r) => (!a.status || r.status === a.status) && [r.text, r.category, r.status, r.scope ?? "repo", repo.fullName].join(" ").toLowerCase().includes(search))
        .map((r) => ({ ...r, repositoryName: repo.fullName, hasTeam: !!repo.teamId }))));
    return groups.flat().sort((x, y) => (x.status === "suggested" ? 0 : 1) - (y.status === "suggested" ? 0 : 1) || y.updatedAt - x.updatedAt).slice(0, 300);
  },
});
