import { internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {authenticated} from "./auth";
import {contextReadable} from "./repositoryContext";
import {p4BaselineMetadata} from "./p4Index";
import {authorizeRepository} from "./auth";
import { repositoryAccess, visibleRepositories } from "./auth";
export const list=query({args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),author:v.optional(v.string()),state:v.optional(v.string()),search:v.optional(v.string()),paginationOpts:paginationOptsValidator},handler:async(ctx,a)=>{
 const viewer=await authenticated(ctx,a.token);
 const repos=await visibleRepositories(ctx,a.token,a.organizationId,a.teamId),allowed=repos.map(r=>r._id).filter(id=>!a.repositoryId||id===a.repositoryId);
 if(a.repositoryId&&!repos.some(r=>r._id===a.repositoryId))throw new Error("Repository not accessible in selected scope");
 if(!allowed.length)return {page:[],isDone:true,continueCursor:""};
 const source=a.search?ctx.db.query("pullRequests").withSearchIndex("by_title",q=>q.search("title",a.search!).eq("organizationId",a.organizationId)):ctx.db.query("pullRequests").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).order("desc");
 const result=await source.filter(q=>q.and(q.or(...allowed.map(id=>q.eq(q.field("repositoryId"),id))),a.author?q.eq(q.field("author"),a.author):true,a.state?q.eq(q.field("state"),a.state):true)).paginate(a.paginationOpts);
 const readiness=new Map<string,Promise<{allowed:boolean;baseRevision?:string}>>();
 async function canReview(repositoryId:typeof allowed[number],baseRevision:string){
  if(!readiness.has(repositoryId))readiness.set(repositoryId,(async()=>{try{
   await repositoryAccess(ctx,viewer._id,repositoryId,true);const repo=await ctx.db.get(repositoryId),connection=repo?.connectionId?await ctx.db.get(repo.connectionId):null;
   if(connection?.kind==='perforce'){const baseline=await p4BaselineMetadata(ctx,{repositoryId,requestedBy:viewer._id});return {allowed:true,baseRevision:baseline.job.sha};}
   return {allowed:Boolean(repo?.enabled&&(!connection||connection.active&&!connection.suspended))};
  }catch{return {allowed:false};}})());const ready=await readiness.get(repositoryId)!;return ready.allowed&&(ready.baseRevision===undefined||ready.baseRevision===baseRevision);
 }
 return {...result,page:await Promise.all(result.page.map(async pr=>{const latest=await ctx.db.query("reviews").withIndex("by_pr",q=>q.eq("repositoryId",pr.repositoryId).eq("prNumber",pr.number)).order("desc").first();const canRequest=pr.state==='open'&&!pr.headSha.startsWith('p4-status:')&&await canReview(pr.repositoryId,pr.baseSha);return {...pr,canRequest,latest:latest&&await contextReadable(ctx,viewer._id,latest)?latest:null};}))};
}});

export const observationFields={
 repositoryId:v.id("repositories"),number:v.number(),title:v.string(),author:v.string(),url:v.string(),
 headSha:v.string(),baseSha:v.string(),state:v.string(),revisionKey:v.optional(v.string()),observedAt:v.number(),
};
export type PullObservation={repositoryId:import("./_generated/dataModel").Id<"repositories">;number:number;title:string;author:string;url:string;headSha:string;baseSha:string;state:string;revisionKey?:string;observedAt:number};
// Called only after authenticated provider reads, independently of review policy.
export async function observePull(ctx:MutationCtx,a:PullObservation,options?:{nativePollingAuthorized:boolean}){
 const repo=await ctx.db.get(a.repositoryId);
 // Native P4 uses a separately authorized poll rather than the Git repository enable flag.
 if(!repo||!repo.enabled&&!options?.nativePollingAuthorized)return null;
 if(!Number.isSafeInteger(a.number)||a.number<1||!Number.isFinite(a.observedAt))throw new Error("Invalid change observation");
 const old=await ctx.db.query("pullRequests").withIndex("by_repo_number",q=>q.eq("repositoryId",repo._id).eq("number",a.number)).unique();
 if(old?.nativeObservedAt!==undefined&&old.nativeObservedAt>=a.observedAt)return old._id;
 const {observedAt,...metadata}=a;
 const data={...metadata,organizationId:repo.organizationId,nativeObservedAt:observedAt,updatedAt:Date.now()};
 if(old){await ctx.db.patch(old._id,data);return old._id;}
 return ctx.db.insert("pullRequests",data);
}
export const observe=internalMutation({args:observationFields,handler:observePull});

export const requestContext=internalQuery({args:{token:v.string(),repositoryId:v.id('repositories'),prNumber:v.number(),expectedRevision:v.string(),expectedBaseRevision:v.string()},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true);
 if(!Number.isSafeInteger(a.prNumber)||a.prNumber<1)throw new Error('Invalid change number');
 const pr=await ctx.db.query('pullRequests').withIndex('by_repo_number',q=>q.eq('repositoryId',repo._id).eq('number',a.prNumber)).unique();
 if(!pr||pr.state!=='open')throw new Error('Open change unavailable');
 if(pr.headSha!==a.expectedRevision||pr.baseSha!==a.expectedBaseRevision)throw new Error('Revision changed; refresh the pull request list');
 const connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(connection?.kind==='perforce'){
  const baseline=await p4BaselineMetadata(ctx,{repositoryId:repo._id,requestedBy:user._id});
  if(!pr.headSha.startsWith('p4:')||baseline.job.sha!==pr.baseSha)throw new Error('Pinned shelf or submitted baseline unavailable; sync native polling and refresh the list');
  return {nativeP4:true,organizationId:repo.organizationId,revisionKey:pr.revisionKey};
 }
 if(!repo.enabled||connection&&(!connection.active||connection.suspended))throw new Error('Repository review access is disabled');
 return {nativeP4:false,organizationId:repo.organizationId,revisionKey:pr.revisionKey};
}});
