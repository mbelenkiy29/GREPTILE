"use node";
import {internalAction,type ActionCtx} from "./_generated/server";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import {provider} from "./scm";
import {originCredentials,originPersonalIdentity,originUserAccess} from '../src/origin-auth';
import {revalidateForgePersonalAccess} from "../src/bitbucket-forge";
import {authenticatedProviderIdentity} from "../src/provider-identity";
import {P4CodeReview,P4Error,p4Credential} from "../src/perforce";
import {decryptCredential} from "../src/credentials";
import {parseP4SubmittedInventory} from "../src/p4-index";
import {eligibleFile,redact} from "../src/engine/indexer";
import type {SourceFile} from "../src/engine/types";
import {repositoryContextValidator,type RepositoryContext} from "./repositoryContext";

export const retrieve=internalAction({args:{repositoryId:v.id("repositories"),actor:v.string(),authorExternalId:v.optional(v.string()),nativeActor:v.optional(v.object({id:v.id("p4Identities"),generation:v.number()})),identifiers:v.array(v.string()),nativeAuthor:v.optional(v.boolean())},handler:async(ctx,a):Promise<{receipt:RepositoryContext|null;files:SourceFile[];hints:{path:string;reason:string;score:number}[];coverage:string[]}>=>{
 const selected=await ctx.runQuery(internal.repositoryContext.select,{repositoryId:a.repositoryId,actor:a.actor,authorExternalId:a.authorExternalId,nativeActor:a.nativeActor,nativeAuthor:a.nativeAuthor});
 if(selected.receipt)await ctx.runAction(internal.repositoryContextJobs.guardForgeContext,{receipt:selected.receipt});
 const files:SourceFile[]=[],hints:{path:string;reason:string;score:number}[]=[],coverage=[...selected.coverage];let bytes=0,omitted=0;
 for(const source of selected.sources){
  const repo=source.repo,related=await ctx.runQuery(internal.context.related,{repositoryId:repo._id,paths:[],identifiers:a.identifiers.slice(0,30)});
  if(bytes>=100000){omitted++;continue;}
  const accept=(file:SourceFile,url:string)=>{
   if(!eligibleFile(file))return;const content=redact(file.content),size=Buffer.byteLength(content);
   if(size+bytes>100000){omitted++;return;}bytes+=size;
   const path="context/"+repo._id+"/"+repo.indexedSha+"/"+file.path;
   files.push({...file,path,content,provenance:{repository:repo.fullName,revision:repo.indexedSha!,sourceUrl:url}});const ref=selected.receipt?.sources.find(s=>s.repositoryId===repo._id);if(ref)(ref.paths??=[]).push(file.path);hints.push({path,reason:"authorized cross-repository context at "+repo.indexedSha,score:30});
  };
  if(source.connection?.kind==="perforce"){
   coverage.push("P4 cross-repository inventory may be filtered by native protections; hidden files and inventory completeness cannot be measured.");
   const identity=source.identity!,credential=p4Credential.parse(JSON.parse(decryptCredential(identity.credentials!,repo.organizationId+":p4-personal:"+repo._id+":"+identity.userId)));
   if(credential.username!==identity.username)throw new Error("P4 source identity credential mismatch");
   const client=new P4CodeReview(source.connection.instance,credential.username,credential.ticket);await client.authenticatedIdentity();
   const blob=await ctx.storage.get(source.baseline!.manifestStorageId!);if(!blob||blob.size>1000000)throw new Error("P4 cross-repository manifest unavailable");
   const saved=JSON.parse(await blob.text()),inventory=parseP4SubmittedInventory(saved.inventory);
   if(saved.sha!==repo.indexedSha||inventory.revision!==repo.indexedSha)throw new Error("P4 cross-repository baseline revision mismatch");
   const project=await client.project(repo.externalId!);if(JSON.stringify(project)!==JSON.stringify(inventory.project))throw new Error("P4 personal context project views changed");
   const records=inventory.manifest.filter(f=>related.paths.includes(f.depotFile.slice(2))&&!["delete","move/delete"].includes(f.headAction));
   omitted+=Math.max(0,records.length-10);
   for(const record of records.slice(0,10)){
    if(!eligibleFile({path:record.depotFile.slice(2),content:"",sha:"",size:record.fileSize})||!["text","utf8","unicode"].includes(record.headType.split("+")[0])){omitted++;continue;}
    try{const file=await client.submittedContent(project,record,inventory.serverId,inventory.change);accept(file,client.base+"/view/"+file.path.split("/").map(encodeURIComponent).join("/")+"?v="+encodeURIComponent("#"+record.headRev));}
    catch(error){if(error instanceof P4Error&&[403,404].includes(error.status)){omitted++;coverage.push("P4 source unavailable to its linked native author: "+record.depotFile);continue;}throw error;}
   }
   await client.authenticatedIdentity();
  }else{
   const client=await provider(ctx,repo),tree=(await client.tree(repo.fullName,repo.indexedSha!)).filter(f=>related.paths.includes(f.path));omitted+=Math.max(0,tree.length-10);
   for(const entry of tree.slice(0,10)){if(bytes>=100000){omitted++;continue;}const file=await client.blob(repo.fullName,entry.path,entry.sha);accept(file,client.sourceUrl(repo.fullName,repo.indexedSha!,file.path));}
  }
 }
 if(files.length)coverage.push("Cross-repository retrieval is bounded to 10 files per repository and 100 KB, selected through indexed graph/search context.");
 if(omitted)coverage.push(`${omitted} cross-repository source selections were omitted by eligibility or the 10-files-per-repository / 100 KB retrieval limits.`);
 if(selected.receipt)await ctx.runAction(internal.repositoryContextJobs.guardForgeContext,{receipt:selected.receipt});
 return {receipt:selected.receipt,files,hints,coverage};
}});

