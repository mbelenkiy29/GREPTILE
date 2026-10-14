import { runtimeTar } from "./runtime-tar";
export { runtimeTar } from "./runtime-tar";
import { P4CodeReview, type P4Snapshot } from "./perforce";
import { parseP4SubmittedInventory } from "./p4-index";
import { runtimeRevisionSchema } from "./runtime-revision";

/** Retrieve raw pinned files, including binaries omitted from the review index. Never use redacted context. */
export async function p4RuntimeArchive(client:P4CodeReview,inventoryInput:unknown,snapshot:P4Snapshot){
 const inventory=parseP4SubmittedInventory(inventoryInput);runtimeRevisionSchema.parse(snapshot.revision);
 if(inventory.project.id!==snapshot.projectId||JSON.stringify(await client.project(snapshot.projectId))!==JSON.stringify(inventory.project))throw new Error("P4 runtime baseline project changed");
 const entries=new Map<string,{revision:string;size?:number;digest?:string;type:string}>();
 const put=(path:string,action:string,type:string,revision:string,size?:number,digest?:string)=>{
  if(["delete","move/delete"].includes(action)){entries.delete(path);return;}
  if(!["add","edit","branch","move/add","integrate","import"].includes(action))throw new Error("Unsupported P4 runtime file action: "+action);
  entries.set(path,{revision,size,digest,type});
 };
 for(const f of inventory.manifest)put(f.depotFile,f.headAction,f.headType,"#"+f.headRev,f.fileSize,f.digest);
 for(const f of snapshot.files)put(f.depotFile,f.action,f.type,"@="+snapshot.change,f.fileSize,f.digest);
 const files:{path:string;bytes:Uint8Array;executable:boolean}[]=[];let total=0;
 for(const [path,f] of entries){
  if(!["text","utf8","unicode","utf16","binary"].includes(f.type.split("+")[0])||f.size===undefined||!f.digest)throw new Error("P4 runtime file lacks supported regular-file metadata: "+path);
  total+=f.size;if(total>20000000||entries.size>10000)throw new Error("P4 runtime exceeds 20 MB or 10,000 files");
  const bytes=await client.runtimeBytes(inventory.project,path,f.revision,f.size,f.digest);
  files.push({path:path.slice(2),bytes,executable:f.type.split("+").slice(1).join("").includes("x")});
 }
 const current=await client.snapshot(snapshot.projectId,snapshot.review.id);
 if(current.revision!==snapshot.revision||!current.review.versions.at(-1)?.pending||!["needsReview","needsRevision"].includes(current.review.state)||JSON.stringify(await client.project(snapshot.projectId))!==JSON.stringify(inventory.project))throw new Error("P4 shelf or project changed during runtime archive retrieval");
 return runtimeTar(files);
}
