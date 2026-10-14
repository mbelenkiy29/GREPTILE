import { mutation, query } from "./_generated/server";
import { audit, authorize } from "./auth";
import type {Id} from "./_generated/dataModel";
import { v } from "convex/values";
import {authenticated} from "./auth";
import {contextReadable,requireFindingReader} from "./repositoryContext";
import { visibleRepositories } from "./auth";

export const report = query({
  args: { token: v.string(), organizationId: v.id("organizations"), since: v.number(), until: v.number(), repositoryId: v.optional(v.id("repositories")), author: v.optional(v.string()), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, a) => {
    if (!Number.isFinite(a.since) || !Number.isFinite(a.until) || a.until < a.since || a.until - a.since > 366 * 86400000) throw new Error("Choose a period of at most one year");
    const repos = await visibleRepositories(ctx,a.token,a.organizationId,a.teamId);
    const allowed = new Set(repos.map(r=>String(r._id)));
    if (a.repositoryId && !repos.some(r => r._id === a.repositoryId)) throw new Error("Repository not accessible");
    // ponytail: indexed period reads, not recent-record samples; daily aggregates when periods exceed Convex read limits.
    const [reviews, findings, usage] = await Promise.all([
      ctx.db.query("reviews").withIndex("by_org_time", q => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).collect(),
      ctx.db.query("findings").withIndex("by_org_time", q => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).collect(),
      ctx.db.query("usageEvents").withIndex("by_org_time", q => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).collect(),
    ]);
    const viewer=await authenticated(ctx,a.token),permitted=await Promise.all(reviews.map(r=>contextReadable(ctx,viewer._id,r)));
    const selected = reviews.filter((r,i)=>permitted[i]).filter(r => allowed.has(r.repositoryId) && (!a.repositoryId || r.repositoryId === a.repositoryId) && (!a.author || r.author === a.author.replace(/^@/, "")));
    const ids = new Set(selected.map(r => String(r._id)));
    const readable=new Map<Id<"reviews">,Promise<boolean>>(reviews.map((r,i)=>[r._id,Promise.resolve(permitted[i]&&allowed.has(r.repositoryId))]));
    const mayReadReview=(id:Id<"reviews">)=>{
      let result=readable.get(id);
      if(!result){result=(async()=>{const review=await ctx.db.get(id);return !!review&&review.organizationId===a.organizationId&&allowed.has(review.repositoryId)&&await contextReadable(ctx,viewer._id,review);})();readable.set(id,result);}
      return result;
    };
    const visibleFindings=await Promise.all(findings.map(async f=>{
      if(!allowed.has(f.repositoryId)||!await mayReadReview(f.reviewId))return false;
      try{await requireFindingReader(ctx,viewer._id,f);return true;}catch{return false;}
    }));
    const visibleUsage=await Promise.all(usage.map(async u=>allowed.has(u.repositoryId)&&(!u.reviewId||await mayReadReview(u.reviewId))));

    const bugs = findings.filter((_,i)=>visibleFindings[i]).filter(f => allowed.has(f.repositoryId) && (!a.repositoryId || f.repositoryId === a.repositoryId) && (!a.author || f.author === a.author.replace(/^@/, "")));
    const costs = usage.filter((_,i)=>visibleUsage[i]).filter(u => allowed.has(u.repositoryId) && (!a.repositoryId || u.repositoryId === a.repositoryId) && (!a.author || (u.reviewId && ids.has(u.reviewId))));
    const daily: Record<string, { reviews: number; findings: number; cost: number }> = {};
    const day = (at: number) => daily[new Date(at).toISOString().slice(0, 10)] ??= { reviews: 0, findings: 0, cost: 0 };
    for (const r of selected) day(r.createdAt).reviews++;
    for (const f of bugs) day(f.createdAt).findings++;
    for (const u of costs) day(u.createdAt).cost += u.estimatedCost;
    const completed = selected.filter(r => r.status === "completed");
    const rated = bugs.filter(f => f.lastFeedback === "useful" || f.lastFeedback === "not_useful" || f.lastFeedback === "false_positive");
    // 👍/👎 on OpenReview finding comments in the period (visible repositories, author filter via PR).
    const findingIds = new Set(bugs.map((f) => String(f._id)));
    const reactionRows = (await ctx.db.query("commentReactions").withIndex("by_org_time", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", a.since).lte("createdAt", a.until)).take(5000))
      .filter((r) => allowed.has(r.repositoryId) && (!a.repositoryId || r.repositoryId === a.repositoryId) && (!a.author || (r.findingId && findingIds.has(String(r.findingId)))));
    const reactions = { up: reactionRows.filter((r) => r.reaction === "+1").length, down: reactionRows.filter((r) => r.reaction === "-1").length };
    return { reactions, totalReviews: selected.length, completed: completed.length, totalPRs: new Set(selected.map(r => `${r.repositoryId}:${r.prNumber}`)).size, findings: bugs.length, severity: Object.fromEntries(["critical", "high", "medium", "low"].map(s => [s, bugs.filter(f => f.severity === s).length])), addressedRate: bugs.length ? bugs.filter(f => f.status === "resolved").length / bugs.length : null, usefulness: rated.length ? rated.filter(f => f.lastFeedback === "useful").length / rated.length : null, cost: costs.reduce((n, u) => n + u.estimatedCost, 0), tokens: costs.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0), averageDuration: completed.length ? completed.reduce((n,r) => n + ((r.finishedAt ?? r.updatedAt) - r.createdAt), 0) / completed.length : null, daily: Object.entries(daily).sort(([a],[b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values })), recent: selected.sort((a,b) => b.createdAt - a.createdAt).slice(0,10) };
  },
});

// Trends from the daily rollup (no raw scans): per-day series, per-repository and per-author
// totals, addressed rate and estimated time saved. Counts only, for repositories the viewer can see.
export const trends = query({
  args: { token: v.string(), organizationId: v.id("organizations"), since: v.number(), until: v.number(), repositoryId: v.optional(v.id("repositories")), author: v.optional(v.string()), teamId: v.optional(v.id("teams")) },
  handler: async (ctx, a) => {
    if (!Number.isFinite(a.since) || !Number.isFinite(a.until) || a.until < a.since || a.until - a.since > 366 * 86400000) throw new Error("Choose a period of at most one year");
    const repos = await visibleRepositories(ctx, a.token, a.organizationId, a.teamId);
    if (a.repositoryId && !repos.some((r) => r._id === a.repositoryId)) throw new Error("Repository not accessible");
    const names = new Map(repos.map((r) => [String(r._id), r.fullName]));
    const from = new Date(a.since).toISOString().slice(0, 10), to = new Date(a.until).toISOString().slice(0, 10), author = a.author?.replace(/^@/, "");
    const rows = (await ctx.db.query("analyticsDaily").withIndex("by_org_day", (q) => q.eq("organizationId", a.organizationId).gte("day", from).lte("day", to)).take(20000))
      .filter((r) => names.has(String(r.repositoryId)) && (!a.repositoryId || r.repositoryId === a.repositoryId) && (!author || r.author === author));
    const days: string[] = [];
    for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z") && days.length < 367; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
    const empty = () => ({ reviews: 0, findings: 0, high: 0, addressed: 0 });
    const byDay = new Map(days.map((d) => [d, empty()])), byRepo = new Map<string, ReturnType<typeof empty>>(), byAuthor = new Map<string, ReturnType<typeof empty>>();
    const add = (m: Map<string, ReturnType<typeof empty>>, k: string, r: ReturnType<typeof empty>) => { const x = m.get(k) ?? empty(); x.reviews += r.reviews; x.findings += r.findings; x.high += r.high; x.addressed += r.addressed; m.set(k, x); };
    for (const r of rows) { add(byDay, r.day, r); add(byRepo, String(r.repositoryId), r); if (r.author) add(byAuthor, r.author, r); }
    const organization = await ctx.db.get(a.organizationId), minutes = organization?.analyticsMinutesPerFinding ?? 15;
    const totals = [...byDay.values()].reduce((t, d) => ({ reviews: t.reviews + d.reviews, findings: t.findings + d.findings, high: t.high + d.high, addressed: t.addressed + d.addressed }), empty());
    const top = (m: Map<string, ReturnType<typeof empty>>, label: (k: string) => string) => [...m].map(([k, x]) => ({ key: k, label: label(k), ...x })).sort((p, q) => q.findings - p.findings || q.reviews - p.reviews).slice(0, 10);
    return {
      days: days.map((d) => ({ day: d, ...byDay.get(d)! })),
      totals,
      addressedRate: totals.findings ? totals.addressed / totals.findings : null,
      minutesPerFinding: minutes,
      hoursSaved: Math.round((totals.addressed * minutes) / 6) / 10,
      byRepository: top(byRepo, (k) => names.get(k) ?? "Unknown repository"),
      byAuthor: top(byAuthor, (k) => "@" + k),
      updatedAt: rows.reduce((m, r) => Math.max(m, r.updatedAt), 0) || null,
    };
  },
});
export const setMinutesPerFinding = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), minutes: v.number() }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  if (!Number.isInteger(a.minutes) || a.minutes < 1 || a.minutes > 480) throw new Error("Use 1 to 480 minutes per finding");
  await ctx.db.patch(a.organizationId, { analyticsMinutesPerFinding: a.minutes });
  await audit(ctx, a.organizationId, user._id, "analytics.minutes_per_finding_changed", String(a.minutes));
} });
