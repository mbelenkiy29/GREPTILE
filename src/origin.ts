import {changeMetadataSchema,catalogPageSize,validateChangePage,type ChangeMetadata,type ChangePage} from "./change-metadata";
import { reviewLinks } from "./review-summary";
import { z } from "zod";
import { repositorySourceUrl } from "./source-url";
import { originApi,originCredentials,originInstallationToken } from "./origin-auth";
import type { Scm,ScmChange,ScmApprovalSnapshot } from "./gitlab";
import type { Finding,SourceFile } from "./engine/types";
import { findingComment } from "./github";
const actor=z.object({user:z.object({id:z.string()}).optional(),app:z.object({id:z.string()}).optional(),serviceAccount:z.object({id:z.string()}).optional()});
const identity=(a:z.infer<typeof actor>)=>a.user?.id??a.app?.id??a.serviceAccount?.id??"unknown";
const ref=z.object({sha:z.string(),ref:z.string()});
const version=z.object({number:z.string().regex(/^\d+$/),headSha:z.string(),baseSha:z.string()});
const prSchema=z.object({number:z.string().regex(/^\d+$/),repository:z.object({id:z.string().min(1)}).optional(),title:z.string(),body:z.string().default(""),state:z.enum(["open","closed"]),draft:z.boolean().default(false),author:actor,head:ref,base:ref,changedFiles:z.number().int().nonnegative().default(0),version});
const commentThreadSchema=z.object({id:z.string().min(1),version,path:z.string().default(""),side:z.enum(["left","right","PULL_REQUEST_COMMENT_SIDE_UNSPECIFIED"]).optional(),startLine:z.number().int().nonnegative().default(0),endLine:z.number().int().nonnegative().default(0)})
 .refine(thread=>thread.side!=="PULL_REQUEST_COMMENT_SIDE_UNSPECIFIED"||(!thread.path&&thread.startLine===0&&thread.endLine===0),"Origin unspecified comment side requires an unanchored discussion")
 .transform(thread=>({...thread,side:thread.side==="PULL_REQUEST_COMMENT_SIDE_UNSPECIFIED"?undefined:thread.side}));
