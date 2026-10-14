import {internalMutation,internalQuery,mutation} from "./_generated/server";
import {v} from "convex/values";
import {internal} from "./_generated/api";
import {p4Baseline} from "./p4Index";
import {connectionDigest} from "./indexAuthority";
import {effectiveSettings} from "./scopes";
import {cancelReview} from "./reviewLifecycle";
import {p4PollingReference} from "./schema";
import {p4PollingAuthority,p4AutomaticAuthority} from "./p4Polling";
import picomatch from "picomatch";
import {rateLimit} from "./rateLimit";
import {authorize} from "./auth";

export const retryPublication=mutation({args:{token:v.string(),reviewId:v.id("reviews")},handler:async(ctx,a)=>{
 const review=await ctx.db.get(a.reviewId);
 if(!review?.nativeP4||review.status!=="failed"||!review.resultStorageId||(review.nativeP4.lease?.expiresAt??0)>Date.now())throw new Error("No failed saved P4 publication to retry");
 await authorize(ctx,a.token,review.organizationId,true);
 const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",review.repositoryId).eq("prNumber",review.prNumber)).order("desc").first();
 if(latest?._id!==review._id)throw new Error("P4 review superseded; inspect the current revision");
 const baseline=await p4Baseline(ctx,{repositoryId:review.repositoryId,requestedBy:review.nativeP4.requestedBy,baselineJobId:review.nativeP4.baselineJobId});
 if(baseline.connection._id!==review.nativeP4.connectionId||await connectionDigest(baseline.connection.credentials)!==review.nativeP4.credentialDigest||baseline.job.sha!==review.baseSha)throw new Error("P4 review baseline or credentials changed");
 if(review.nativeP4.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);
 await rateLimit(ctx,`review:${review.organizationId}`,20);
 const retryScheduledId=await ctx.scheduler.runAfter(0,internal.jobs.review,{reviewId:review._id}),now=Date.now();
 await ctx.db.patch(review._id,{status:"queued",attempts:0,error:undefined,finishedAt:undefined,updatedAt:now,retryAt:now,retryScheduledId});
 return review._id;
}});

