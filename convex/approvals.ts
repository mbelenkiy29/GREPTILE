import {mutation,query,internalMutation,internalQuery} from "./_generated/server";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import {authorize,authorizeRepository,audit} from "./auth";
import {approvalPolicyValidator} from "./schema";
import {approvalDefaults,approvalPolicySchema,approvalPolicyKey} from "../src/approval";
import {runtimePolicy} from "./runtime";
import {runtimePolicyKey} from "../src/runtime-policy";
import {requireContextReader} from "./repositoryContext";
export async function approvalPolicy(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">){
 const policies=await ctx.db.query("approvalPolicies").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect();
 return policies.find(p=>p.repositoryId===repo._id)?.policy??policies.find(p=>!p.repositoryId&&p.teamId===repo.teamId&&p.teamId)?.policy??policies.find(p=>!p.repositoryId&&!p.teamId)?.policy??approvalDefaults;
}
export const settings=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 const repositories=await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect(),repositoryIds=[];
 for(const repo of repositories){const c=repo.connectionId?await ctx.db.get(repo.connectionId):null;if((!repo.connectionId&&repo.installationId)||(c?.active&&!c.suspended&&["github-enterprise","gitea","gitlab","origin","bitbucket-cloud","bitbucket-dc"].includes(c.kind)))repositoryIds.push(repo._id);}
 return {policies:await ctx.db.query("approvalPolicies").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect(),repositoryIds};
}});
export const save=mutation({args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),policy:approvalPolicyValidator,inherit:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(a.repositoryId&&a.teamId)throw new Error("Choose a team or repository scope");
 if(a.teamId&&(await ctx.db.get(a.teamId))?.organizationId!==a.organizationId)throw new Error("Team belongs to another workspace");
 if(a.repositoryId){
  const {repo}=await authorizeRepository(ctx,a.token,a.repositoryId,true,true);
  if(repo.organizationId!==a.organizationId)throw new Error("Repository belongs to another workspace");
  const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
  if(!a.inherit&&a.policy.enabled&&connection?.kind==="perforce")throw new Error("Automatic approval is unavailable for Perforce; native transitions are not revision guarded");
 }
 const policy=approvalPolicySchema.parse(a.policy),old=(await ctx.db.query("approvalPolicies").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect()).find(p=>p.repositoryId===a.repositoryId&&p.teamId===a.teamId);
 if(a.inherit){if(!a.teamId&&!a.repositoryId)throw new Error("Organization defaults have no parent");if(old)await ctx.db.delete(old._id);}
 else if(old)await ctx.db.patch(old._id,{policy,updatedAt:Date.now()});
 else await ctx.db.insert("approvalPolicies",{organizationId:a.organizationId,teamId:a.teamId,repositoryId:a.repositoryId,policy,updatedAt:Date.now()});
 await audit(ctx,a.organizationId,user._id,"approval.policy_changed",a.repositoryId??a.teamId??a.organizationId);
 // Existing approvals are checked against the new inherited policy by the sweep.
 await ctx.scheduler.runAfter(0,internal.approvals.sweep,{});
 await ctx.scheduler.runAfter(0,internal.approvals.policyRecheck,{organizationId:a.organizationId,repositoryId:a.repositoryId,teamId:a.teamId});
}});
export const request=internalMutation({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
 const review=await ctx.db.get(a.reviewId);if(!review||review.status!=="completed")return null;
 const repo=await ctx.db.get(review.repositoryId);if(!repo?.enabled)return null;
 const policy=await approvalPolicy(ctx,repo);if(!policy.enabled)return null;
 let job=await ctx.db.query("approvalJobs").withIndex("by_review",q=>q.eq("reviewId",review._id)).unique();
 if(!job){const id=await ctx.db.insert("approvalJobs",{organizationId:repo.organizationId,repositoryId:repo._id,reviewId:review._id,prNumber:review.prNumber,headSha:review.headSha,policyKey:approvalPolicyKey(policy),status:"pending",reasons:[],createdAt:Date.now(),updatedAt:Date.now()});job=await ctx.db.get(id);}
 if(job&&job.status!=="evaluating")await ctx.scheduler.runAfter(0,internal.approvalJobs.process,{id:job._id});return job?._id??null;
}});
export const data=internalQuery({args:{id:v.id("approvalJobs")},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job)throw new Error("Approval job missing");
 const repo=await ctx.db.get(job.repositoryId),review=await ctx.db.get(job.reviewId);if(!repo||!review)throw new Error("Approval source missing");
 const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",repo._id).eq("prNumber",review.prNumber)).order("desc").first();
 const findings=await ctx.db.query("findings").withIndex("by_pr",q=>q.eq("repositoryId",repo._id).eq("prNumber",review.prNumber)).collect();
 const policy=await approvalPolicy(ctx,repo),runtime=await runtimePolicy(ctx,repo),run=await ctx.db.query("runtimeJobs").withIndex("by_review",q=>q.eq("reviewId",review._id)).order("desc").first();
 const runtimePassed=runtime.enabled&&run?.status==="passed"&&run.policyKey===runtimePolicyKey(runtime)&&run.headSha===review.headSha&&run.revisionKey===review.revisionKey&&run.evidence?.executionStarted===true&&run.evidence.exitCode===0&&!run.evidence.timedOut;
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 return {job,repo,review,providerKind:connection?.kind,latest:latest?._id===review._id,unresolved:findings.filter(f=>f.status==="open").length,policy,runtimeRequired:runtime.requiredForApproval,runtimePassed:Boolean(runtimePassed)};
}});
export const claim=internalMutation({args:{id:v.id("approvalJobs"),lease:v.string()},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.status==="invalidated"||(["evaluating","revocation_pending"].includes(job.status)&&(job.leaseExpiresAt??0)>Date.now()))return false;
 await ctx.db.patch(job._id,{status:job.status==="revocation_pending"||job.status==="failed"&&job.providerReviewId!==undefined?"revocation_pending":"evaluating",lease:a.lease,leaseExpiresAt:Date.now()+300000,updatedAt:Date.now()});return true;
}});
export const beforePublish=internalMutation({args:{id:v.id("approvalJobs"),lease:v.string(),policyKey:v.string()},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.status!=="evaluating"||job.lease!==a.lease||(job.leaseExpiresAt??0)<=Date.now())throw new Error("Approval lease expired");
 const state=await ctx.runQuery(internal.approvals.data,{id:a.id});
 if(!state.repo.enabled||!state.latest||state.review.status!=="completed"||state.unresolved||!state.policy.enabled||approvalPolicyKey(state.policy)!==a.policyKey||(state.runtimeRequired&&!state.runtimePassed)||!state.review.coverageLimits||state.review.coverageLimits.length||state.review.approvalAssessment?.confidence!==1)throw new Error("Trusted approval state changed");
 await ctx.db.patch(job._id,{policyKey:a.policyKey});
}});
// Persist the receipt before any post-publication reads; recovery must retain native withdrawal intent.
export const recordPublished=internalMutation({args:{id:v.id("approvalJobs"),lease:v.string(),providerReviewId:v.union(v.number(),v.string())},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.status!=="evaluating"||job.lease!==a.lease||(job.leaseExpiresAt??0)<=Date.now())throw new Error("Approval lease expired");
 if(job.providerReviewId!==undefined&&job.providerReviewId!==a.providerReviewId)throw new Error("Approval receipt changed");
 await ctx.db.patch(job._id,{providerReviewId:a.providerReviewId,updatedAt:Date.now()});
}});
export const finish=internalMutation({args:{id:v.id("approvalJobs"),lease:v.string(),status:v.string(),reasons:v.array(v.string()),providerReviewId:v.optional(v.union(v.number(),v.string()))},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.lease!==a.lease)return;
 await ctx.db.patch(job._id,{status:job.status==="revocation_pending"&&a.status==="failed"?"revocation_pending":a.status,reasons:a.reasons,providerReviewId:a.providerReviewId??job.providerReviewId,lease:undefined,leaseExpiresAt:undefined,updatedAt:Date.now()});
 await audit(ctx,job.organizationId,undefined,"approval."+a.status,job._id);
}});
export const forChange=internalMutation({args:{repositoryId:v.id("repositories"),prNumber:v.number()},handler:async(ctx,a)=>{
 const jobs=await ctx.db.query("approvalJobs").withIndex("by_repo_pr",q=>q.eq("repositoryId",a.repositoryId).eq("prNumber",a.prNumber)).collect();
 for(const j of jobs)if(j.status!=="invalidated")await ctx.scheduler.runAfter(0,internal.approvalJobs.process,{id:j._id});
}});
export const forRevision=internalMutation({args:{repositoryId:v.id("repositories"),headSha:v.string()},handler:async(ctx,a)=>{
 const jobs=await ctx.db.query("approvalJobs").withIndex("by_repo_pr",q=>q.eq("repositoryId",a.repositoryId)).collect();
 for(const job of jobs)if(job.headSha===a.headSha&&job.status!=="invalidated")await ctx.scheduler.runAfter(0,internal.approvalJobs.process,{id:job._id});
}});
const sweptStatuses=["approved","pending","failed","waiting_checks","evaluating","revocation_pending"] as const;
const sweptStatus=v.union(...sweptStatuses.map(status=>v.literal(status)));
export const sweep=internalMutation({args:{},handler:async(ctx)=>{
 for(const status of sweptStatuses)await ctx.scheduler.runAfter(0,internal.approvals.sweepStatus,{status});
}});
export const sweepStatus=internalMutation({args:{status:sweptStatus,cursor:v.optional(v.string())},handler:async(ctx,a)=>{
 const page=await ctx.db.query("approvalJobs").withIndex("by_status",q=>q.eq("status",a.status)).order("asc").paginate({numItems:100,cursor:a.cursor??null});
 for(const job of page.page)if(!["evaluating","revocation_pending"].includes(job.status)||(job.leaseExpiresAt??0)<=Date.now())await ctx.scheduler.runAfter(0,internal.approvalJobs.process,{id:job._id});
 if(!page.isDone)await ctx.scheduler.runAfter(0,internal.approvals.sweepStatus,{status:a.status,cursor:page.continueCursor});
}});
// Blocked jobs do not need periodic provider reads, but trusted policy edits must refresh them.
export const policyRecheck=internalMutation({args:{organizationId:v.id("organizations"),repositoryId:v.optional(v.id("repositories")),teamId:v.optional(v.id("teams")),cursor:v.optional(v.string())},handler:async(ctx,a)=>{
 const page=await ctx.db.query("approvalJobs").withIndex("by_org_status",q=>q.eq("organizationId",a.organizationId).eq("status","blocked")).paginate({numItems:100,cursor:a.cursor??null});
 for(const job of page.page){
  if(a.repositoryId&&job.repositoryId!==a.repositoryId)continue;
  const repo=await ctx.db.get(job.repositoryId);
  if(!repo||repo.organizationId!==a.organizationId||(a.teamId&&repo.teamId!==a.teamId))continue;
  await ctx.scheduler.runAfter(0,internal.approvalJobs.process,{id:job._id});
 }
 if(!page.isDone)await ctx.scheduler.runAfter(0,internal.approvals.policyRecheck,{...a,cursor:page.continueCursor});
}});
export const review=query({args:{token:v.string(),reviewId:v.id("reviews")},handler:async(ctx,a)=>{const r=await ctx.db.get(a.reviewId);if(!r)throw new Error("Review missing");const reader=await authorizeRepository(ctx,a.token,r.repositoryId);await requireContextReader(ctx,reader.user._id,r);return ctx.db.query("approvalJobs").withIndex("by_review",q=>q.eq("reviewId",r._id)).unique();}});
