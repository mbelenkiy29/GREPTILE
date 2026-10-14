import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { authorize, authorizeRepository,visibleRepositories,audit } from "./auth";
import { effectiveSettings } from "./scopes";
export const repository = query({
  args: { token: v.string(), repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    await authorizeRepository(ctx, args.token, repo._id);
    const preferences = await ctx.db
      .query("learnedPreferences")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .collect();
    return { repo, settings: await effectiveSettings(ctx, repo), preferences };
  },
});
export const resetPreference = mutation({
  args: { token: v.string(), preferenceId: v.id("learnedPreferences") },
  handler: async (ctx, args) => {
    const preference = await ctx.db.get(args.preferenceId);
    if (!preference) throw new Error("Preference not found");
    const {repo,user}=await authorizeRepository(ctx,args.token,preference.repositoryId,true,true);if(repo.organizationId!==preference.organizationId)throw new Error("Preference scope mismatch");
    await ctx.db.delete(preference._id);
    await audit(ctx,preference.organizationId,user._id,"preference.reset",preference._id);
  },
});
export const preferences=query({args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),search:v.optional(v.string()),status:v.optional(v.union(v.literal("enabled"),v.literal("disabled")))},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId);if((a.search?.length??0)>200)throw new Error("Search is too long");
 const repos=await visibleRepositories(ctx,a.token,a.organizationId,a.teamId);
 if(a.repositoryId&&!repos.some(r=>r._id===a.repositoryId))throw new Error("Repository not accessible");
 const search=a.search?.trim().toLowerCase()??"";
 const groups=await Promise.all(repos.filter(r=>!a.repositoryId||r._id===a.repositoryId).map(async repo=>{
  const records=await ctx.db.query("learnedPreferences").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).collect();
  return Promise.all(records.filter(p=>p.organizationId===a.organizationId&&(!a.status||p.enabled===(a.status==="enabled"))&&[p.instruction,p.category,p.source,repo.fullName].join(" ").toLowerCase().includes(search)).map(async p=>{
   const findingId=p.findingId??ctx.db.normalizeId("findings",p.source),record=findingId?await ctx.db.get(findingId):null;
   const finding=record?.repositoryId===repo._id&&record.organizationId===a.organizationId?record:null;
   const review=p.sourceReviewId?await ctx.db.get(p.sourceReviewId):null;
   const sourceReview=review?.repositoryId===repo._id&&review.organizationId===a.organizationId?{id:review._id,revision:review.headSha,prNumber:review.prNumber}:null;
   const thread=p.conversationId?await ctx.db.get(p.conversationId):null;
   const conversation=thread?.repositoryId===repo._id&&thread.organizationId===a.organizationId?{author:thread.author,question:thread.question,prNumber:thread.prNumber,createdAt:thread.createdAt}:null;
   const history=finding?(await ctx.db.query("findingFeedback").withIndex("by_finding",q=>q.eq("findingId",finding._id)).collect()).filter(f=>f.organizationId===a.organizationId).sort((x,y)=>y.createdAt-x.createdAt):[];
   const feedback=await Promise.all(history.slice(0,20).map(async f=>({id:f._id,value:f.value,comment:f.comment,createdAt:f.createdAt,author:f.githubLogin??(f.userId?(await ctx.db.get(f.userId))?.login:undefined)??"Unknown author",generatedPreference:f._id===p.feedbackId})));
   return {...p,repositoryName:repo.fullName,sourceReview,finding:finding?{title:finding.title,reviewId:finding.reviewId,prNumber:finding.prNumber,status:finding.status,filePath:finding.filePath,startLine:finding.startLine}:null,conversation,feedback,feedbackCount:history.length};
  }));
 }));
 return groups.flat().sort((x,y)=>(y.updatedAt??y.createdAt)-(x.updatedAt??x.createdAt));
}});
export const setPreferenceEnabled=mutation({args:{token:v.string(),preferenceId:v.id("learnedPreferences"),enabled:v.boolean()},handler:async(ctx,a)=>{
 const p=await ctx.db.get(a.preferenceId);if(!p)throw new Error("Preference not found");
 const {repo,user}=await authorizeRepository(ctx,a.token,p.repositoryId,true,true);if(repo.organizationId!==p.organizationId)throw new Error("Preference scope mismatch");
 await ctx.db.patch(p._id,{enabled:a.enabled,updatedAt:Date.now()});await audit(ctx,p.organizationId,user._id,a.enabled?"preference.enabled":"preference.disabled",p._id);
}});
