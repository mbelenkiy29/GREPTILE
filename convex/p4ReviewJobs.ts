"use node";
import {budgetModel} from "./budgetModel";
import {action,internalAction} from "./_generated/server";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import {hasCurrentRepositoryEvidence} from "../src/context-history";
import type {RepositoryContext} from "./repositoryContext";
import type {Id} from "./_generated/dataModel";
import {decryptCredential} from "../src/credentials";
import {connectionDigest} from "./indexAuthority";
import {P4CodeReview,p4Credential} from "../src/perforce";
import {reviewChange} from "../src/engine/review";
import {findingSchema,categories,severities,type ReviewInput,type ReviewResult,type ModelProvider} from "../src/engine/types";
import {ModelFailure} from "../src/engine/model";
import {reviewLinks} from "../src/review-summary";
import {redact} from "../src/redact";
import {z} from "zod";
import {randomUUID} from "node:crypto";

export const request=action({args:{token:v.string(),organizationId:v.id("organizations"),repositoryId:v.id("repositories"),nativeNumber:v.number(),force:v.optional(v.boolean()),expectedRevision:v.optional(v.string()),expectedBaseRevision:v.optional(v.string())},handler:async(ctx,a):Promise<Id<"reviews">>=>{
 if(!Number.isSafeInteger(a.nativeNumber)||a.nativeNumber<1)throw new Error("Invalid P4 review number");
 const access=await ctx.runQuery(internal.p4Index.authorize,{token:a.token,organizationId:a.organizationId,repositoryId:a.repositoryId});
 const prepared=await ctx.runAction(internal.p4ShelfJobs.prepare,{repositoryId:a.repositoryId,requestedBy:access.nativeDepot.requestedBy,reviewId:a.nativeNumber,revision:a.expectedRevision});
 try{if(a.expectedBaseRevision!==undefined&&prepared.baseRevision!==a.expectedBaseRevision)throw new Error('Submitted baseline changed; refresh the pull request list');return await ctx.runMutation(internal.p4Reviews.enqueue,{repositoryId:a.repositoryId,requestedBy:access.nativeDepot.requestedBy,nativeNumber:a.nativeNumber,revision:prepared.revision,baseRevision:prepared.baseRevision,baselineJobId:prepared.baselineJobId,inputStorageId:prepared.storageId,connectionId:access.connection._id,credentialDigest:await connectionDigest(access.connection.credentials),force:a.force});}
 catch(error){await ctx.storage.delete(prepared.storageId);throw error;}
}});

