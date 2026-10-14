import {mutation,query,internalMutation,internalQuery,type QueryCtx,type MutationCtx} from './_generated/server';
import {v} from 'convex/values';
import {internal} from './_generated/api';
import type {Id} from './_generated/dataModel';
import {authorize,authorizeRepository,audit,repositoryAccess} from './auth';
import type {Doc} from './_generated/dataModel';
import {p4Baseline} from './p4Index';
import {connectionDigest} from './indexAuthority';
import {cancelReview} from './reviewLifecycle';
import {effectiveSettings} from './scopes';
import {observePull} from './pulls';
const identity={id:v.id('p4Polls'),generation:v.number()},worker={...identity,leaseId:v.string()};
/** A completed authorized index replaces an enabled poll's baseline atomically. */
export async function adoptP4Baseline(ctx:MutationCtx,job:Doc<'indexJobs'>){
 if(!job.nativeDepot||job.status!=='completed')return;
 const poll=await ctx.db.query('p4Polls').withIndex('by_repo',q=>q.eq('repositoryId',job.repositoryId)).unique();
 if(!poll?.enabled||poll.baselineJobId===job._id)return;
 // Index upload cannot resurrect revoked polling or authorize a different connection generation.
 if(poll.connectionId!==job.nativeDepot.connectionId||poll.credentialDigest!==job.nativeDepot.credentialDigest)return;
 try{await repositoryAccess(ctx,poll.requestedBy,job.repositoryId,true,true);}catch{return;}
 if(poll.scheduledId){const scheduled=await ctx.db.system.get(poll.scheduledId);if(scheduled?.state.kind==='pending')await ctx.scheduler.cancel(poll.scheduledId);}
 for(const review of await ctx.db.query('reviews').withIndex('by_repo',q=>q.eq('repositoryId',job.repositoryId)).collect())if(review.nativeP4?.polling?.id===poll._id&&!['completed','failed','cancelled'].includes(review.status))await cancelReview(ctx,review);
 const generation=poll.generation+1,now=Date.now();
 const scheduledId=await ctx.scheduler.runAfter(0,internal.p4PollJobs.step,{id:poll._id,generation});
 await ctx.db.patch(poll._id,{generation,baselineJobId:job._id,status:'queued',pending:[],position:0,pages:0,cursor:undefined,lease:undefined,attempts:0,error:undefined,scheduledId,nextAt:now,updatedAt:now});
}
export async function p4PollingAuthority(ctx:QueryCtx|MutationCtx,id:Id<'p4Polls'>,generation:number,leaseId?:string){
 const poll=await ctx.db.get(id);
 if(!poll?.enabled||poll.generation!==generation||poll.status==='failed'||leaseId&&(!poll.lease||poll.lease.id!==leaseId||poll.lease.expiresAt<=Date.now()))throw new Error('P4 polling stopped, replaced or lease expired');
 const baseline=await p4Baseline(ctx,poll);
 if(baseline.connection._id!==poll.connectionId||await connectionDigest(baseline.connection.credentials)!==poll.credentialDigest)throw new Error('P4 polling credentials changed; administrator must restart');
 return {poll,...baseline};
}
export async function p4AutomaticAuthority(ctx:QueryCtx|MutationCtx,repositoryId:Id<'repositories'>,reference:{id:Id<'p4Polls'>;generation:number}){
 const state=await p4PollingAuthority(ctx,reference.id,reference.generation);
 if(state.repo._id!==repositoryId||!(await effectiveSettings(ctx,state.repo)).automatic)throw new Error('P4 automatic review authority or policy changed');
 return state;
}
export const configure=mutation({args:{token:v.string(),repositoryId:v.id('repositories'),enabled:v.boolean()},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true,true);
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;if(connection?.kind!=='perforce')throw new Error('P4 repository required');
 const old=await ctx.db.query('p4Polls').withIndex('by_repo',q=>q.eq('repositoryId',repo._id)).unique();
 if(old?.scheduledId){const scheduled=await ctx.db.system.get(old.scheduledId);if(scheduled?.state.kind==='pending')await ctx.scheduler.cancel(old.scheduledId);}
 // Poll generation revocation cancels its automatic runs, never manual requests.
 if(old)for(const review of await ctx.db.query('reviews').withIndex('by_repo',q=>q.eq('repositoryId',repo._id)).collect())if(review.nativeP4?.polling?.id===old._id&&!['completed','failed','cancelled'].includes(review.status))await cancelReview(ctx,review);
 if(!a.enabled){if(old)await ctx.db.patch(old._id,{enabled:false,status:'disabled',generation:old.generation+1,scheduledId:undefined,nextAt:undefined,lease:undefined,updatedAt:Date.now()});await audit(ctx,repo.organizationId,user._id,'p4.polling.disabled',repo._id);return;}
 const baseline=await p4Baseline(ctx,{repositoryId:repo._id,requestedBy:user._id});
 const now=Date.now(),generation=(old?.generation??0)+1;
 const value={organizationId:repo.organizationId,repositoryId:repo._id,requestedBy:user._id,connectionId:baseline.connection._id,credentialDigest:await connectionDigest(baseline.connection.credentials),baselineJobId:baseline.job._id,enabled:true,generation,status:'queued',pending:[],position:0,pages:0,scanned:0,skipped:0,diagnostics:[],attempts:0,updatedAt:now};
 const id=old?old._id:await ctx.db.insert('p4Polls',{...value,createdAt:now});
 if(old)await ctx.db.patch(id,{...value,cursor:undefined,error:undefined,lease:undefined});
 const scheduledId=await ctx.scheduler.runAfter(0,internal.p4PollJobs.step,{id,generation});
 await ctx.db.patch(id,{scheduledId,nextAt:now});await audit(ctx,repo.organizationId,user._id,'p4.polling.enabled',repo._id);
}});
export const list=query({args:{token:v.string(),organizationId:v.id('organizations')},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 return (await ctx.db.query('p4Polls').withIndex('by_org',q=>q.eq('organizationId',a.organizationId)).collect()).map(p=>({id:p._id,repositoryId:p.repositoryId,enabled:p.enabled,status:p.status,cursor:p.cursor,position:p.position,pending:p.pending.length,pages:p.pages,scanned:p.scanned,skipped:p.skipped,diagnostics:p.diagnostics,attempts:p.attempts,error:p.error,nextAt:p.nextAt,lastCompleteAt:p.lastCompleteAt,updatedAt:p.updatedAt}));
}});
export const claim=internalMutation({args:worker,handler:async(ctx,a)=>{
 const poll=await ctx.db.get(a.id);if(!poll?.enabled||poll.generation!==a.generation||poll.status==='failed'||(poll.lease?.expiresAt??0)>Date.now())return false;
 if(poll.scheduledId){const scheduled=await ctx.db.system.get(poll.scheduledId);if(scheduled?.state.kind==='pending')await ctx.scheduler.cancel(poll.scheduledId);}
 await ctx.db.patch(poll._id,{status:'polling',lease:{id:a.leaseId,expiresAt:Date.now()+15*60000},scheduledId:undefined,nextAt:undefined,updatedAt:Date.now()});return true;
}});
export const data=internalQuery({args:worker,handler:(ctx,a)=>p4PollingAuthority(ctx,a.id,a.generation,a.leaseId)});
export const previous=internalQuery({args:{...worker,nativeNumber:v.number()},handler:async(ctx,a)=>{
 const {repo}=await p4PollingAuthority(ctx,a.id,a.generation,a.leaseId);
 return ctx.db.query('reviews').withIndex('by_pr',q=>q.eq('repositoryId',repo._id).eq('prNumber',a.nativeNumber)).order('desc').first();
}});
export const observe=internalMutation({args:{...worker,nativeNumber:v.number(),title:v.string(),author:v.string(),url:v.string(),revision:v.string(),state:v.union(v.literal('open'),v.literal('closed')),observedAt:v.number()},handler:async(ctx,a)=>{
 const {poll,repo,job}=await p4PollingAuthority(ctx,a.id,a.generation,a.leaseId);
 if(poll.pending[poll.position]!==a.nativeNumber)throw Error('P4 observation does not match the claimed inventory row');
 return observePull(ctx,{repositoryId:repo._id,number:a.nativeNumber,title:a.title,author:a.author,url:a.url,headSha:a.revision,baseSha:job.sha,state:a.state,observedAt:a.observedAt},{nativePollingAuthorized:true});
}});
export const closed=internalMutation({args:{...worker,nativeNumber:v.number()},handler:async(ctx,a)=>{
 const {repo}=await p4PollingAuthority(ctx,a.id,a.generation,a.leaseId);
 for(const review of await ctx.db.query('reviews').withIndex('by_pr',q=>q.eq('repositoryId',repo._id).eq('prNumber',a.nativeNumber)).collect())if(review.nativeP4&&!['completed','failed','cancelled'].includes(review.status))await cancelReview(ctx,review);
 const pr=await ctx.db.query('pullRequests').withIndex('by_repo_number',q=>q.eq('repositoryId',repo._id).eq('number',a.nativeNumber)).unique();
 if(pr)await ctx.db.patch(pr._id,{state:'closed',updatedAt:Date.now()});
}});
export const progress=internalMutation({args:{...worker,page:v.optional(v.object({ids:v.array(v.number()),cursor:v.union(v.number(),v.null())})),processed:v.optional(v.boolean()),skippedReason:v.optional(v.string()),error:v.optional(v.string())},handler:async(ctx,a)=>{
 const poll=await ctx.db.get(a.id);if(!poll?.enabled||poll.generation!==a.generation||poll.lease?.id!==a.leaseId||poll.lease.expiresAt<=Date.now())return false;
 const now=Date.now();
 if(a.error){const attempts=poll.attempts+1,delay=60000*attempts;const scheduledId=attempts<3?await ctx.scheduler.runAfter(delay,internal.p4PollJobs.step,{id:a.id,generation:a.generation}):undefined;await ctx.db.patch(poll._id,{attempts,error:a.error.slice(0,1000),status:attempts<3?'queued':'failed',scheduledId,nextAt:scheduledId?now+delay:undefined,lease:undefined,updatedAt:now});return true;}
 await p4PollingAuthority(ctx,a.id,a.generation,a.leaseId);
 if(Boolean(a.page)===Boolean(a.processed)||a.skippedReason&&!a.processed)throw new Error('P4 polling progress must contain exactly one page or processed row');
 if(a.page&&(poll.position<poll.pending.length||poll.pages>=100&&a.page.ids.length>0||a.page.ids.length>100||new Set(a.page.ids).size!==a.page.ids.length||a.page.ids.some(n=>!Number.isSafeInteger(n)||n<1||poll.cursor!==undefined&&n>=poll.cursor)||a.page.cursor!==null&&a.page.cursor!==Math.min(...a.page.ids)))throw new Error('P4 polling page identity or 10,000-review coverage limit exceeded');
 const pending=a.page?a.page.ids:poll.pending,position=a.page?0:poll.position+(a.processed?1:0),cursor=a.page?a.page.cursor??undefined:poll.cursor;
 if(position>pending.length||a.processed&&poll.position>=poll.pending.length)throw new Error('P4 polling row position invalid');
 const complete=position===pending.length&&cursor===undefined,delay=complete?5*60000:4000;
 const scheduledId=await ctx.scheduler.runAfter(delay,internal.p4PollJobs.step,{id:a.id,generation:a.generation});
 const diagnostics=a.skippedReason?[...poll.diagnostics,{nativeNumber:poll.pending[poll.position],reason:a.skippedReason.slice(0,500)}].slice(-20):poll.diagnostics;
 await ctx.db.patch(poll._id,{pending:complete?[]:pending,position:complete?0:position,cursor,pages:complete?0:poll.pages+(a.page?1:0),scanned:poll.scanned+(a.processed?1:0),skipped:poll.skipped+(a.skippedReason?1:0),diagnostics,attempts:0,error:undefined,status:complete?'waiting':'queued',scheduledId,nextAt:now+delay,lease:undefined,updatedAt:now,...(complete?{lastCompleteAt:now}:{})});return true;
}});
export const recover=internalMutation({args:{},handler:async(ctx)=>{
 // ponytail: bounded sweep; page this index when more than 1,000 native projects poll.
 for(const poll of await ctx.db.query('p4Polls').withIndex('by_enabled',q=>q.eq('enabled',true)).take(1000)){
  if(poll.status==='failed'||(poll.lease?.expiresAt??0)>Date.now())continue;
  const scheduled=poll.scheduledId?await ctx.db.system.get(poll.scheduledId):null;
  if(scheduled&&['pending','inProgress'].includes(scheduled.state.kind))continue;
  const scheduledId=await ctx.scheduler.runAfter(0,internal.p4PollJobs.step,{id:poll._id,generation:poll.generation});
  await ctx.db.patch(poll._id,{scheduledId,nextAt:Date.now(),lease:undefined,status:'queued',updatedAt:Date.now()});
 }
}});
