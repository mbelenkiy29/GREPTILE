import { mutation,query,internalMutation,internalQuery } from "./_generated/server";
import { chargeCredits } from "./billing";
import type { QueryCtx,MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v,ConvexError } from "convex/values";
import { authorize,authorizeRepository,audit } from "./auth";
import { runtimePolicyValidator,runtimeEvidenceValidator } from "./schema";
import { runtimeDefaults,runtimePolicySchema,runtimePolicyKey,generatedTestsKey } from "../src/runtime-policy";
import { testCommand } from "../src/generated-tests";
import { runtimeEvidenceSchema } from "../src/engine/types";
import { redact } from "../src/redact";
import { rateLimit } from "./rateLimit";
import { requireP4Worker } from "./reviewLifecycle";
import { p4FixAuthority } from "./p4FixAuthority";
import { p4AutomaticAuthority } from "./p4Polling";

export async function runtimePolicy(ctx:QueryCtx|MutationCtx,repo:Doc<"repositories">){
 const policies=await ctx.db.query("runtimePolicies").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect();
 return policies.find(p=>p.repositoryId===repo._id)?.policy??policies.find(p=>!p.repositoryId&&p.teamId===repo.teamId&&p.teamId)?.policy??policies.find(p=>!p.repositoryId&&!p.teamId)?.policy??runtimeDefaults;
}
export const settings=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 return {policies:await ctx.db.query("runtimePolicies").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect(),workers:(await ctx.db.query("runtimeWorkers").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect()).map(w=>({_id:w._id,name:w.name,expiresAt:w.expiresAt,revoked:w.revoked,lastSeen:w.lastSeen}))};
}});
export const save=mutation({args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),policy:runtimePolicyValidator,inherit:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(a.teamId&&a.repositoryId)throw new Error("Choose a team or repository scope");
 if(a.teamId&&(await ctx.db.get(a.teamId))?.organizationId!==a.organizationId)throw new Error("Team belongs to another workspace");
 if(a.repositoryId&&(await authorizeRepository(ctx,a.token,a.repositoryId,true,true)).repo.organizationId!==a.organizationId)throw new Error("Repository belongs to another workspace");
 const policy=runtimePolicySchema.parse(a.policy),old=(await ctx.db.query("runtimePolicies").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect()).find(p=>p.repositoryId===a.repositoryId&&p.teamId===a.teamId);
 if(a.inherit){if(!a.repositoryId&&!a.teamId)throw new Error("Organization defaults have no parent");if(old)await ctx.db.delete(old._id);}
 else if(old)await ctx.db.patch(old._id,{policy,updatedAt:Date.now()});
 else await ctx.db.insert("runtimePolicies",{organizationId:a.organizationId,teamId:a.teamId,repositoryId:a.repositoryId,policy,updatedAt:Date.now()});
 await audit(ctx,a.organizationId,user._id,"runtime.policy_changed",a.repositoryId??a.teamId??a.organizationId);
 await ctx.scheduler.runAfter(0,internal.approvals.sweep,{});
}});
export const worker=mutation({args:{token:v.string(),organizationId:v.id("organizations"),name:v.string(),hash:v.string()},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!a.name.trim()||a.name.length>100||! /^[a-f0-9]{64}$/.test(a.hash))throw new Error("Invalid worker credential");
 await rateLimit(ctx,"runtime-worker:"+a.organizationId,5);
 if(await ctx.db.query("runtimeWorkers").withIndex("by_hash",q=>q.eq("tokenHash",a.hash)).unique())throw new Error("Worker credential already registered");
 const id=await ctx.db.insert("runtimeWorkers",{organizationId:a.organizationId,name:a.name.trim(),tokenHash:a.hash,expiresAt:Date.now()+90*86400000,revoked:false,createdAt:Date.now()});
 await audit(ctx,a.organizationId,user._id,"runtime.worker_created",id);return id;
}});
export const revoke=mutation({args:{token:v.string(),workerId:v.id("runtimeWorkers")},handler:async(ctx,a)=>{const w=await ctx.db.get(a.workerId);if(!w)throw new Error("Worker missing");const {user}=await authorize(ctx,a.token,w.organizationId,true);await ctx.db.patch(w._id,{revoked:true});await audit(ctx,w.organizationId,user._id,"runtime.worker_revoked",w._id);}});
export const request=internalMutation({args:{reviewId:v.id("reviews"),workerLease:v.optional(v.string())},handler:async(ctx,a)=>{
 const review=await ctx.db.get(a.reviewId);if(!review||["cancelled","completed","failed"].includes(review.status))return false;
 const repo=await ctx.db.get(review.repositoryId);if(!repo||!repo.enabled&&!review.nativeP4)return false;
 const policy=await runtimePolicy(ctx,repo);if(!policy.enabled)return false;
 requireP4Worker(review,a.workerLease);
 const waitForRuntime=async()=>{await ctx.db.patch(review._id,{status:"waiting_runtime",updatedAt:Date.now(),...(review.nativeP4?{nativeP4:{...review.nativeP4,lease:undefined}}:{})});};
 const key=runtimePolicyKey(policy),old=(await ctx.db.query("runtimeJobs").withIndex("by_review",q=>q.eq("reviewId",review._id)).order("desc").take(20)).find(j=>j.kind!=="tests");
 if(old&&old.policyKey===key){const wait=["preparing","fetching","queued","running"].includes(old.status);if(wait)await waitForRuntime();return wait;}
 if(old&&["preparing","fetching","queued","running"].includes(old.status))await ctx.db.patch(old._id,{status:"cancelled",error:"Runtime policy changed",updatedAt:Date.now()});
 const online=(await ctx.db.query("runtimeWorkers").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect()).some(w=>!w.revoked&&w.expiresAt>Date.now()&&(w.lastSeen??0)>Date.now()-120000);
 const id=await ctx.db.insert("runtimeJobs",{organizationId:repo.organizationId,repositoryId:repo._id,reviewId:review._id,headSha:review.headSha,revisionKey:review.revisionKey,policy,policyKey:key,status:online?"preparing":"unavailable",error:online?undefined:"No connected runtime worker. Start an approved worker and re-review.",attempts:0,createdAt:Date.now(),updatedAt:Date.now()});
 if(!online)return false;
 await waitForRuntime();
 await ctx.scheduler.runAfter(0,internal.runtimeJobs.prepare,{id});return true;
}});
const workerOnline=async(ctx:MutationCtx,organizationId:Doc<"repositories">["organizationId"])=>(await ctx.db.query("runtimeWorkers").withIndex("by_org",q=>q.eq("organizationId",organizationId)).collect()).some(w=>!w.revoked&&w.expiresAt>Date.now()&&(w.lastSeen??0)>Date.now()-120000);
// Generated reproduction tests for verified findings: one job per review, on the approved image and
// test command template. The review waits like a runtime check and resumes when results arrive.
export const requestTests=internalMutation({args:{reviewId:v.id("reviews"),tests:v.array(v.object({fingerprint:v.string(),path:v.string(),content:v.string()}))},handler:async(ctx,a)=>{
 const review=await ctx.db.get(a.reviewId);if(!review||["cancelled","completed","failed"].includes(review.status)||review.nativeP4||!a.tests.length)return false;
 const repo=await ctx.db.get(review.repositoryId);if(!repo?.enabled)return false;
 const policy=await runtimePolicy(ctx,repo);if(!policy.generatedTests||!policy.testCommand)return false;
 if((await ctx.db.query("runtimeJobs").withIndex("by_review",q=>q.eq("reviewId",review._id)).collect()).some(j=>j.kind==="tests"))return false;
 if(!await workerOnline(ctx,repo.organizationId))return false;
 // Generated tests make this a generated-test review (M1 credits); without credits the review goes on untested.
 if(!(await chargeCredits(ctx,repo.organizationId,"generated-tests")).allowed)return false;
 const tests=a.tests.slice(0,3).map(t=>({...t,command:testCommand(policy.testCommand!,t.path)}));
 const id=await ctx.db.insert("runtimeJobs",{organizationId:repo.organizationId,repositoryId:repo._id,reviewId:review._id,headSha:review.headSha,revisionKey:review.revisionKey,policy,policyKey:generatedTestsKey(policy),kind:"tests",tests,status:"preparing",attempts:0,createdAt:Date.now(),updatedAt:Date.now()});
 await ctx.db.patch(review._id,{status:"waiting_runtime",updatedAt:Date.now()});
 await ctx.scheduler.runAfter(0,internal.runtimeJobs.prepare,{id});
 return true;
}});
export const testsEnabled=internalQuery({args:{repositoryId:v.id("repositories")},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo?.enabled)return false;
 const policy=await runtimePolicy(ctx,repo);
 return !!policy.generatedTests&&!!policy.testCommand&&(await ctx.db.query("runtimeWorkers").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect()).some(w=>!w.revoked&&w.expiresAt>Date.now()&&(w.lastSeen??0)>Date.now()-120000);
}});
// The latest generated-test job for a review, with its recorded results (empty when none ran).
export const generatedTests=internalQuery({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
 const job=(await ctx.db.query("runtimeJobs").withIndex("by_review",q=>q.eq("reviewId",a.reviewId)).order("desc").take(20)).find(j=>j.kind==="tests");
 if(!job||["preparing","fetching","queued","running"].includes(job.status))return null;
 return {status:job.status,error:job.error,tests:(job.tests??[]).map(t=>({...t,...job.testResults?.find(r=>r.fingerprint===t.fingerprint)}))};
}});
const jobKey=(job:Pick<Doc<"runtimeJobs">,"kind">,policy:Parameters<typeof runtimePolicyKey>[0])=>job.kind==="tests"?generatedTestsKey(policy):runtimePolicyKey(policy);
export const data=internalQuery({args:{id:v.id("runtimeJobs")},handler:async(ctx,a)=>{const job=await ctx.db.get(a.id);if(!job)throw new Error("Runtime job missing");const repo=await ctx.db.get(job.repositoryId);if(!repo)throw new Error("Repository missing");return {job,repo};}});
export const preparing=internalMutation({args:{id:v.id("runtimeJobs")},handler:async(ctx,a)=>{const job=await ctx.db.get(a.id);if(job?.status!=="preparing")return false;await ctx.db.patch(job._id,{status:"fetching",updatedAt:Date.now()});return true;}});
export const ready=internalMutation({args:{id:v.id("runtimeJobs"),sourceStorageId:v.id("_storage")},handler:async(ctx,a)=>{const job=await ctx.db.get(a.id);if(job?.status!=="fetching"){await ctx.storage.delete(a.sourceStorageId);return;}await ctx.db.patch(job._id,{sourceStorageId:a.sourceStorageId,status:"queued",updatedAt:Date.now()});}});
async function workerIdentity(ctx:QueryCtx|MutationCtx,hash:string){
 const worker=await ctx.db.query("runtimeWorkers").withIndex("by_hash",q=>q.eq("tokenHash",hash)).unique();
 if(!worker||worker.revoked||worker.expiresAt<=Date.now())throw new ConvexError({code:"RUNTIME_WORKER_CREDENTIAL_REJECTED",message:"Runtime worker credential expired or revoked"});return worker;
}
export const claim=internalMutation({args:{hash:v.string(),lease:v.string()},handler:async(ctx,a)=>{
 const worker=await workerIdentity(ctx,a.hash);if(!/^[a-f0-9-]{36}$/.test(a.lease))throw new Error("Invalid lease");
 await rateLimit(ctx,"runtime-poll:"+worker._id,30);await ctx.db.patch(worker._id,{lastSeen:Date.now()});
 const job=await ctx.db.query("runtimeJobs").withIndex("by_org_status",q=>q.eq("organizationId",worker.organizationId).eq("status","queued")).first();if(!job)return null;
 const review=await ctx.db.get(job.reviewId),repo=await ctx.db.get(job.repositoryId),latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",job.repositoryId).eq("prNumber",review?.prNumber??-1)).order("desc").first();
 if(!repo||!review||!repo.enabled&&!review.nativeP4||review.status!=="waiting_runtime"||latest?._id!==review._id||jobKey(job,await runtimePolicy(ctx,repo))!==job.policyKey){await completeJob(ctx,job,"cancelled","Review revision or trusted runtime policy changed");return null;}
 if(review.nativeP4){try{await p4FixAuthority(ctx,review);if(review.nativeP4.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);}catch{await completeJob(ctx,job,"cancelled","P4 runtime baseline or authority changed");return null;}}
 // Generated tests run one after another, each within the approved timeout.
 await ctx.db.patch(job._id,{status:"running",workerId:worker._id,lease:a.lease,leaseExpiresAt:Date.now()+(job.policy.timeout*Math.max(1,job.tests?.length??1)+300)*1000,attempts:job.attempts+1,updatedAt:Date.now()});
 return {id:job._id,headSha:job.headSha,repository:repo.fullName,image:job.policy.image,command:job.kind==="tests"?job.policy.testCommand??"":job.policy.command,timeout:job.policy.timeout,...(job.kind==="tests"?{kind:"tests" as const,tests:job.tests??[]}:{})};
}});
export const authenticatedJob=internalQuery({args:{hash:v.string(),id:v.id("runtimeJobs"),lease:v.string(),source:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const worker=await workerIdentity(ctx,a.hash),job=await ctx.db.get(a.id);
 if(!job||job.organizationId!==worker.organizationId||job.workerId!==worker._id||job.status!=="running"||job.lease!==a.lease||(job.leaseExpiresAt??0)<=Date.now())throw new Error("Runtime lease expired, replayed, or unauthorized");
 if(a.source){const repo=await ctx.db.get(job.repositoryId),review=await ctx.db.get(job.reviewId);if(!repo||!review||!repo.enabled&&!review.nativeP4||review.status!=="waiting_runtime"||jobKey(job,await runtimePolicy(ctx,repo))!==job.policyKey)throw new Error("Runtime source authorization or trusted policy changed");}
 if(a.source){const review=await ctx.db.get(job.reviewId);if(review?.nativeP4){await p4FixAuthority(ctx,review);if(review.nativeP4.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);}}
 return job;
}});
export const heartbeat=internalMutation({args:{hash:v.string(),id:v.id("runtimeJobs"),lease:v.string()},handler:async(ctx,a)=>{
 const job=await ctx.runQuery(internal.runtime.authenticatedJob,a);
 if(!job.workerId)throw new Error("Runtime worker missing");
 await rateLimit(ctx,"runtime-poll:"+job.workerId,30);
 await ctx.db.patch(job.workerId,{lastSeen:Date.now()});
 // The execution deadline stays fixed; heartbeats do not renew job leases.
}});
async function completeJob(ctx:MutationCtx,job:Doc<"runtimeJobs">,status:string,error?:string,evidence?:Doc<"runtimeJobs">["evidence"],testResults?:Doc<"runtimeJobs">["testResults"]){
 await ctx.db.patch(job._id,{status,error,evidence,testResults,sourceStorageId:undefined,lease:undefined,leaseExpiresAt:undefined,updatedAt:Date.now()});
 if(job.sourceStorageId)await ctx.storage.delete(job.sourceStorageId);
 const review=await ctx.db.get(job.reviewId);
 if(review?.status==="waiting_runtime"){
  // Generated-test results attach to findings, never to the review's runtime evidence.
  if(job.kind!=="tests")await ctx.db.patch(review._id,{runtimeEvidence:status==="cancelled"?undefined:evidence,updatedAt:Date.now()});
  await ctx.scheduler.runAfter(0,internal.jobs.review,{reviewId:review._id});
 }
}
const testResultValidator=v.array(v.object({fingerprint:v.string(),evidence:v.optional(runtimeEvidenceValidator),error:v.optional(v.string())}));
export const complete=internalMutation({args:{id:v.id("runtimeJobs"),hash:v.optional(v.string()),lease:v.optional(v.string()),error:v.optional(v.string()),evidence:v.optional(runtimeEvidenceValidator),tests:v.optional(testResultValidator),stale:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||!["preparing","fetching","queued","running"].includes(job.status))return;
 if(job.status==="running"){const worker=await workerIdentity(ctx,a.hash??"");if(job.workerId!==worker._id||job.lease!==a.lease||(job.leaseExpiresAt??0)<=Date.now())throw new Error("Invalid runtime lease");}
 if(job.kind==="tests"){
  // Each result must match its own test's approved command, the job image and revision.
  const results=(a.tests??[]).filter(r=>job.tests?.some(t=>t.fingerprint===r.fingerprint)).map(r=>{
   const evidence=r.evidence?runtimeEvidenceSchema.parse(r.evidence):undefined,test=job.tests!.find(t=>t.fingerprint===r.fingerprint)!;
   if(evidence&&(evidence.headSha!==job.headSha||evidence.image!==job.policy.image||evidence.command!==test.command))throw new Error("Generated test evidence does not match the approved job");
   return {fingerprint:r.fingerprint,...(evidence?{evidence:{...evidence,output:redact(evidence.output).slice(-8000)}}:{}),...(r.error?{error:redact(r.error).slice(0,1000)}:{})};
  });
  const repo=await ctx.db.get(job.repositoryId),current=repo&&generatedTestsKey(await runtimePolicy(ctx,repo))===job.policyKey;
  await completeJob(ctx,job,a.stale||!current?"cancelled":results.length?"completed":"failed",a.stale||!current?"Review revision or trusted runtime policy changed":a.error,undefined,a.stale||!current?undefined:results);
  return;
 }
 const evidence=a.evidence?runtimeEvidenceSchema.parse(a.evidence):undefined;
 if(evidence&&(evidence.headSha!==job.headSha||evidence.image!==job.policy.image||evidence.command!==job.policy.command))throw new Error("Runtime evidence does not match the approved job");
 const sanitized=evidence?{...evidence,output:redact(evidence.output)}:undefined;
 const repo=await ctx.db.get(job.repositoryId),policyMatches=repo&&runtimePolicyKey(await runtimePolicy(ctx,repo))===job.policyKey;
 let nativeAuthority=true;
 const review=await ctx.db.get(job.reviewId);
 if(review?.nativeP4){try{await p4FixAuthority(ctx,review);if(review.nativeP4.polling)await p4AutomaticAuthority(ctx,review.repositoryId,review.nativeP4.polling);}catch{nativeAuthority=false;}}
 if(a.stale||!policyMatches||!nativeAuthority){await completeJob(ctx,job,"cancelled","Review revision or trusted runtime policy changed",sanitized);return;}
 await completeJob(ctx,job,evidence?.timedOut?"timed_out":evidence?.executionStarted&&evidence.exitCode===0?"passed":"failed",a.error,sanitized);
}});
const recoveryStatuses=["preparing","fetching","queued","running"] as const;
export const recoverPage=internalMutation({args:{status:v.union(v.literal("preparing"),v.literal("fetching"),v.literal("queued"),v.literal("running")),cursor:v.union(v.string(),v.null())},handler:async(ctx,a):Promise<{isDone:boolean;cursor:string;recovered:number}>=>{
 const page=await ctx.db.query("runtimeJobs").withIndex("by_status",q=>q.eq("status",a.status)).paginate({numItems:100,cursor:a.cursor});
 let recovered=0;
 for(const job of page.page){
  if(a.status==="running"&&(job.leaseExpiresAt??0)>Date.now())continue;
  if(a.status!=="running"&&job.updatedAt>Date.now()-5*60000)continue;
  await completeJob(ctx,job,a.status==="running"?"timed_out":"unavailable",a.status==="running"?"Runtime worker lease expired without recorded results":"Runtime worker or source preparation unavailable");recovered++;
 }
 if(!page.isDone)await ctx.scheduler.runAfter(0,internal.runtime.recoverPage,{status:a.status,cursor:page.continueCursor});
 return {isDone:page.isDone,cursor:page.continueCursor,recovered};
}});
export const recover=internalMutation({args:{},handler:async(ctx)=>{
 for(const status of recoveryStatuses)await ctx.scheduler.runAfter(0,internal.runtime.recoverPage,{status,cursor:null});
}});
export const review=query({args:{token:v.string(),reviewId:v.id("reviews")},handler:async(ctx,a)=>{const r=await ctx.db.get(a.reviewId);if(!r)throw new Error("Review missing");await authorizeRepository(ctx,a.token,r.repositoryId);return ctx.db.query("runtimeJobs").withIndex("by_review",q=>q.eq("reviewId",r._id)).collect();}});
