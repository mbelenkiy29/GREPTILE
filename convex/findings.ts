import { query } from "./_generated/server";
import {requireContextReader,contextReadable,requireFindingReader} from "./repositoryContext";
import { v } from "convex/values";
import { authorize, authorizeRepository, visibleRepositories } from "./auth";
import { executionExplanation } from "../src/execution-claims";
import type {Doc,Id} from "./_generated/dataModel";
import type {QueryCtx} from "./_generated/server";
import { effectiveSettings } from "./scopes";
import { eligibleFixFinding } from "../src/fix-prompt";
import { p4FixAuthority } from "./p4FixAuthority";
function fixEligibility(ctx:QueryCtx,token:string){
 const access=new Map<Id<"repositories">,Promise<{repo:Doc<"repositories">;minimumConfidence:number}|null>>();
 const latest=new Map<string,Promise<Doc<"reviews">|null>>();
 const native=new Map<Id<"reviews">,Promise<boolean>>();
 return async(finding:Doc<"findings">,review:Doc<"reviews">|null)=>{
  if(!review)return false;
  let scope=access.get(finding.repositoryId);
  if(!scope){scope=(async()=>{try{const {repo}=await authorizeRepository(ctx,token,finding.repositoryId,true);return {repo,minimumConfidence:(await effectiveSettings(ctx,repo)).minimumConfidence};}catch{return null;}})();access.set(finding.repositoryId,scope);}
  const writable=await scope;if(!writable)return false;
  const key=finding.repositoryId+":"+finding.prNumber;
  let newest=latest.get(key);
  if(!newest){newest=ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",finding.repositoryId).eq("prNumber",finding.prNumber)).order("desc").first();latest.set(key,newest);}
  if(!eligibleFixFinding(finding,review,(await newest)?._id,writable.minimumConfidence))return false;
  if(!review.nativeP4)return writable.repo.enabled;
  let ready=native.get(review._id);
  if(!ready){ready=p4FixAuthority(ctx,review).then(()=>true,()=>false);native.set(review._id,ready);}
  return ready;
 };
}
function readableExplanation(finding:Doc<"findings">,review:Doc<"reviews">|null){
 const evidence=review?.headSha===finding.commitSha&&review.runtimeEvidence?.headSha===review.headSha?review.runtimeEvidence:undefined;
 return {...finding,title:executionExplanation(finding.title,evidence),description:executionExplanation(finding.description,evidence),impact:executionExplanation(finding.impact,evidence),suggestedFix:executionExplanation(finding.suggestedFix,evidence)};
}
export const get = query({
  args: { token: v.string(), findingId: v.id("findings") },
  handler: async (ctx, args) => {
    const finding = await ctx.db.get(args.findingId);
    if (!finding) throw new Error("Finding not found");
    const reader=await authorizeRepository(ctx, args.token, finding.repositoryId),review=await ctx.db.get(finding.reviewId);if(review)await requireContextReader(ctx,reader.user._id,review);await requireFindingReader(ctx,reader.user._id,finding);
    return {...readableExplanation(finding,review),canFix:await fixEligibility(ctx,args.token)(finding,review)};
  },
});
export const list = query({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    teamId:v.optional(v.id("teams")),
    cursor: v.optional(v.string()),
    repositoryId: v.optional(v.id("repositories")),
    severity: v.optional(v.string()),
    category: v.optional(v.string()),
    status: v.optional(v.string()),
    author: v.optional(v.string()),
    usefulness: v.optional(v.string()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const reader=await authorize(ctx, args.token, args.organizationId);
    const allowed = new Set((await visibleRepositories(ctx,args.token,args.organizationId,args.teamId)).map(r=>String(r._id)));
    if(args.repositoryId&&!allowed.has(args.repositoryId))throw new Error("Repository not accessible in selected scope");
    if(!allowed.size)return {page:[],isDone:true,continueCursor:""};
    const result = await ctx.db
      .query("findings")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.or(...[...allowed].map(id=>q.eq(q.field("repositoryId"),id))),
          args.repositoryId
            ? q.eq(q.field("repositoryId"), args.repositoryId)
            : true,
          args.severity ? q.eq(q.field("severity"), args.severity) : true,
          args.category ? q.eq(q.field("category"), args.category) : true,
          args.status ? q.eq(q.field("status"), args.status) : true,
          args.author ? q.eq(q.field("author"), args.author) : true,
          args.usefulness
            ? q.eq(q.field("lastFeedback"), args.usefulness)
            : true,
          args.since ? q.gte(q.field("createdAt"), args.since) : true,
        ),
      )
      .paginate({ numItems: 30, cursor: args.cursor ?? null });
    const parents=await Promise.all(result.page.map(r=>ctx.db.get(r.reviewId)));
    const permitted=await Promise.all(result.page.map(async (r,i)=>{const review=parents[i];try{await requireFindingReader(ctx,reader.user._id,r);return !review||await contextReadable(ctx,reader.user._id,review);}catch{return false;}}));
    const canFix=fixEligibility(ctx,args.token);
    const page=await Promise.all(result.page.map(async(r,i)=>allowed.has(r.repositoryId)&&permitted[i]?{...readableExplanation(r,parents[i]),canFix:await canFix(r,parents[i])}:null));
    return {...result,page:page.filter(r=>r!==null)};
  },
});
