import { query } from "./_generated/server";
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
    return { totalReviews: selected.length, completed: completed.length, totalPRs: new Set(selected.map(r => `${r.repositoryId}:${r.prNumber}`)).size, findings: bugs.length, severity: Object.fromEntries(["critical", "high", "medium", "low"].map(s => [s, bugs.filter(f => f.severity === s).length])), addressedRate: bugs.length ? bugs.filter(f => f.status === "resolved").length / bugs.length : null, usefulness: rated.length ? rated.filter(f => f.lastFeedback === "useful").length / rated.length : null, cost: costs.reduce((n, u) => n + u.estimatedCost, 0), tokens: costs.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0), averageDuration: completed.length ? completed.reduce((n,r) => n + ((r.finishedAt ?? r.updatedAt) - r.createdAt), 0) / completed.length : null, daily: Object.entries(daily).sort(([a],[b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values })), recent: selected.sort((a,b) => b.createdAt - a.createdAt).slice(0,10) };
  },
});
