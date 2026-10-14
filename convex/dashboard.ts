import { recordFindingFeedback } from "./feedbackCore";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { authorize, authorizeRepository, visibleRepositories,repositoryAccess } from "./auth";
import { repositorySourceUrl } from "../src/source-url";
import {contextReadable,requireFindingReader} from "./repositoryContext";
import type {Id} from "./_generated/dataModel";
import {repositoryIdentity} from "./repositoryIdentity";

export const rulesPage=query({
  args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),cursor:v.optional(v.string())},
  handler:async(ctx,args)=>{
    await authorize(ctx,args.token,args.organizationId);
    const repositories=await visibleRepositories(ctx,args.token,args.organizationId,args.teamId);
    if(args.repositoryId&&!repositories.some(r=>r._id===args.repositoryId))throw new Error("Repository not accessible in this scope");
    const ids=args.repositoryId?[args.repositoryId]:repositories.map(r=>r._id);
    return ctx.db.query("customRules").withIndex("by_org",q=>q.eq("organizationId",args.organizationId))
      .filter(q=>q.or(q.eq(q.field("repositoryId"),undefined),...ids.map(id=>q.eq(q.field("repositoryId"),id))))
      .order("desc").paginate({numItems:30,cursor:args.cursor??null});
  }
});

export const overview = query({
  args: { token: v.string(), organizationId: v.id("organizations"),teamId:v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const {user}=await authorize(ctx, args.token, args.organizationId);
    const [reviews, findings, usage, members, rules] =
      await Promise.all([
        ctx.db
          .query("reviews")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .order("desc")
          .take(100),
        ctx.db
          .query("findings")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .order("desc")
          .take(200),
        ctx.db
          .query("usageEvents")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .order("desc")
          .take(1000),
        ctx.db
          .query("organizationMembers")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .collect(),
        ctx.db
          .query("customRules")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .take(200),
      ]);
    const permitted = await visibleRepositories(ctx, args.token, args.organizationId,args.teamId);
    const allowed = new Set(permitted.map(r => String(r._id)));
    const readable=new Map<Id<"reviews">,Promise<boolean>>();
    const mayReadReview=(id:Id<"reviews">)=>{
      let result=readable.get(id);
      if(!result){result=(async()=>{const review=await ctx.db.get(id);return !!review&&review.organizationId===args.organizationId&&allowed.has(review.repositoryId)&&await contextReadable(ctx,user._id,review);})();readable.set(id,result);}
      return result;
    };
    const reviewAccess=await Promise.all(reviews.map(r=>mayReadReview(r._id)));
    const findingAccess=await Promise.all(findings.map(async f=>{
      if(!allowed.has(f.repositoryId)||!await mayReadReview(f.reviewId))return false;
      try{await requireFindingReader(ctx,user._id,f);return true;}catch{return false;}
    }));
    const usageAccess=await Promise.all(usage.map(async u=>allowed.has(u.repositoryId)&&(!u.reviewId||await mayReadReview(u.reviewId))));
    const writable=await Promise.all(permitted.map(async r=>{try{await repositoryAccess(ctx,user._id,r._id,true);return r._id;}catch{return null;}}));
    return {
      repositories: await Promise.all(permitted.map(async r=>({...r,provider:await repositoryIdentity(ctx,r)}))),
      writableRepositoryIds:writable.filter((id):id is NonNullable<typeof id>=>id!==null),
      reviews: reviews.filter((_,i)=>reviewAccess[i]),
      findings: findings.filter((_,i)=>findingAccess[i]),
      usage: usage.filter((_,i)=>usageAccess[i]),
      rules: rules.filter(r => !r.repositoryId || allowed.has(r.repositoryId)),
      indexJobs: await Promise.all(
        permitted.map((r) =>
          ctx.db
            .query("indexJobs")
            .withIndex("by_repo", (q) => q.eq("repositoryId", r._id))
            .order("desc")
            .first(),
        ),
      ),
      members: await Promise.all(
        members.map(async (m) => ({ ...m, user: await ctx.db.get(m.userId) })),
      ),
      bounded: true,
    };
  },
});
export const rules = mutation({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    id: v.optional(v.id("customRules")),
    remove: v.optional(v.boolean()),
    repositoryId: v.optional(v.id("repositories")),
    title: v.string(),
    instructions: v.string(),
    category: v.string(),
    severity: v.string(),
    globs: v.array(v.string()),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await authorize(ctx, args.token, args.organizationId, true);
    if (args.id) {
      const old = await ctx.db.get(args.id);
      if (!old || old.organizationId !== args.organizationId)
        throw new Error("Rule not found");
      if (args.remove) {
        await ctx.db.delete(args.id);
        return;
      }
    }
    if (args.repositoryId) {
      const repo = await ctx.db.get(args.repositoryId);
      if (!repo || repo.organizationId !== args.organizationId)
        throw new Error("Invalid repository scope");
    }
    if (
      !args.title.trim() ||
      !args.instructions.trim() ||
      args.instructions.length > 10000 ||
      !["critical", "high", "medium", "low"].includes(args.severity)
    )
      throw new Error("Invalid rule");
    const rule = {
      organizationId: args.organizationId,
      repositoryId: args.repositoryId,
      title: args.title,
      instructions: args.instructions,
      category: args.category,
      severity: args.severity,
      globs: args.globs,
      enabled: args.enabled,
    };
    if (args.id) await ctx.db.patch(args.id, rule);
    else await ctx.db.insert("customRules", { ...rule, createdAt: Date.now() });
  },
});
export const feedback = mutation({
  args: {
    token: v.string(),
    findingId: v.id("findings"),
    value: v.string(),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const finding = await ctx.db.get(args.findingId);
    if (!finding) throw new Error("Finding not found");
    const { user } = await authorizeRepository(ctx, args.token, finding.repositoryId,true);
    if (
      ![
        "useful",
        "not_useful",
        "resolved",
        "wont_fix",
        "false_positive",
      ].includes(args.value) ||
      args.comment.length > 5000
    )
      throw new Error("Invalid feedback");
    await recordFindingFeedback(ctx, finding, { value: args.value, comment: args.comment, userId: user._id });
  },
});
export const knowledge = query({
  args: { token: v.string(), repositoryId: v.id("repositories"), search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    const {user}=await authorizeRepository(ctx, args.token, repo._id);
    if ((args.search?.length ?? 0) > 200) throw new Error("Knowledge search is too long");
    const connection = repo.connectionId ? await ctx.db.get(repo.connectionId) : null;
    const source = connection?.organizationId === repo.organizationId ? connection : undefined;
    const search = args.search?.trim().toLowerCase();
    // ponytail: scan compact repository subsystem records; use a search index if this grows beyond Convex read limits.
    const entries = (await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .collect()).filter(entry => !search || [entry.subsystem, entry.description, ...entry.files, ...entry.dependencies, ...entry.risks, ...entry.conventions].some(value => value.toLowerCase().includes(search)));
    const findings = await ctx.db
      .query("findings")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .order("desc")
      .take(100);
    const readable=new Map<Id<"reviews">,Promise<boolean>>();
    const permitted=await Promise.all(findings.map(async finding=>{
      let result=readable.get(finding.reviewId);
      if(!result){result=(async()=>{const review=await ctx.db.get(finding.reviewId);return !!review&&review.repositoryId===repo._id&&review.organizationId===repo.organizationId&&await contextReadable(ctx,user._id,review);})();readable.set(finding.reviewId,result);}
      if(!await result)return false;
      try{await requireFindingReader(ctx,user._id,finding);return true;}catch{return false;}
    }));
    const visibleFindings=findings.filter((_,i)=>permitted[i]);
    return entries.map((entry) => ({
      ...entry,
      sources: entry.files.map(path => {
        try {
          if (repo.connectionId && !source) throw new Error("Provider connection unavailable");
          return { path, url: repositorySourceUrl(source?.kind ?? "github", source?.instance ?? "https://github.com", repo.fullName, entry.sha, path, repo.externalId) };
        } catch { return { path, url: undefined }; }
      }),
      pastFindings: visibleFindings
        .filter((finding) => entry.files.includes(finding.filePath))
        .map((finding) => ({
          id: finding._id,
          title: finding.title,
          status: finding.status,
          prNumber: finding.prNumber,
          reviewId: finding.reviewId,
        })),
    }));
  },
});
