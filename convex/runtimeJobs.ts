"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { runtimeEvidenceValidator } from "./schema";
import { provider } from "./scm";
import { P4CodeReview, p4Credential } from "../src/perforce";
import { decryptCredential } from "../src/credentials";
import { p4RuntimeArchive } from "../src/p4-runtime";
async function nativeRuntime(ctx:Parameters<typeof provider>[0],reviewId:import("./_generated/dataModel").Id<"reviews">){
 const state=await ctx.runQuery(internal.p4Reviews.data,{reviewId});
 const credential=p4Credential.parse(JSON.parse(decryptCredential(state.connection.credentials,state.repo.organizationId+":perforce")));
 const client=new P4CodeReview(state.connection.instance,credential.username,credential.ticket);
 const snapshot=await client.snapshot(state.repo.externalId!,state.review.prNumber);
 return {state,client,snapshot,stale:snapshot.revision!==state.review.headSha||!snapshot.review.versions.at(-1)?.pending||!["needsReview","needsRevision"].includes(snapshot.review.state)};
}
export const prepare=internalAction({args:{id:v.id("runtimeJobs")},handler:async(ctx,a)=>{
 if(!await ctx.runMutation(internal.runtime.preparing,a))return;
 try{
  const {job,repo}=await ctx.runQuery(internal.runtime.data,a);
  const {review}=await ctx.runQuery(internal.reviews.data,{reviewId:job.reviewId});
  let source:Uint8Array;
  if(review.nativeP4){
   const native=await nativeRuntime(ctx,job.reviewId);
   if(native.stale||native.snapshot.revision!==job.headSha||review.revisionKey!==job.revisionKey)throw new Error("P4 runtime revision changed");
   const manifest=await ctx.storage.get(native.state.job.manifestStorageId!);
   if(!manifest||manifest.size>1000000)throw new Error("P4 runtime baseline manifest unavailable");
   const saved=JSON.parse(await manifest.text());
   if(saved.sha!==review.baseSha)throw new Error("P4 runtime baseline revision mismatch");
   source=await p4RuntimeArchive(native.client,saved.inventory,native.snapshot);
   await ctx.runQuery(internal.p4Reviews.data,{reviewId:job.reviewId});
  }else{
   const client=await provider(ctx,repo);
   if(!client.archive)throw new Error("This provider does not yet support exact-revision runtime archives");
   source=await client.archive(repo.fullName,job.headSha);
  }
  const sourceStorageId=await ctx.storage.store(new Blob([source as BlobPart],{type:"application/gzip"}));
  await ctx.runMutation(internal.runtime.ready,{...a,sourceStorageId});
 }catch(error){await ctx.runMutation(internal.runtime.complete,{...a,error:error instanceof Error?error.message:"Runtime source preparation failed"});}
}});
export const report=internalAction({args:{id:v.id("runtimeJobs"),hash:v.string(),lease:v.string(),error:v.optional(v.string()),evidence:v.optional(runtimeEvidenceValidator),tests:v.optional(v.array(v.object({fingerprint:v.string(),evidence:v.optional(runtimeEvidenceValidator),error:v.optional(v.string())})))},handler:async(ctx,a)=>{
 const job=await ctx.runQuery(internal.runtime.authenticatedJob,{hash:a.hash,id:a.id,lease:a.lease});
 const {repo}=await ctx.runQuery(internal.runtime.data,{id:a.id});
 const review=await ctx.runQuery(internal.reviews.data,{reviewId:job.reviewId});
 let stale:boolean;
 if(review.review.nativeP4){
  try{const native=await nativeRuntime(ctx,job.reviewId);stale=native.stale||native.snapshot.revision!==job.headSha||native.state.review.revisionKey!==job.revisionKey;}
  catch{stale=true;}
 }else{
  const current=await (await provider(ctx,repo)).pullRequest(repo.fullName,review.review.prNumber);
  stale=current.state!=="open"||current.head.sha!==job.headSha||current.revisionKey!==job.revisionKey;
 }
 await ctx.runMutation(internal.runtime.complete,{...a,stale});
}});
