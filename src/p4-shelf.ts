import {z} from "zod";
import {P4CodeReview} from "./perforce";
import {parseP4SubmittedInventory} from "./p4-index";
import {exclusionReason,redact} from "./engine/indexer";
import type {ReviewInput,SourceFile} from "./engine/types";

/** Overlay an archived shelf on the exact submitted inventory used to build verified context. */
export async function p4ShelfFromIndex(client:P4CodeReview,projectId:string,reviewId:number,baseline:{inventory:unknown;files:SourceFile[];coverage:string[]}):Promise<{input:ReviewInput;version:number;change:number;serverId:string;baseRevisions:Record<string,number>}> {
 z.number().int().positive().safe().parse(reviewId);
 const inventory=parseP4SubmittedInventory(baseline.inventory),project=await client.project(projectId);
 if(inventory.project.id!==projectId||JSON.stringify(project)!==JSON.stringify(inventory.project))throw new Error("P4 indexed project or views changed; re-index before reviewing");
 const snapshot=await client.snapshot(projectId,reviewId);
 if(!snapshot.review.versions.at(-1)?.pending||!["needsReview","needsRevision"].includes(snapshot.review.state))throw new Error("P4 review must have an open archived shelf");
 if(snapshot.files.length>500)throw new Error("P4 review exceeds 500 changed files");
 const records=new Map(inventory.manifest.map(f=>[f.depotFile.slice(2),f])),sources=new Map<string,SourceFile>();
 let total=0;
 for(const file of baseline.files){
  const record=records.get(file.path);
  if(sources.has(file.path)||!record||!record.digest||record.fileSize===undefined||!["add","edit","branch","move/add","integrate","import"].includes(record.headAction)||!["text","utf8","unicode"].includes(record.headType.split("+")[0])||file.sha!==`p4:${inventory.serverId}:${record.headRev}:${record.digest.toLowerCase()}`)throw new Error("P4 indexed source identity does not match submitted inventory");
  if(exclusionReason(file))throw new Error("P4 indexed source exceeds eligible review coverage");
  total+=Buffer.byteLength(file.content);if(total>20000000)throw new Error("P4 indexed source exceeds 20 MB context coverage");sources.set(file.path,{...file,content:redact(file.content)});
 }
 const revisions=Object.fromEntries(inventory.manifest.filter(f=>!["delete","move/delete"].includes(f.headAction)).map(f=>[f.depotFile,f.headRev]));
 const diff:ReviewInput["diff"]=[],coverage=[...baseline.coverage,...snapshot.coverage],baseRevisions:Record<string,number>={};
 for(const file of snapshot.files){
  const relative=file.depotFile.slice(2),reason=exclusionReason({path:relative,sha:snapshot.revision,size:file.fileSize,content:""});
  if(reason){sources.delete(relative);coverage.push(`Excluded ${relative}: ${reason}`);continue;}
  if(!["text","utf8","unicode"].includes(file.type.split("+")[0])){sources.delete(relative);coverage.push(`Excluded ${relative}: unsupported source type`);continue;}
  const added=["add","branch","move/add"].includes(file.action),base=sources.get(relative),baseRevision=added?0:revisions[file.depotFile];
  if(added&&revisions[file.depotFile]!==undefined||!added&&(!base||!Number.isSafeInteger(baseRevision)||baseRevision<1))throw new Error("P4 changed file does not match the selected readable baseline: "+relative);
  const change=await client.diff(snapshot,file.depotFile,baseRevision);baseRevisions[file.depotFile]=baseRevision;
  // Compare redacted left-side context with the same baseline used for cross-file retrieval.
  let line=0,oldLines=0;const lines=base?.content.split("\n")??[];
  for(const value of redact(change.patch).split("\n")){
   const header=/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(value);
   if(header){line=Number(header[1]);continue;}
   if(value.startsWith("-")||value.startsWith(" ")){if(lines[line-1]!==value.slice(1))throw new Error("P4 diff left side does not match indexed baseline: "+relative);line++;oldLines++;}
  }
  if(change.status==='removed'&&oldLines!==(base!.content.length?lines.length-(base!.content.endsWith('\n')?1:0):0))throw new Error('P4 deletion does not cover the complete indexed baseline: '+relative);
  if(change.status==="removed")sources.delete(relative);
  else{
   const source=await client.content(snapshot,file.depotFile),excluded=exclusionReason({...source,path:relative});
   if(excluded){sources.delete(relative);coverage.push(`Excluded ${relative}: ${excluded}`);continue;}
   sources.set(relative,{...source,path:relative,content:redact(source.content)});
  }
  diff.push({...change,path:relative,patch:redact(change.patch)});
 }
 if([...sources.values()].reduce((sum,file)=>sum+Buffer.byteLength(file.content),0)>20000000)throw new Error("P4 overlaid shelf exceeds 20 MB context coverage");
 const latest=await client.snapshot(projectId,reviewId);
 if(!latest.review.versions.at(-1)?.pending||latest.revision!==snapshot.revision||latest.review.state!==snapshot.review.state||JSON.stringify(await client.project(projectId))!==JSON.stringify(project))throw new Error("P4 revision, state or project views changed during review ingestion");
 return {version:snapshot.version,change:snapshot.change,serverId:inventory.serverId,baseRevisions,input:{repository:client.base+"/projects/"+encodeURIComponent(projectId),baseSha:inventory.revision,headSha:snapshot.revision,title:snapshot.review.description.split("\n")[0]||"P4 review "+reviewId,description:snapshot.review.description,files:[...sources.values()],diff,rules:[],mode:"standard",coverageLimits:coverage}};
}
