import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { audit, authorize } from "./auth";
import { assertRuleScope } from "./dashboard";
import { duplicatesOf, ruleProblem } from "../src/rule-assistant";

// AI rule assistant (dashboard side). Admins request a run (draft from a description, refine the
// existing rules, or suggest rules from fixed findings and approved conventions); a node action calls
// the model; every output is stored as a suggestion that an admin approves or rejects. All admin
// actions are audited; nothing reaches customRules without an approval.
const kind = v.union(v.literal("draft"), v.literal("refine"), v.literal("suggest"));
const PENDING_LIMIT = 2, DAILY_LIMIT = 30;

export const request = mutation({
  args: { token: v.string(), organizationId: v.id("organizations"), kind, description: v.optional(v.string()), repositoryId: v.optional(v.id("repositories")), teamId: v.optional(v.id("teams")), repositoryPattern: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Id<"ruleAssistantRuns">> => {
    const { user } = await authorize(ctx, a.token, a.organizationId, true);
    const description = a.description?.trim() ?? "";
    if (a.kind === "draft" && (description.length < 10 || description.length > 2000)) throw new Error("Describe the rule in 10 to 2,000 characters");
    const scope = a.kind === "draft" ? { repositoryId: a.repositoryId, teamId: a.teamId, repositoryPattern: a.repositoryPattern?.trim() || undefined } : {};
    await assertRuleScope(ctx, a.organizationId, scope);
    const recent = await ctx.db.query("ruleAssistantRuns").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gt("createdAt", Date.now() - 86400000)).take(DAILY_LIMIT + 1);
    if (recent.filter((r) => r.status === "pending").length >= PENDING_LIMIT) throw new Error("The rule assistant is already working on earlier requests; try again when they finish");
    if (recent.length >= DAILY_LIMIT) throw new Error("The rule assistant has reached its daily limit for this workspace");
    const now = Date.now();
    const runId = await ctx.db.insert("ruleAssistantRuns", { organizationId: a.organizationId, kind: a.kind, status: "pending", ...(a.kind === "draft" ? { description } : {}), ...scope, requestedBy: user._id, createdAt: now, updatedAt: now });
    await audit(ctx, a.organizationId, user._id, "rule_assistant." + a.kind, runId);
    await ctx.scheduler.runAfter(0, internal.ruleAssistantJobs.run, { runId });
    return runId;
  },
});

// Imported AI rule files (CLI onboarding): each candidate is guarded and stored as an `import`
// suggestion; nothing becomes a rule until an admin approves it.
export const importRules = mutation({
  args: { token: v.string(), organizationId: v.id("organizations"), repositoryId: v.optional(v.id("repositories")), rules: v.array(v.object({ title: v.string(), instructions: v.string(), globs: v.array(v.string()), source: v.object({ path: v.string(), line: v.number() }) })) },
  handler: async (ctx, a): Promise<{ runId: Id<"ruleAssistantRuns">; suggested: number; rejected: { title: string; reason: string }[] }> => {
    const { user } = await authorize(ctx, a.token, a.organizationId, true);
    if (a.rules.length > 50) throw new Error("Import at most 50 rules at a time");
    await assertRuleScope(ctx, a.organizationId, { repositoryId: a.repositoryId });
    const recent = await ctx.db.query("ruleAssistantRuns").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gt("createdAt", Date.now() - 86400000)).take(DAILY_LIMIT + 1);
    if (recent.length >= DAILY_LIMIT) throw new Error("The rule assistant has reached its daily limit for this workspace");
    const existing = (await ctx.db.query("customRules").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(200)).map(ruleRow);
    const now = Date.now(), rejected: { title: string; reason: string }[] = [], accepted: typeof a.rules = [];
    for (const r of a.rules) {
      const rule = { title: r.title.trim().slice(0, 120), instructions: r.instructions.trim(), globs: r.globs };
      const problem = rule.instructions.length > 2000 || r.source.path.length > 200 ? "too long" : ruleProblem(rule);
      if (problem) rejected.push({ title: rule.title.slice(0, 120), reason: problem }); else accepted.push({ ...r, ...rule });
    }
    const runId = await ctx.db.insert("ruleAssistantRuns", { organizationId: a.organizationId, kind: "import", status: "completed", ...(a.repositoryId ? { repositoryId: a.repositoryId } : {}), suggestions: accepted.length, rejected: rejected.slice(0, 20), requestedBy: user._id, createdAt: now, updatedAt: now });
    const scope = a.repositoryId ? { repositoryId: a.repositoryId as string } : {};
    for (const r of accepted)
      await ctx.db.insert("ruleSuggestions", { organizationId: a.organizationId, runId, kind: "import", status: "suggested", title: r.title, instructions: r.instructions, category: "rules", severity: "medium", globs: r.globs, ...(a.repositoryId ? { repositoryId: a.repositoryId } : {}), rationale: `Imported from ${r.source.path} (line ${r.source.line}).`, issues: duplicatesOf(r, existing, scope), sources: [{ kind: "file", label: r.source.path, ids: [], detail: `line ${r.source.line}` }], createdAt: now, updatedAt: now });
    await audit(ctx, a.organizationId, user._id, "rule_assistant.import", runId);
    return { runId, suggested: accepted.length, rejected };
  },
});

