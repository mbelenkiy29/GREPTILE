import {changeMetadataSchema,catalogPageSize,numberedPage,validateChangePage,type ChangeMetadata,type ChangePage} from "./change-metadata";
import { reviewLinks } from "./review-summary";
import { z } from "zod";
import { repositorySourceUrl } from "./source-url";
import type { Finding, SourceFile } from "./engine/types";
import { findingComment, summaryMarker, type Github } from "./github";
import { changedLines } from "./engine/diff";
type ExternalId = string | number;
type GithubChange = Awaited<ReturnType<Github["pullRequest"]>>;
type WithId<T> = Omit<T,"id"> & {id:ExternalId};
export type ScmChange = Omit<GithubChange,"comments"|"reviews"> & {revisionKey?:string;authorExternalId?:string;comments:WithId<GithubChange["comments"][number]>[];reviews:WithId<GithubChange["reviews"][number]>[]};
type GithubApprovalSnapshot=Awaited<ReturnType<Github["approvalSnapshot"]>>;
export type ScmApprovalSnapshot = Omit<GithubApprovalSnapshot, "pr"|"reviews"> & {pr:ScmChange;reviews:WithId<GithubApprovalSnapshot["reviews"][number]>[]};
export type Scm = Pick<Github,"tree"|"blob"|"branches"|"sourceUrl"> & {
 head(repository:string,branch:string):Promise<string>;
 canReply?(repository:string,author:string):Promise<boolean>;
  archive?(repository:string,sha:string):Promise<Uint8Array>;
  supportsApproval?:boolean;
  approvalSnapshot?(repository:string,number:number,extraChecks?:{name:string;appId?:number}[]):Promise<ScmApprovalSnapshot>;
  approve?(repository:string,number:number,head:string,marker:string,botLogin:string,revisionKey?:string):Promise<{id:ExternalId;reused:boolean}>;
  dismissApproval?(repository:string,number:number,id:ExternalId):Promise<void>;
 changeMetadata(repository:string,number:number):Promise<ChangeMetadata>;
 openChanges(repository:string,cursor:string|null):Promise<ChangePage>;
 pullRequest(repository:string,number:number):Promise<ScmChange>;
 publish(repository:string,number:number,sha:string,summary:string,findings:Finding[],marker:string,style?:string,revisionKey?:string,unresolvedCount?:number):Promise<{id:ExternalId;reused:boolean;comments?:{id:ExternalId;fingerprint:string}[]}>;
 reply(repository:string,number:number,body:string,parent?:ExternalId,marker?:string):Promise<{id:ExternalId}>;
  // Optional: commit ancestry/changes for incremental review, and resolving OpenReview-started finding threads.
  compare?(repository:string,base:string,head:string):Promise<{status:"ahead"|"behind"|"diverged"|"identical";commits:number;complete:boolean;files:import("./engine/types").ChangedFile[]}>;
  resolveFindingThreads?(repository:string,number:number,items:{commentId:number;body:string;marker:string}[]):Promise<{resolved:number;skipped:number}>;
  startCheckRun?(repository:string,sha:string,externalId:string,detailsUrl?:string):Promise<number|null>;
  reactions?(repository:string,commentIds:number[]):Promise<{commentId:string;user:string;reaction:"+1"|"-1";createdAt:number}[]>;
  completeCheckRun?(repository:string,id:number,result:{conclusion:"success"|"failure"|"neutral"|"cancelled";title:string;summary:string;detailsUrl?:string}):Promise<void>;
};
const note=z.object({id:z.number(),body:z.string(),author:z.object({username:z.string()}),position:z.object({new_path:z.string(),new_line:z.number().nullable(),head_sha:z.string().optional()}).nullish()});
const prSchema=z.object({iid:z.number(),title:z.string(),description:z.string().nullable(),draft:z.boolean(),state:z.string(),web_url:z.string(),author:z.object({id:z.number().int().positive().optional(),username:z.string()}),source_branch:z.string(),target_branch:z.string(),diff_refs:z.object({base_sha:z.string(),head_sha:z.string(),start_sha:z.string()})});
const approvalUser=z.object({id:z.number().int().positive(),username:z.string().min(1)});
const approvalState=z.object({approved_by:z.array(z.object({user:approvalUser,approved_at:z.string().datetime({offset:true}).optional()})),user_can_approve:z.boolean().optional()});
const approvalNote=z.object({id:z.number().int().positive(),body:z.string(),author:approvalUser,system:z.boolean(),noteable_iid:z.number().int().positive(),noteable_type:z.literal("MergeRequest")});
const approvalReceipt=z.object({head:z.string().regex(/^[a-f0-9]{40}$/),revisionKey:z.string().regex(/^[a-f0-9]{40}:[a-f0-9]{40}$/),approvedAt:z.string().datetime({offset:true}),botId:z.number().int().positive()}).strict();
const approvalMarker=/^<!-- openreview:approval:[a-zA-Z0-9_-]+ -->$/;
const receiptTitle="OpenReview native approval receipt. No merge was performed.";
function receiptBody(receipt:z.infer<typeof approvalReceipt>,marker:string){return receiptTitle+"\n\n<!-- openreview-gitlab-approval:"+JSON.stringify(receipt)+" -->\n\n"+marker;}
function parseReceipt(body:string){const match=body.match(/^OpenReview native approval receipt\. No merge was performed\.\n\n<!-- openreview-gitlab-approval:(\{[^\n]+\}) -->\n\n(<!-- openreview:approval:[a-zA-Z0-9_-]+ -->)$/);if(!match)return;try{const receipt=approvalReceipt.parse(JSON.parse(match[1]));if(receiptBody(receipt,match[2])===body)return {...receipt,marker:match[2]};}catch{} }
class GitlabError extends Error {constructor(readonly status:number,endpoint:string){super("GitLab "+status+" at "+endpoint.split("?")[0]);}}
export class Gitlab implements Scm {
 readonly supportsApproval=true;
 constructor(private base:string,private token:string,private project?:string){}
 async request<T>(endpoint:string,schema:z.ZodType<T>,body?:unknown,method?:"PUT"|"DELETE"):Promise<T>{
  if(!endpoint.startsWith("/")||endpoint.startsWith("//")||endpoint.includes("://"))throw new Error("Invalid provider API path");
  const response=await fetch(this.base+"/api/v4"+endpoint,{method:method??(body===undefined?"GET":"POST"),redirect:"error",headers:{"PRIVATE-TOKEN":this.token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new GitlabError(response.status,endpoint);
  return schema.parse(response.status===204?null:await response.json());
 }
 async paginate<T>(endpoint:string,schema:z.ZodType<T>):Promise<T[]>{
  const result:T[]=[];
  for(let page=1;page<=100;page++){const items=await this.request(endpoint+(endpoint.includes("?")?"&":"?")+"per_page=100&page="+page,z.array(schema));result.push(...items);if(items.length<100)return result;}
  throw new Error("GitLab pagination limit exceeded; coverage incomplete");
 }
 prefix(repo:string){return "/projects/"+encodeURIComponent(this.project??repo);}
 private async approvalAuthority(repo:string,number:number){
  if(!Number.isSafeInteger(number)||number<1)throw new Error("Invalid GitLab merge request identity");
  const prefix=this.prefix(repo)+"/merge_requests/"+number;
  const [bot,pr]=await Promise.all([this.request("/user",approvalUser),this.request(prefix,prSchema.extend({project_id:z.number().int().positive(),detailed_merge_status:z.string().min(1),has_conflicts:z.boolean(),blocking_discussions_resolved:z.boolean(),head_pipeline:z.object({sha:z.string(),status:z.string()}).nullable()}))]);
  if(pr.iid!==number||(this.project&&String(pr.project_id)!==this.project))throw new Error("GitLab approval project or change mismatch");
  return {bot,pr,prefix,revisionKey:pr.diff_refs.base_sha+":"+pr.diff_refs.start_sha};
 }
 async approvalSnapshot(repo:string,number:number,_extraChecks:{name:string;appId?:number}[]=[]):Promise<ScmApprovalSnapshot>{
  void _extraChecks;
  const pr=await this.pullRequest(repo,number),a=await this.approvalAuthority(repo,number);
  if(a.pr.diff_refs.head_sha!==pr.head.sha||a.revisionKey!==pr.revisionKey)throw new Error("GitLab revision changed during approval verification");
  const [project,statuses,approvals,notes]=await Promise.all([
   this.request(this.prefix(repo),z.object({id:z.number().int().positive(),only_allow_merge_if_pipeline_succeeds:z.boolean(),only_allow_merge_if_all_discussions_are_resolved:z.boolean(),only_allow_merge_if_all_status_checks_passed:z.boolean().optional()})),
   this.paginate(this.prefix(repo)+"/repository/commits/"+pr.head.sha+"/statuses?all=false&ref="+encodeURIComponent(pr.head.ref),z.object({id:z.number().int().positive(),name:z.string().min(1),sha:z.string(),ref:z.string(),status:z.string()})),
   this.request(a.prefix+"/approvals",approvalState),this.paginate(a.prefix+"/notes",approvalNote),
  ]);
  if(project.id!==a.pr.project_id||statuses.some(s=>s.sha!==pr.head.sha||s.ref!==pr.head.ref))throw new Error("GitLab check project or revision mismatch");
  if(new Set(statuses.map(s=>s.name)).size!==statuses.length)throw new Error("GitLab latest statuses contain duplicate contexts");
  const checks:{name:string;status:string;conclusion:string|null}[]=statuses.map(s=>({name:s.name,status:["success","failed","canceled","skipped"].includes(s.status)?"completed":"in_progress",conclusion:s.status}));
  const required:{name:string}[]=[];
  const add=(name:string,passed:boolean)=>{if(checks.some(c=>c.name===name))throw new Error("GitLab status collides with native approval gate");checks.push({name,status:"completed",conclusion:passed?"success":"failure"});required.push({name});};
  add("OpenReview / GitLab merge conditions",["mergeable","not_approved"].includes(a.pr.detailed_merge_status)&&!a.pr.has_conflicts);
  if(project.only_allow_merge_if_pipeline_succeeds)add("OpenReview / GitLab required pipeline",a.pr.head_pipeline?.sha===pr.head.sha&&a.pr.head_pipeline.status==="success");
  if(project.only_allow_merge_if_all_discussions_are_resolved)add("OpenReview / GitLab resolved discussions",a.pr.blocking_discussions_resolved);
  if(project.only_allow_merge_if_all_status_checks_passed){
   const external=await this.paginate(a.prefix+"/status_checks",z.object({id:z.number().int().positive(),name:z.string().min(1),status:z.enum(["pending","passed","failed"])}));
   if(new Set(external.map(c=>c.id)).size!==external.length)throw new Error("GitLab duplicate external status checks");
   for(const c of external)add("OpenReview / GitLab external check #"+c.id,c.status==="passed");
  }
  const active=approvals.approved_by.filter(v=>v.user.id===a.bot.id&&v.user.username===a.bot.username);
  if(active.length>1||active.some(v=>!v.approved_at))throw new Error("GitLab bot approval timestamp unavailable or ambiguous");
  const reviews=notes.flatMap(n=>{const r=parseReceipt(n.body);if(!r||n.system||n.author.id!==a.bot.id||n.author.username!==a.bot.username||n.noteable_iid!==number||r.botId!==a.bot.id)return [];return [{id:n.id,body:n.body,commit_id:r.head,state:active[0]?.approved_at===r.approvedAt?"APPROVED":"DISMISSED",user:{login:a.bot.username,type:"Bot"}}];});
  const current=await this.approvalAuthority(repo,number);if(current.pr.state!==a.pr.state||current.pr.draft!==a.pr.draft||current.pr.diff_refs.head_sha!==pr.head.sha||current.revisionKey!==pr.revisionKey||current.bot.id!==a.bot.id)throw new Error("GitLab revision or publisher changed during approval verification");
  return {pr,checks,nativeRequiredChecks:required,humanChangeRequested:a.pr.detailed_merge_status==="requested_changes",reviews,botLogin:a.bot.username};
 }
 async approve(repo:string,number:number,head:string,marker:string,botLogin:string,revisionKey?:string){
  if(!/^[a-f0-9]{40}$/.test(head)||!approvalMarker.test(marker)||!revisionKey)throw new Error("Invalid GitLab approval identity or native revision");
  const a=await this.approvalAuthority(repo,number);
  if(a.bot.username!==botLogin)throw new Error("GitLab approval publisher changed");
  if(a.pr.state!=="opened"||a.pr.draft||a.pr.diff_refs.head_sha!==head||a.revisionKey!==revisionKey||a.pr.author.username===botLogin)throw new Error("GitLab approval revision changed or own merge request");
  const [state,notes]=await Promise.all([this.request(a.prefix+"/approvals",approvalState),this.paginate(a.prefix+"/notes",approvalNote)]);
  const active=state.approved_by.filter(v=>v.user.id===a.bot.id&&v.user.username===botLogin);
  if(active.length>1)throw new Error("Ambiguous GitLab bot approval");
  const own=notes.filter(n=>n.author.id===a.bot.id&&n.author.username===botLogin&&!n.system&&n.noteable_iid===number&&n.body.endsWith(marker));
  if(own.length>1)throw new Error("Duplicate GitLab approval receipts");
  if(own.length){const r=parseReceipt(own[0].body);if(!r||r.botId!==a.bot.id||r.head!==head||r.revisionKey!==revisionKey||r.approvedAt!==active[0]?.approved_at)throw new Error("GitLab saved approval receipt or native approval changed");return {id:own[0].id,reused:true};}
  if(active.length)throw new Error("GitLab bot already approved without this receipt; remove its approval before retrying");
  if(state.user_can_approve===false)throw new Error("GitLab bot is not eligible to approve");
  const result=await this.request(a.prefix+"/approve",approvalState,{sha:head}),approved=result.approved_by.filter(v=>v.user.id===a.bot.id&&v.user.username===botLogin);
  if(approved.length!==1||!approved[0].approved_at)throw new Error("GitLab native approval timestamp unavailable; inspect bot approval before retrying");
  const approvedAt=approved[0].approved_at;
  try{
   const current=await this.approvalAuthority(repo,number);if(current.pr.state!=="opened"||current.pr.draft||current.pr.diff_refs.head_sha!==head||current.revisionKey!==revisionKey||current.bot.id!==a.bot.id)throw new Error("GitLab revision changed during approval publication");
   const body=receiptBody({head,revisionKey,approvedAt,botId:a.bot.id},marker),n=await this.request(a.prefix+"/notes",approvalNote,{body});
   if(n.author.id!==a.bot.id||n.author.username!==botLogin||n.body!==body||n.system||n.noteable_iid!==number)throw new Error("GitLab returned an unrelated approval receipt");
   return {id:n.id,reused:false};
  }catch(error){
   const current=await this.request(a.prefix+"/approvals",approvalState);
   if(current.approved_by.some(v=>v.user.id===a.bot.id&&v.user.username===botLogin&&v.approved_at===approvedAt))await this.request(a.prefix+"/unapprove",z.unknown(),{});
   throw error;
  }
 }
 async dismissApproval(repo:string,number:number,id:number){
  if(!Number.isSafeInteger(id)||id<1)throw new Error("Invalid GitLab approval receipt identity");
  const a=await this.approvalAuthority(repo,number),n=await this.request(a.prefix+"/notes/"+id,approvalNote),r=parseReceipt(n.body);
  if(!r||n.system||n.noteable_iid!==number||n.author.id!==a.bot.id||n.author.username!==a.bot.username||r.botId!==a.bot.id)throw new Error("Refusing to withdraw an unrelated GitLab approval");
  const state=await this.request(a.prefix+"/approvals",approvalState),active=state.approved_by.filter(v=>v.user.id===a.bot.id&&v.user.username===a.bot.username);
  if(!active.length)return;
  if(active.length!==1||!active[0].approved_at)throw new Error("GitLab bot approval timestamp unavailable or ambiguous");
  if(active[0].approved_at!==r.approvedAt)return; // A newer bot approval is owned by a different receipt.
  await this.request(a.prefix+"/unapprove",z.unknown(),{});
  if((await this.request(a.prefix+"/approvals",approvalState)).approved_by.some(v=>v.user.id===a.bot.id))throw new Error("GitLab approval withdrawal was not confirmed");
 }
 async canReply(repo:string,author:string){
  const me=await this.request("/user",z.object({id:z.number(),username:z.string()}));
  if(me.username.toLowerCase()===author.toLowerCase())return false;
  const users=await this.request("/users?username="+encodeURIComponent(author)+"&active=true&exclude_internal=true&without_project_bots=true",z.array(z.object({id:z.number(),username:z.string(),state:z.string(),locked:z.boolean().optional()})));
  const user=users.find(u=>u.username===author&&u.state==="active"&&!u.locked&&u.id!==me.id);if(!user)return false;
  try{
   const member=await this.request(this.prefix(repo)+"/members/all/"+user.id,z.object({id:z.number(),username:z.string(),state:z.string(),access_level:z.number(),expires_at:z.string().nullable(),membership_state:z.string().optional()}));
   return member.id===user.id&&member.username===author&&member.state==="active"&&member.access_level>=30&&(!member.membership_state||member.membership_state==="active")&&(member.expires_at===null||member.expires_at>new Date().toISOString().slice(0,10));
  }catch(error){if(error instanceof GitlabError&&error.status===404)return false;throw error;}
 }
 async discussionParent(repo:string,number:number,commentId:number,author:string,body:string){
  const discussions=await this.paginate(this.prefix(repo)+"/merge_requests/"+number+"/discussions",z.object({id:z.string(),notes:z.array(note)}));
  const thread=discussions.find(d=>d.notes.some(n=>n.id===commentId&&n.author.username===author&&n.body===body));
  if(!thread?.notes.length)throw new Error("GitLab comment changed or discussion unavailable");
  return thread.notes[0].id;
 }
 sourceUrl(repository:string,revision:string,file:string){return repositorySourceUrl("gitlab",this.base,repository,revision,file);}
 async repositories(){return (await this.paginate("/projects?membership=true&simple=true",z.object({id:z.number(),path_with_namespace:z.string(),default_branch:z.string().nullable(),http_url_to_repo:z.string().url(),namespace:z.object({id:z.number().int().positive(),kind:z.string(),full_path:z.string().min(1)}).optional()}))).filter(r=>r.default_branch).map(r=>({externalId:String(r.id),fullName:r.path_with_namespace,defaultBranch:r.default_branch!,remoteUrl:r.http_url_to_repo,...(r.namespace?.kind==="group"?{group:{externalId:String(r.namespace.id),name:r.namespace.full_path.slice(0,100)}}:{})}));}
 async head(repo:string,branch:string){return (await this.request(this.prefix(repo)+"/repository/commits/"+encodeURIComponent(branch),z.object({id:z.string()}))).id;}
 async archive(repo:string,sha:string):Promise<Uint8Array>{
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error("Runtime archive requires an exact Git commit");
  const endpoint=this.prefix(repo)+"/repository/archive.tar.gz?sha="+sha+"&include_lfs_blobs=false";
  // Node fetch defaults to Sec-Fetch-Mode: cors, which GitLab's archive hotlink detector rejects.
  const response=await fetch(this.base+"/api/v4"+endpoint,{mode:"same-origin",headers:{"PRIVATE-TOKEN":this.token},redirect:"error",signal:AbortSignal.timeout(60000)});
  if(!response.ok||Number(response.headers.get("content-length")??0)>20000000){await response.body?.cancel();throw new Error("Runtime archive unavailable or too large");}
  const reader=response.body?.getReader();if(!reader)throw new Error("Runtime archive missing");
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000000)throw new Error("Runtime archive exceeds 20 MB");parts.push(value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(bytes[0]!==0x1f||bytes[1]!==0x8b)throw new Error("Runtime archive is not gzip");
  return bytes;
 }
 async tree(repo:string,sha:string){return (await this.paginate(this.prefix(repo)+"/repository/tree?recursive=true&ref="+encodeURIComponent(sha),z.object({id:z.string(),path:z.string(),type:z.string()}))).filter(f=>f.type==="blob").map(f=>({path:f.path,sha:f.id,type:f.type}));}
 async blob(repo:string,path:string,sha:string):Promise<SourceFile>{const file=await this.request(this.prefix(repo)+"/repository/blobs/"+encodeURIComponent(sha),z.object({content:z.string(),encoding:z.literal("base64"),size:z.number()}));if(file.size>200000)return {path,sha,size:file.size,content:""};return {path,sha,content:Buffer.from(file.content,"base64").toString("utf8")};}
 async branches(repo:string){const branches=await this.paginate(this.prefix(repo)+"/repository/branches",z.object({name:z.string(),protected:z.boolean(),commit:z.object({id:z.string()})}));return {branches:branches.slice(0,200).map(b=>({name:b.name,sha:b.commit.id,protected:b.protected})),limited:branches.length>200};}
 async changeMetadata(repo:string,number:number):Promise<ChangeMetadata>{
  const pr=await this.request(this.prefix(repo)+"/merge_requests/"+number,prSchema);
  if(pr.iid!==number)throw new Error("GitLab change identity mismatch");
  return changeMetadataSchema.parse({number:pr.iid,title:pr.title,html_url:pr.web_url,draft:pr.draft,state:pr.state==="opened"?"open":pr.state==="merged"?"merged":"closed",user:{login:pr.author.username},head:{sha:pr.diff_refs.head_sha,ref:pr.source_branch},base:{sha:pr.diff_refs.base_sha,ref:pr.target_branch},revisionKey:pr.diff_refs.base_sha+":"+pr.diff_refs.start_sha});
 }
 async openChanges(repo:string,cursor:string|null):Promise<ChangePage>{
  const page=numberedPage(cursor),rows=await this.request(this.prefix(repo)+`/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=${catalogPageSize}&page=${page}`,z.array(z.object({iid:z.number().int().positive().safe()})).max(catalogPageSize));
  return validateChangePage({numbers:rows.map(r=>r.iid),next:rows.length===catalogPageSize?String(page+1):null},cursor);
 }
 async pullRequest(repo:string,number:number){
  const prefix=this.prefix(repo)+"/merge_requests/"+number;
  const pr=await this.request(prefix,prSchema);
  const [files,notes,commits,pipelines]=await Promise.all([
   this.paginate(prefix+"/diffs",z.object({new_path:z.string(),old_path:z.string(),new_file:z.boolean(),deleted_file:z.boolean(),renamed_file:z.boolean(),diff:z.string(),too_large:z.boolean().optional(),collapsed:z.boolean().optional()})),
   this.paginate(prefix+"/notes",note),
   this.paginate(prefix+"/commits",z.object({id:z.string()})),
   this.paginate(prefix+"/pipelines",z.object({sha:z.string(),status:z.string(),id:z.number()}))
  ]);
  if(files.some(f=>f.too_large||f.collapsed))throw new Error("GitLab omitted diffs; complete review unavailable");
  const latest=await this.request(prefix,prSchema);
  if(latest.state!==pr.state||latest.diff_refs.head_sha!==pr.diff_refs.head_sha||latest.diff_refs.base_sha!==pr.diff_refs.base_sha||latest.diff_refs.start_sha!==pr.diff_refs.start_sha)throw new Error("GitLab revision changed during ingestion");
  return {number:pr.iid,title:pr.title,body:pr.description,draft:pr.draft,state:pr.state==="opened"?"open":"closed",html_url:pr.web_url,user:{login:pr.author.username},...(pr.author.id?{authorExternalId:String(pr.author.id)}:{}),head:{sha:pr.diff_refs.head_sha,ref:pr.source_branch},base:{sha:pr.diff_refs.base_sha,ref:pr.target_branch},revisionKey:pr.diff_refs.base_sha+":"+pr.diff_refs.start_sha,diff:files.map(f=>({path:f.new_path,previousPath:f.renamed_file?f.old_path:undefined,status:f.deleted_file?"removed":f.new_file?"added":f.renamed_file?"renamed":"modified",patch:f.diff})),comments:notes.map(n=>({id:n.id,body:n.body,path:n.position?.new_path??"",line:n.position?.new_line??null,user:{login:n.author.username}})),reviews:[],commits:commits.map(c=>({sha:c.id})),checks:pipelines.filter(p=>p.sha===pr.diff_refs.head_sha).map(p=>({name:"GitLab pipeline #"+p.id,status:["success","failed","canceled","skipped"].includes(p.status)?"completed":"in_progress",conclusion:p.status==="success"?"success":p.status}))};
 }
 async publish(repo:string,number:number,sha:string,summary:string,findings:Finding[],marker:string,style="detailed",revisionKey?:string,unresolvedCount=findings.length){
  const prefix=this.prefix(repo)+"/merge_requests/"+number;
  const pr=await this.request(prefix,prSchema);if(pr.diff_refs.head_sha!==sha||pr.state!=="opened"||(revisionKey!==undefined&&revisionKey!==pr.diff_refs.base_sha+":"+pr.diff_refs.start_sha))throw new Error("Merge request revision changed or closed");
  const current=async()=>{const latest=await this.request(prefix,prSchema);if(latest.state!=="opened"||latest.diff_refs.head_sha!==sha||latest.diff_refs.base_sha!==pr.diff_refs.base_sha||latest.diff_refs.start_sha!==pr.diff_refs.start_sha)throw new Error("Merge request revision changed or closed");};
  const me=await this.request("/user",z.object({username:z.string()}));
  const notes=await this.paginate(prefix+"/notes",note),comments:{id:number;fingerprint:string}[]=[];
  const diffs=findings.length?await this.paginate(prefix+"/diffs",z.object({new_path:z.string(),old_path:z.string(),diff:z.string(),too_large:z.boolean().optional(),collapsed:z.boolean().optional()})):[];
  for(const f of findings){
   const findingMarker="<!-- openreview:"+marker+":finding:"+f.fingerprint+" -->";
   const diff=diffs.find(d=>d.new_path===f.filePath);if(!diff||diff.too_large||diff.collapsed||!changedLines(diff.diff).has(f.startLine))throw new Error("Finding line not in complete current diff");
   const prior=notes.find(n=>n.author.username===me.username&&n.body.includes(findingMarker)&&n.position?.head_sha===sha&&n.position.new_path===f.filePath&&n.position.new_line===f.startLine);if(prior){comments.push({id:prior.id,fingerprint:f.fingerprint});continue;}
   await current();
   const result=await this.request(prefix+"/discussions",z.object({notes:z.array(note).min(1)}),{body:findingComment(f,style,{syntax:"gitlab",start:f.startLine,end:f.startLine})+"\n\n"+findingMarker+(process.env.APP_URL?"\n\n[Fix with your agent]("+process.env.APP_URL+"/fix/"+marker+"?finding="+f.fingerprint+")":""),position:{position_type:"text",base_sha:pr.diff_refs.base_sha,head_sha:sha,start_sha:pr.diff_refs.start_sha,new_path:diff.new_path,old_path:diff.old_path,new_line:f.startLine}});
   if(result.notes[0].author.username!==me.username||result.notes[0].position?.head_sha!==sha)throw new Error("GitLab returned another publication identity or revision");
   comments.push({id:result.notes[0].id,fingerprint:f.fingerprint});
  }
  const revisionMarker="<!-- openreview-revision:"+sha+" -->";
  await current();
  // One summary note per merge request, found by its hidden marker and edited in place.
  const body="## OpenReview\n\n"+summary+reviewLinks(marker,unresolvedCount)+"\n\n**Last reviewed commit:** [`"+sha.slice(0,7)+"`]("+this.base+"/"+repo.split("/").map(encodeURIComponent).join("/")+"/-/commit/"+encodeURIComponent(sha)+")\n\n"+summaryMarker+"\n<!-- openreview:"+marker+" -->\n"+revisionMarker;
  const existing=notes.filter(n=>n.author.username===me.username&&n.body.includes(summaryMarker)).at(-1);
  if(existing){
   if(existing.body===body)return {id:existing.id,reused:true,comments};
   const edited=await this.request(prefix+"/notes/"+existing.id,note,{body},"PUT");
   if(edited.author.username!==me.username)throw new Error("GitLab returned another publication identity");
   return {id:existing.id,reused:false,comments};
  }
  const result=await this.request(prefix+"/notes",note,{body});
  if(result.author.username!==me.username)throw new Error("GitLab returned another publication identity");
  return {id:result.id,reused:false,comments};
 }
 async reply(repo:string,number:number,body:string,parent?:string|number,marker?:string){
  const prefix=this.prefix(repo)+"/merge_requests/"+number;
  if(marker){const me=await this.request("/user",z.object({username:z.string()}));const prior=(await this.paginate(prefix+"/notes",note)).find(n=>n.author.username===me.username&&n.body.includes("<!-- openreview:"+marker+" -->"));if(prior)return {id:prior.id};body+="\n\n<!-- openreview:"+marker+" -->";}
  if(parent){const discussions=await this.paginate(prefix+"/discussions",z.object({id:z.string(),notes:z.array(note)}));const thread=discussions.find(d=>d.notes.some(n=>n.id===parent));if(!thread)throw new Error("Parent discussion unavailable");return this.request(prefix+"/discussions/"+encodeURIComponent(thread.id)+"/notes",z.object({id:z.number()}),{body});}
  return this.request(prefix+"/notes",z.object({id:z.number()}),{body});
 }
}