const commentSchema=z.object({id:z.string().min(1),body:z.string(),author:actor,thread:commentThreadSchema});
const reviewSchema=z.object({id:z.string().min(1),author:actor,body:z.string().default(""),verdict:z.string(),pullRequestVersion:version,dismissal:z.unknown().optional()});
const approvalReviewSchema=reviewSchema.extend({submittedAt:z.string().datetime({offset:true}).optional()});
const approvalMarker=/^<!-- openreview:approval:[a-zA-Z0-9_-]+ -->$/;
const approvalBody=(marker:string)=>"OpenReview approved this exact native version after all configured approval gates passed. No merge was performed.\n\n"+marker;
function inlineBody(f:Finding,style:string,marker:string){return findingComment(f,style)+"\n\n<!-- openreview-review:"+marker+" -->"+(process.env.APP_URL?"\n\n[Fix with your agent]("+process.env.APP_URL+"/fix/"+marker+"?finding="+f.fingerprint+")":"");}
function sameThread(a:z.infer<typeof commentSchema>["thread"],b:z.infer<typeof commentSchema>["thread"]){return a.id===b.id&&a.version.number===b.version.number&&a.version.headSha===b.version.headSha&&a.version.baseSha===b.version.baseSha&&a.path===b.path&&a.side===b.side&&a.startLine===b.startLine&&(a.endLine||a.startLine)===(b.endLine||b.startLine);}
export class OriginApiError extends Error {constructor(public status:number,endpoint:string){super("Origin "+status+" at "+endpoint.split("?")[0]);this.name="OriginApiError";}}
export class Origin implements Scm {
 readonly supportsApproval=true;
 private token:{token:string;expiresAt:string}|undefined;
 constructor(private credentials:z.infer<typeof originCredentials>,private repositoryId?:string,private confirmedPermission?:(repository:string,author:string)=>Promise<boolean>){}
 private prefix(repository:string){if(repository.split("/").length!==2||repository.split("/").some(p=>!p||p==="."||p===".."||/[\0\r\n]/.test(p)))throw new Error("Invalid Origin repository identity");return "/repos/"+(this.repositoryId?"_/"+encodeURIComponent(this.repositoryId):repository.split("/").map(encodeURIComponent).join("/"));}
 private owns(a:z.infer<typeof actor>){return a.app?.id===this.credentials.appId&&!a.user&&!a.serviceAccount;}
 private async accessToken(){
  if(!this.token||Date.parse(this.token.expiresAt)<Date.now()+30000)this.token=await originInstallationToken(this.credentials);
  return this.token.token;
 }
 private async change(repository:string,number:number){
  if(!Number.isSafeInteger(number)||number<1)throw new Error("Invalid Origin change number");
  const pr=await this.request(this.prefix(repository)+"/pulls/"+number,prSchema);
  // Native GetPullRequest omits repository; bind it to the authenticated endpoint.
  const repositoryIdentity=pr.repository??await this.request(this.prefix(repository),z.object({id:z.string().min(1)}));
  if(pr.number!==String(number)||(this.repositoryId&&repositoryIdentity.id!==this.repositoryId)||pr.head.sha!==pr.version.headSha)throw new Error("Origin change repository, number or version identity mismatch");
  return {...pr,repository:repositoryIdentity};
 }
 async request<S extends z.ZodTypeAny>(endpoint:string,schema:S,body?:unknown,method?:"PUT"):Promise<z.output<S>>{
  if(!endpoint.startsWith("/")||endpoint.startsWith("//")||endpoint.includes("://"))throw new Error("Invalid Origin API path");
  const response=await fetch(originApi+endpoint,{method:method??(body===undefined?"GET":"POST"),redirect:"error",headers:{authorization:"Bearer "+await this.accessToken(),"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  if(!response.ok){if(response.status===401)this.token=undefined;throw new OriginApiError(response.status,endpoint);}
  return schema.parse(await response.json());
 }
 private async paginate<S extends z.ZodTypeAny>(endpoint:string,key:string,schema:S,pullNumber?:number):Promise<z.output<S>[]>{
  const all:z.output<S>[]=[];let cursor="";const seen=new Set<string>();
  for(let page=0;page<100;page++){
   const query=new URLSearchParams({pageSize:"100",...(cursor?{pageToken:cursor}:{})});
   const result=await this.request(endpoint+(endpoint.includes("?")?"&":"?")+query,z.object({[key]:z.array(schema).default([]),nextPageToken:z.string().default(""),...(pullNumber!==undefined?{pullRequest:z.object({number:z.string(),repository:z.object({id:z.string()})})}:{})}).passthrough());
   if(pullNumber!==undefined){const context=z.object({number:z.string(),repository:z.object({id:z.string()})}).parse(result.pullRequest);if(context.number!==String(pullNumber)||(this.repositoryId&&context.repository.id!==this.repositoryId))throw new Error("Origin discussion repository or change identity mismatch");}
   all.push(...result[key] as z.output<S>[]);cursor=result.nextPageToken as string;
   if(!cursor)return all;
   if(seen.has(cursor))throw new Error("Origin repeated a pagination cursor");seen.add(cursor);
  }
  throw new Error("Origin pagination limit exceeded; coverage incomplete");
 }
 async repositories(){return (await this.paginate("/installation/repos","repositories",z.object({id:z.string(),fullName:z.string(),defaultBranch:z.string()}))).map(r=>({externalId:r.id,fullName:r.fullName,defaultBranch:r.defaultBranch,remoteUrl:"https://origin.cursor.com/"+r.fullName+".git"}));}
 async archive(repository:string,sha:string):Promise<Uint8Array>{
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))throw new Error("Origin runtime archive requires an exact Git commit");
  if(!this.repositoryId||!/^(?:r|repo)_[a-zA-Z0-9]+$/.test(this.repositoryId))throw new Error("Origin runtime archive requires an immutable repository identity");
  const prefix=this.prefix(repository),verify=async()=>{
   const repo=await this.request(prefix,z.object({id:z.string()})),commit=await this.request(prefix+"/git/commits/"+sha,z.object({sha:z.string()}));
   if(repo.id!==this.repositoryId||commit.sha!==sha)throw new Error("Origin runtime repository or commit identity changed");
  };
  await verify();
  let response=await fetch(originApi+prefix+"/tarball/"+sha,{redirect:"manual",headers:{authorization:"Bearer "+await this.accessToken(),accept:"application/gzip"},signal:AbortSignal.timeout(60000)});
  if(response.status===302){
   const location=response.headers.get("location");await response.body?.cancel();
   let target:URL;try{if(!location||location.length>20000)throw new Error();target=new URL(location);}catch{throw new Error("Origin runtime signed download URL invalid");}
   const allowed=[new URL(originApi).hostname,...(process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS??"").split(",").map(host=>host.trim()).filter(Boolean)];
   if(target.protocol!=="https:"||target.username||target.password||target.hash||target.port||!allowed.includes(target.hostname))throw new Error("Origin runtime download host requires operator approval in ORIGIN_ARCHIVE_ALLOWED_HOSTS");
   // The signed URL is the download credential. Never forward App Bearer credentials.
   response=await fetch(target,{redirect:"error",signal:AbortSignal.timeout(60000)});
  }
  const raw=response.headers.get("content-length"),expected=raw===null?undefined:Number(raw);
  if(response.status!==200||raw!==null&&(!/^\d+$/.test(raw)||!Number.isSafeInteger(expected)||Number(raw)>20000000)){
   if(response.status===401)this.token=undefined;
   await response.body?.cancel();throw new Error("Origin runtime archive unavailable or size invalid");
  }
  const reader=response.body?.getReader();if(!reader)throw new Error("Origin runtime archive missing");
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000000)throw new Error("Origin runtime archive exceeds 20 MB");parts.push(value);}}finally{await reader.cancel();}
  if(expected!==undefined&&expected!==size)throw new Error("Origin runtime archive size mismatch");
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(bytes[0]!==0x1f||bytes[1]!==0x8b)throw new Error("Origin runtime archive is not gzip");
  await verify();return bytes;
 }
 async head(repository:string,branch:string){return (await this.request(this.prefix(repository)+"/git/ref/"+encodeURIComponent("heads/"+branch),z.object({object:z.object({sha:z.string(),type:z.literal("commit")})}))).object.sha;}
 async tree(repository:string,sha:string){const result=await this.request(this.prefix(repository)+"/git/trees/"+encodeURIComponent(sha)+"?recursive=true",z.object({tree:z.array(z.object({path:z.string(),sha:z.string(),type:z.string(),size:z.number().optional()})).default([]),truncated:z.boolean().default(false)}));if(result.truncated)throw new Error("Origin truncated the repository tree; subtree indexing required");return result.tree.filter(f=>f.type==="blob");}
 async blob(repository:string,path:string,sha:string):Promise<SourceFile>{const b=await this.request(this.prefix(repository)+"/git/blobs/"+encodeURIComponent(sha),z.object({size:z.number(),encoding:z.literal("base64"),content:z.string()}));return {path,sha,size:b.size,content:b.size>200000?"":Buffer.from(b.content,"base64").toString("utf8")};}
 async branches(repository:string){const branches=await this.paginate(this.prefix(repository)+"/branches","branches",z.object({name:z.string(),commit:z.object({sha:z.string()})}));return {branches:branches.slice(0,200).map(b=>({name:b.name,sha:b.commit.sha,protected:false})),limited:branches.length>200};}
 sourceUrl(repository:string,revision:string,path:string){return repositorySourceUrl("origin",originApi,repository,revision,path,this.repositoryId);}
 async canReply(repository:string,author:string){
  if(!/^user_[a-zA-Z0-9]+$/.test(author))return false;
  try{
   const user=await this.request(this.prefix(repository)+"/collaborators/"+encodeURIComponent(author)+"/permission",z.object({user:z.object({id:z.string()}),permission:z.enum(["read","write","admin","custom"])}));
   return user.user.id===author&&["admin","write"].includes(user.permission);
  }catch(error){
   if(error instanceof OriginApiError&&error.status===404&&this.confirmedPermission)return this.confirmedPermission(repository,author);
   throw error;
  }
 }
 async approvalSnapshot(repository:string,number:number,_extraChecks:{name:string;appId?:number}[]=[]):Promise<ScmApprovalSnapshot>{
  void _extraChecks;
  if(!this.repositoryId)throw new Error("Origin approval requires an immutable repository identity");
  const pr=await this.pullRequest(repository,number),prefix=this.prefix(repository)+"/pulls/"+number;
  const reference=z.object({id:z.string().min(1),number:z.string(),repository:z.object({id:z.string()})});
  const [nativeReviews,mergeability,nativeChecks]=await Promise.all([
   this.paginate(prefix+"/reviews","reviews",approvalReviewSchema,number),
   this.request(prefix+"/mergeability?expectedHeadSha="+encodeURIComponent(pr.head.sha),z.object({pullRequest:reference,verdict:z.string(),blockers:z.array(z.object({pullRequest:reference,kind:z.string().optional(),message:z.string().min(1)})),evaluatedPullRequests:z.array(reference).min(1),headSha:z.string(),baseRef:z.string(),baseSha:z.string().min(1),evaluatedAt:z.string().datetime({offset:true})})),
   this.paginate(this.prefix(repository)+"/commits/"+pr.head.sha+"/check-runs","checkRuns",z.object({id:z.string().min(1),repository:z.object({id:z.string()}),sha:z.string(),baseSha:z.string().optional(),name:z.string().min(1),status:z.string(),conclusion:z.string().nullish()}))
  ]);
  if(nativeChecks.some(check=>check.repository.id!==this.repositoryId||check.sha!==pr.head.sha))throw new Error("Origin approval check repository or revision mismatch");
  // Commit listings include every comparison base. Only this version's base and base-agnostic attempts apply.
  const checks=nativeChecks.filter(check=>check.baseSha===undefined||check.baseSha===pr.base.sha).map(check=>({name:check.name,status:check.status,conclusion:check.conclusion??null}));
  const target=mergeability.pullRequest;
  if(target.number!==String(number)||target.repository.id!==this.repositoryId||mergeability.headSha!==pr.head.sha||mergeability.evaluatedPullRequests.some(p=>p.repository.id!==this.repositoryId)||!mergeability.evaluatedPullRequests.some(p=>p.id===target.id&&p.number===target.number)||mergeability.blockers.some(b=>!mergeability.evaluatedPullRequests.some(p=>p.id===b.pullRequest.id&&p.number===b.pullRequest.number&&p.repository.id===b.pullRequest.repository.id)))throw new Error("Origin approval mergeability repository or change identity mismatch");
  if(nativeReviews.some(r=>[r.author.user,r.author.app,r.author.serviceAccount].filter(Boolean).length!==1))throw new Error("Origin approval review actor is ambiguous");
  // Mergeability enforces native required-check owners and attempts. Unknown conditions remain blocking.
  // A single-PR review does not cover unresolved ancestors in a stack.
  const conditionsPassed=mergeability.evaluatedPullRequests.length===1&&mergeability.baseRef===pr.base.ref&&(
   mergeability.verdict==="mergeable"&&mergeability.blockers.length===0||
   mergeability.verdict==="blocked"&&mergeability.blockers.length>0&&mergeability.blockers.every(b=>b.pullRequest.id===target.id&&b.kind==="required_approvals")
  );
  const gate="OpenReview / Origin merge conditions";
  if(checks.some(c=>c.name===gate))throw new Error("Origin check collides with native approval gate");
  const reviews=nativeReviews.map(r=>{
   const marker=r.body.split("\n").at(-1)??"",ownedBody=!this.owns(r.author)||approvalMarker.test(marker)&&r.body===approvalBody(marker);
   return {id:r.id,body:r.body,commit_id:r.pullRequestVersion.headSha,user:{login:identity(r.author),type:r.author.user?"User":"Bot"},state:r.dismissal!==undefined||!r.submittedAt?"DISMISSED":r.verdict==="approve"&&ownedBody&&r.pullRequestVersion.number===pr.revisionKey&&r.pullRequestVersion.baseSha===pr.base.sha?"APPROVED":r.verdict==="request_changes"?"CHANGES_REQUESTED":"COMMENTED"};
  });
  const current=await this.change(repository,number);
  if(current.version.number!==pr.revisionKey||current.head.sha!==pr.head.sha||current.version.baseSha!==pr.base.sha||current.base.ref!==pr.base.ref||current.state!==pr.state||current.draft!==pr.draft)throw new Error("Origin revision changed during approval verification");
  return {pr,checks:[...checks,{name:gate,status:"completed",conclusion:conditionsPassed?"success":"failure"}],nativeRequiredChecks:[{name:gate}],reviews,botLogin:this.credentials.appId,humanChangeRequested:reviews.some(r=>r.user.type==="User"&&r.state==="CHANGES_REQUESTED")};
 }
 async approve(repository:string,number:number,head:string,marker:string,botLogin:string,revisionKey?:string){
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)||!approvalMarker.test(marker)||botLogin!==this.credentials.appId||!revisionKey||!/^\d+$/.test(revisionKey)||!this.repositoryId)throw new Error("Invalid Origin approval identity or revision");
  const pr=await this.change(repository,number),prefix=this.prefix(repository)+"/pulls/"+number,body=approvalBody(marker);
  const guard=(current:z.infer<typeof prSchema>)=>{if(current.state!=="open"||current.draft||current.head.sha!==head||current.version.number!==revisionKey||current.version.baseSha!==pr.version.baseSha||this.owns(current.author))throw new Error("Origin approval revision changed or own pull request");};
  guard(pr);
  const matching=(await this.paginate(prefix+"/reviews","reviews",approvalReviewSchema,number)).filter(r=>this.owns(r.author)&&r.body.trimEnd().endsWith(marker));
  if(matching.length>1)throw new Error("Multiple Origin approvals share the operation identity");
  const valid=(r:z.infer<typeof approvalReviewSchema>)=>this.owns(r.author)&&r.body===body&&r.verdict==="approve"&&!!r.submittedAt&&r.dismissal===undefined&&r.pullRequestVersion.number===revisionKey&&r.pullRequestVersion.headSha===head&&r.pullRequestVersion.baseSha===pr.version.baseSha;
  if(matching.length){if(!valid(matching[0]))throw new Error("Origin saved approval identity or revision changed");guard(await this.change(repository,number));return {id:matching[0].id,reused:true};}
  guard(await this.change(repository,number));
  const result=await this.request(prefix+"/reviews",approvalReviewSchema,{verdict:"approve",versionNumber:revisionKey,body});
  if(!valid(result))throw new Error("Origin returned another approval identity or revision");
  // The durable coordinator rechecks revision/policy after publication and dismisses on a race.
  return {id:result.id,reused:false};
 }
 async dismissApproval(repository:string,number:number,id:string|number){
  if(typeof id!=="string"||!/^rev_[a-z0-9]+$/.test(id)||!this.repositoryId)throw new Error("Invalid Origin approval review identity");
  const prefix=this.prefix(repository)+"/pulls/"+number;
  const get=async()=>{const matches=(await this.paginate(prefix+"/reviews","reviews",approvalReviewSchema,number)).filter(r=>r.id===id);if(matches.length!==1)throw new Error("Origin approval review unavailable");return matches[0];};
  const review=await get(),marker=review.body.split("\n").at(-1)??"";
  if(!this.owns(review.author)||!approvalMarker.test(marker)||review.body!==approvalBody(marker)||review.verdict!=="approve"||!review.submittedAt)throw new Error("Refusing to dismiss an unrelated Origin review");
  if(review.dismissal!==undefined)return;
  const result=await this.request(prefix+"/reviews/"+id+"/dismissals",approvalReviewSchema,{message:"OpenReview approval invalidated: native revision or trusted approval policy changed."},"PUT");
  if(result.id!==id||!this.owns(result.author)||result.body!==review.body||result.dismissal===undefined)throw new Error("Origin approval dismissal identity was not confirmed");
  if((await get()).dismissal===undefined)throw new Error("Origin approval dismissal was not confirmed");
 }
 async findingParent(repository:string,number:number,threadId:string){return (await this.paginate(this.prefix(repository)+"/pulls/"+number+"/comments","comments",commentSchema,number)).find(c=>c.thread.id===threadId&&this.owns(c.author)&&/<!-- openreview-finding:[a-f0-9]+ -->/.test(c.body))?.id;}
 async followUp(repository:string,number:number,commentId:string,author:string,body:string){
  const comments=await this.paginate(this.prefix(repository)+"/pulls/"+number+"/comments","comments",commentSchema,number),question=comments.find(c=>c.id===commentId);
  if(!question||question.author.user?.id!==author||question.author.app||question.author.serviceAccount||question.body!==body)throw new Error("Origin question author or body changed, or comment belongs to another change");
  if(!/@openreview\b/i.test(question.body))return null;
  const root=comments.find(c=>sameThread(c.thread,question.thread)&&this.owns(c.author)&&/<!-- openreview-finding:[a-f0-9]+ -->/.test(c.body));
  // All Origin comments, including general discussion, have native threads.
  return {commentId:question.id,author,question:question.body,inline:true,parentCommentId:root?.id??question.id};
 }
 async changeMetadata(repository:string,number:number):Promise<ChangeMetadata>{
  const pr=await this.change(repository,number);
  return changeMetadataSchema.parse({number:Number(pr.number),title:pr.title,html_url:"https://cursor.com/codebase/"+repository.split("/").map(encodeURIComponent).join("/")+"/pull/"+number,state:pr.state,draft:pr.draft,user:{login:identity(pr.author)},head:pr.head,base:{...pr.base,sha:pr.version.baseSha},revisionKey:pr.version.number});
 }
 async openChanges(repository:string,cursor:string|null):Promise<ChangePage>{
  const query=new URLSearchParams({state:"open",sortBy:"created",direction:"asc",pageSize:String(catalogPageSize),...(cursor?{pageToken:cursor}:{})});
  const page=await this.request(this.prefix(repository)+"/pulls?"+query,z.object({pullRequests:z.array(z.object({number:z.string().regex(/^[1-9][0-9]*$/)})).max(catalogPageSize),nextPageToken:z.string().default("")}));
  return validateChangePage({numbers:page.pullRequests.map(p=>Number(p.number)),next:page.nextPageToken||null},cursor);
 }
 async pullRequest(repository:string,number:number):Promise<ScmChange>{
  const prefix=this.prefix(repository)+"/pulls/"+number;const pr=await this.change(repository,number);
  const [files,comments,reviews,commits,checks]=await Promise.all([
   this.paginate(prefix+"/files","files",z.object({filename:z.string(),previousFilename:z.string().optional(),status:z.string(),patch:z.string().default(""),changes:z.number().default(0)})),
   this.paginate(prefix+"/comments","comments",commentSchema,number),this.paginate(prefix+"/reviews","reviews",reviewSchema,number),
   this.paginate(prefix+"/commits","commits",z.object({sha:z.string()})),
   this.paginate(this.prefix(repository)+"/commits/"+pr.head.sha+"/check-runs","checkRuns",z.object({name:z.string(),status:z.string(),conclusion:z.string().optional()}))
  ]);
  const current=await this.change(repository,number);
  if(current.version.number!==pr.version.number||current.head.sha!==pr.head.sha||current.version.baseSha!==pr.version.baseSha||current.state!==pr.state)throw new Error("Origin pull request changed during retrieval");
  if(!Number.isSafeInteger(Number(pr.number))||files.length!==pr.changedFiles||files.some(f=>f.changes>0&&!f.patch&&!/\.(png|jpg|gif|pdf|zip|ico|woff2?)$/i.test(f.filename)))throw new Error("Origin change exceeds supported numbering or diff coverage");
  if(pr.version.headSha!==pr.head.sha)throw new Error("Origin change version and head differ");
  return {revisionKey:pr.version.number,number:Number(pr.number),title:pr.title,body:pr.body,state:pr.state,draft:pr.draft,html_url:"https://cursor.com/codebase/"+repository.split("/").map(encodeURIComponent).join("/")+"/pull/"+number,user:{login:identity(pr.author)},authorExternalId:pr.author.user&&!pr.author.app&&!pr.author.serviceAccount?pr.author.user.id:undefined,head:pr.head,base:{...pr.base,sha:pr.version.baseSha},diff:files.map(f=>({path:f.filename,previousPath:f.previousFilename,status:f.status,patch:f.patch})),comments:comments.map(c=>({id:c.id,body:c.body,path:c.thread.path,line:c.thread.startLine||null,user:{login:identity(c.author)}})),reviews:reviews.map(r=>({id:r.id,body:r.body,commit_id:r.pullRequestVersion.headSha,state:r.verdict})),commits,checks:checks.map(c=>({...c,conclusion:c.conclusion??null}))};
 }
 private async findings(repository:string,number:number,marker:string,pr:z.infer<typeof prSchema>,findings:Finding[],style:string){
  if(!findings.length)return [];
  const comments=(await this.paginate(this.prefix(repository)+"/pulls/"+number+"/comments","comments",commentSchema,number)).filter(c=>this.owns(c.author)&&c.body.includes("<!-- openreview-review:"+marker+" -->"));
  return findings.map(f=>{
   const matches=comments.filter(c=>c.body===inlineBody(f,style,marker)&&c.thread.version.number===pr.version.number&&c.thread.version.headSha===pr.head.sha&&c.thread.version.baseSha===pr.version.baseSha&&c.thread.path===f.filePath&&c.thread.side==="right"&&c.thread.startLine===f.startLine&&(c.thread.endLine||c.thread.startLine)===f.endLine);
   if(matches.length!==1)throw new Error("Origin finding publication identity, revision or anchor unavailable");
   return {id:matches[0].id,fingerprint:f.fingerprint};
  });
 }
 async publish(repository:string,number:number,sha:string,summary:string,findings:Finding[],marker:string,style="detailed",revisionKey?:string,unresolvedCount=findings.length){
  const prefix=this.prefix(repository)+"/pulls/"+number;
  if(!/^[a-zA-Z0-9:_-]{1,200}$/.test(marker)||findings.length>50||findings.some(f=>f.commitSha!==sha||!Number.isInteger(f.startLine)||!Number.isInteger(f.endLine)||f.startLine<1||f.endLine<f.startLine))throw new Error("Invalid Origin publication identity, findings or native comment limit");
  const pr=await this.change(repository,number);if(pr.head.sha!==sha||pr.state!=="open"||(revisionKey!==undefined&&revisionKey!==pr.version.number))throw new Error("Origin change was updated or closed");
  const guard=async()=>{const current=await this.change(repository,number);if(current.state!=="open"||current.head.sha!==sha||current.version.number!==pr.version.number||current.version.baseSha!==pr.version.baseSha)throw new Error("Origin change was updated or closed during publication");};
  const body="## OpenReview\n\n"+summary+reviewLinks(marker,unresolvedCount)+"\n\n<!-- openreview:"+marker+" -->";
  const reviews=await this.paginate(prefix+"/reviews","reviews",reviewSchema,number),old=reviews.filter(r=>this.owns(r.author)&&r.body.trimEnd().endsWith("<!-- openreview:"+marker+" -->"));
  if(old.length>1)throw new Error("Multiple Origin reviews share the publication identity");
  const valid=(r:z.infer<typeof reviewSchema>)=>this.owns(r.author)&&r.body===body&&r.verdict==="comment"&&r.dismissal===undefined&&r.pullRequestVersion.number===pr.version.number&&r.pullRequestVersion.headSha===sha&&r.pullRequestVersion.baseSha===pr.version.baseSha;
  if(old.length){if(!valid(old[0]))throw new Error("Origin saved review identity, content or revision changed");const comments=await this.findings(repository,number,marker,pr,findings,style);await guard();return {id:old[0].id,reused:true,comments};}
  await guard();
  const review=await this.request(prefix+"/reviews",reviewSchema,{verdict:"comment",versionNumber:pr.version.number,body,comments:findings.map(f=>({body:inlineBody(f,style,marker),inline:{path:f.filePath,side:"right",startLine:f.startLine,endLine:f.endLine}}))});
  if(!valid(review))throw new Error("Origin returned another publication identity or revision");
  const comments=await this.findings(repository,number,marker,pr,findings,style);await guard();return {id:review.id,reused:false,comments};
 }
 async reply(repository:string,number:number,body:string,parent?:string|number,marker?:string){
  const prefix=this.prefix(repository)+"/pulls/"+number;
  const comments=await this.paginate(prefix+"/comments","comments",commentSchema,number),thread=parent!==undefined?comments.find(c=>c.id===String(parent))?.thread:undefined;
  if(parent!==undefined&&!thread)throw new Error("Origin parent comment unavailable inside this change");
  if(marker){if(!/^[a-zA-Z0-9:_-]{1,200}$/.test(marker))throw new Error("Invalid Origin reply identity");body+="\n\n<!-- openreview:"+marker+" -->";const old=comments.find(c=>this.owns(c.author)&&c.body===body&&(thread?c.thread.id===thread.id:!c.thread.path&&c.thread.startLine===0));if(old){if(thread&&!sameThread(old.thread,thread))throw new Error("Origin saved reply thread version or anchor changed");return {id:old.id};}}
  // CreateComment returns a compact thread reference. ListPullRequestComments
  // supplies its version and anchor; require that authoritative readback.
  const result=await this.request(prefix+"/comments",z.object({id:z.string().min(1),body:z.string(),author:actor,thread:z.object({id:z.string().min(1)}).passthrough()}),{body,...(thread?{threadId:thread.id}:{})});
  if(!this.owns(result.author)||result.body!==body||(thread&&result.thread.id!==thread.id))throw new Error("Origin returned another reply author, body or thread");
  const valid=(comment:z.infer<typeof commentSchema>)=>this.owns(comment.author)&&comment.body===body&&(thread?sameThread(comment.thread,thread):!comment.thread.path&&comment.thread.startLine===0&&comment.thread.endLine===0);
  if(result.thread.version!==undefined&&!valid(commentSchema.parse(result)))throw new Error("Origin returned another reply author, body or thread");
  const saved=(await this.paginate(prefix+"/comments","comments",commentSchema,number)).filter(c=>c.id===result.id);
  if(saved.length!==1||saved[0].thread.id!==result.thread.id||!valid(saved[0]))throw new Error("Origin reply readback author, body, version or anchor unavailable");
  return {id:result.id};
 }
}
