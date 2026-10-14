import { internalQuery, type QueryCtx, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { repositoryAccess } from "./auth";
import { connectionDigest } from "./indexAuthority";
import {personalIdentityProviders} from "../src/personal-providers";
import {providerIdentityAuthority} from "./providerIdentities";
import { p4IdentityAuthority } from "./p4Identities";
import type { Id } from "./_generated/dataModel";

import {repositoryContextValidator,type RepositoryContext} from "./repositoryContextTypes";
export {repositoryContextValidator,type RepositoryContext} from "./repositoryContextTypes";
const identityRef=v.object({id:v.id("p4Identities"),generation:v.number()});

export async function validateRepositoryContext(ctx:QueryCtx|MutationCtx,receipt:RepositoryContext){
 const {repo,user}=await repositoryAccess(ctx,receipt.userId,receipt.repositoryId);
 if(receipt.nativeActor){const native=await p4IdentityAuthority(ctx,receipt.nativeActor.id,receipt.nativeActor.generation);if(native.repo._id!==repo._id||native.identity.userId!==user._id||native.identity.username!==receipt.actor)throw new Error("Native context author changed");}
 else if(receipt.providerActor){const linked=await providerIdentityAuthority(ctx,receipt.providerActor.id,repo._id,receipt.providerActor.generation);if(linked.identity.userId!==user._id||linked.identity.username!==receipt.actor||linked.identity.externalId!==receipt.providerActor.externalId)throw new Error("Provider context author changed");}
 else if(repo.connectionId||!receipt.githubActorId||String(user.githubId)!==receipt.githubActorId||user.login!==receipt.actor)throw new Error("Context author or provider identity changed");
 const allowed=new Set<string>();
 for(const reference of receipt.clusters){
  const cluster=await ctx.db.get(reference.id);
  if(!cluster||cluster.organizationId!==repo.organizationId||!cluster.repositoryIds.includes(repo._id)||JSON.stringify(cluster.repositoryIds)!==JSON.stringify(reference.repositoryIds))throw new Error("Repository context cluster changed; re-review");
  for(const id of cluster.repositoryIds){const r=(await repositoryAccess(ctx,user._id,id)).repo;if(r.organizationId!==repo.organizationId)throw new Error("Repository context workspace changed");allowed.add(id);}
 }
 for(const ref of receipt.sources){
  if((ref.paths?.length??0)>10)throw new Error("Repository context path limit exceeded");
  const r=(await repositoryAccess(ctx,user._id,ref.repositoryId)).repo;
  if(!allowed.has(r._id)||r._id===repo._id||r.indexStatus!=="ready"||r.indexedSha!==ref.revision||r.connectionId!==ref.connectionId||r.installationId!==ref.installationId||r.externalId!==ref.externalId||r.fullName!==ref.fullName)throw new Error("Repository context revision or provider changed; re-review");
  if(r.connectionId){const c=await ctx.db.get(r.connectionId);if(!c?.active||c.suspended||c.organizationId!==repo.organizationId||c.instance!==ref.instance||c.kind!==ref.kind||!r.enabled&&c.kind!=="perforce"||await connectionDigest(c.credentials)!==ref.credentialDigest)throw new Error("Repository context connection revoked or replaced");}
  if(!r.connectionId&&!r.enabled)throw new Error("Repository context source disabled");
  if(ref.kind==="bitbucket-cloud"||ref.kind==="origin"){if(!ref.providerIdentity)throw new Error("Provider context source requires native personal identity");const linked=await providerIdentityAuthority(ctx,ref.providerIdentity.id,r._id,ref.providerIdentity.generation);if(linked.identity.userId!==user._id||linked.identity.externalId!==ref.providerIdentity.externalId)throw new Error("Provider source personal identity changed");}
  else if(ref.providerIdentity)throw new Error("Personal source identity provider changed");
  if(ref.identity){const native=await p4IdentityAuthority(ctx,ref.identity.id,ref.identity.generation);if(native.repo._id!==r._id||native.identity.userId!==user._id)throw new Error("Repository context native identity changed");}
  if(ref.baselineJobId){const job=await ctx.db.get(ref.baselineJobId);if(!ref.identity||!job?.nativeDepot||job.repositoryId!==r._id||job.status!=="completed"||job.sha!==ref.revision||job.nativeDepot.connectionId!==ref.connectionId||job.nativeDepot.credentialDigest!==ref.credentialDigest||!job.manifestStorageId)throw new Error("P4 context baseline changed");}
 }
}
export const validate=internalQuery({args:{receipt:repositoryContextValidator},handler:async(ctx,a)=>{await validateRepositoryContext(ctx,a.receipt);return true;}});

export const select=internalQuery({args:{repositoryId:v.id("repositories"),actor:v.string(),authorExternalId:v.optional(v.string()),nativeActor:v.optional(identityRef),nativeAuthor:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo)throw new Error("Context repository missing");
 const clusters=(await ctx.db.query("repositoryClusters").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect()).filter(c=>c.repositoryIds.includes(repo._id));
 if(!clusters.length)return {receipt:null,sources:[],coverage:[]};
 const primaryConnection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(primaryConnection&&primaryConnection.kind!=="perforce"&&!personalIdentityProviders.includes(primaryConnection.kind))return {receipt:null,sources:[],coverage:["Cross-repository context omitted: this provider requires a verified connection-specific review-author identity; native username equality is insufficient."]};
 if(primaryConnection?.kind==="perforce"&&!a.nativeActor)return {receipt:null,sources:[],coverage:["Cross-repository context omitted: native review author must link a personal P4 identity."]};
 if(a.nativeAuthor&&!a.nativeActor)return {receipt:null,sources:[],coverage:["Cross-repository context omitted: native review author must link a personal P4 identity."]};
 let githubActorId:string|undefined;
 let userId:Id<"users">|undefined,providerActor:RepositoryContext["providerActor"];
 if(primaryConnection&&personalIdentityProviders.includes(primaryConnection.kind)){
  const linked=a.authorExternalId?await ctx.db.query("providerIdentities").withIndex("by_connection_external",q=>q.eq("connectionId",primaryConnection._id).eq("externalId",a.authorExternalId!)).unique():null;
  try{if(!linked||linked.username!==a.actor)throw new Error("Unlinked author");await providerIdentityAuthority(ctx,linked._id,repo._id);userId=linked.userId;providerActor={id:linked._id,generation:linked.generation,externalId:linked.externalId};}catch{return {receipt:null,sources:[],coverage:["Cross-repository context omitted: link the review author's personal provider identity for this connection."]};}
 }
 else if(a.nativeActor){const native=await p4IdentityAuthority(ctx,a.nativeActor.id,a.nativeActor.generation);if(native.repo._id!==repo._id||native.identity.username!==a.actor)throw new Error("Native context author mismatch");userId=native.identity.userId;}
 else{
  if(!a.authorExternalId||!/^([1-9][0-9]*)$/.test(a.authorExternalId))return {receipt:null,sources:[],coverage:["Cross-repository context omitted: GitHub review author has no verified immutable account ID."]};
  for(const m of await ctx.db.query("organizationMembers").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect()){const u=await ctx.db.get(m.userId);if(u?.login===a.actor&&String(u.githubId)===a.authorExternalId){userId=m.userId;githubActorId=a.authorExternalId;break;}}
 }
 if(!userId)return {receipt:null,sources:[],coverage:["Cross-repository context omitted: review author is not linked to a workspace identity."]};
 await repositoryAccess(ctx,userId,repo._id);
 const selected:RepositoryContext["clusters"]=[],approved=new Set<Id<"repositories">>(),coverage:string[]=[];
 for(const c of clusters){let accessible=true;for(const id of c.repositoryIds){try{if((await repositoryAccess(ctx,userId,id)).repo.organizationId!==repo.organizationId)accessible=false;}catch{accessible=false;}}
  if(!accessible){coverage.push("A repository cluster was omitted because the review author lacks access to every participating repository.");continue;}
  selected.push({id:c._id,repositoryIds:c.repositoryIds});c.repositoryIds.forEach(id=>approved.add(id));
 }
 const receipt:RepositoryContext={repositoryId:repo._id,userId,actor:a.actor,githubActorId,nativeActor:a.nativeActor,providerActor,clusters:selected,sources:[]};
 const sources=[];
 for(const id of approved){
  if(id===repo._id)continue;const source=(await repositoryAccess(ctx,userId,id)).repo;
  if(source.indexStatus!=="ready"||!source.indexedSha){coverage.push("Cross-repository source not ready: "+source.fullName);continue;}
  const connection=source.connectionId?await ctx.db.get(source.connectionId):null;
  if(!source.enabled&&connection?.kind!=="perforce"||source.connectionId&&(!connection?.active||connection.suspended)){coverage.push("Cross-repository source connection unavailable: "+source.fullName);continue;}
  const ref:RepositoryContext["sources"][number]={repositoryId:id,revision:source.indexedSha,connectionId:source.connectionId,installationId:source.installationId,externalId:source.externalId,fullName:source.fullName,instance:connection?.instance,kind:connection?.kind,credentialDigest:connection?await connectionDigest(connection.credentials):undefined};
  if(connection?.kind==="bitbucket-cloud"||connection?.kind==="origin"){
   const linked=await ctx.db.query("providerIdentities").withIndex("by_connection_user",q=>q.eq("connectionId",connection._id).eq("userId",userId!)).unique();
   try{if(!linked)throw new Error("Unlinked source");await providerIdentityAuthority(ctx,linked._id,id,linked.generation);ref.providerIdentity={id:linked._id,generation:linked.generation,externalId:linked.externalId};}catch{coverage.push("Provider cross-repository source requires a current personal identity: "+source.fullName);continue;}
  }
  let nativeIdentity=null,baseline=null;
  if(connection?.kind==="perforce"){
   const identity=await ctx.db.query("p4Identities").withIndex("by_repo_user",q=>q.eq("repositoryId",id).eq("userId",userId!)).unique();
   if(identity){try{nativeIdentity=(await p4IdentityAuthority(ctx,identity._id,identity.generation)).identity;}catch{/* Explicit omission below; bot credentials cannot substitute. */}}
   baseline=await ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",id)).order("desc").first();
   if(!nativeIdentity||!baseline?.nativeDepot||baseline.status!=="completed"||baseline.sha!==source.indexedSha||!baseline.manifestStorageId){coverage.push("P4 cross-repository source requires a current personal identity and submitted baseline: "+source.fullName);continue;}
   ref.identity={id:nativeIdentity._id,generation:nativeIdentity.generation};ref.baselineJobId=baseline._id;
  }
  receipt.sources.push(ref);sources.push({repo:source,connection,identity:nativeIdentity,baseline});
 }
 await validateRepositoryContext(ctx,receipt);
 return {receipt,sources,coverage};
}});

