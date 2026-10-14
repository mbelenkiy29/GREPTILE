import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { audit, authorize } from "./auth";
import { enableIndexing } from "./repositories";
import { rateLimit } from "./rateLimit";
import { manifestPaths, mergeManifests, parseManifest, suggestClusters } from "../src/cluster-suggestions";

// Repository onboarding automation: optional auto-enable for newly installed repositories, and
// suggested cross-repository clusters that an admin approves with one click (never applied automatically).

// Team value overrides the workspace; unset everywhere means off, so existing workspaces are unchanged.
export async function autoEnableFor(ctx: MutationCtx, repo: Doc<"repositories">) {
  const team = repo.teamId ? await ctx.db.get(repo.teamId) : null;
  const organization = await ctx.db.get(repo.organizationId);
  return team?.autoEnableRepositories ?? organization?.autoEnableRepositories ?? false;
}
// Called right after a repository row is first created from an installation. Enabling goes through the
// normal path (access checks, catalog, indexing); if that refuses, the repository stays disabled.
export async function autoEnableNewRepository(ctx: MutationCtx, repositoryId: Id<"repositories">) {
  const repo = await ctx.db.get(repositoryId);
  if (!repo || repo.enabled || !(await autoEnableFor(ctx, repo))) return false;
  try { await enableIndexing(ctx, repo); }
  catch (error) { await audit(ctx, repo.organizationId, undefined, "repository.auto_enable_failed", `${repo._id}: ${error instanceof Error ? error.message.slice(0, 160) : "refused"}`); return false; }
  await audit(ctx, repo.organizationId, undefined, "repository.auto_enabled", repo._id);
  return true;
}

export const setAutoEnable = mutation({
  args: { token: v.string(), organizationId: v.id("organizations"), teamId: v.optional(v.id("teams")), value: v.union(v.literal("on"), v.literal("off"), v.literal("inherit")) },
  handler: async (ctx, a) => {
    const { user } = await authorize(ctx, a.token, a.organizationId, true);
    if (a.teamId) {
      const team = await ctx.db.get(a.teamId);
      if (!team || team.organizationId !== a.organizationId) throw new Error("Team not accessible");
      await ctx.db.patch(team._id, { autoEnableRepositories: a.value === "inherit" ? undefined : a.value === "on" });
    } else {
      if (a.value === "inherit") throw new Error("The workspace setting is on or off");
      await ctx.db.patch(a.organizationId, { autoEnableRepositories: a.value === "on" });
    }
    await audit(ctx, a.organizationId, user._id, "repositories.auto_enable." + a.value, a.teamId ?? a.organizationId);
  },
});