// Admin view: open suggestions and the latest runs (with failures and guard rejections).
export const page = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  const runs = await ctx.db.query("ruleAssistantRuns").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId)).order("desc").take(10);
  const suggestions = await ctx.db.query("ruleSuggestions").withIndex("by_org_status", (q) => q.eq("organizationId", a.organizationId).eq("status", "suggested")).order("desc").take(50);
  return { runs, suggestions };
} });

const ruleRow = (r: Doc<"customRules">) => ({ id: r._id as string, title: r.title, instructions: r.instructions, category: r.category, severity: r.severity, globs: r.globs, enabled: r.enabled, createdAt: r.createdAt, ...(r.repositoryId ? { repositoryId: r.repositoryId as string } : {}), ...(r.teamId ? { teamId: r.teamId as string } : {}), ...(r.repositoryPattern ? { repositoryPattern: r.repositoryPattern } : {}) });
// Everything a run needs, read once: the workspace's rules and, for suggestions, resolved findings and
// approved conventions. Usage is attributed to the scoped repository or the workspace's first one.
export const context = internalQuery({ args: { runId: v.id("ruleAssistantRuns") }, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.runId);
  if (!run || run.status !== "pending") return null;
  const rules = (await ctx.db.query("customRules").withIndex("by_org", (q) => q.eq("organizationId", run.organizationId)).order("desc").take(200)).map(ruleRow);
  const repositories = await ctx.db.query("repositories").withIndex("by_org", (q) => q.eq("organizationId", run.organizationId)).take(500);
  const names = new Map(repositories.map((r) => [r._id as string, r.fullName]));
  const usageRepositoryId = run.repositoryId ?? repositories[0]?._id;
  if (run.kind !== "suggest") return { run, rules, usageRepositoryId, findings: [], conventions: [] };
  const findings = (await ctx.db.query("findings").withIndex("by_org_time", (q) => q.eq("organizationId", run.organizationId)).order("desc").take(2000))
    .filter((f) => f.status === "resolved" && names.has(f.repositoryId))
    .map((f) => ({ id: f._id as string, repositoryId: f.repositoryId as string, repository: names.get(f.repositoryId)!, prNumber: f.prNumber, title: f.title, category: f.category, severity: f.severity, filePath: f.filePath }));
  const conventions = (await ctx.db.query("learnedRules").withIndex("by_org", (q) => q.eq("organizationId", run.organizationId)).take(500))
    .filter((c) => c.status === "approved")
    .map((c) => ({ id: c._id as string, text: c.text, category: c.category, frequency: c.frequency, repositoryId: c.repositoryId as string, ...(c.scope ? { scope: c.scope } : {}), ...(c.teamId ? { teamId: c.teamId as string } : {}) }));
  return { run, rules, usageRepositoryId, findings, conventions };
} });