export const enqueue=internalMutation({args:{repositoryId:v.id("repositories"),requestedBy:v.id("users"),nativeNumber:v.number(),revision:v.string(),baseRevision:v.string(),baselineJobId:v.id("indexJobs"),inputStorageId:v.id("_storage"),credentialDigest:v.string(),connectionId:v.id("providerConnections"),force:v.optional(v.boolean()),polling:v.optional(p4PollingReference),pollLease:v.optional(v.string()),branches:v.optional(v.array(v.string()))},handler:async(ctx,a)=>{
 const baseline=await p4Baseline(ctx,a);
 if(!Number.isSafeInteger(a.nativeNumber)||a.nativeNumber<1||!a.revision.startsWith(`p4:${a.nativeNumber}:`)||baseline.job.sha!==a.baseRevision||baseline.connection._id!==a.connectionId||await connectionDigest(baseline.connection.credentials)!==a.credentialDigest)throw new Error("P4 prepared review identity changed");
 const settings=await effectiveSettings(ctx,baseline.repo);
 if(a.polling){
  if(!a.pollLease)throw new Error("P4 polling worker lease required");
  const {poll}=await p4PollingAuthority(ctx,a.polling.id,a.polling.generation,a.pollLease);
  if(poll.repositoryId!==a.repositoryId||poll.requestedBy!==a.requestedBy||poll.baselineJobId!==a.baselineJobId||!settings.automatic||!a.branches?.length||settings.targetBranches.length&&!a.branches.some(b=>picomatch(settings.targetBranches)(b))||a.branches.some(b=>picomatch(settings.ignoredBranches)(b)))throw new Error("P4 automatic review policy or authority changed");
 }
 const previous=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",a.repositoryId).eq("prNumber",a.nativeNumber)).order("desc").first();
 if(previous?.nativeP4&&previous.headSha===a.revision&&previous.baseSha===a.baseRevision&&!a.force&&!["failed","cancelled"].includes(previous.status)){await ctx.storage.delete(a.inputStorageId);return previous._id;}
 if(a.polling&&previous&&!settings.rereview)throw new Error("P4 automatic re-review disabled");
 await rateLimit(ctx,`review:${baseline.repo.organizationId}`,20);
 for(const pending of await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",a.repositoryId).eq("prNumber",a.nativeNumber)).collect())if(!["completed","failed","cancelled"].includes(pending.status))await cancelReview(ctx,pending);
 const now=Date.now();
 const id=await ctx.db.insert("reviews",{organizationId:baseline.repo.organizationId,repositoryId:a.repositoryId,prNumber:a.nativeNumber,headSha:a.revision,revisionKey:a.revision,baseSha:a.baseRevision,status:"queued",mode:settings.mode,attempts:0,createdAt:now,updatedAt:now,nativeP4:{requestedBy:a.requestedBy,connectionId:a.connectionId,credentialDigest:a.credentialDigest,baselineJobId:a.baselineJobId,inputStorageId:a.inputStorageId,...(a.polling?{polling:a.polling}:{})}});
 await ctx.scheduler.runAfter(0,internal.jobs.review,{reviewId:id});return id;
}});
export const claim=internalMutation({args:{reviewId:v.id("reviews"),leaseId:v.string()},handler:async(ctx,a):Promise<boolean>=>{
 const review=await ctx.db.get(a.reviewId);
 if(!review?.nativeP4||["completed","cancelled"].includes(review.status)||(review.nativeP4.lease?.expiresAt??0)>Date.now())return false;
 if(!await ctx.runMutation(internal.reviews.stage,{reviewId:a.reviewId,status:"ingesting"}))return false;
 await ctx.db.patch(review._id,{nativeP4:{...review.nativeP4,lease:{id:a.leaseId,expiresAt:Date.now()+15*60000}}});return true;
}});
export const finish=internalMutation({args:{reviewId:v.id("reviews"),leaseId:v.string(),error:v.optional(v.string()),githubReviewId:v.optional(v.number()),comments:v.optional(v.array(v.object({id:v.number(),fingerprint:v.string()})))},handler:async(ctx,a):Promise<boolean>=>{
 const review=await ctx.db.get(a.reviewId);if(!review?.nativeP4||review.nativeP4.lease?.id!==a.leaseId||review.nativeP4.lease.expiresAt<=Date.now())return false;
 if(!a.error&&review.status!=='cancelled'){
  if(review.nativeP4.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);
  await p4Baseline(ctx,{repositoryId:review.repositoryId,requestedBy:review.nativeP4.requestedBy,baselineJobId:review.nativeP4.baselineJobId});
 }
 const {leaseId,...result}=a;void leaseId;
 await ctx.runMutation(internal.reviews.finished,result);
 await ctx.db.patch(review._id,{nativeP4:{...review.nativeP4,lease:undefined}});return true;
}});
export const data=internalQuery({args:{reviewId:v.id("reviews"),leaseId:v.optional(v.string())},handler:async(ctx,a)=>{
 const review=await ctx.db.get(a.reviewId);if(!review?.nativeP4)throw new Error("P4 review unavailable");
 if(a.leaseId&&(review.nativeP4.lease?.id!==a.leaseId||review.nativeP4.lease.expiresAt<=Date.now()))throw new Error("P4 review worker lease expired or replaced");
 if(review.nativeP4.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);
 const baseline=await p4Baseline(ctx,{repositoryId:review.repositoryId,requestedBy:review.nativeP4.requestedBy,baselineJobId:review.nativeP4.baselineJobId});
 if(baseline.connection._id!==review.nativeP4.connectionId||await connectionDigest(baseline.connection.credentials)!==review.nativeP4.credentialDigest||baseline.job.sha!==review.baseSha)throw new Error("P4 review baseline or credentials changed");
 return {...baseline,review};
}});
