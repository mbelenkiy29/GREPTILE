import {v} from 'convex/values';
import {internalMutation,internalQuery,mutation,query,type MutationCtx,type QueryCtx} from './_generated/server';
import {internal} from './_generated/api';
import type {Doc,Id} from './_generated/dataModel';
import {authorizeRepository,visibleRepositories} from './auth';
import {connectionDigest} from './indexAuthority';
import {observationFields,observePull} from './pulls';
const worker={id:v.id('pullCatalogJobs'),leaseId:v.string()};
async function authority(ctx:QueryCtx|MutationCtx,repo:Doc<'repositories'>){
 if(!repo.enabled)throw Error('Repository disabled; change import cancelled');
 let binding;
 if(repo.connectionId){const c=await ctx.db.get(repo.connectionId);if(!c?.active||c.suspended||c.organizationId!==repo.organizationId)throw Error('Provider disconnected; change import cancelled');if(c.kind==='perforce')throw Error('Perforce changes use native review polling');binding={connection:c._id,kind:c.kind,instance:c.instance,credential:await connectionDigest(c.credentials)};}
 else{const installation=await ctx.db.query('githubInstallations').withIndex('by_installation',q=>q.eq('installationId',repo.installationId!)).unique();if(!installation?.active||installation.organizationId!==repo.organizationId)throw Error('GitHub installation unavailable; change import cancelled');binding={installation:installation.installationId};}
 return connectionDigest(JSON.stringify({...binding,repository:repo._id,organization:repo.organizationId,external:repo.externalId,fullName:repo.fullName}));
}
export async function beginCatalog(ctx:MutationCtx,repositoryId:Id<'repositories'>){
 const repo=await ctx.db.get(repositoryId);if(!repo)throw Error('Repository not found');
 const binding=await authority(ctx,repo),old=await ctx.db.query('pullCatalogJobs').withIndex('by_repo',q=>q.eq('repositoryId',repo._id)).order('desc').first();
 if(old&&['queued','running'].includes(old.status)&&old.authority===binding)return old._id;
 if(old&&['queued','running'].includes(old.status)){await ctx.db.patch(old._id,{status:'cancelled',lease:undefined,updatedAt:Date.now()});if(old.scheduledId){const schedule=await ctx.db.system.get(old.scheduledId);if(schedule?.state.kind==='pending')await ctx.scheduler.cancel(old.scheduledId);}}
 const now=Date.now(),id=await ctx.db.insert('pullCatalogJobs',{repositoryId,organizationId:repo.organizationId,authority:binding,status:'queued',cursor:null,seenCursors:[],processed:0,pages:0,attempts:0,createdAt:now,updatedAt:now});
 const scheduledId=await ctx.scheduler.runAfter(0,internal.pullCatalogJobs.step,{id});await ctx.db.patch(id,{scheduledId});return id;
}
export const begin=internalMutation({args:{repositoryId:v.id('repositories')},handler:(ctx,a)=>beginCatalog(ctx,a.repositoryId)});
export const sync=mutation({args:{token:v.string(),repositoryId:v.id('repositories')},handler:async(ctx,a)=>{await authorizeRepository(ctx,a.token,a.repositoryId,true,true);return beginCatalog(ctx,a.repositoryId);}});
export const list=query({args:{token:v.string(),organizationId:v.id('organizations'),teamId:v.optional(v.id('teams')),repositoryId:v.optional(v.id('repositories'))},handler:async(ctx,a)=>{
 const repos=await visibleRepositories(ctx,a.token,a.organizationId,a.teamId);if(a.repositoryId&&!repos.some(r=>r._id===a.repositoryId))throw Error('Repository not accessible');
 return Promise.all(repos.filter(r=>!a.repositoryId||r._id===a.repositoryId).map(async repo=>{const job=await ctx.db.query('pullCatalogJobs').withIndex('by_repo',q=>q.eq('repositoryId',repo._id)).order('desc').first();const c=repo.connectionId?await ctx.db.get(repo.connectionId):null;return {repositoryId:repo._id,fullName:repo.fullName,enabled:repo.enabled,supported:c?.kind!=='perforce',job:job?{status:job.status,processed:job.processed,pages:job.pages,error:job.error,updatedAt:job.updatedAt}:null};}));
}});
export const claim=internalMutation({args:worker,handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||!['queued','running'].includes(job.status)||(job.lease?.expiresAt??0)>Date.now())return null;
 const repo=await ctx.db.get(job.repositoryId);try{if(!repo||await authority(ctx,repo)!==job.authority)throw Error('Repository connection changed; restart import');}catch(e){await ctx.db.patch(job._id,{status:'cancelled',error:e instanceof Error?e.message:'Import access unavailable',lease:undefined,updatedAt:Date.now()});return null;}
 await ctx.db.patch(job._id,{status:'running',scheduledId:undefined,lease:{id:a.leaseId,expiresAt:Date.now()+8*60000},updatedAt:Date.now()});return {job,repo};
}});
export const allowed=internalQuery({args:worker,handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.status!=='running'||job.lease?.id!==a.leaseId||job.lease.expiresAt<=Date.now())return false;
 const repo=await ctx.db.get(job.repositoryId);try{return !!repo&&await authority(ctx,repo)===job.authority;}catch{return false;}
}});
export const finishPage=internalMutation({args:{...worker,rows:v.array(v.object(observationFields)),next:v.union(v.string(),v.null())},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.status!=='running'||job.lease?.id!==a.leaseId||job.lease.expiresAt<=Date.now())return false;
 const repo=await ctx.db.get(job.repositoryId);if(!repo||await authority(ctx,repo)!==job.authority)throw Error('Repository connection changed; restart import');
 const nextDigest=a.next===null?null:await connectionDigest(a.next);
 if(a.rows.length>30||a.rows.some(r=>r.repositoryId!==repo._id)||new Set(a.rows.map(r=>r.number)).size!==a.rows.length||a.next!==null&&(!a.next||a.next.length>2000||a.next===job.cursor||job.seenCursors.includes(nextDigest!)||!a.rows.length))throw Error('Invalid or repeated change catalog page');
 for(const row of a.rows)await observePull(ctx,row);
 const pages=job.pages+1,limited=pages>=1000&&a.next!==null;
 const scheduledId=a.next!==null&&!limited?await ctx.scheduler.runAfter(0,internal.pullCatalogJobs.step,{id:job._id}):undefined;
 await ctx.db.patch(job._id,{status:limited?'failed':a.next===null?'completed':'queued',cursor:a.next,seenCursors:a.next?[...job.seenCursors,nextDigest!]:job.seenCursors,processed:job.processed+a.rows.length,pages,attempts:0,error:limited?'Import reached the 30,000-change coverage limit; newer changes continue through provider events.':undefined,lease:undefined,scheduledId,updatedAt:Date.now()});return true;
}});
export const failed=internalMutation({args:{...worker,error:v.string()},handler:async(ctx,a)=>{
 const job=await ctx.db.get(a.id);if(!job||job.status!=='running'||job.lease?.id!==a.leaseId)return;
 const attempts=job.attempts+1,scheduledId=attempts<3?await ctx.scheduler.runAfter(10000*2**attempts,internal.pullCatalogJobs.step,{id:job._id}):undefined;
 await ctx.db.patch(job._id,{status:scheduledId?'queued':'failed',attempts,error:a.error.slice(0,1000),lease:undefined,scheduledId,updatedAt:Date.now()});
}});
const recoveryPageArgs={status:v.union(v.literal('queued'),v.literal('running')),cursor:v.union(v.string(),v.null())};
async function recoverCatalogPage(ctx:MutationCtx,status:'queued'|'running',cursor:string|null):Promise<{isDone:boolean;cursor:string}>{
 const page=await ctx.db.query('pullCatalogJobs').withIndex('by_status',q=>q.eq('status',status)).paginate({numItems:100,cursor});
 for(const job of page.page){
  if((job.lease?.expiresAt??0)>Date.now())continue;const scheduled=job.scheduledId?await ctx.db.system.get(job.scheduledId):null;if(scheduled&&['pending','inProgress'].includes(scheduled.state.kind))continue;
  const scheduledId=await ctx.scheduler.runAfter(0,internal.pullCatalogJobs.step,{id:job._id});await ctx.db.patch(job._id,{status:'queued',lease:undefined,scheduledId,updatedAt:Date.now()});
 }
 if(!page.isDone)await ctx.scheduler.runAfter(0,internal.pullCatalogs.recoverPage,{status,cursor:page.continueCursor});
 return {isDone:page.isDone,cursor:page.continueCursor};
}
export const recoverPage=internalMutation({args:recoveryPageArgs,handler:(ctx,a)=>recoverCatalogPage(ctx,a.status,a.cursor)});
export const recover=internalMutation({args:{},handler:async(ctx)=>{
 for(const status of ['queued','running'] as const)await ctx.scheduler.runAfter(0,internal.pullCatalogs.recoverPage,{status,cursor:null});
}});