const suggestion = v.object({
  kind: v.union(v.literal("draft"), v.literal("refine"), v.literal("suggest"), v.literal("flag")),
  title: v.string(), instructions: v.string(), category: v.string(), severity: v.string(), globs: v.array(v.string()),
  repositoryId: v.optional(v.string()), teamId: v.optional(v.string()), repositoryPattern: v.optional(v.string()),
  targetRuleId: v.optional(v.string()), base: v.optional(v.object({ title: v.string(), instructions: v.string() })),
  rationale: v.string(),
  issues: v.array(v.object({ kind: v.string(), detail: v.string(), ruleId: v.optional(v.string()) })),
  sources: v.array(v.object({ kind: v.string(), label: v.string(), ids: v.array(v.string()), detail: v.optional(v.string()) })),
});
export const complete = internalMutation({ args: { runId: v.id("ruleAssistantRuns"), suggestions: v.array(suggestion), rejected: v.array(v.object({ title: v.string(), reason: v.string() })) }, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.runId);
  if (!run || run.status !== "pending") return;
  const now = Date.now();
  for (const s of a.suggestions) {
    // Ids came back through the action as strings: keep only those that still name this workspace's records.
    const repositoryId = s.repositoryId ? ctx.db.normalizeId("repositories", s.repositoryId) : null;
    const teamId = s.teamId ? ctx.db.normalizeId("teams", s.teamId) : null;
    const targetRuleId = s.targetRuleId ? ctx.db.normalizeId("customRules", s.targetRuleId) : null;
    if (repositoryId && (await ctx.db.get(repositoryId))?.organizationId !== run.organizationId) continue;
    if (teamId && (await ctx.db.get(teamId))?.organizationId !== run.organizationId) continue;
    if (targetRuleId && (await ctx.db.get(targetRuleId))?.organizationId !== run.organizationId) continue;
    if ((s.kind === "refine" || s.kind === "flag") && !targetRuleId) continue;
    await ctx.db.insert("ruleSuggestions", { organizationId: run.organizationId, runId: run._id, kind: s.kind, status: "suggested", title: s.title, instructions: s.instructions, category: s.category, severity: s.severity, globs: s.globs, ...(repositoryId ? { repositoryId } : {}), ...(teamId ? { teamId } : {}), ...(s.repositoryPattern ? { repositoryPattern: s.repositoryPattern } : {}), ...(targetRuleId ? { targetRuleId } : {}), ...(s.base ? { base: s.base } : {}), rationale: s.rationale, issues: s.issues, sources: s.sources, createdAt: now, updatedAt: now });
  }
  await ctx.db.patch(run._id, { status: "completed", suggestions: a.suggestions.length, rejected: a.rejected.slice(0, 20), updatedAt: now });
} });
export const fail = internalMutation({ args: { runId: v.id("ruleAssistantRuns"), error: v.string() }, handler: async (ctx, a) => {
  const run = await ctx.db.get(a.runId);
  if (run?.status === "pending") await ctx.db.patch(run._id, { status: "failed", error: a.error.slice(0, 300), updatedAt: Date.now() });
} });

// Approve or reject one suggestion. Approval re-runs the guard on the (optionally edited) text and the
// scope checks, then creates the rule (draft, suggest), rewrites it (refine; stale if the rule changed
// since) or disables the newer rule of a flagged pair (flag).
export const decide = mutation({
  args: { token: v.string(), suggestionId: v.id("ruleSuggestions"), decision: v.union(v.literal("approved"), v.literal("rejected")), title: v.optional(v.string()), instructions: v.optional(v.string()), severity: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ status: "approved" | "rejected" | "stale"; ruleId?: Id<"customRules"> }> => {
    const s = await ctx.db.get(a.suggestionId);
    if (!s) throw new Error("Suggestion not found");
    const { user } = await authorize(ctx, a.token, s.organizationId, true);
    if (s.status !== "suggested") throw new Error("This suggestion was already decided");
    const now = Date.now();
    const close = async (status: "approved" | "rejected" | "stale", ruleId?: Id<"customRules">) => {
      await ctx.db.patch(s._id, { status, decidedBy: user._id, updatedAt: now, ...(ruleId ? { ruleId } : {}) });
      await audit(ctx, s.organizationId, user._id, "rule_suggestion." + status, s._id);
      return { status, ...(ruleId ? { ruleId } : {}) };
    };
    if (a.decision === "rejected") return close("rejected");
    if (s.kind === "flag") {
      const target = s.targetRuleId ? await ctx.db.get(s.targetRuleId) : null;
      if (!target || target.organizationId !== s.organizationId || target.title !== s.base?.title || target.instructions !== s.base?.instructions) return close("stale");
      await ctx.db.patch(target._id, { enabled: false });
      await audit(ctx, s.organizationId, user._id, "rule.updated", target._id);
      return close("approved", target._id);
    }
    const rule = { title: (a.title ?? s.title).trim(), instructions: (a.instructions ?? s.instructions).trim(), severity: a.severity ?? s.severity, globs: s.globs };
    if (!["critical", "high", "medium", "low"].includes(rule.severity) || rule.instructions.length > 10000) throw new Error("Invalid rule");
    const problem = ruleProblem(rule);
    if (problem) throw new Error(`This rule cannot be saved: ${problem}`);
    if (s.kind === "refine") {
      const target = s.targetRuleId ? await ctx.db.get(s.targetRuleId) : null;
      if (!target || target.organizationId !== s.organizationId || target.title !== s.base?.title || target.instructions !== s.base?.instructions) return close("stale");
      await ctx.db.patch(target._id, rule);
      await audit(ctx, s.organizationId, user._id, "rule.updated", target._id);
      return close("approved", target._id);
    }
    await assertRuleScope(ctx, s.organizationId, s);
    const ruleId = await ctx.db.insert("customRules", { organizationId: s.organizationId, ...(s.repositoryId ? { repositoryId: s.repositoryId } : {}), ...(s.teamId ? { teamId: s.teamId } : {}), ...(s.repositoryPattern ? { repositoryPattern: s.repositoryPattern } : {}), ...rule, category: s.category, enabled: true, createdAt: now });
    await audit(ctx, s.organizationId, user._id, "rule.created", ruleId);
    return close("approved", ruleId);
  },
});
