"use node";
import {internalAction} from "./_generated/server";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import {randomUUID} from "node:crypto";
import {redact} from "../src/redact";
import {approvalBlockers,approvalPolicyKey,type ApprovalState} from "../src/approval";
import {provider} from "./scm";
import type {FunctionReturnType} from "convex/server";
import type {Scm,ScmApprovalSnapshot} from "../src/gitlab";
type State=FunctionReturnType<typeof internal.approvals.data>;
function gates(state:State,snapshot:ScmApprovalSnapshot):ApprovalState{
 return {supported:true,open:snapshot.pr.state==="open",draft:snapshot.pr.draft,head:snapshot.pr.head.sha,reviewedHead:state.review.headSha,revisionKey:snapshot.pr.revisionKey,reviewedRevisionKey:state.review.revisionKey,latest:state.latest&&state.repo.enabled,completed:state.review.status==="completed",coverageLimits:state.review.coverageLimits,unresolved:state.unresolved,assessment:state.review.approvalAssessment,author:snapshot.pr.user.login,changedPaths:snapshot.pr.diff.map(f=>f.path),humanChangeRequested:snapshot.humanChangeRequested,requiredChecksKnown:true,checks:snapshot.checks,nativeRequiredChecks:snapshot.nativeRequiredChecks,runtimeRequired:state.runtimeRequired,runtimePassed:state.runtimePassed,requirementsNotMet:state.review.requirementsNotMet??0};
}
export const process=internalAction({args:{id:v.id("approvalJobs")},handler:async(ctx,a)=>{
 const lease=randomUUID();if(!await ctx.runMutation(internal.approvals.claim,{...a,lease}))return;
 let providerReviewId:string|number|undefined,scm:Scm|undefined,target:State|undefined,withdrawalAttempted=false,publicationAttempted=false;
 const marker="<!-- openreview:approval:"+a.id+" -->";
 const recoverReceipt=async()=>{
  if(!scm?.approvalSnapshot||!target)throw new Error("Approval receipt recovery unavailable");
  const snapshot=await scm.approvalSnapshot(target.repo.fullName,target.review.prNumber,target.policy.requiredChecks);
  const owned=snapshot.reviews.filter(r=>r.commit_id===target!.review.headSha&&r.body?.trimEnd().endsWith(marker)&&r.user.login===snapshot.botLogin&&r.state==="APPROVED");
  if(owned.length>1)throw new Error("Multiple native approval receipts require inspection");
  providerReviewId=owned[0]?.id;
 };
 const withdraw=async()=>{withdrawalAttempted=true;if(!scm?.dismissApproval||!target||providerReviewId===undefined)throw new Error("Approval withdrawal authority unavailable");await scm.dismissApproval(target.repo.fullName,target.review.prNumber,providerReviewId);};
 try{
  let state=await ctx.runQuery(internal.approvals.data,a);target=state;providerReviewId=state.job.providerReviewId;
  if(state.providerKind==="perforce"&&providerReviewId===undefined&&state.job.status!=="revocation_pending"){
   await ctx.runMutation(internal.approvals.finish,{...a,lease,status:"unsupported",reasons:["Automatic approval is unavailable for Perforce; native transitions are not revision guarded"]});return;
  }
  scm=await provider(ctx,state.repo);
  // A failed withdrawal is irreversible job intent: never re-approve it if gates later recover.
  if(state.job.status==="revocation_pending"){
   if(providerReviewId===undefined)await recoverReceipt();
   if(providerReviewId!==undefined)await withdraw();await ctx.runMutation(internal.approvals.finish,{...a,lease,status:"invalidated",reasons:["Approval withdrawn after verification failure"],providerReviewId});return;
  }
  if(!scm.supportsApproval||!scm.approvalSnapshot||!scm.approve||!scm.dismissApproval){if(providerReviewId!==undefined)throw new Error("Provider approval withdrawal is unavailable");await ctx.runMutation(internal.approvals.finish,{...a,lease,status:"unsupported",reasons:["Provider approval is unsupported"]});return;}
  let snapshot=await scm.approvalSnapshot(state.repo.fullName,state.review.prNumber,state.policy.requiredChecks);
  const existing=snapshot.reviews.find(r=>r.commit_id===state.review.headSha&&r.body?.includes(marker)&&r.user.login===snapshot.botLogin&&r.state==="APPROVED");
  providerReviewId=existing?.id??providerReviewId;
  let reasons=approvalBlockers(state.policy,gates(state,snapshot));
  if(providerReviewId&&state.job.policyKey!==approvalPolicyKey(state.policy))reasons.push("Trusted approval policy changed");
  if(providerReviewId&&!existing)reasons.push("Provider approval is no longer active");
  if(reasons.length){
   if(providerReviewId){await withdraw();await ctx.runMutation(internal.approvals.finish,{...a,lease,status:"invalidated",reasons,providerReviewId});}
   else await ctx.runMutation(internal.approvals.finish,{...a,lease,status:reasons.every(r=>r==="Required checks have not passed")?"waiting_checks":"blocked",reasons});
   return;
  }
  if(!providerReviewId){
   const policyKey=approvalPolicyKey(state.policy);
   await ctx.runMutation(internal.approvals.beforePublish,{...a,lease,policyKey});
   publicationAttempted=true;
   const result=await scm.approve(state.repo.fullName,state.review.prNumber,state.review.headSha,marker,snapshot.botLogin,state.review.revisionKey);providerReviewId=result.id;
   await ctx.runMutation(internal.approvals.recordPublished,{...a,lease,providerReviewId});
   // Provider reads and database mutations cannot be atomic. Recheck after publication and revoke on a race.
   [state,snapshot]=await Promise.all([ctx.runQuery(internal.approvals.data,a),scm.approvalSnapshot(state.repo.fullName,state.review.prNumber,state.policy.requiredChecks)]);
   reasons=approvalBlockers(state.policy,gates(state,snapshot));
   if(!snapshot.reviews.some(r=>r.id===providerReviewId&&r.commit_id===state.review.headSha&&r.body?.includes(marker)&&r.user.login===snapshot.botLogin&&r.state==="APPROVED"))reasons.push("Provider approval was not confirmed after publication");
   if(approvalPolicyKey(state.policy)!==policyKey)reasons.push("Trusted approval policy changed during publication");
   if(reasons.length){await withdraw();await ctx.runMutation(internal.approvals.finish,{...a,lease,status:"invalidated",reasons,providerReviewId});return;}
  }
  await ctx.runMutation(internal.approvals.finish,{...a,lease,status:"approved",reasons:[],providerReviewId});
 }catch(error){
  const reasons=[redact(error instanceof Error?error.message:"Approval verification failed").slice(0,1000)];
  let status="failed";
  if(providerReviewId!==undefined||publicationAttempted||target?.job.status==="revocation_pending"){
   status="revocation_pending";
   if(!withdrawalAttempted){try{if(providerReviewId===undefined)await recoverReceipt();if(providerReviewId!==undefined)await withdraw();status="invalidated";reasons.push("Native approval is no longer active after verification failure");}catch{reasons.push("Native approval withdrawal could not be confirmed; retry pending");}}
   else reasons.push("Native approval withdrawal could not be confirmed; retry pending");
  }
  await ctx.runMutation(internal.approvals.finish,{...a,lease,status,reasons,providerReviewId});
 }
}});
