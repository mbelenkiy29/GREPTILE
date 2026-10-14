"use node";
import {internalAction} from "./_generated/server";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import type {Id} from "./_generated/dataModel";
import {z} from "zod";
import {decryptCredential} from "../src/credentials";
import {P4CodeReview,p4Credential} from "../src/perforce";
import {p4ShelfFromIndex} from "../src/p4-shelf";
import type {SourceFile} from "../src/engine/types";

// Durable review dispatch consumes this private artifact; it never accepts client-supplied source bodies.
export const prepare=internalAction({args:{repositoryId:v.id("repositories"),requestedBy:v.id("users"),reviewId:v.number(),baselineJobId:v.optional(v.id("indexJobs")),revision:v.optional(v.string())},handler:async(ctx,a):Promise<{storageId:Id<"_storage">;revision:string;baselineJobId:Id<"indexJobs">;baseRevision:string;version:number;change:number}>=>{
 const before=await ctx.runQuery(internal.p4Index.baseline,{repositoryId:a.repositoryId,requestedBy:a.requestedBy,baselineJobId:a.baselineJobId});
 const blob=await ctx.storage.get(before.job.manifestStorageId!);
 if(!blob||blob.size>1000000)throw new Error("P4 baseline manifest unavailable or exceeds coverage");
 const manifest=z.object({sha:z.string(),inventory:z.unknown()}).parse(JSON.parse(await blob.text()));
 if(manifest.sha!==before.job.sha)throw new Error("P4 baseline manifest revision mismatch");
 const files:SourceFile[]=[];let bytes=0;
 for(const file of before.files){
  const source=await ctx.storage.get(file.storageId);
  if(!source||source.size>200000)throw new Error("P4 indexed source unavailable or exceeds coverage");
  bytes+=source.size;if(bytes>20000000)throw new Error("P4 context exceeds 20 MB coverage");files.push({path:file.path,sha:file.sha,content:await source.text(),size:source.size});
 }
 const credential=p4Credential.parse(JSON.parse(decryptCredential(before.connection.credentials,before.repo.organizationId+":perforce")));
 const client=new P4CodeReview(before.connection.instance,credential.username,credential.ticket);
 const result=await p4ShelfFromIndex(client,before.repo.externalId!,a.reviewId,{inventory:manifest.inventory,files,coverage:["P4 protections may hide files; hidden inventory cannot be measured.","Paths are depot-relative. Project-specific ignore files are not applied automatically.",...((before.job.skippedTotal??0)>0?[`${before.job.skippedTotal} baseline files were skipped; inspect the index job for recorded reasons.`]:[])]});
 if(a.revision&&result.input.headSha!==a.revision)throw new Error("P4 shelf no longer matches requested revision");
 const after=await ctx.runQuery(internal.p4Index.baseline,{repositoryId:a.repositoryId,requestedBy:a.requestedBy,baselineJobId:before.job._id});
 const initialFiles=new Map(before.files.map(f=>[f._id,f]));
 if(after.connection.credentials!==before.connection.credentials||after.files.length!==before.files.length||after.files.some(f=>{const old=initialFiles.get(f._id);return old?.sha!==f.sha||old.storageId!==f.storageId;}))throw new Error("P4 baseline or credentials changed during ingestion");
 const storageId=await ctx.storage.store(new Blob([JSON.stringify({...result,baselineJobId:before.job._id,repositoryId:before.repo._id,connectionId:before.connection._id})],{type:"application/json"}));
 return {storageId,revision:result.input.headSha,baselineJobId:before.job._id,baseRevision:result.input.baseSha,version:result.version,change:result.change};
}});
