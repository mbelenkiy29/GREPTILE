import {createHash} from "node:crypto";
import {z} from "zod";
import {providerOrigin} from "./credentials";
import type {ChangedFile,Finding} from "./engine/types";
import {changedLines} from "./engine/diff";
import {findingComment} from "./review-summary";
const number=z.number().int().positive().safe();
const numeric=z.union([z.string().regex(/^\d+$/),z.number().int().nonnegative().safe()]).transform(Number).refine(Number.isSafeInteger);
const projectId=z.string().min(1).max(200).refine(s=>!/[\0\r\n/]/.test(s)&&s!=="."&&s!=="..");
export const p4DepotFile=z.string().min(4).max(4096).refine(s=>s.startsWith("//")&&!/[\0\r\n#@*]/.test(s)&&!s.slice(2).split("/").some(p=>!p||p==="."||p===".."));
export const p4ProjectSchema=z.object({id:projectId,name:z.string().max(2000),branches:z.array(z.object({id:projectId,name:z.string().max(2000),paths:z.array(z.string().min(3).max(4096).refine(s=>/^[+-]?\/\//.test(s)&&!/[\0\r\n]/.test(s))).max(2000)})).max(2000),deleted:z.boolean().optional()}).refine(p=>new Set(p.branches.map(b=>b.id)).size===p.branches.length,"Duplicate P4 branch identity");
const listing=z.object({id:number,author:z.string(),description:z.string(),updated:z.number().int().nonnegative().max(8640000000000),pending:z.boolean(),state:z.string(),projects:z.union([z.record(z.array(z.string())),z.array(z.never()).transform(():Record<string,string[]>=>({}))])});
const review=listing.extend({versions:z.array(z.object({change:number,archiveChange:number.optional(),pending:z.boolean(),time:z.number().int().nonnegative()})).min(1)});
const file=z.object({depotFile:p4DepotFile,action:z.string(),type:z.string(),rev:numeric,fileSize:numeric.optional(),digest:z.string().regex(/^[0-9a-fA-F]{32}$/).optional()});
export type P4Review=z.infer<typeof listing>;
export type P4Project=z.infer<typeof p4ProjectSchema>;
// Native fstat metadata only; never accept uploaded file bodies as provider evidence.
export const p4DepotRecord=z.object({code:z.literal("stat"),depotFile:p4DepotFile.refine(s=>!s.includes("\\")),headRev:numeric.refine(n=>n>0),headChange:numeric.refine(n=>n>0),headAction:z.string(),headType:z.string(),fileSize:numeric.optional(),digest:z.string().regex(/^[a-f0-9]{32}$/i).optional()}).strict();
export const p4Credential=z.object({username:z.string().min(1).max(200).refine(s=>!/[\0\r\n:]/.test(s)),ticket:z.string().min(10).max(10000).refine(s=>!/[\0\r\n]/.test(s))}).strict();
export type P4Snapshot={projectId:string;review:z.infer<typeof review>;version:number;change:number;revision:string;files:z.infer<typeof file>[];coverage:string[]};
export type P4ApprovalInspection={reviewNumber:number;version:number;revision:string;state:string;pending:boolean;nativeApprovalAvailable:boolean;nativeBlockers:string[];coverage:string[];inspectedAt:number};
const commentContext=z.object({comment:number.optional(),version:number.optional(),file:p4DepotFile.nullish().transform(v=>v??undefined),leftLine:z.number().int().nonnegative().safe().nullable().optional(),rightLine:z.number().int().nonnegative().safe().nullable().optional(),content:z.array(z.string().max(256)).max(5).optional()});
const comment=z.object({id:number,body:z.string(),user:z.string(),topic:z.string(),flags:z.array(z.string()),context:z.union([commentContext,z.array(z.never()).transform(()=>({}))]).pipe(commentContext)});
export type P4Comment=z.infer<typeof comment>;
export class P4Error extends Error {constructor(readonly status:number,path:string){super("P4 Code Review "+status+" at "+path.split("?")[0]);}}
function matches(file:string,view:string){
 const pattern=view.replace(/^[+-]/,"").split(/(\.\.\.|\*)/).map(s=>s==="..."?".*":s==="*"?"[^/]*":s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("");
 return new RegExp("^"+pattern+"$").test(file);
}
export function p4PathAllowed(file:string,paths:string[]){let included=false;for(const p of paths)if(matches(file,p))included=!p.startsWith("-");return included;}
function completeHunk(patch:string,source:string|undefined){
 const lines=patch.split("\n"),header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines.shift()??"");
 if(!header)throw new Error("P4 diff hunk header invalid");
 const oldCount=Number(header[2]??1),newCount=Number(header[4]??1);let old=0,next=0,line=Number(header[3]);
 if(![Number(header[1]),oldCount,line,newCount].every(Number.isSafeInteger)||oldCount>0&&Number(header[1])<1||newCount>0&&line<1)throw new Error("P4 diff hunk line range invalid");
 const text=source?.split("\n");if(lines.at(-1)==="")lines.pop();
 for(const value of lines){
  if(value==="\\ No newline at end of file")continue;
  if(!/^[ +\-]/.test(value))throw new Error("P4 diff hunk contains invalid or truncated lines");
  if(value[0]!=="+")old++;
  if(value[0]!=="-"){next++;if(text&&text[line-1]!==value.slice(1))throw new Error("P4 diff does not match archived source");line++;}
 }
 if(old!==oldCount||next!==newCount)throw new Error("P4 diff hunk coverage incomplete");
 return {oldStart:Number(header[1]),oldEnd:Number(header[1])+oldCount,newStart:Number(header[3]),newEnd:Number(header[3])+newCount};
}
export class P4CodeReview {
 readonly base:string;
 private readonly authorization:string;
 constructor(instance:string,private readonly username:string,ticket:string){
  this.base=providerOrigin(instance);
  if(!p4Credential.safeParse({username,ticket}).success)throw new Error("P4 bot username and valid ticket required");
  this.authorization="Basic "+Buffer.from(username+":"+ticket).toString("base64");
 }
 private async bytes(path:string,limit=4000000,payload?:Record<string,unknown>){
  if(!path.startsWith("/")||path.startsWith("//")||path.includes("://"))throw new Error("Invalid P4 API path");
  const response=await fetch(this.base+path,{redirect:"error",headers:{authorization:this.authorization,accept:"application/json",...(payload?{"content-type":"application/json"}:{})},...(payload?{method:"POST",body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new P4Error(response.status,path);
  const reader=response.body?.getReader();if(!reader)throw new Error("P4 response body missing");const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error("P4 response exceeds retrieval coverage limit");chunks.push(value);}}finally{await reader.cancel();}
  return Buffer.concat(chunks);
 }
 private async request<T>(path:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>,payload?:Record<string,unknown>):Promise<T>{return schema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await this.bytes(path,4000000,payload))));}
 private async data<T>(path:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>,payload?:Record<string,unknown>):Promise<T>{const result=await this.request(path,z.object({error:z.null(),data:z.unknown()}),payload);return schema.parse(result.data);}
 async authenticatedIdentity(){
  const session=await this.request("/api/v9/session",z.object({isValid:z.literal(true),user:z.object({User:z.string()})}));
  if(session.user.User!==this.username)throw new Error("P4 authenticated user does not match the claimed identity");
  return session.user.User;
 }
 async projects(){
  const result=await this.request("/api/v9/projects?fields=id,name,branches,deleted",z.object({projects:z.array(p4ProjectSchema).max(2000)}));
  if(new Set(result.projects.map(p=>p.id)).size!==result.projects.length)throw new Error("Duplicate P4 project identity");
  return result.projects.filter(p=>!p.deleted);
 }
 async project(id:string){projectId.parse(id);const value=await this.request("/api/v9/projects/"+encodeURIComponent(id)+"?fields=id,name,branches,deleted",z.object({project:p4ProjectSchema}));if(value.project.id!==id||value.project.deleted)throw new Error("P4 project identity changed or deleted");return value.project;}
 async reviewPage(project:string,after?:number):Promise<{reviews:P4Review[];cursor:number|null}>{
  projectId.parse(project);if(after!==undefined)number.parse(after);
  const query=new URLSearchParams({max:"100",project});if(after!==undefined)query.set("after",String(after));
  const page=await this.data("/api/v11/reviews?"+query,z.object({reviews:z.array(listing).max(100),lastSeen:number.nullable(),totalCount:z.number().int().nonnegative().nullable()}));
  if(page.reviews.some(r=>!Object.hasOwn(r.projects,project)))throw new Error("P4 review outside selected project");
  if(new Set(page.reviews.map(r=>r.id)).size!==page.reviews.length)throw new Error("Duplicate P4 review identity");
  // Native permission filtering can shorten a page before the end of the inventory.
  const cursor=page.lastSeen;
  if(!page.reviews.length&&cursor!==null||page.reviews.length&&cursor!==Math.min(...page.reviews.map(r=>r.id))||after!==undefined&&page.reviews.some(r=>r.id>=after))throw new Error("P4 pagination incomplete or stalled");
  return {reviews:page.reviews,cursor};
 }
 private async review(project:string,id:number){
  number.parse(id);const result=await this.data("/api/v11/reviews/"+id,z.object({reviews:z.array(review).length(1)}));const value=result.reviews[0];
  if(value.id!==id||!Object.hasOwn(value.projects,project))throw new Error("P4 review identity or project changed");return value;
 }
 async reviewStatus(project:string,id:number){const selected=await this.project(project),value=await this.review(project,id);this.scope(selected,value);return value;}
 async approvalInspection(project:string,id:number):Promise<P4ApprovalInspection>{
  const initial=await this.snapshot(project,id);
  // Native blockers can contain private project/user metadata. Return only their categories.
  const emptyArray=z.array(z.never()).transform(():Record<string,unknown>=>({}));
  const result=await this.data(`/api/v11/reviews/${id}/transitions`,z.object({
   transitions:z.record(z.string().max(200)),blocked:z.union([z.record(z.unknown()),emptyArray]),
  }));
  const final=await this.snapshot(project,id);
  if(final.revision!==initial.revision||final.review.updated!==initial.review.updated||final.review.state!==initial.review.state||final.review.pending!==initial.review.pending)throw new Error("P4 review changed during approval inspection; retry");
  const blocked=result.blocked.approved;
  const categories=blocked&&typeof blocked==='object'&&!Array.isArray(blocked)?Object.keys(blocked):[];
  const nativeBlockers:string[]=categories.map(key=>key==='moderators'?"Native moderator approval is required":key==='votes'?"Native minimum or required reviewer votes are missing":key==='tests'?"Native workflow tests block approval":"Native approval has an additional unresolved restriction");
  if(Object.keys(result.blocked).some(key=>key!=='approved')||blocked!==undefined&&!categories.length)nativeBlockers.push("Native approval restrictions could not be fully interpreted");
  const nativeApprovalAvailable=Object.hasOwn(result.transitions,'approved')&&!nativeBlockers.length;
  if(!nativeApprovalAvailable&&!nativeBlockers.length)nativeBlockers.push("The native server does not allow this account to approve the current review");
  return {reviewNumber:id,version:final.version,revision:final.revision,state:final.review.state,pending:final.review.pending,nativeApprovalAvailable,nativeBlockers:[...new Set(nativeBlockers)],coverage:final.coverage,inspectedAt:Date.now()};
 }
 private async files(id:number,version:number){
  const value=await this.data(`/api/v11/reviews/${id}/files?from=0&to=${version}`,z.object({limited:z.boolean(),files:z.array(file).max(10000)}));
  if(value.limited)throw new Error("P4 review file inventory is truncated; complete review unavailable");
  if(new Set(value.files.map(f=>f.depotFile)).size!==value.files.length)throw new Error("Duplicate P4 file identity");return value.files;
 }
 private scope(selected:P4Project,value:z.infer<typeof review>){
  const ids=value.projects[selected.id]??[];
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!selected.branches.some(b=>b.id===id)))throw new Error("P4 review branch identity changed or unavailable");
  return selected.branches.filter(b=>ids.includes(b.id));
 }
 private identity(value:z.infer<typeof review>,files:z.infer<typeof file>[],branches:P4Project['branches']){
  const version=value.versions.length,current=value.versions[version-1],change=current.pending?current.archiveChange:current.change;
  if(!change)throw new Error("P4 shelved review has no archived changelist; stable revision unavailable");
  const manifest=files.map(f=>[f.depotFile,f.action,f.type,f.rev,f.fileSize??null,f.digest?.toLowerCase()??null]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0);
  const scope=branches.map(b=>[b.id,b.paths]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0);
  return {version,change,revision:`p4:${value.id}:${version}:${change}:`+createHash("sha256").update(JSON.stringify({manifest,scope})).digest("hex")};
 }
 async snapshot(projectId:string,id:number):Promise<P4Snapshot>{
  const selected=await this.project(projectId),initial=await this.review(projectId,id),files=await this.files(id,initial.versions.length);
  const branches=this.scope(selected,initial);
  if(files.some(f=>!branches.some(b=>p4PathAllowed(f.depotFile,b.paths))))throw new Error("P4 review includes files outside selected project branches");
  const identity=this.identity(initial,files,branches),latest=await this.review(projectId,id),currentFiles=await this.files(id,latest.versions.length),currentProject=await this.project(projectId);
  if(identity.revision!==this.identity(latest,currentFiles,this.scope(currentProject,latest)).revision)throw new Error("P4 revision or branch scope changed during snapshot retrieval");
  return {projectId,review:latest,...identity,files,coverage:["P4 Code Review filters inventories by the authenticated account's permissions; files hidden by server protection cannot be measured."]};
 }
 async content(snapshot:P4Snapshot,path:string){
  p4DepotFile.parse(path);const expected=snapshot.files.find(f=>f.depotFile===path);
  if(!expected||['delete','move/delete'].includes(expected.action)||!expected.digest||expected.fileSize===undefined)throw new Error("P4 file has no readable pinned digest");
  if(!["text","utf8","unicode"].includes(expected.type.split("+")[0])||expected.fileSize>1000000)throw new Error("P4 source type or size exceeds review coverage");
  return this.pinnedContent(path,"@="+snapshot.change,expected.fileSize,expected.digest,snapshot.revision);
 }
 async submittedContent(project:P4Project,record:z.input<typeof p4DepotRecord>,serverId:string,change:number){
  const selected=p4ProjectSchema.parse(project),expected=p4DepotRecord.parse(record);
  number.parse(change);z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/).parse(serverId);
  if(selected.deleted||expected.headChange>change||!selected.branches.some(b=>p4PathAllowed(expected.depotFile,b.paths)))throw new Error("P4 submitted file outside selected project or changelist");
  if(!["add","edit","branch","move/add","integrate","import"].includes(expected.headAction)||!["text","utf8","unicode"].includes(expected.headType.split("+")[0])||expected.fileSize===undefined||expected.fileSize>200000||!expected.digest)throw new Error("P4 submitted file has no readable pinned source within indexing coverage");
  const current=await this.project(selected.id);
  if(JSON.stringify(current)!==JSON.stringify(selected))throw new Error("P4 project views changed before submitted source retrieval");
  const result=await this.pinnedContent(expected.depotFile,"#"+expected.headRev,expected.fileSize,expected.digest,`p4:${serverId}:${expected.headRev}:${expected.digest.toLowerCase()}`,200000);
  if(JSON.stringify(await this.project(selected.id))!==JSON.stringify(selected))throw new Error("P4 project views changed during submitted source retrieval");
  return {...result,path:expected.depotFile.slice(2),size:expected.fileSize};
 }
 private async pinnedContent(path:string,revision:string,size:number,digest:string,sha:string,limit=1000000){
  const bytes=await this.pinnedBytes(path,revision,size,digest,limit);
  return {path,content:new TextDecoder("utf-8",{fatal:true}).decode(bytes),sha};
 }
 async runtimeBytes(project:P4Project,path:string,revision:string,size:number,digest:string){
  p4DepotFile.parse(path);z.string().regex(/^(?:#[1-9][0-9]*|@=[1-9][0-9]*)$/).parse(revision);
  z.number().int().nonnegative().max(20000000).parse(size);z.string().regex(/^[a-f0-9]{32}$/i).parse(digest);
  if(!project.branches.some(b=>p4PathAllowed(path,b.paths))||JSON.stringify(await this.project(project.id))!==JSON.stringify(project))throw new Error("P4 runtime file outside current project views");
  return this.pinnedBytes(path,revision,size,digest,20000000);
 }
 private async pinnedBytes(path:string,revision:string,size:number,digest:string,limit:number){
  const metadata=await this.data("/api/v11/files/"+Buffer.from(path).toString("base64url")+"?"+new URLSearchParams({fileRevision:revision}),z.object({filename:z.string().optional(),fileName:z.string().optional(),fileRevision:z.string(),contentLink:z.string().url()}));
  if((metadata.fileName??metadata.filename)!==path||metadata.filename!==undefined&&metadata.filename!==path||metadata.fileRevision!==revision)throw new Error("P4 source metadata revision mismatch");
  const link=new URL(metadata.contentLink),base=new URL(this.base);
  if(link.origin!==base.origin||link.username||link.password||link.hash||decodeURIComponent(link.pathname)!==base.pathname.replace(/\/$/,"")+"/view/"+path.slice(2))throw new Error("P4 content link outside trusted file origin");
  // Native contentLink omits the version even when metadata is revision-pinned.
  link.searchParams.set("v",revision);
  const bytes=await this.bytes(link.pathname.slice(base.pathname.replace(/\/$/,"").length)+link.search,limit);
  if(bytes.length!==size||createHash("md5").update(bytes).digest("hex")!==digest.toLowerCase())throw new Error("P4 source digest changed or does not match pinned revision");
  return bytes;
 }
 async diff(snapshot:P4Snapshot,path:string,baseRevision:number):Promise<ChangedFile>{
  p4DepotFile.parse(path);z.number().int().nonnegative().safe().parse(baseRevision);
  const expected=snapshot.files.find(f=>f.depotFile===path);if(!expected)throw new Error("P4 diff file outside pinned snapshot");
  if(!["add","edit","delete","integrate","branch","move/add","move/delete"].includes(expected.action)||!["text","utf8","unicode"].includes(expected.type.split("+")[0]))throw new Error("P4 diff action or source type exceeds review coverage");
  const added=["add","branch","move/add"].includes(expected.action),deleted=["delete","move/delete"].includes(expected.action);
  if(added!== (baseRevision===0))throw new Error("P4 diff base revision does not match file action");
  // Native #0 diff lookup can return 404 for a new depot path. Its empty left
  // side and digest-verified archived bytes fully define the addition.
  if(added){
   const source=(await this.content(snapshot,path)).content,lines=source.split('\n');
   if(lines.at(-1)==='')lines.pop();
   const patch=source.length?`@@ -0,0 +1,${lines.length} @@\n`+lines.map(line=>'+'+line+'\n').join('')+(source.endsWith('\n')?'':'\\ No newline at end of file\n'):'';
   if(patch)completeHunk(patch,source);
   return {path,status:'added',patch};
  }
  const query=new URLSearchParams({from:"#"+baseRevision,to:"@="+snapshot.change,type:"file",lines:"3",max_size:"1000000",max_diffs:"-1",offset:"0"});
  const native=await this.data("/api/v11/files/"+Buffer.from(path).toString("base64url")+"/diff?"+query,z.object({
   isCut:z.union([z.boolean(),z.number()]),isSame:z.boolean(),header:z.string(),diffs:z.array(z.string()).max(10000),
   fetchContent:z.boolean().optional(),isContentChunk:z.union([z.boolean(),z.number()]).optional(),originalLinesData:z.unknown().optional(),
   paging:z.object({diffs:z.number().int().nonnegative(),offset:z.number().int().nonnegative().nullable()}),
  }));
  if(native.isCut||native.fetchContent===false||native.isContentChunk||native.originalLinesData!==undefined||native.paging.offset!==null||native.paging.diffs!==native.diffs.length)throw new Error("P4 diff is truncated or paginated; complete review unavailable");
  const header=`--- a/${added?"dev/null":path+"#"+baseRevision}\n+++ b/${deleted?"dev/null":path+"@="+snapshot.change}\n`;
  if(native.header!==header||native.isSame!== (native.diffs.length===0))throw new Error("P4 diff revision header or status mismatch");
  const source=deleted?undefined:(await this.content(snapshot,path)).content;let oldEnd=0,newEnd=0;
  const patches=native.diffs.map(patch=>{
   // Swarm reports its empty deletion side as +0,1. Normalize only that
   // observed shape, with exclusively removed lines; validate counts below.
   if(deleted&&/^@@ -\d+(?:,\d+)? \+0,1 @@(?:.*)\n/.test(patch)&&patch.split('\n').slice(1).every(line=>!line||line.startsWith('-')||line==='\\ No newline at end of file'))return patch.replace(/(\+0),1(?= @@)/,'$1,0');
   return patch;
  });
  for(const patch of patches){const h=completeHunk(patch,source);if(h.oldStart<oldEnd||h.newStart<newEnd)throw new Error("P4 diff contains overlapping or reordered hunks");oldEnd=h.oldEnd;newEnd=h.newEnd;}
  return {path,status:deleted?"removed":"modified",patch:patches.map(p=>p.endsWith("\n")?p:p+"\n").join("")};
 }
 async comments(snapshot:P4Snapshot):Promise<P4Comment[]>{
  const latest=await this.snapshot(snapshot.projectId,snapshot.review.id);if(latest.revision!==snapshot.revision)throw new Error("P4 review changed before comment retrieval");snapshot=latest;
  const topic=`reviews/${snapshot.review.id}`,result:P4Comment[]=[];let after:number|undefined,scanned=0,pages=0;
  for(;;){
   if(++pages>100)throw new Error("P4 comment pagination exceeds complete coverage limit");
   const query=new URLSearchParams({topic,max:"100","context[version]":String(snapshot.version),ignoreArchived:"false"});if(after!==undefined)query.set("after",String(after));
   const page=await this.request("/api/v9/comments?"+query,z.object({topic:z.string().optional(),comments:z.union([z.record(comment),z.array(comment).max(100).refine(values=>new Set(values.map(c=>c.id)).size===values.length,"Duplicate P4 comment identity").transform(values=>Object.fromEntries(values.map(c=>[String(c.id),c])))]),lastSeen:number.nullable()}));
   const values=Object.entries(page.comments);
   if(page.topic!==undefined&&page.topic!==topic||values.length>100||values.some(([key,c])=>String(c.id)!==key||c.topic!==topic||c.context.version!==snapshot.version||c.context.file&&!snapshot.files.some(f=>f.depotFile===c.context.file)))throw new Error("P4 comment identity, version or file scope mismatch");
   // Native version filtering can omit every scanned comment while advancing lastSeen.
   if(!values.length){
    if(page.lastSeen===null)return result;
    if(page.lastSeen<=(after??0))throw new Error("P4 empty comment pagination stalled; complete coverage unavailable");
    after=page.lastSeen;continue;
   }
   const ids=values.map(([,c])=>c.id);
   if(page.lastSeen===null||page.lastSeen<Math.max(...ids)||page.lastSeen<=(after??0)||ids.some(id=>after!==undefined&&id<=after||result.some(c=>c.id===id))||scanned+ids.length>5000)throw new Error("P4 comment pagination incomplete, stalled or exceeds coverage limit");
   scanned+=ids.length;result.push(...values.map(([,c])=>c));after=page.lastSeen;
  }
 }
 async reply(snapshot:P4Snapshot,question:P4Comment,answer:string,run:string,authorize?:()=>Promise<void>){
  question=comment.parse(question);
  if(!/^[a-zA-Z0-9:_-]{1,100}$/.test(run)||!answer.trim()||Buffer.byteLength(answer)>100000||question.user===this.username)throw new Error("Invalid P4 conversation reply");
  const topic=`reviews/${snapshot.review.id}`,tag=`<!-- openreview:conversation:${run}:${snapshot.revision} -->`,body=answer+"\n\n"+tag;
  if(Buffer.byteLength(body)>100000)throw new Error("P4 conversation reply exceeds publication coverage");
  const current=async()=>{
   await authorize?.();
   const latest=await this.snapshot(snapshot.projectId,snapshot.review.id);
   if(latest.revision!==snapshot.revision||!latest.review.pending||!["needsReview","needsRevision"].includes(latest.review.state))throw new Error("P4 conversation shelf changed or closed");
   const comments=await this.comments(latest),target=comments.find(c=>c.id===question.id);
   if(!target||target.user!==question.user||target.body!==question.body||target.topic!==topic||target.context.version!==snapshot.version||JSON.stringify(target.context)!==JSON.stringify(question.context)||target.flags.includes("closed"))throw new Error("P4 question changed, archived or outside the current review");
   return comments;
  };
  const existing=await current(),matches=existing.filter(c=>c.user===this.username&&c.context.comment===question.id&&c.body.trimEnd().endsWith(tag));
  if(matches.length>1||matches.some(c=>c.flags.includes("closed")||c.body!==body))throw new Error("P4 reply retry identity conflicts with the saved answer");
  if(matches.length)return {id:matches[0].id,reused:true};
  // Recheck the source question immediately before publishing; parent identity is native, never inferred from Markdown.
  await current();
  const result=(await this.data(`/api/v11/comments/reviews/${snapshot.review.id}`,z.object({comments:z.array(comment).length(1)}),{body,taskState:"comment",context:{comment:question.id,version:snapshot.version}})).comments[0];
  if(result.user!==this.username||result.topic!==topic||result.context.comment!==question.id||result.context.version!==snapshot.version||result.flags.includes("closed")||result.body!==body)throw new Error("P4 returned another conversation reply identity");
  await current();return {id:result.id,reused:false};
 }
 async publish(snapshot:P4Snapshot,summary:string,findings:Finding[],baseRevisions:Record<string,number>,run:string,style="detailed",authorize?:()=>Promise<void>){
  if(!/^[a-zA-Z0-9:_-]{1,100}$/.test(run)||!summary.trim()||Buffer.byteLength(summary)>100000||findings.length>30||new Set(findings.map(f=>f.fingerprint)).size!==findings.length)throw new Error("Invalid P4 publication");
  const current=async()=>{await authorize?.();const latest=await this.snapshot(snapshot.projectId,snapshot.review.id);if(latest.revision!==snapshot.revision||!["needsReview","needsRevision"].includes(latest.review.state))throw new Error("P4 review changed or closed before publication");return latest;};
  snapshot=await current();
  const excerpts=new Map<string,string[]>();
  for(const f of findings){
   if(f.commitSha!==snapshot.revision||!/^[a-f0-9]{16,64}$/.test(f.fingerprint)||!Number.isSafeInteger(f.startLine)||f.startLine<1||!Object.hasOwn(baseRevisions,f.filePath)||!changedLines((await this.diff(snapshot,f.filePath,baseRevisions[f.filePath])).patch).has(f.startLine))throw new Error("P4 finding is outside the complete pinned diff");
   const lines=(await this.content(snapshot,f.filePath)).content.split("\n");
   excerpts.set(f.fingerprint,lines.slice(Math.max(0,f.startLine-5),f.startLine).map(line=>line.slice(0,256)));
  }
  const existing=await this.comments(snapshot),topic=`reviews/${snapshot.review.id}`,marker=`<!-- openreview:${run}:${snapshot.revision}`;
  const inline:{id:number;fingerprint:string}[]=[];
  const post=async(body:string,context:{file?:string;rightLine?:number;content?:string[]},tag:string)=>{
   const previous=existing.find(c=>c.user===this.username&&c.context.file===context.file&&!(c.context.leftLine||undefined)&&(c.context.rightLine||undefined)===context.rightLine&&c.body.trimEnd().endsWith(tag));if(previous){if(previous.flags.includes("closed"))throw new Error("P4 publication was archived; do not recreate it on retry");return {comment:previous,reused:true};}
   if(Buffer.byteLength(body)>100000)throw new Error("P4 comment exceeds publication coverage limit");
   await current();
   const result=(await this.data(`/api/v11/comments/reviews/${snapshot.review.id}`,z.object({comments:z.array(comment).length(1)}),{body,taskState:"comment",context:{version:snapshot.version,...context,...(context.file?{type:"text",leftLine:null}:{})}})).comments[0];
   if(result.user!==this.username||result.topic!==topic||result.context.version!==snapshot.version||result.context.file!==context.file||result.context.leftLine||(result.context.rightLine||undefined)!==context.rightLine||context.content&&JSON.stringify(result.context.content)!==JSON.stringify(context.content)||!result.body.trimEnd().endsWith(tag)||result.flags.includes("closed"))throw new Error("P4 returned another publication identity or context");
   existing.push(result);return {comment:result,reused:false};
  };
  // Publish the summary last so an interrupted run can recover individual comments before claiming complete publication.
  for(const f of findings){const tag=marker+":finding:"+f.fingerprint+" -->",result=await post(findingComment(f,style)+"\n\n"+tag,{file:f.filePath,rightLine:f.startLine,content:excerpts.get(f.fingerprint)},tag);inline.push({id:result.comment.id,fingerprint:f.fingerprint});}
  const tag=marker+" -->",root=await post("## OpenReview\n\n"+summary+"\n\n"+tag,{},tag);await current();
  return {id:root.comment.id,reused:root.reused,comments:inline};
 }
}