// Suggested clusters: admin request → background scan of indexed root manifests → stored suggestions.
export const requestClusterSuggestions = mutation({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  await rateLimit(ctx, "cluster-suggestions:" + a.organizationId, 3, 3600000);
  await audit(ctx, a.organizationId, user._id, "cluster_suggestions.requested", a.organizationId);
  await ctx.scheduler.runAfter(0, internal.repositoryOnboarding.scanClusters, { organizationId: a.organizationId });
} });
export const clusterInputs = internalQuery({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const repos = await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(500);
  const manifests = [];
  for (const repo of repos) {
    const files = (await Promise.all(manifestPaths.map((path) => ctx.db.query("repositoryFiles").withIndex("by_path", (q) => q.eq("repositoryId", repo._id).eq("path", path)).unique()))).filter((f): f is Doc<"repositoryFiles"> => !!f);
    manifests.push({ id: repo._id as string, fullName: repo.fullName, files: files.map((f) => ({ path: f.path, storageId: f.storageId })) });
  }
  const clusters = (await ctx.db.query("repositoryClusters").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(500)).map((c) => c.repositoryIds.map(String));
  const decided = (await ctx.db.query("clusterSuggestions").withIndex("by_org_status", (q) => q.eq("organizationId", a.organizationId).eq("status", "dismissed")).take(1000)).map((s) => s.key);
  return { manifests, clusters, decided };
} });
export const scanClusters = internalAction({ args: { organizationId: v.id("organizations") }, handler: async (ctx, a): Promise<number> => {
  const inputs = await ctx.runQuery(internal.repositoryOnboarding.clusterInputs, a);
  const repos = [];
  for (const m of inputs.manifests) {
    const parsed = [];
    for (const f of m.files) {
      const blob = await ctx.storage.get(f.storageId);
      if (blob && blob.size <= 512_000) parsed.push(parseManifest(f.path, await blob.text()));
    }
    repos.push({ id: m.id, fullName: m.fullName, ...mergeManifests(parsed) });
  }
  const suggestions = suggestClusters(repos, { existing: inputs.clusters, skip: new Set(inputs.decided) });
  return ctx.runMutation(internal.repositoryOnboarding.storeClusterSuggestions, { organizationId: a.organizationId, suggestions });
} });
export const storeClusterSuggestions = internalMutation({
  args: { organizationId: v.id("organizations"), suggestions: v.array(v.object({ key: v.string(), name: v.string(), repositoryIds: v.array(v.string()), reasons: v.array(v.object({ kind: v.string(), detail: v.string() })), score: v.number() })) },
  handler: async (ctx, a) => {
    // Open suggestions are replaced by the latest scan; decided ones are kept as history.
    for (const old of await ctx.db.query("clusterSuggestions").withIndex("by_org_status", (q) => q.eq("organizationId", a.organizationId).eq("status", "suggested")).take(200)) await ctx.db.delete(old._id);
    let stored = 0;
    for (const s of a.suggestions) {
      const ids = s.repositoryIds.map((id) => ctx.db.normalizeId("repositories", id)).filter((id): id is Id<"repositories"> => !!id);
      const repos = await Promise.all(ids.map((id) => ctx.db.get(id)));
      if (ids.length !== s.repositoryIds.length || repos.some((r) => r?.organizationId !== a.organizationId)) continue;
      await ctx.db.insert("clusterSuggestions", { organizationId: a.organizationId, key: s.key, name: s.name.slice(0, 100), repositoryIds: ids, reasons: s.reasons, score: s.score, status: "suggested", createdAt: Date.now(), updatedAt: Date.now() });
      stored++;
    }
    return stored;
  },
});
export const clusterSuggestionsPage = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  return (await ctx.db.query("clusterSuggestions").withIndex("by_org_status", (q) => q.eq("organizationId", a.organizationId).eq("status", "suggested")).take(50)).sort((x, y) => y.score - x.score);
} });
// One click: approve creates the cluster with the same checks as a hand-made one; dismiss hides the set
// from future scans. Both are audited.
export const decideClusterSuggestion = mutation({
  args: { token: v.string(), suggestionId: v.id("clusterSuggestions"), decision: v.union(v.literal("approved"), v.literal("dismissed")), name: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ status: "approved" | "dismissed" | "stale"; clusterId?: Id<"repositoryClusters"> }> => {
    const s = await ctx.db.get(a.suggestionId);
    if (!s) throw new Error("Suggestion not found");
    const { user } = await authorize(ctx, a.token, s.organizationId, true);
    if (s.status !== "suggested") throw new Error("This suggestion was already decided");
    const close = async (status: "approved" | "dismissed" | "stale", clusterId?: Id<"repositoryClusters">) => {
      await ctx.db.patch(s._id, { status, decidedBy: user._id, updatedAt: Date.now(), ...(clusterId ? { clusterId } : {}) });
      await audit(ctx, s.organizationId, user._id, "cluster_suggestion." + status, s._id);
      return { status, ...(clusterId ? { clusterId } : {}) };
    };
    if (a.decision === "dismissed") return close("dismissed");
    const name = (a.name ?? s.name).trim();
    if (!name || name.length > 100) throw new Error("Enter a cluster name of 1–100 characters");
    const repos = await Promise.all(s.repositoryIds.map((id) => ctx.db.get(id)));
    if (repos.some((r) => !r || r.organizationId !== s.organizationId) || s.repositoryIds.length < 2 || s.repositoryIds.length > 20) return close("stale");
    const clusterId = await ctx.db.insert("repositoryClusters", { organizationId: s.organizationId, name, repositoryIds: s.repositoryIds, createdAt: Date.now() });
    await audit(ctx, s.organizationId, user._id, "cluster.updated", name);
    return close("approved", clusterId);
  },
});
