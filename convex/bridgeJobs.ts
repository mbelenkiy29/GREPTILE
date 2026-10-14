"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { provider } from "./scm";
import {decryptCredential} from "../src/credentials";
import {P4CodeReview,p4Credential} from "../src/perforce";
import {parseP4SubmittedInventory} from "../src/p4-index";
import type {P4FixFile} from "../src/bridge-p4";
import {p4FixManifest} from "../src/p4-fix-manifest";

export const claim=action({args:{secret:v.string(),hash:v.string(),requestId:v.id("fixRequests")},handler:async(ctx,a):Promise<{requestId:Id<"fixRequests">;repository:string;remoteUrl?:string;headSha:string;agent:string;prompt:string;native?:{instance:string;project:string;serverId:string;files:P4FixFile[]}}>=>{
 try {
  const {repo,review,native}=await ctx.runMutation(internal.bridge.claimData,a);
  if(native){
   const blob=await ctx.storage.get(native.job.manifestStorageId!);if(!blob||blob.size>1000000)throw new Error("P4 baseline manifest unavailable");
   const saved=JSON.parse(await blob.text());const inventory=parseP4SubmittedInventory(saved.inventory);
   if(saved.sha!==review.baseSha||inventory.revision!==review.baseSha)throw new Error("P4 fix baseline revision mismatch");
   const credential=p4Credential.parse(JSON.parse(decryptCredential(native.connection.credentials,repo.organizationId+":perforce")));
   const client=new P4CodeReview(native.connection.instance,credential.username,credential.ticket),snapshot=await client.snapshot(repo.externalId!,review.prNumber);
   if(snapshot.revision!==review.headSha||!snapshot.review.versions.at(-1)?.pending||!["needsReview","needsRevision"].includes(snapshot.review.state)||JSON.stringify(await client.project(repo.externalId!))!==JSON.stringify(inventory.project))throw new Error("P4 shelf or project views changed; re-review before fixing");
   const files=p4FixManifest(inventory,native.files,snapshot);
   return await ctx.runMutation(internal.bridge.claim,{...a,current:{headSha:snapshot.revision,revisionKey:snapshot.revision,state:"open",native:{instance:native.connection.instance,project:repo.externalId!,serverId:inventory.serverId,files}}});
  }
  const pr=await (await provider(ctx,repo)).pullRequest(repo.fullName,review.prNumber);
  return await ctx.runMutation(internal.bridge.claim,{...a,current:{headSha:pr.head.sha,revisionKey:pr.revisionKey,state:pr.state}});
 }catch(error){
  // A duplicate or revoked request cannot overwrite a successful claim.
  await ctx.runMutation(internal.bridge.claimFailed,a).catch(()=>{});
  throw error;
 }
}});
