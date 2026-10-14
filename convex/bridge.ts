import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {requireContextReader,requireFindingReader} from "./repositoryContext";
import { authenticated, authorize, authorizeRepository, repositoryAccess, service, audit } from "./auth";
import { codingAgentValidator } from "./schema";
import { effectiveSettings } from "./scopes";
import { rateLimit } from "./rateLimit";
import { fixPrompt, eligibleFixFinding } from "../src/fix-prompt";
import {p4FixAuthority} from "./p4FixAuthority";
import { findingSchema } from "../src/engine/types";

async function device(ctx: MutationCtx, hash: string) {
  const d=await ctx.db.query("bridgeDevices").withIndex("by_hash",q=>q.eq("tokenHash",hash)).unique();
  if(!d || d.revoked || d.expiresAt<Date.now() || !d.userId || !d.organizationId) throw new Error("Bridge is unpaired, expired, or revoked");
  const m=await ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",d.organizationId!).eq("userId",d.userId!)).unique();
  if(!m || m.role === "viewer") throw new Error("Workspace write access revoked");
  await ctx.db.patch(d._id,{lastSeen:Date.now()});
  return d;
}
export const startPair = mutation({args:{secret:v.string(),hash:v.string(),code:v.string(),name:v.string()},handler:async(ctx,a)=>{
  service(a.secret); if(!/^[a-f0-9]{64}$/.test(a.hash)|| !/^[a-f0-9]{12}$/.test(a.code)||a.name.length>100) throw new Error("Invalid pairing");
  await rateLimit(ctx,"bridge:pair",30);
  const existing=await ctx.db.query("bridgeDevices").withIndex("by_hash",q=>q.eq("tokenHash",a.hash)).unique();
  if(existing) throw new Error("Pairing already started");
  return ctx.db.insert("bridgeDevices",{tokenHash:a.hash,code:a.code,name:a.name,expiresAt:Date.now()+10*60000,revoked:false,createdAt:Date.now()});
}});
function pairingCode(value:string){const code=value.trim().replaceAll("-","").toLowerCase();if(!/^[a-f0-9]{12}$/.test(code))throw new Error("Invalid or expired pairing code");return code;}
export const previewPair = mutation({args:{token:v.string(),organizationId:v.id("organizations"),code:v.string()},handler:async(ctx,a)=>{
 const {user,member}=await authorize(ctx,a.token,a.organizationId);if(member.role==="viewer")throw new Error("Workspace write access required");
 await rateLimit(ctx,`bridge:preview:${user._id}`,10);
 const d=await ctx.db.query("bridgeDevices").withIndex("by_code",q=>q.eq("code",pairingCode(a.code))).unique();
 if(!d||d.userId||d.revoked||d.expiresAt<=Date.now())throw new Error("Invalid or expired pairing code");
 const workspace=await ctx.db.get(a.organizationId);
 return {deviceId:d._id,name:d.name,expiresAt:d.expiresAt,account:user.login,userId:user._id,organizationId:a.organizationId,workspace:workspace!.name};
}});
export const approvePair = mutation({args:{token:v.string(),organizationId:v.id("organizations"),code:v.string(),expectedDeviceId:v.optional(v.id("bridgeDevices")),expectedUserId:v.optional(v.id("users"))},handler:async(ctx,a)=>{
  const {user,member}=await authorize(ctx,a.token,a.organizationId);if(member.role==="viewer")throw new Error("Workspace write access required");
  if(a.expectedUserId&&a.expectedUserId!==user._id)throw new Error("Pairing account changed; review the code again");
  await rateLimit(ctx,`bridge:approve:${user._id}`,10);
  const d=await ctx.db.query("bridgeDevices").withIndex("by_code",q=>q.eq("code",pairingCode(a.code))).unique();
  if(!d || d.userId || d.revoked || d.expiresAt<=Date.now() || a.expectedDeviceId&&d._id!==a.expectedDeviceId) throw new Error("Invalid or expired pairing code");
  await ctx.db.patch(d._id,{userId:user._id,organizationId:a.organizationId,expiresAt:Date.now()+90*86400000});
}});
export const pairStatus = mutation({args:{secret:v.string(),hash:v.string()},handler:async(ctx,a)=>{
  service(a.secret); const d=await ctx.db.query("bridgeDevices").withIndex("by_hash",q=>q.eq("tokenHash",a.hash)).unique();
  if(!d || d.revoked || d.expiresAt<Date.now()) throw new Error("Pairing expired");
  if(!d.userId) return {paired:false};
  await device(ctx,a.hash); const user=await ctx.db.get(d.userId); const org=await ctx.db.get(d.organizationId!);
  return {paired:true,user:user?.login,workspace:org?.name};
}});
export const personal = query({args:{token:v.string(),organizationId:v.optional(v.id("organizations"))},handler:async(ctx,a)=>{
  const u=await authenticated(ctx,a.token); const devices=await ctx.db.query("bridgeDevices").withIndex("by_user",q=>q.eq("userId",u._id)).collect();
  const identity=a.organizationId?await authorize(ctx,a.token,a.organizationId):null;
  const workspace=a.organizationId?await ctx.db.get(a.organizationId):null;
  const preference=await ctx.db.query("personalSettings").withIndex("by_user",q=>q.eq("userId",u._id)).unique();
  return {account:u.login,agent:preference?.agent??workspace?.defaultAgent??"codex",personalAgent:preference?.agent,workspaceAgent:workspace?.defaultAgent??"codex",canPair:!!identity&&identity.member.role!=="viewer",canManageWorkspace:!!identity&&["owner","admin"].includes(identity.member.role),devices:devices.filter(d=>!a.organizationId||d.organizationId===a.organizationId).map(d=>({_id:d._id,name:d.name,expiresAt:d.expiresAt,revoked:d.revoked,lastSeen:d.lastSeen}))};
}});
export const savePersonal = mutation({args:{token:v.string(),agent:v.optional(codingAgentValidator)},handler:async(ctx,a)=>{
 const u=await authenticated(ctx,a.token);const old=await ctx.db.query("personalSettings").withIndex("by_user",q=>q.eq("userId",u._id)).unique();
 if(!a.agent){if(old)await ctx.db.delete(old._id);return;}
 if(old) await ctx.db.patch(old._id,{agent:a.agent,updatedAt:Date.now()});else await ctx.db.insert("personalSettings",{userId:u._id,agent:a.agent,updatedAt:Date.now()});
}});
export const saveWorkspaceAgent=mutation({args:{token:v.string(),organizationId:v.id("organizations"),agent:codingAgentValidator},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 await ctx.db.patch(a.organizationId,{defaultAgent:a.agent});
 await audit(ctx,a.organizationId,user._id,"agent.default_changed",a.agent);
}});
export const revoke = mutation({args:{token:v.string(),deviceId:v.id("bridgeDevices")},handler:async(ctx,a)=>{
 const u=await authenticated(ctx,a.token);const d=await ctx.db.get(a.deviceId);if(d?.userId!==u._id) throw new Error("Device not accessible");await ctx.db.patch(d._id,{revoked:true});
}});
export const createFix = mutation({args:{token:v.string(),reviewId:v.id("reviews"),findingId:v.optional(v.id("findings")),agent:v.union(v.literal("codex"),v.literal("claude"),v.literal("cursor"))},handler:async(ctx,a)=>{
 const r=await ctx.db.get(a.reviewId);if(!r) throw new Error("Review not found");const {user}=await authorizeRepository(ctx,a.token,r.repositoryId,true);await requireContextReader(ctx,user._id,r);
 await rateLimit(ctx,`fix:${user._id}`,20);
 const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",r.repositoryId).eq("prNumber",r.prNumber)).order("desc").first();
 if(latest?._id!==r._id||r.status!=="completed") throw new Error("Fix requires the latest completed review");
 const repo=await ctx.db.get(r.repositoryId);if(!repo)throw new Error("Repository unavailable");
 if(r.nativeP4)await p4FixAuthority(ctx,r);else if(!repo.enabled)throw new Error("Repository disabled");
 const config=await effectiveSettings(ctx,repo);
 const f=(await ctx.db.query("findings").withIndex("by_pr",q=>q.eq("repositoryId",repo._id).eq("prNumber",r.prNumber)).collect()).filter(f=>eligibleFixFinding(f,r,latest?._id,config.minimumConfidence)&&(!a.findingId||f._id===a.findingId));
 if(!f.length)throw new Error("No eligible unresolved findings at this revision");
 for(const finding of f)await requireFindingReader(ctx,user._id,finding);
 const prompt=fixPrompt(repo.fullName,`PR #${r.prNumber}`,f.map(f=>({...findingSchema.parse(f),fingerprint:f.fingerprint,agent:f.agent,commitSha:f.commitSha})),r.runtimeEvidence)+"\nDo not commit, push, merge, or mark issues resolved. Leave an inspectable diff and report test results."+(r.nativeP4?"\nThis is a native Perforce client. Do not submit a changelist, sync, unshelve, change client mappings, revert unrelated files or overwrite unrelated opened files. Limit any native action changes required by remediation to the reviewed target files. Preserve the prepared checkout and report native diffs and regression results.":"");
 return ctx.db.insert("fixRequests",{userId:user._id,organizationId:r.organizationId,repositoryId:repo._id,reviewId:r._id,headSha:r.headSha,findingIds:f.map(finding=>finding._id),agent:a.agent,prompt,status:"pending",expiresAt:Date.now()+5*60000,createdAt:Date.now(),updatedAt:Date.now()});
}});
async function pendingClaim(ctx:MutationCtx,a:{secret:string;hash:string;requestId:import("./_generated/dataModel").Id<"fixRequests">},checkFindings=true) {
 service(a.secret);const d=await device(ctx,a.hash);const r=await ctx.db.get(a.requestId);
 if(!r||r.userId!==d.userId||r.organizationId!==d.organizationId||r.expiresAt<Date.now()||r.status!=="pending")throw new Error("Fix request expired, replayed, or not accessible");
 const review=await ctx.db.get(r.reviewId);const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",r.repositoryId).eq("prNumber",review?.prNumber ?? -1)).order("desc").first();
 if(!review||review.status!=="completed"||latest?._id!==review._id||review.headSha!==r.headSha)throw new Error("Review revision changed");
 await requireContextReader(ctx,d.userId!,review);
 const {repo}=await repositoryAccess(ctx,d.userId!,r.repositoryId,true);if(review.nativeP4)await p4FixAuthority(ctx,review);else if(!repo.enabled)throw new Error("Repository disabled");
 if(checkFindings){
  // Old unbound requests expire after five minutes; do not infer their selection from prompt text.
  if(!r.findingIds?.length)throw new Error("Fix request must be recreated with current findings");
  const settings=await effectiveSettings(ctx,repo);
  for(const id of r.findingIds){
   const finding=await ctx.db.get(id);
   if(!finding||finding.organizationId!==r.organizationId||finding.repositoryId!==r.repositoryId||finding.prNumber!==review.prNumber||!eligibleFixFinding(finding,review,latest?._id,settings.minimumConfidence))throw new Error("Finding eligibility changed; create a new Fix request");
   await requireFindingReader(ctx,d.userId!,finding);
  }
 }
 return {d,r,repo,review};
}
const claimArgs={secret:v.string(),hash:v.string(),requestId:v.id("fixRequests")};
export const claimData=internalMutation({args:claimArgs,handler:async(ctx,a)=>{
 const {repo,review}=await pendingClaim(ctx,a);return {repo,review,...(review.nativeP4?{native:await p4FixAuthority(ctx,review)}:{})};
}});
const nativeFix=v.object({instance:v.string(),project:v.string(),serverId:v.string(),files:v.array(v.object({depotFile:v.string(),haveRevision:v.number(),revision:v.string(),digest:v.string(),fileSize:v.number(),nativeAction:v.optional(v.union(v.literal("add"),v.literal("branch"),v.literal("move/add"),v.literal("edit"),v.literal("integrate"),v.literal("delete"),v.literal("move/delete"))),archiveChange:v.optional(v.number())}))});
export const claim = internalMutation({args:{...claimArgs,current:v.object({headSha:v.string(),revisionKey:v.optional(v.string()),state:v.string(),native:v.optional(nativeFix)})},handler:async(ctx,a)=>{
 const {d,r,repo,review}=await pendingClaim(ctx,a);
 if(a.current.state!=="open"||a.current.headSha!==r.headSha||a.current.revisionKey!==review.revisionKey)throw new Error("Provider revision changed or pull request closed; re-review before fixing");
 if(!!review.nativeP4!==!!a.current.native)throw new Error("Fix provider identity mismatch");
 if(a.current.native){const b=await p4FixAuthority(ctx,review);if(a.current.native.instance!==b.connection.instance||a.current.native.project!==repo.externalId||!review.baseSha?.startsWith(`p4:${a.current.native.serverId}:submitted:`))throw new Error("P4 fix context identity mismatch");}
 await ctx.db.patch(r._id,{status:"claimed",deviceId:d._id,updatedAt:Date.now()});
 return {requestId:r._id,repository:repo.fullName,remoteUrl:repo.remoteUrl,headSha:r.headSha,agent:r.agent,prompt:r.prompt,...(a.current.native?{native:a.current.native}:{})};
}});
export const claimFailed=internalMutation({args:claimArgs,handler:async(ctx,a)=>{
 const {r}=await pendingClaim(ctx,a,false);
 await ctx.db.patch(r._id,{status:"failed",error:"Could not verify the current open revision and selected findings. Refresh the review and create a new Fix request; no agent was launched.",updatedAt:Date.now()});
}});
export const report = mutation({args:{secret:v.string(),hash:v.string(),requestId:v.id("fixRequests"),status:v.union(v.literal("launched"),v.literal("failed"),v.literal("finished")),error:v.optional(v.string())},handler:async(ctx,a)=>{
 service(a.secret);const d=await device(ctx,a.hash);const r=await ctx.db.get(a.requestId);
 if(!r||r.deviceId!==d._id)throw new Error("Request not claimed by this device");
 // An acknowledged write can lose its HTTP response. Repeated identical
 // outcomes acknowledge the receipt without changing terminal state or time.
 if(r.status===a.status)return;
 if(!((r.status==="claimed"&&a.status!=="finished")||(r.status==="launched"&&a.status!=="launched")))throw new Error("Request not claimed by this device");
 await ctx.db.patch(r._id,{status:a.status,error:a.error?.slice(0,1000),updatedAt:Date.now()});
}});
export const status = query({args:{token:v.string(),requestId:v.id("fixRequests")},handler:async(ctx,a)=>{
 const u=await authenticated(ctx,a.token),r=await ctx.db.get(a.requestId);
 if(!r||r.userId!==u._id)throw new Error("Request not accessible");
 await authorizeRepository(ctx,a.token,r.repositoryId);
 return {status:r.status==="pending"&&r.expiresAt<Date.now()?"expired":r.status,error:r.error,updatedAt:r.updatedAt};
}});
