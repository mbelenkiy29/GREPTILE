import {changeMetadataSchema,catalogPageSize,numberedPage,validateChangePage,type ChangeMetadata,type ChangePage} from "./change-metadata";
import { reviewLinks } from "./review-summary";
import { z } from "zod";
import { repositorySourceUrl } from "./source-url";
import type { Scm, ScmChange, ScmApprovalSnapshot } from "./gitlab";
import type { ChangedFile, Finding, SourceFile } from "./engine/types";
import { changedLines } from "./engine/diff";
import { findingComment } from "./github";

const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().safe();
const user = z.object({id:id.optional(),name:z.string(),active:z.boolean(),type:z.string().optional()});
const path = z.object({components:z.array(z.string()).min(1)});
function filePath(p:z.infer<typeof path>){
 const result=p.components.join("/");
 if(!result||result.split("/").some(c=>!c||c==="."||c==="..")||/[\0\r\n]/.test(result))throw new Error("Invalid Bitbucket file path");
 return result;
}
const ref=z.object({displayId:z.string(),latestCommit:commit,repository:z.object({id})});
const participant=z.object({user:user.extend({id}),role:z.enum(["AUTHOR","REVIEWER","PARTICIPANT"]),status:z.enum(["UNAPPROVED","APPROVED","NEEDS_WORK"]),approved:z.boolean(),lastReviewedCommit:commit.nullish()}).superRefine((p,ctx)=>{
 if(p.approved!==(p.status==="APPROVED"))ctx.addIssue({code:"custom",message:"Bitbucket participant approval status is inconsistent"});
 if(p.status!=="UNAPPROVED"&&!p.lastReviewedCommit)ctx.addIssue({code:"custom",message:"Bitbucket reviewer decision has no reviewed commit"});
});
const prSchema=z.object({id,title:z.string(),description:z.string().nullish(),draft:z.boolean().default(false),state:z.enum(["OPEN","MERGED","DECLINED"]),author:z.object({user}),fromRef:ref,toRef:ref,reviewers:z.array(participant).optional(),participants:z.array(participant).optional()});
const publisher=user.extend({id,slug:z.string().min(1).max(255),type:z.enum(["NORMAL","SERVICE"])});
const approvalPr=prSchema.extend({draft:z.boolean(),locked:z.boolean(),version:z.number().int().nonnegative().safe(),author:z.object({user:publisher}),reviewers:z.array(participant),participants:z.array(participant)});
const approvalActivity=z.object({id,createdDate:z.number().int().nonnegative().safe(),action:z.enum(["APPROVED","AUTO_MERGE_CANCELLED","AUTO_MERGE_REQUESTED","COMMENTED","DECLINED","DELETED","MERGED","OPENED","REOPENED","RESCOPED","REVIEW_COMMENTED","REVIEW_DISCARDED","REVIEW_FINISHED","REVIEWED","UNAPPROVED","UPDATED"]),user:publisher});
function decisions(pr:z.infer<typeof prSchema>):ScmChange["reviews"]{
 const seen=new Map<number,z.infer<typeof participant>>();
 for(const p of [...pr.reviewers??[],...pr.participants??[]]){
  const previous=seen.get(p.user.id);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(p))throw new Error("Bitbucket participant identity or decision is inconsistent");
  seen.set(p.user.id,p);
 }
 return [...seen.values()].sort((a,b)=>a.user.id-b.user.id).filter(p=>p.role!=="AUTHOR"&&p.status!=="UNAPPROVED").map(p=>({id:"participant:"+p.user.id,body:null,commit_id:p.lastReviewedCommit!,state:p.status==="APPROVED"?"APPROVED":"CHANGES_REQUESTED",user:{login:p.user.name,type:p.user.type==="NORMAL"?"User":p.user.type==="SERVICE"?"Bot":"Unknown"}}));
}
function ingestionIdentity(pr:z.infer<typeof prSchema>){return JSON.stringify({state:pr.state,draft:pr.draft,fromRef:pr.fromRef,toRef:pr.toRef,author:pr.author,decisions:decisions(pr)});}
const commentSchema=z.object({id,text:z.string(),author:user,anchor:z.object({path,line:z.number().nullish(),toHash:commit.optional(),fromHash:commit.optional()}).nullish()});
type Comment=z.infer<typeof commentSchema> & {comments?:Comment[]};
const comment:z.ZodType<Comment>=commentSchema.extend({comments:z.lazy(()=>z.array(comment)).optional()});
const approvalNote=commentSchema.extend({author:publisher,version:z.number().int().nonnegative().safe(),pending:z.boolean(),reply:z.boolean(),state:z.string(),parent:z.object({id}).nullish()});
const approvalReceiptSchema=z.object({head:commit,revisionKey:commit,botId:id,activityId:id}).strict();
const approvalMarker=z.string().regex(/^<!-- openreview:approval:[a-zA-Z0-9_-]+ -->$/);
function approvalBody(receipt:z.infer<typeof approvalReceiptSchema>,marker:string){return "OpenReview native approval receipt. No merge was performed.\n\n<!-- openreview-bitbucket-dc-approval:"+JSON.stringify(receipt)+" -->\n\n"+marker;}
function parseApprovalReceipt(text:string){
 const match=/^OpenReview native approval receipt\. No merge was performed\.\n\n<!-- openreview-bitbucket-dc-approval:(\{[^\n]+\}) -->\n\n(<!-- openreview:approval:[a-zA-Z0-9_-]+ -->)$/.exec(text);
 if(!match)return;try{const receipt=approvalReceiptSchema.parse(JSON.parse(match[1]));if(approvalBody(receipt,match[2])===text)return {...receipt,marker:match[2]};}catch{}
}
const change=z.object({path,srcPath:path.nullish(),type:z.enum(["ADD","COPY","DELETE","MODIFY","MOVE","UNKNOWN"]),nodeType:z.string().optional()});
const hunk=z.object({sourceLine:z.number().int().nonnegative(),sourceSpan:z.number().int().nonnegative(),destinationLine:z.number().int().nonnegative(),destinationSpan:z.number().int().nonnegative(),truncated:z.boolean().optional(),segments:z.array(z.object({type:z.enum(["ADDED","REMOVED","CONTEXT"]),truncated:z.boolean().optional(),lines:z.array(z.object({line:z.string(),truncated:z.boolean().optional()}))}))});
const diff=z.object({diffs:z.array(z.object({source:path.nullish(),destination:path.nullish(),binary:z.boolean().optional(),truncated:z.boolean().optional(),hunks:z.array(hunk)})),truncated:z.boolean().optional()});