export const baseline=internalQuery({args:{id:v.id("indexJobs")},handler:async(ctx,a)=>{const job=await ctx.db.get(a.id);if(!job?.manifestStorageId)throw new Error("Context baseline missing");return job;}});

export async function requireContextReader(ctx:QueryCtx|MutationCtx,userId:Id<"users">,review:{repositoryContext?:RepositoryContext}){
 if(!review.repositoryContext)return;
 const ids=new Set([...review.repositoryContext.clusters.flatMap(c=>c.repositoryIds),...review.repositoryContext.sources.map(s=>s.repositoryId)]);
 for(const id of ids)await repositoryAccess(ctx,userId,id);
}
export async function contextReadable(ctx:QueryCtx|MutationCtx,userId:Id<"users">,review:{repositoryContext?:RepositoryContext}){try{await requireContextReader(ctx,userId,review);return true;}catch{return false;}}

export async function requireFindingReader(ctx:QueryCtx|MutationCtx,userId:Id<"users">,finding:{evidence:{filePath:string}[]}){
 const ids=new Set(finding.evidence.flatMap(e=>{const match=/^context\/([^/]+)\//.exec(e.filePath);return match?[match[1] as Id<"repositories">]:[];}));for(const id of ids)await repositoryAccess(ctx,userId,id);
}