export const validate=internalAction({args:{receipt:repositoryContextValidator},handler:async(ctx,a)=>{
 await ctx.runQuery(internal.repositoryContext.validate,a);
 if(a.receipt.providerActor){
  const ref=a.receipt.providerActor,state=await ctx.runQuery(internal.providerIdentities.data,{id:ref.id,repositoryId:a.receipt.repositoryId,generation:ref.generation}),personal=decryptCredential(state.identity.credentials!,state.repo.organizationId+":provider-personal:"+state.connection._id+":"+state.identity.userId),current=state.connection.kind==='bitbucket-cloud'?await revalidateForgePersonalAccess(personal,state.connection.installationId??'',state.connection.namespaceId??'',state.repo.externalId??'',state.repo.fullName):state.connection.kind==='origin'?await originUserAccess(originCredentials.parse(JSON.parse(decryptCredential(state.connection.credentials,state.connection.organizationId+':origin'))),originPersonalIdentity.parse(JSON.parse(personal)),state.repo.externalId??''):await authenticatedProviderIdentity(state.connection.kind,state.connection.instance,personal);
  if(current.externalId!==ref.externalId||current.username!==a.receipt.actor)throw new Error("Native provider author identity changed or revoked");
 }
 await validatePersonalSources(ctx,a.receipt);
 const identities=[...(a.receipt.nativeActor?[{...a.receipt.nativeActor,source:undefined}]:[]),...a.receipt.sources.flatMap(source=>source.identity?[{...source.identity,source}]:[])];
 for(const ref of identities){
  const state=await ctx.runQuery(internal.p4Identities.data,{id:ref.id,generation:ref.generation}),identity=state.identity,credential=p4Credential.parse(JSON.parse(decryptCredential(identity.credentials!,state.repo.organizationId+":p4-personal:"+state.repo._id+":"+identity.userId)));
  if(credential.username!==identity.username)throw new Error("P4 source identity credential mismatch");
  const client=new P4CodeReview(state.connection.instance,credential.username,credential.ticket);await client.authenticatedIdentity();
  const project=await client.project(state.repo.externalId!);
  if(ref.source){
   const baseline=await ctx.runQuery(internal.repositoryContext.baseline,{id:ref.source.baselineJobId!}),blob=await ctx.storage.get(baseline.manifestStorageId!);
   if(!blob||blob.size>1000000)throw new Error("P4 source manifest unavailable");
   const saved=JSON.parse(await blob.text()),inventory=parseP4SubmittedInventory(saved.inventory);
   if(inventory.revision!==ref.source.revision||saved.sha!==ref.source.revision||JSON.stringify(project)!==JSON.stringify(inventory.project))throw new Error("P4 context revision or native project views changed");
   for(const path of ref.source.paths??[]){const record=inventory.manifest.find(f=>f.depotFile.slice(2)===path);if(!record)throw new Error("P4 context source outside pinned inventory");await client.submittedContent(project,record,inventory.serverId,inventory.change);}
  }
 }
 await ctx.runQuery(internal.repositoryContext.validate,a);return true;
}});

async function validatePersonalSources(ctx:ActionCtx,receipt:RepositoryContext){
 for(const source of receipt.sources){
  if(source.kind!=="bitbucket-cloud"&&source.kind!=="origin")continue;const ref=source.providerIdentity;if(!ref)throw new Error("Provider source personal identity missing");
  const state=await ctx.runQuery(internal.providerIdentities.data,{id:ref.id,repositoryId:source.repositoryId,generation:ref.generation}),personal=decryptCredential(state.identity.credentials!,state.repo.organizationId+":provider-personal:"+state.connection._id+":"+state.identity.userId);
  const current=source.kind==="origin"?await originUserAccess(originCredentials.parse(JSON.parse(decryptCredential(state.connection.credentials,state.connection.organizationId+":origin"))),originPersonalIdentity.parse(JSON.parse(personal)),state.repo.externalId??""):await revalidateForgePersonalAccess(personal,state.connection.installationId??"",state.connection.namespaceId??"",state.repo.externalId??"",state.repo.fullName);
  if(current.externalId!==ref.externalId||state.identity.userId!==receipt.userId)throw new Error("Provider source personal access changed");
 }
}

export const guardForgeContext=internalAction({args:{receipt:repositoryContextValidator},handler:async(ctx,a)=>{
 await ctx.runQuery(internal.repositoryContext.validate,a);
 if(a.receipt.providerActor){const ref=a.receipt.providerActor,state=await ctx.runQuery(internal.providerIdentities.data,{id:ref.id,repositoryId:a.receipt.repositoryId,generation:ref.generation});
  if(state.connection.kind==="bitbucket-cloud"||state.connection.kind==="origin"){const personal=decryptCredential(state.identity.credentials!,state.repo.organizationId+":provider-personal:"+state.connection._id+":"+state.identity.userId),current=state.connection.kind==="origin"?await originUserAccess(originCredentials.parse(JSON.parse(decryptCredential(state.connection.credentials,state.connection.organizationId+":origin"))),originPersonalIdentity.parse(JSON.parse(personal)),state.repo.externalId??""):await revalidateForgePersonalAccess(personal,state.connection.installationId??"",state.connection.namespaceId??"",state.repo.externalId??"",state.repo.fullName);if(current.externalId!==ref.externalId||current.username!==a.receipt.actor)throw new Error("Provider author changed");}
 }
 await validatePersonalSources(ctx,a.receipt);await ctx.runQuery(internal.repositoryContext.validate,a);return true;
}});