// DC caps diff streams instead of paging them. Never turn a truncated response into a complete review.
function patch(d:z.infer<typeof diff>["diffs"][number]){
 if(d.binary||d.truncated||d.hunks.some(h=>h.truncated||h.segments.some(s=>s.truncated||s.lines.some(l=>l.truncated))))throw new Error("Bitbucket omitted binary or truncated diff; complete review unavailable");
 return d.hunks.map(h=>{
  const old=h.segments.reduce((n,s)=>n+(s.type!=="ADDED"?s.lines.length:0),0),next=h.segments.reduce((n,s)=>n+(s.type!=="REMOVED"?s.lines.length:0),0);
  if(old!==h.sourceSpan||next!==h.destinationSpan)throw new Error("Bitbucket diff hunk coverage incomplete");
  return `@@ -${h.sourceLine},${h.sourceSpan} +${h.destinationLine},${h.destinationSpan} @@\n`+h.segments.flatMap(s=>s.lines.map(l=>(s.type==="ADDED"?"+":s.type==="REMOVED"?"-":" ")+l.line)).join("\n")+"\n";
 }).join("");
}
function flatten(comments:Comment[]):Comment[]{return comments.flatMap(c=>[c,...flatten(c.comments??[])]);}

export class BitbucketDC implements Scm {
 readonly supportsApproval=true;
 constructor(private base:string,private token:string,private externalId?:string,private botUsername?:string){}
 prefix(repo:string){
  const parts=repo.split("/");if(parts.length!==2||parts.some(p=>!p||p==="."||p===".."||/[\0\r\n]/.test(p)))throw new Error("Invalid Bitbucket repository");
  return "/projects/"+encodeURIComponent(parts[0])+"/repos/"+encodeURIComponent(parts[1]);
 }
 async request<T>(endpoint:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>,body?:unknown,namespace:"api/latest"|"build-status/latest"="api/latest",requirePublisher=false,method?:"PUT"):Promise<T>{
  if(!endpoint.startsWith("/")||endpoint.startsWith("//")||endpoint.includes("://"))throw new Error("Invalid Bitbucket API path");
  const response=await fetch(this.base+"/rest/"+namespace+endpoint,{method:method??(body===undefined?"GET":"POST"),redirect:"error",headers:{authorization:"Bearer "+this.token,accept:"application/json","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error("Bitbucket Data Center "+response.status+" at "+endpoint.split("?")[0]);
  const authenticated=response.headers.get("x-ausername");if(requirePublisher&&(!this.botUsername||authenticated!==this.botUsername)||this.botUsername&&authenticated&&authenticated!==this.botUsername){await response.body?.cancel();throw new Error("Bitbucket token does not belong to the configured bot username or authenticated header is missing");}
  return schema.parse(JSON.parse(await this.read(response,4000000)));
 }
 private async read(response:Response,limit:number){
  const reader=response.body?.getReader();if(!reader)throw new Error("Bitbucket response body missing");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error("Bitbucket response exceeds coverage limit");chunks.push(value);}}finally{await reader.cancel();}
  try{return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));}catch{throw new Error("Bitbucket response is not UTF-8");}
 }
 async paginate<T>(endpoint:string,schema:z.ZodType<T>,namespace:"api/latest"|"build-status/latest"="api/latest"){
  const result:T[]=[];let start=0;
  // ponytail: 10,000 entries per enumeration; partition discovery/indexing if instances exceed this ceiling.
  for(let page=0;page<100;page++){
   const p=await this.request(endpoint+(endpoint.includes("?")?"&":"?")+"limit=100&start="+start,z.object({values:z.array(schema),isLastPage:z.boolean(),nextPageStart:z.number().int().nonnegative().optional()}),undefined,namespace);
   result.push(...p.values);if(p.isLastPage)return result;
   if(p.nextPageStart===undefined||p.nextPageStart<=start)throw new Error("Bitbucket pagination did not advance; coverage incomplete");start=p.nextPageStart;
  }
  throw new Error("Bitbucket pagination exceeded; coverage incomplete");
 }
 async assertRepository(repo:string){if(this.externalId&&(await this.request(this.prefix(repo),z.object({id}))).id.toString()!==this.externalId)throw new Error("Bitbucket repository identity changed");}
 private approvalGet<T>(endpoint:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>,namespace:"api/latest"|"build-status/latest"="api/latest"){
  return this.request(endpoint,schema,undefined,namespace,true);
 }
 private async approvalPages<T>(endpoint:string,schema:z.ZodType<T>,namespace:"api/latest"|"build-status/latest"="api/latest"){
  const values:T[]=[];let start=0;
  for(let count=0;count<100;count++){
   const result=await this.approvalGet(endpoint+(endpoint.includes("?")?"&":"?")+"limit=100&start="+start,z.object({start:z.number().int().nonnegative().safe(),values:z.array(schema).max(100),isLastPage:z.boolean(),nextPageStart:z.number().int().nonnegative().safe().optional()}),namespace);
   if(result.start!==start)throw new Error("Bitbucket approval pagination cursor mismatch");
   values.push(...result.values);if(result.isLastPage)return values;
   if(result.nextPageStart===undefined||result.nextPageStart<=start)throw new Error("Bitbucket approval pagination did not advance");start=result.nextPageStart;
  }
  throw new Error("Bitbucket approval pagination exceeds coverage limit");
 }
 async approvalEvidence(repo:string,number:number){
  id.parse(number);
  if(!this.externalId||!/^([1-9][0-9]*)$/.test(this.externalId)||!this.botUsername||this.botUsername!==this.botUsername.trim()||this.botUsername.toLowerCase()==="anonymous"||/[\u0000-\u001f\u007f]/.test(this.botUsername))throw new Error("Bitbucket approval requires repository and publisher identities");
  const prefix=this.prefix(repo),prPath=prefix+"/pull-requests/"+number;
  const get=this.approvalGet.bind(this),pages=this.approvalPages.bind(this);
  const repository=await get(prefix,z.object({id}));
  if(String(repository.id)!==this.externalId)throw new Error("Bitbucket approval repository identity changed");
  const accounts=(await pages("/users?filter="+encodeURIComponent(this.botUsername),publisher)).filter(u=>u.name===this.botUsername);
  if(accounts.length!==1||!accounts[0].active)throw new Error("Bitbucket approval publisher is inactive or ambiguous");
  const bot=accounts[0],pr=await get(prPath,approvalPr);
  if(pr.id!==number||pr.toRef.repository.id!==repository.id)throw new Error("Bitbucket approval change identity mismatch");
  const [mergeability,statuses,activities]=await Promise.all([
   pr.state!=="OPEN"?Promise.resolve({conflicted:false,outcome:"UNKNOWN" as const,vetoes:[]}):get(prPath+"/merge",z.object({conflicted:z.boolean(),outcome:z.enum(["CLEAN","CONFLICTED","UNKNOWN"]),vetoes:z.array(z.object({summaryMessage:z.string(),detailedMessage:z.string()})).max(1000)})),
   pages("/commits/"+pr.fromRef.latestCommit,z.object({key:z.string().min(1),state:z.enum(["CANCELLED","FAILED","INPROGRESS","SUCCESSFUL","UNKNOWN"])}),"build-status/latest"),
   pages(prPath+"/activities",approvalActivity)
  ]);
  // This endpoint documents a most-recent-100 ceiling. A full page cannot prove
  // that older check keys are absent, even when isLastPage is true.
  if(statuses.length>=100)throw new Error("Bitbucket approval build status coverage reaches native 100-entry limit");
  if(new Set(statuses.map(s=>s.key)).size!==statuses.length||new Set(activities.map(a=>a.id)).size!==activities.length)throw new Error("Bitbucket approval duplicate status or activity identity");
  const reviews=decisions(pr);
  const members=[...pr.reviewers,...pr.participants];
  if(members.some(p=>p.user.id===bot.id&&(p.user.name!==bot.name||p.user.type!==bot.type||!p.user.active)))throw new Error("Bitbucket approval participant publisher identity changed");
  const own=activities.filter(a=>a.user.id===bot.id);
  if(own.some(a=>a.user.name!==bot.name||a.user.slug!==bot.slug||a.user.type!==bot.type))throw new Error("Bitbucket approval activity publisher identity changed");
  const decisionActions=new Set(["APPROVED","UNAPPROVED","REVIEWED","REVIEW_FINISHED","REVIEW_DISCARDED"]);
  const decisionActivities=own.filter(a=>decisionActions.has(a.action)).sort((a,b)=>a.id-b.id);
  if(decisionActivities.some((a,i)=>i>0&&a.createdDate<decisionActivities[i-1].createdDate))throw new Error("Bitbucket approval activity ordering is inconsistent");
  const latest=decisionActivities.at(-1);
  // Unknown review completion events cannot serve as approval ownership proof.
  const active=members.some(p=>p.user.id===bot.id&&p.status==="APPROVED"&&p.lastReviewedCommit===pr.fromRef.latestCommit);
  const publisherApprovalActivity=active&&latest?.action==="APPROVED"?latest:undefined;
  const checks=statuses.map(s=>({name:s.key,status:s.state==="INPROGRESS"?"in_progress":"completed",conclusion:s.state==="SUCCESSFUL"?"success":s.state==="FAILED"?"failure":s.state.toLowerCase()}));
  const gate="OpenReview / Bitbucket Data Center native merge conditions";
  if(checks.some(c=>c.name===gate))throw new Error("Bitbucket approval status collides with native gate");
  const noObjections=!members.some(p=>p.role!=="AUTHOR"&&p.status==="NEEDS_WORK"&&p.user.id!==bot.id);
  const eligible=pr.state==="OPEN"&&!pr.draft&&!pr.locked&&pr.author.user.active&&pr.author.user.id!==bot.id&&noObjections&&mergeability.outcome==="CLEAN"&&!mergeability.conflicted&&mergeability.vetoes.length===0;
  checks.push({name:gate,status:"completed",conclusion:eligible?"success":"failure"});
  const after=await get(prPath,approvalPr);
  if(JSON.stringify(pr)!==JSON.stringify(after))throw new Error("Bitbucket revision, version or reviewer decisions changed during approval verification");
  const afterActivities=await pages(prPath+"/activities",approvalActivity);
  if(new Set(afterActivities.map(a=>a.id)).size!==afterActivities.length)throw new Error("Bitbucket approval duplicate activity identity");
  const decisionIdentity=(list:z.infer<typeof approvalActivity>[])=>JSON.stringify(list.filter(a=>a.user.id===bot.id&&decisionActions.has(a.action)).sort((a,b)=>a.id-b.id));
  if(decisionIdentity(activities)!==decisionIdentity(afterActivities))throw new Error("Bitbucket publisher decision activities changed during approval verification");
  if((await get(prefix,z.object({id}))).id!==repository.id)throw new Error("Bitbucket approval repository identity changed");
  return {pr,bot,checks,required:[{name:gate}],reviews,mergeability,publisherApprovalActivity,publisherLatestDecision:latest};
 }
 private async approvalAuthority(repo:string,number:number){
  id.parse(number);
  if(!this.externalId||!this.botUsername||this.botUsername.toLowerCase()==="anonymous")throw new Error("Bitbucket approval identities unavailable");
  const prefix=this.prefix(repo)+"/pull-requests/"+number;
  const accounts=(await this.approvalPages("/users?filter="+encodeURIComponent(this.botUsername),publisher)).filter(u=>u.name===this.botUsername);
  if(accounts.length!==1||!accounts[0].active)throw new Error("Bitbucket approval publisher is inactive or ambiguous");
  const pr=await this.approvalGet(prefix,approvalPr),bot=accounts[0];
  if(pr.id!==number||String(pr.toRef.repository.id)!==this.externalId||(await this.approvalGet(this.prefix(repo),z.object({id}))).id!==pr.toRef.repository.id)throw new Error("Bitbucket approval repository or change identity mismatch");
  decisions(pr);
  const members=[...pr.reviewers,...pr.participants];
  if(members.some(p=>p.user.id===bot.id&&(p.user.name!==bot.name||p.user.type!==bot.type||!p.user.active)))throw new Error("Bitbucket approval participant publisher identity changed");
  return {pr,bot,prefix,members};
 }
 private async approvalDecisionHistory(prefix:string,bot:z.infer<typeof publisher>){
  const activities=await this.approvalPages(prefix+"/activities",approvalActivity);
  if(new Set(activities.map(a=>a.id)).size!==activities.length)throw new Error("Bitbucket approval duplicate activity identity");
  const own=activities.filter(a=>a.user.id===bot.id);
  if(own.some(a=>a.user.name!==bot.name||a.user.slug!==bot.slug||a.user.type!==bot.type))throw new Error("Bitbucket approval activity publisher identity changed");
  const decisions=own.filter(a=>["APPROVED","UNAPPROVED","REVIEWED","REVIEW_FINISHED","REVIEW_DISCARDED"].includes(a.action)).sort((a,b)=>a.id-b.id);
  if(decisions.some((a,i)=>i>0&&a.createdDate<decisions[i-1].createdDate))throw new Error("Bitbucket approval activity ordering is inconsistent");
  return decisions;
 }
 private async latestApprovalDecision(prefix:string,bot:z.infer<typeof publisher>){return (await this.approvalDecisionHistory(prefix,bot)).at(-1);}
 private async approvalNotes(prefix:string){
  const activities=await this.approvalPages(prefix+"/activities",z.object({comment:approvalNote.optional()}));
  const notes=activities.flatMap(a=>a.comment?[a.comment]:[]);
  if(new Set(notes.map(n=>n.id)).size!==notes.length)throw new Error("Bitbucket approval duplicate receipt identity");
  return notes;
 }
 private ownsReceipt(n:z.infer<typeof approvalNote>,bot:z.infer<typeof publisher>){
  return n.author.id===bot.id&&n.author.name===bot.name&&n.author.slug===bot.slug&&n.author.type===bot.type&&!n.pending&&!n.reply&&!n.parent&&!n.anchor&&n.state==="OPEN";
 }
 async approvalSnapshot(repo:string,number:number,_extraChecks:{name:string;appId?:number}[]=[]):Promise<ScmApprovalSnapshot>{
  void _extraChecks;
  const pr=await this.pullRequest(repo,number),a=await this.approvalEvidence(repo,number);
  if(pr.head.sha!==a.pr.fromRef.latestCommit||pr.revisionKey!==a.pr.toRef.latestCommit)throw new Error("Bitbucket revision changed during approval verification");
  const notes=await this.approvalNotes(this.prefix(repo)+"/pull-requests/"+number);
  const reviews=notes.flatMap(n=>{const r=parseApprovalReceipt(n.text);if(!r||r.botId!==a.bot.id||!this.ownsReceipt(n,a.bot))return [];return [{id:n.id,body:n.text,commit_id:r.head,state:a.pr.state==="OPEN"&&a.publisherApprovalActivity?.id===r.activityId&&r.head===pr.head.sha?"APPROVED":"DISMISSED",user:{login:a.bot.name,type:"Bot"}}];});
  const current=await this.approvalAuthority(repo,number),decision=await this.latestApprovalDecision(current.prefix,current.bot);
  if(JSON.stringify(current.pr)!==JSON.stringify(a.pr)||decision?.id!==a.publisherLatestDecision?.id||current.bot.id!==a.bot.id)throw new Error("Bitbucket revision or publisher decisions changed during approval verification");
  return {pr,checks:a.checks,nativeRequiredChecks:a.required,humanChangeRequested:current.members.some(p=>p.role!=="AUTHOR"&&p.status==="NEEDS_WORK"&&p.user.id!==a.bot.id),reviews,botLogin:a.bot.name};
 }
 private async withdrawApproval(repo:string,number:number,receipt:z.infer<typeof approvalReceiptSchema>){
  const a=await this.approvalAuthority(repo,number);
  if(a.bot.id!==receipt.botId)throw new Error("Bitbucket approval receipt publisher changed");
  if(a.pr.state!=="OPEN")return;
  const decision=await this.latestApprovalDecision(a.prefix,a.bot);
  if(decision?.id!==receipt.activityId||decision.action!=="APPROVED"||!a.members.some(p=>p.user.id===a.bot.id&&p.status==="APPROVED"&&p.lastReviewedCommit===receipt.head))return;
  const current=await this.approvalAuthority(repo,number),latest=await this.latestApprovalDecision(current.prefix,current.bot);
  if(JSON.stringify(current.pr)!==JSON.stringify(a.pr)||latest?.id!==receipt.activityId)throw new Error("Bitbucket native approval changed before withdrawal");
  const result=await this.request(a.prefix+"/participants/"+encodeURIComponent(a.bot.slug)+"?version="+a.pr.version,participant,{status:"UNAPPROVED",lastReviewedCommit:a.pr.fromRef.latestCommit},"api/latest",true,"PUT");
  if(result.user.id!==a.bot.id||result.user.name!==a.bot.name||result.status!=="UNAPPROVED"||result.approved)throw new Error("Bitbucket approval withdrawal response mismatch");
  const after=await this.approvalAuthority(repo,number),afterDecision=await this.latestApprovalDecision(after.prefix,after.bot);
  if(afterDecision?.id===receipt.activityId&&after.members.some(p=>p.user.id===a.bot.id&&p.status==="APPROVED"))throw new Error("Bitbucket approval withdrawal was not confirmed");
 }
 async approve(repo:string,number:number,head:string,marker:string,botLogin:string,revisionKey?:string){
  commit.parse(head);commit.parse(revisionKey);approvalMarker.parse(marker);
  const a=await this.approvalEvidence(repo,number),prefix=this.prefix(repo)+"/pull-requests/"+number;
  if(a.bot.name!==botLogin)throw new Error("Bitbucket approval publisher changed");
  const guard=(pr:z.infer<typeof approvalPr>)=>{if(pr.state!=="OPEN"||pr.draft||pr.locked||pr.fromRef.latestCommit!==head||pr.toRef.latestCommit!==revisionKey||JSON.stringify(pr.fromRef)!==JSON.stringify(a.pr.fromRef)||JSON.stringify(pr.toRef)!==JSON.stringify(a.pr.toRef)||pr.author.user.id!==a.pr.author.user.id||pr.author.user.id===a.bot.id||[...pr.reviewers,...pr.participants].some(p=>p.role!=="AUTHOR"&&p.status==="NEEDS_WORK"&&p.user.id!==a.bot.id))throw new Error("Bitbucket approval revision, author or objections changed");};
  guard(a.pr);
  const notes=await this.approvalNotes(prefix),matches=notes.filter(n=>this.ownsReceipt(n,a.bot)&&parseApprovalReceipt(n.text)?.marker===marker);
  if(matches.length>1)throw new Error("Bitbucket approval receipt is ambiguous");
  const prior=matches[0];
  if(prior){const r=parseApprovalReceipt(prior.text)!;if(r.botId!==a.bot.id||r.head!==head||r.revisionKey!==revisionKey||a.publisherApprovalActivity?.id!==r.activityId)throw new Error("Bitbucket approval receipt is no longer active");return {id:prior.id,reused:true};}
  if([...a.pr.reviewers,...a.pr.participants].some(p=>p.user.id===a.bot.id&&p.status==="APPROVED"))throw new Error("Bitbucket publisher already approved without this receipt; inspect native approval before retrying");
  if(a.checks.filter(c=>a.required.some(r=>r.name===c.name)).some(c=>c.conclusion!=="success"))throw new Error("Bitbucket native approval checks have not passed");
  const before=await this.approvalAuthority(repo,number);guard(before.pr);
  if(JSON.stringify(before.pr)!==JSON.stringify(a.pr))throw new Error("Bitbucket native metadata changed before approval");
  const result=await this.request(prefix+"/participants/"+encodeURIComponent(a.bot.slug)+"?version="+before.pr.version,participant,{status:"APPROVED",lastReviewedCommit:head},"api/latest",true,"PUT");
  if(result.user.id!==a.bot.id||result.user.name!==a.bot.name||result.user.type!==a.bot.type||!result.user.active||result.status!=="APPROVED"||result.lastReviewedCommit!==head)throw new Error("Bitbucket native approval identity unavailable; inspect before retrying");
  const after=await this.approvalAuthority(repo,number),newDecisions=(await this.approvalDecisionHistory(prefix,a.bot)).filter(d=>d.id>(a.publisherLatestDecision?.id??0)),activity=newDecisions.length===1?newDecisions[0]:undefined;
  if(!activity||activity.action!=="APPROVED"||activity.id<=(a.publisherLatestDecision?.id??0)||!after.members.some(p=>p.user.id===a.bot.id&&p.status==="APPROVED"&&p.lastReviewedCommit===head))throw new Error("Bitbucket native approval activity unavailable; inspect before retrying");
  const receipt={head,revisionKey:revisionKey!,botId:a.bot.id,activityId:activity.id};
  try{
   guard(after.pr);
   const body=approvalBody(receipt,marker),note=await this.request(prefix+"/comments",approvalNote,{text:body},"api/latest",true);
   if(!this.ownsReceipt(note,a.bot)||note.text!==body)throw new Error("Bitbucket returned an unrelated approval receipt");
   const current=await this.approvalAuthority(repo,number);guard(current.pr);
   if((await this.latestApprovalDecision(prefix,current.bot))?.id!==activity.id)throw new Error("Bitbucket native approval changed during receipt publication");
   return {id:note.id,reused:false};
  }catch(error){await this.withdrawApproval(repo,number,receipt);throw error;}
 }
 async dismissApproval(repo:string,number:number,noteId:string|number){
  id.parse(noteId);const a=await this.approvalAuthority(repo,number),note=await this.approvalGet(a.prefix+"/comments/"+noteId,approvalNote),receipt=parseApprovalReceipt(note.text);
  if(!receipt||receipt.botId!==a.bot.id||!this.ownsReceipt(note,a.bot))throw new Error("Refusing to withdraw an unrelated Bitbucket approval");
  await this.withdrawApproval(repo,number,receipt);
 }
 async archive(repo:string,sha:string):Promise<Uint8Array>{
  if(!commit.safeParse(sha).success)throw new Error("Runtime archive requires an exact Git commit");
  if(!this.externalId||!/^([1-9][0-9]*)$/.test(this.externalId)||!this.botUsername)throw new Error("Bitbucket runtime archive requires repository and publisher identities");
  const prefix=this.prefix(repo);await this.assertRepository(repo);
  // A fixed top-level directory matches the worker's single-component extraction.
  // Never use the default branch or a filtered subset of the reviewed commit.
  const query=new URLSearchParams({at:sha,format:"tar.gz",prefix:"openreview/"});
  const response=await fetch(this.base+"/rest/api/latest"+prefix+"/archive?"+query,{redirect:"error",headers:{authorization:"Bearer "+this.token,accept:"application/octet-stream"},signal:AbortSignal.timeout(60000)});
  const length=response.headers.get("content-length"),expected=length===null?undefined:Number(length);
  if(!response.ok||response.headers.get("x-ausername")!==this.botUsername||expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0||expected>20000000)){
   await response.body?.cancel();throw new Error("Bitbucket runtime archive unavailable, publisher changed or size invalid");
  }
  const reader=response.body?.getReader();if(!reader)throw new Error("Runtime archive missing");
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000000)throw new Error("Runtime archive exceeds 20 MB");parts.push(value);}}finally{await reader.cancel();}
  if(expected!==undefined&&expected!==size)throw new Error("Bitbucket runtime archive size mismatch");
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(bytes[0]!==0x1f||bytes[1]!==0x8b)throw new Error("Runtime archive is not gzip");
  await this.assertRepository(repo);return bytes;
 }
 async repositories(){
  const repos=await this.paginate("/repos?permission=REPO_WRITE&state=AVAILABLE&archived=ACTIVE",z.object({id,slug:z.string(),project:z.object({key:z.string(),id:id.optional(),name:z.string().optional(),type:z.string().optional()}),scmId:z.string(),links:z.object({clone:z.array(z.object({name:z.string(),href:z.string().url()}))})}));
  const result:{externalId:string;fullName:string;defaultBranch:string;remoteUrl:string;group?:{externalId:string;name:string}}[]=[];
  for(const r of repos.filter(r=>r.scmId==="git")){
   const fullName=r.project.key+"/"+r.slug;
   const branch=await this.request(this.prefix(fullName)+"/default-branch",z.object({displayId:z.string()}));
   const remote=r.links.clone.find(l=>l.name==="http");if(!remote)throw new Error("Bitbucket HTTPS clone URL unavailable");
   const url=new URL(remote.href);if(url.protocol!=="https:"||url.host!==new URL(this.base).host||url.username||url.password)throw new Error("Bitbucket clone URL must use the trusted HTTPS instance");
   result.push({externalId:String(r.id),fullName,defaultBranch:branch.displayId,remoteUrl:url.href,...(r.project.type==="NORMAL"&&r.project.id!==undefined?{group:{externalId:String(r.project.id),name:(r.project.name??r.project.key).slice(0,100)}}:{})});
  }
  return result;
 }
 sourceUrl(repo:string,revision:string,file:string){return repositorySourceUrl("bitbucket-dc",this.base,repo,revision,file);}
 async head(repo:string,branch:string){await this.assertRepository(repo);const branches=await this.paginate(this.prefix(repo)+"/branches?filterText="+encodeURIComponent(branch),z.object({displayId:z.string(),latestCommit:commit}));const found=branches.find(b=>b.displayId===branch);if(!found)throw new Error("Bitbucket branch unavailable");return found.latestCommit;}
 async tree(repo:string,sha:string){
  await this.assertRepository(repo);commit.parse(sha);
  const paths=(await this.paginate(this.prefix(repo)+"/files?at="+sha,z.string())).map(p=>filePath({components:p.split("/")}));
  const directories=new Map<string,string[]>(),modified=new Map<string,string>();
  for(const p of paths){const directory=p.split("/").slice(0,-1).join("/");const list=directories.get(directory)??[];list.push(p);directories.set(directory,list);}
  for(const [directory,files] of directories){
   const result=await this.request(this.prefix(repo)+"/last-modified"+(directory?"/"+directory.split("/").map(encodeURIComponent).join("/"):"")+"?at="+sha,z.object({files:z.record(z.object({id:commit}))}));
   for(const p of files){
    const name=p.split("/").at(-1)!;if(!Object.hasOwn(result.files,name))throw new Error("Bitbucket last-modified source coverage incomplete");modified.set(p,result.files[name].id);
   }
  }
  return paths.map(p=>({path:p,sha:modified.get(p)!,type:"blob"}));
 }
 async blob(repo:string,p:string,sha:string):Promise<SourceFile>{
  commit.parse(sha);filePath({components:p.split("/")});await this.assertRepository(repo);
  const endpoint=this.prefix(repo)+"/raw/"+p.split("/").map(encodeURIComponent).join("/")+"?at="+sha;
  const response=await fetch(this.base+"/rest/api/latest"+endpoint,{redirect:"error",headers:{authorization:"Bearer "+this.token},signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error("Bitbucket Data Center "+response.status+" reading source");
  let content:string;
  try{content=await this.read(response,200000);}catch(error){if(error instanceof Error&&error.message.includes("coverage limit"))return {path:p,sha,content:"",size:200001};if(error instanceof Error&&error.message.includes("not UTF-8"))return {path:p,sha,content:"\0"};throw error;}
  return {path:p,sha,content,size:Buffer.byteLength(content)};
 }
 async branches(repo:string){await this.assertRepository(repo);const list=await this.paginate(this.prefix(repo)+"/branches",z.object({displayId:z.string(),latestCommit:commit}));return {branches:list.slice(0,200).map(b=>({name:b.displayId,sha:b.latestCommit,protected:false})),limited:list.length>200};}
 async details(repo:string,number:number){id.parse(number);const pr=await this.request(this.prefix(repo)+"/pull-requests/"+number,prSchema);if(pr.id!==number||this.externalId&&String(pr.toRef.repository.id)!==this.externalId)throw new Error("Bitbucket pull request repository identity mismatch");return pr;}
 async comments(repo:string,number:number){return flatten((await this.paginate(this.prefix(repo)+"/pull-requests/"+number+"/activities",z.object({comment:comment.optional()}))).flatMap(a=>a.comment?[a.comment]:[]));}
 async changeMetadata(repo:string,number:number):Promise<ChangeMetadata>{
  await this.assertRepository(repo);
  const pr=await this.request(this.prefix(repo)+"/pull-requests/"+number,prSchema.omit({reviewers:true,participants:true}));
  if(pr.id!==number||this.externalId&&String(pr.toRef.repository.id)!==this.externalId)throw new Error("Bitbucket change identity mismatch");
  return changeMetadataSchema.parse({number:pr.id,title:pr.title,html_url:this.base+this.prefix(repo)+"/pull-requests/"+number,draft:pr.draft,state:pr.state==="OPEN"?"open":pr.state==="MERGED"?"merged":"closed",user:{login:pr.author.user.name},head:{sha:pr.fromRef.latestCommit,ref:pr.fromRef.displayId},base:{sha:pr.toRef.latestCommit,ref:pr.toRef.displayId},revisionKey:pr.toRef.latestCommit});
 }
 async openChanges(repo:string,cursor:string|null):Promise<ChangePage>{
  await this.assertRepository(repo);const start=numberedPage(cursor,0);
  const page=await this.request(this.prefix(repo)+`/pull-requests?state=OPEN&order=OLDEST&limit=${catalogPageSize}&start=${start}`,z.object({start:z.number().int().nonnegative(),values:z.array(z.object({id})).max(catalogPageSize),isLastPage:z.boolean(),nextPageStart:z.number().int().nonnegative().optional()}));
  if(page.start!==start||!page.isLastPage&&(page.nextPageStart===undefined||page.nextPageStart<=start))throw new Error("Bitbucket catalog cursor did not advance");
  return validateChangePage({numbers:page.values.map(r=>r.id),next:page.isLastPage?null:String(page.nextPageStart)},cursor);
 }
 async pullRequest(repo:string,number:number):Promise<ScmChange>{
  const pr=await this.details(repo,number),prefix=this.prefix(repo)+"/pull-requests/"+number;
  const [base,changes,comments,commits,checks]=await Promise.all([
   this.request(prefix+"/merge-base",z.object({id:commit})),
   this.request(prefix+"/changes?limit=10000&withComments=false",z.object({values:z.array(change),isLastPage:z.literal(true),truncated:z.literal(false).optional()})),
   this.comments(repo,number),this.paginate(prefix+"/commits",z.object({id:commit})),
   this.paginate("/commits/"+pr.fromRef.latestCommit,z.object({key:z.string(),name:z.string().optional(),state:z.string()}),"build-status/latest")
  ]);
  const files:ChangedFile[]=[];
  for(const c of changes.values){
   if(c.type==="UNKNOWN"||c.nodeType&&c.nodeType!=="FILE")throw new Error("Bitbucket unsupported change; complete review unavailable");
   const p=filePath(c.path),old=c.srcPath?filePath(c.srcPath):undefined;
   const native=await this.request(prefix+"/diff/"+p.split("/").map(encodeURIComponent).join("/")+"?withComments=false&contextLines=3"+(old?"&srcPath="+encodeURIComponent(old):""),diff);
   if(native.truncated||native.diffs.length!==1)throw new Error("Bitbucket diff coverage incomplete");
   const d=native.diffs[0],actual=d.destination??d.source;if(!actual||filePath(actual)!==p)throw new Error("Bitbucket diff path mismatch");
   files.push({path:p,previousPath:old,status:c.type==="DELETE"?"removed":c.type==="ADD"?"added":c.type==="MOVE"?"renamed":"modified",patch:patch(d)});
  }
  const latest=await this.details(repo,number);if(ingestionIdentity(pr)!==ingestionIdentity(latest))throw new Error("Bitbucket revision, author or reviewer decisions changed during ingestion");
  return {number:pr.id,title:pr.title,body:pr.description??null,draft:pr.draft??false,state:pr.state==="OPEN"?"open":"closed",html_url:this.base+this.prefix(repo)+"/pull-requests/"+number,user:{login:pr.author.user.name},...(pr.author.user.id&&pr.author.user.active&&pr.author.user.type==="NORMAL"?{authorExternalId:String(pr.author.user.id)}:{}),head:{sha:pr.fromRef.latestCommit,ref:pr.fromRef.displayId},base:{sha:base.id,ref:pr.toRef.displayId},revisionKey:pr.toRef.latestCommit,diff:files,comments:comments.map(c=>({id:c.id,body:c.text,path:c.anchor?filePath(c.anchor.path):"",line:c.anchor?.line??null,user:{login:c.author.name}})),reviews:decisions(pr),commits:commits.map(c=>({sha:c.id})),checks:checks.map(c=>({name:c.name??c.key,status:c.state==="INPROGRESS"?"in_progress":"completed",conclusion:c.state==="SUCCESSFUL"?"success":c.state==="FAILED"?"failure":c.state.toLowerCase()}))};
 }
 async publish(repo:string,number:number,sha:string,summary:string,findings:Finding[],marker:string,style="detailed",revisionKey?:string,unresolvedCount=findings.length){
  const pr=await this.pullRequest(repo,number);
  if(!this.botUsername)throw new Error("Configure the Bitbucket bot username before publishing");
  const guard=async()=>{const current=await this.details(repo,number);if(current.state!=="OPEN"||current.fromRef.latestCommit!==sha||revisionKey!==current.toRef.latestCommit)throw new Error("Bitbucket revision changed or closed");};
  await guard();const notes=await this.comments(repo,number),prefix=this.prefix(repo)+"/pull-requests/"+number+"/comments",comments:{id:number;fingerprint:string}[]=[];
  for(const f of findings){
   const file=pr.diff.find(d=>d.path===f.filePath);if(!file||!changedLines(file.patch).has(f.startLine))throw new Error("Bitbucket finding must anchor to an added line in the reviewed diff");
   const findingMarker="<!-- openreview-finding:"+f.fingerprint+" -->",runMarker="<!-- openreview:"+marker+" -->";
   const prior=notes.find(n=>n.author.name===this.botUsername&&n.anchor?.toHash===sha&&n.text.includes(findingMarker)&&n.text.includes(runMarker));if(prior){comments.push({id:prior.id,fingerprint:f.fingerprint});continue;}
   await guard();const result=await this.request(prefix,z.object({id,author:user}),{text:findingComment(f,style)+"\n\n"+runMarker+(process.env.APP_URL?"\n\n[Fix with your agent]("+process.env.APP_URL+"/fix/"+marker+"?finding="+f.fingerprint+")":""),anchor:{diffType:"RANGE",fromHash:pr.base.sha,toHash:sha,path:f.filePath,...(file.previousPath?{srcPath:file.previousPath}:{}),line:f.startLine,lineType:"ADDED",fileType:"TO"}});
   if(result.author.name!==this.botUsername)throw new Error("Bitbucket published comment author differs from configured bot");
   comments.push({id:result.id,fingerprint:f.fingerprint});
  }
  const prior=notes.find(n=>n.author.name===this.botUsername&&!n.anchor&&n.text.includes("<!-- openreview:"+marker+" -->"));if(prior)return {id:prior.id,reused:true,comments};
  await guard();const result=await this.request(prefix,z.object({id,author:user}),{text:"## OpenReview\n\n"+summary+reviewLinks(marker,unresolvedCount)+"\n\n<!-- openreview:"+marker+" -->"});if(result.author.name!==this.botUsername)throw new Error("Bitbucket published comment author differs from configured bot");return {id:result.id,reused:false,comments};
 }
 async canReply(repo:string,author:string){
  if(author===this.botUsername||!author.trim()||author.length>255||/[\0\r\n]/.test(author))return false;
  this.prefix(repo);
  await this.assertRepository(repo);
  const [projectKey,repositorySlug]=repo.split("/");
  // Native permission filtering includes inherited access; do not infer membership from group names or direct grants.
  const query=new URLSearchParams({filter:author,permission:"REPO_WRITE","permission.projectKey":projectKey,"permission.repositorySlug":repositorySlug});
  const authors=await this.paginate("/users?"+query,user);
  return authors.some(u=>u.name===author&&u.active&&u.type==="NORMAL");
 }
 async reply(repo:string,number:number,body:string,parent?:string|number,marker?:string){
  await this.details(repo,number);if(parent!==undefined)id.parse(parent);
  if(!this.botUsername)throw new Error("Configure the Bitbucket bot username before publishing");
  if(marker){const prior=(await this.comments(repo,number)).find(c=>c.author.name===this.botUsername&&c.text.includes("<!-- openreview:"+marker+" -->"));if(prior)return {id:prior.id};body+="\n\n<!-- openreview:"+marker+" -->";}
  return this.request(this.prefix(repo)+"/pull-requests/"+number+"/comments",z.object({id}),{text:body,...(parent===undefined?{}:{parent:{id:parent}})});
 }
}
