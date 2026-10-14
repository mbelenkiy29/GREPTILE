"use node";
import {action} from "./_generated/server";
import {internal} from "./_generated/api";
import type {Id} from "./_generated/dataModel";
import {v} from "convex/values";
import {parseP4SubmittedInventory} from "../src/p4-index";
import {P4CodeReview,p4Credential} from "../src/perforce";
import {decryptCredential} from "../src/credentials";
import {exclusionReason} from "../src/engine/indexer";

export const upload=action({args:{token:v.string(),organizationId:v.id("organizations"),repositoryId:v.id("repositories"),instance:v.string(),inventory:v.string()},handler:async(ctx,a):Promise<{jobId:Id<"indexJobs">;revision:string;total:number}>=>{
 if(Buffer.byteLength(a.inventory)>750000)throw new Error("P4 metadata exceeds hosted upload coverage (750 KB)");
 const inventory=parseP4SubmittedInventory(JSON.parse(a.inventory));
 if(inventory.manifest.length>8000)throw new Error("Hosted P4 inventory exceeds 8,000 records");
 const {repo,connection,nativeDepot}=await ctx.runQuery(internal.p4Index.authorize,{token:a.token,organizationId:a.organizationId,repositoryId:a.repositoryId});
 if(a.instance!==connection.instance||inventory.project.id!==repo.externalId)throw new Error("P4 inventory belongs to another connection or project");
 const credential=p4Credential.parse(JSON.parse(decryptCredential(connection.credentials,repo.organizationId+":perforce")));
 const client=new P4CodeReview(connection.instance,credential.username,credential.ticket);
 if(JSON.stringify(await client.project(inventory.project.id))!==JSON.stringify(inventory.project))throw new Error("P4 project views changed; regenerate the native inventory");
 const skipped:{path:string;reason:string}[]=[],entries:{path:string;sha:string}[]=[];let bytes=0;
 for(const file of inventory.manifest){
  const path=file.depotFile.slice(2),sha=`p4:${inventory.serverId}:${file.headRev}:${file.digest?.toLowerCase()??"unreadable"}`;
  const reason=["delete","move/delete"].includes(file.headAction)?"Deleted at indexed revision":!["add","edit","branch","move/add","integrate","import"].includes(file.headAction)?"Archived or unavailable source action":!["text","utf8","unicode"].includes(file.headType.split("+")[0])?"Unsupported source type":exclusionReason({path,sha,size:file.fileSize,content:""});
  if(reason){skipped.push({path,reason});continue;}
  if(file.fileSize===undefined||!file.digest)throw new Error("P4 readable source metadata has no pinned digest or size");
  bytes+=file.fileSize;if(bytes>20000000)throw new Error("P4 inventory exceeds 20 MB indexing coverage");entries.push({path,sha});
 }
 const storageId=await ctx.storage.store(new Blob([JSON.stringify({sha:inventory.revision,gitignore:"",entries,inventory})],{type:"application/json"}));
 let jobId:Id<"indexJobs">|null=null;
 try{
  jobId=await ctx.runMutation(internal.repositories.indexing,{repositoryId:repo._id,sha:inventory.revision,total:entries.length,nativeDepot,skipped:skipped.slice(0,500),skippedTotal:skipped.length});
  if(!jobId)throw new Error("P4 indexing did not start");
  await ctx.runMutation(internal.repositories.indexProgress,{jobId,cursor:0,manifestStorageId:storageId});
  return {jobId,revision:inventory.revision,total:entries.length};
 }catch(error){if(!jobId)await ctx.storage.delete(storageId);throw error;}
}});