export const run=internalAction({args:{reviewId:v.id("reviews")},handler:async(ctx,a)=>{
 const leaseId=randomUUID();
 try{
  const initial=await ctx.runQuery(internal.reviews.data,a);
  if(["completed","cancelled"].includes(initial.review.status))return;
  if(!initial.review.nativeP4)throw new Error("P4 review unavailable");
  if(!await ctx.runMutation(internal.p4Reviews.claim,{...a,leaseId}))return;
  let state=await ctx.runQuery(internal.p4Reviews.data,{...a,leaseId});
  const credential=p4Credential.parse(JSON.parse(decryptCredential(state.connection.credentials,state.repo.organizationId+":perforce")));
  const client=new P4CodeReview(state.connection.instance,credential.username,credential.ticket);
  const current=async()=>{
   state=await ctx.runQuery(internal.p4Reviews.data,{...a,leaseId});
   if(state.review.status==="cancelled")throw new Error("P4 review cancelled");
   const snapshot=await client.snapshot(state.repo.externalId!,state.review.prNumber);
   if(snapshot.revision!==state.review.headSha||!snapshot.review.versions.at(-1)?.pending||!["needsReview","needsRevision"].includes(snapshot.review.state)){
    await ctx.runMutation(internal.reviews.stage,{...a,workerLease:leaseId,status:"cancelled",detail:"P4 shelf changed or closed; request the current revision"});
    throw new Error("P4 shelf changed or closed; request the current revision");
   }
   return snapshot;
  };
  const snapshot=await current(),blob=await ctx.storage.get(state.review.nativeP4!.inputStorageId);
  if(!blob||blob.size>60000000)throw new Error("P4 prepared input unavailable or exceeds coverage");
  const prepared=JSON.parse(await blob.text()) as {input:ReviewInput;repositoryId:string;connectionId:string;baselineJobId:string;baseRevisions:Record<string,number>};
  if(prepared.repositoryId!==state.repo._id||prepared.connectionId!==state.connection._id||prepared.baselineJobId!==state.review.nativeP4!.baselineJobId||prepared.input.headSha!==snapshot.revision||prepared.input.baseSha!==state.review.baseSha)throw new Error("P4 prepared input identity mismatch");
  const config=await ctx.runQuery(internal.repositories.data,{repositoryId:state.repo._id});
  await ctx.runMutation(internal.reviews.recordPr,{...a,workerLease:leaseId,title:prepared.input.title,author:snapshot.review.author,url:client.base+"/reviews/"+snapshot.review.id,headSha:snapshot.revision,baseSha:prepared.input.baseSha,state:"open",commits:[snapshot.revision]});
  if(!state.review.resultStorageId&&await ctx.runMutation(internal.runtime.request,{...a,workerLease:leaseId}))return;
  state=await ctx.runQuery(internal.p4Reviews.data,{...a,leaseId});
  let result:ReviewResult&{repositoryContext?:RepositoryContext;integrationScopes?:{id:Id<"integrationConnections">;generation:number}[]};
  if(state.review.resultStorageId){const saved=await ctx.storage.get(state.review.resultStorageId);if(!saved||saved.size>2000000)throw new Error("P4 saved result unavailable");result=JSON.parse(await saved.text());if(result.metadata.headSha!==snapshot.revision)throw new Error("P4 saved result revision mismatch");}
  else{
   const requirements=await ctx.runAction(internal.integrationJobs.requirements,{repositoryId:state.repo._id,references:prepared.input.title+"\n"+prepared.input.description});
   const linked=await ctx.runQuery(internal.p4Identities.find,{repositoryId:state.repo._id,username:snapshot.review.author});
   const cross=await ctx.runAction(internal.repositoryContextJobs.retrieve,{repositoryId:state.repo._id,actor:snapshot.review.author,nativeAuthor:true,nativeActor:linked?{id:linked.identity._id,generation:linked.identity.generation}:undefined,identifiers:[...new Set(prepared.input.diff.flatMap(f=>f.patch.match(/[A-Za-z_]\w{3,}/g)??[]))].slice(0,30)});
   const context={repositoryId:state.repo._id,scopes:requirements.scopes,repositoryContext:cross.receipt??undefined};
   const underlying=budgetModel(ctx,config.settings.model,{get:key=>ctx.runQuery(internal.cache.get,{organizationId:state.repo.organizationId,key,context}),set:async(key,value)=>{await ctx.runMutation(internal.cache.set,{organizationId:state.repo.organizationId,key,result:value,context});}});
   const model:ModelProvider={generate:async(request,validator)=>{
    const currentSnapshot=await current();
    if(cross.receipt){if(currentSnapshot.review.author!==cross.receipt.actor)throw new Error("P4 context author changed");await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:cross.receipt});}
    try{const response=await underlying.generate(request,validator);await ctx.runMutation(internal.reviews.recordCall,{...a,usage:response.usage});if(cross.receipt)await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:cross.receipt});return response;}
    catch(error){if(error instanceof ModelFailure)await ctx.runMutation(internal.reviews.recordCall,{...a,usage:error.usage,error:redact(error.message).slice(0,4000)});throw error;}
   }};
   const prior=(await ctx.runQuery(internal.reviews.data,a)).findings,findings=prior.filter(f=>hasCurrentRepositoryEvidence(f,cross.files));
   result={...await reviewChange({...prepared.input,mode:state.review.mode as ReviewInput["mode"],files:[...prepared.input.files,...requirements.files,...cross.files],runtimeEvidence:state.review.runtimeEvidence,coverageLimits:[...(prepared.input.coverageLimits??[]),...requirements.coverage,...cross.coverage,...(findings.length<prior.length?["Some prior cross-repository findings were withheld because their exact pinned evidence was not fetched in the current authorized context; they remain unresolved."]:[]),"Runtime archives preserve depot-relative paths and the selected operator-enumerated baseline; P4 protections can hide files and inventory completeness cannot be measured."],contextHints:[...cross.hints,...requirements.files.map(f=>({path:f.path,reason:"authorized requirements at "+f.sha,score:100}))],rules:config.rules.map(r=>({id:r._id,title:r.title,instructions:r.instructions,severity:z.enum(severities).parse(r.severity),category:r.category,globs:r.globs,enabled:r.enabled})),preferences:config.preferences,existingFindings:findings.map(f=>({...findingSchema.parse(f),fingerprint:f.fingerprint,agent:f.agent,commitSha:f.commitSha})),settings:{minimumConfidence:config.settings.minimumConfidence,severityThreshold:z.enum(severities).parse(config.settings.severityThreshold),maxComments:config.settings.maxComments,ignoredPaths:config.settings.ignoredPaths,categories:config.settings.categories.map(c=>z.enum(categories).parse(c)),instructions:config.settings.instructions,summarySections:config.settings.summarySections}},model,async status=>{await ctx.runMutation(internal.reviews.stage,{...a,workerLease:leaseId,status});}),integrationScopes:requirements.scopes,repositoryContext:cross.receipt??undefined};
   await current();
   const storageId=await ctx.storage.store(new Blob([JSON.stringify(result)],{type:"application/json"}));
   try{await ctx.runMutation(internal.reviews.save,{...a,workerLease:leaseId,storageId,summary:result.summary,integrationScopes:requirements.scopes,repositoryContext:cross.receipt??undefined,approvalAssessment:result.metadata.approvalAssessment,reviewScore:result.metadata.reviewScore,coverageLimits:result.metadata.coverageLimits,findings:[...result.findings,...(result.metadata.carriedForward??[])],resolved:result.metadata.resolvedFingerprints,usage:result.usage});}catch(error){await ctx.storage.delete(storageId);throw error;}
  }
  await ctx.runMutation(internal.reviews.stage,{...a,workerLease:leaseId,status:"publishing"});
  await ctx.runQuery(internal.integrations.validate,{repositoryId:state.repo._id,scopes:result.integrationScopes??[]});
  const latest=await current();
  if(result.repositoryContext){if(result.repositoryContext.repositoryId!==state.repo._id||latest.review.author!==result.repositoryContext.actor)throw new Error("P4 context author changed");await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:result.repositoryContext});}
  const published=await client.publish(latest,result.summary+reviewLinks(a.reviewId,result.findings.length),result.findings.slice(0,config.settings.maxComments).map(f=>({...f,filePath:"//"+f.filePath})),prepared.baseRevisions,a.reviewId,config.settings.commentStyle,async()=>{const latest=await current();if(result.repositoryContext){if(result.repositoryContext.repositoryId!==state.repo._id||latest.review.author!==result.repositoryContext.actor)throw new Error("P4 context author changed");await ctx.runAction(internal.repositoryContextJobs.validate,{receipt:result.repositoryContext});}await ctx.runQuery(internal.integrations.validate,{repositoryId:state.repo._id,scopes:result.integrationScopes??[]});});
  await ctx.runMutation(internal.p4Reviews.finish,{...a,leaseId,githubReviewId:published.id,comments:published.comments});
 }catch(error){await ctx.runMutation(internal.p4Reviews.finish,{...a,leaseId,error:redact(error instanceof Error?error.message:"P4 review failed").slice(0,4000)});}
}});
