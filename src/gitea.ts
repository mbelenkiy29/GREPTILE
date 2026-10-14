import {changeMetadataSchema,catalogPageSize,numberedPage,validateChangePage,type ChangeMetadata,type ChangePage} from "./change-metadata";
import { reviewLinks } from "./review-summary";
import { z } from "zod";
import { repositorySourceUrl } from "./source-url";
import { Github,findingComment,findingFingerprint } from "./github";
import { parseDiff,changedLines } from "./engine/diff";
import type { Finding } from "./engine/types";
const userSchema=z.object({id:z.number().int().positive(),login:z.string(),active:z.boolean(),prohibit_login:z.boolean(),type:z.string()});
const reviewCommentSchema=z.object({id:z.number().int().positive(),body:z.string(),user:z.object({login:z.string()}),pull_request_review_id:z.number().int().positive(),path:z.string().optional(),position:z.number().optional()});
const approvalReviewSchema=z.object({id:z.number().int().positive(),body:z.string().nullable(),commit_id:z.string(),state:z.string(),dismissed:z.boolean(),stale:z.boolean(),user:z.object({login:z.string(),type:z.string()})});
function statusMatches(pattern:string,name:string){
 // These native glob forms have unambiguous semantics across supported Gitea versions.
 if(/[\[\]{}\\!()]/.test(pattern))throw new Error("Unsupported Gitea required status pattern; approval checks are unknown");
 return new RegExp("^"+[...pattern].map(c=>c==="*"?".*":c==="?"?".":c.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("")+"$").test(name);
}
export class Gitea extends Github {
 readonly supportsApproval=true;
 constructor(private instance:string,private credential:string){super(credential,instance+"/api/v1");}
 protected override async publisherLogin(){return (await this.request("/user",z.object({login:z.string().min(1)}))).login;}
 override async request<T>(endpoint:string,schema:z.ZodType<T>,options:RequestInit={}):Promise<T>{
  if(!endpoint.startsWith("/")||endpoint.startsWith("//")||endpoint.includes("://"))throw new Error("Invalid Gitea API path");
  const response=await fetch(this.instance+"/api/v1"+endpoint,{...options,redirect:"error",headers:{authorization:"token "+this.credential,"content-type":"application/json",...options.headers},signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error("Gitea "+response.status+" at "+endpoint.split("?")[0]);
  if(response.status===204)return schema.parse(null);
  const text=await response.text();
  return schema.parse(response.headers.get("content-type")?.includes("json")?JSON.parse(text):text);
 }
 override async paginate<T>(endpoint:string,schema:z.ZodType<T>){const result:T[]=[];for(let page=1;page<=100;page++){const list=await this.request(endpoint+(endpoint.includes("?")?"&":"?")+"limit=100&page="+page,z.array(schema));result.push(...list);if(list.length<100)return result;}throw new Error("Gitea pagination exceeded; coverage incomplete");}
 override sourceUrl(repository:string,revision:string,file:string){return repositorySourceUrl("gitea",this.instance,repository,revision,file);}
 async discover(){return (await this.paginate("/user/repos",z.object({id:z.number(),full_name:z.string(),default_branch:z.string(),clone_url:z.string().url(),owner:z.object({id:z.number().int().positive(),login:z.string().min(1),type:z.string()}).optional()}))).map(r=>({externalId:String(r.id),fullName:r.full_name,defaultBranch:r.default_branch,remoteUrl:r.clone_url,...(r.owner?.type==="Organization"?{group:{externalId:String(r.owner.id),name:r.owner.login.slice(0,100)}}:{})}));}
 override async canReply(repo:string,author:string){
  const me=await this.request("/user",z.object({id:z.number(),login:z.string()}));if(me.login.toLowerCase()===author.toLowerCase())return false;
  const permission=await this.request("/repos/"+repo+"/collaborators/"+encodeURIComponent(author)+"/permission",z.object({permission:z.string(),user:userSchema}));
  return permission.user.id!==me.id&&permission.user.login===author&&permission.user.active&&!permission.user.prohibit_login&&permission.user.type==="User"&&["owner","admin","write"].includes(permission.permission);
 }
 async followUps(repo:string,number:number,author:string,target:{commentId:number;body:string}|{reviewContent:string;state:string}){
  const prefix="/repos/"+repo;
  const timeline=await this.paginate(prefix+"/issues/"+number+"/timeline",z.object({id:z.number().int().positive(),body:z.string(),type:z.string(),review_id:z.number().optional(),user:z.object({login:z.string()})}));
  const entries="commentId" in target?timeline.filter(c=>c.id===target.commentId&&c.body===target.body&&c.user.login===author):timeline.filter(c=>c.type==="review"&&c.body===target.reviewContent&&c.user.login===author);
  const me=await this.request("/user",z.object({login:z.string()}));
  const result:{commentId:number;body:string;inline:boolean;parentCommentId?:number}[]=[],threads=new Map<number,z.infer<typeof reviewCommentSchema>[]>();
  const thread=async(id:number)=>{if(!threads.has(id)){if(threads.size>=100)throw new Error("Gitea discussion lookup limit exceeded");threads.set(id,await this.paginate(prefix+"/pulls/"+number+"/reviews/"+id+"/comments",reviewCommentSchema));}return threads.get(id)!;};
  const inline=(c:z.infer<typeof reviewCommentSchema>,comments:z.infer<typeof reviewCommentSchema>[])=>{const root=comments.find(n=>n.user.login===me.login&&c.path!==undefined&&c.position!==undefined&&n.path===c.path&&n.position===c.position&&findingFingerprint(n.body));return {commentId:c.id,body:c.body,inline:true,parentCommentId:root?.id??c.id};};
  // Native timeline responses omit code comments on Gitea 28; resolve direct replies through their scoped reviews.
  if(!entries.length&&"commentId" in target){
   const reviews=await this.paginate(prefix+"/pulls/"+number+"/reviews",z.object({id:z.number().int().positive()}));
   if(reviews.length>100)throw new Error("Gitea discussion lookup limit exceeded");
   for(const review of reviews){const comments=await thread(review.id),comment=comments.find(c=>c.id===target.commentId&&c.body===target.body&&c.user.login===author);if(comment)return /@openreview\b/i.test(comment.body)?[inline(comment,comments)]:[];}
  }
  if(!entries.length)throw new Error("Gitea comment changed or review unavailable");
  for(const entry of entries){
   if(entry.type==="comment")result.push({commentId:entry.id,body:entry.body,inline:false});
   else if(entry.type==="code"||entry.type==="review"){
    if(!entry.review_id||!Number.isSafeInteger(entry.review_id)||entry.review_id<1)throw new Error("Gitea review identity unavailable");
    const comments=await thread(entry.review_id);
    if(entry.type==="code"){const c=comments.find(c=>c.id===entry.id&&c.body===entry.body&&c.user.login===author);if(!c)throw new Error("Gitea inline comment changed or unavailable");result.push(inline(c,comments));}
    else{
     const review=await this.request(prefix+"/pulls/"+number+"/reviews/"+entry.review_id,z.object({id:z.number(),body:z.string().nullable(),state:z.string(),user:z.object({login:z.string()})}));
     if(review.id!==entry.review_id||review.body!==entry.body||review.user.login!==author||review.state==="PENDING")throw new Error("Gitea submitted review changed or unavailable");
     if("reviewContent" in target&&review.state!==target.state)continue;
     result.push({commentId:entry.id,body:entry.body,inline:false},...comments.filter(c=>c.user.login===author).map(c=>inline(c,comments)));
    }
   }else throw new Error("Unsupported Gitea conversation comment type");
  }
  return [...new Map(result.filter(c=>/@openreview\b/i.test(c.body)).map(c=>[c.commentId,c])).values()];
 }
 async branches(repo:string){const branches=await this.paginate("/repos/"+repo+"/branches",z.object({name:z.string(),protected:z.boolean(),commit:z.object({id:z.string()})}));return {branches:branches.slice(0,200).map(b=>({name:b.name,sha:b.commit.id,protected:b.protected})),limited:branches.length>200};}
 private async latestStatuses(repo:string,sha:string){
  const statuses:{context:string;status:string}[]=[];
  for(let page=1;;page++){
   if(page>100)throw new Error("Gitea approval status pagination exceeded");
   const result=await this.request("/repos/"+repo+"/commits/"+sha+"/status?limit=100&page="+page,z.object({sha:z.string(),total_count:z.number().int().nonnegative(),statuses:z.array(z.object({context:z.string(),status:z.string()})).nullable()}));
   if(result.sha!==sha)throw new Error("Gitea statuses belong to another revision");
   statuses.push(...result.statuses??[]);if(statuses.length>=result.total_count)break;
   if(!result.statuses?.length)throw new Error("Gitea approval status coverage incomplete");
  }
  if(new Set(statuses.map(s=>s.context)).size!==statuses.length)throw new Error("Gitea combined statuses contain ambiguous duplicate contexts");
  return statuses;
 }
 override async archive(repo:string,sha:string):Promise<Uint8Array>{
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error("Runtime archive requires an exact Git commit");
  if(!/^[^/]+\/[^/]+$/.test(repo)||repo.split("/").some(p=>p==="."||p===".."))throw new Error("Invalid Gitea repository identity");
  const response=await fetch(this.instance+"/api/v1/repos/"+repo.split("/").map(encodeURIComponent).join("/")+"/archive/"+sha+".tar.gz",{redirect:"error",headers:{authorization:"token "+this.credential},signal:AbortSignal.timeout(60000)});
  if(!response.ok||Number(response.headers.get("content-length")??0)>20000000){await response.body?.cancel();throw new Error("Runtime archive unavailable or too large");}
  const reader=response.body?.getReader();if(!reader)throw new Error("Runtime archive missing");
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000000)throw new Error("Runtime archive exceeds 20 MB");parts.push(value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(bytes[0]!==0x1f||bytes[1]!==0x8b)throw new Error("Runtime archive is not gzip");return bytes;
 }
 override async approvalSnapshot(repo:string,number:number,_extraChecks:{name:string;appId?:number}[]=[]){
  // Shared approval gates enforce configured checks against all returned native statuses.
  void _extraChecks;
  const pr=await this.pullRequest(repo,number),prefix="/repos/"+repo;
  const [branch,nativeReviews,bot]=await Promise.all([
   this.request(prefix+"/branches/"+encodeURIComponent(pr.base.ref),z.object({protected:z.boolean(),enable_status_check:z.boolean().optional(),status_check_contexts:z.array(z.string()).nullable().optional()})),
   this.paginate(prefix+"/pulls/"+number+"/reviews",approvalReviewSchema),
   this.request("/user",z.object({login:z.string().min(1)}))
  ]);
  if(branch.protected&&(branch.enable_status_check===undefined||branch.status_check_contexts===undefined))throw new Error("Gitea effective required checks unavailable");
  const patterns=branch.protected&&branch.enable_status_check?branch.status_check_contexts:null;
  if(branch.protected&&branch.enable_status_check&&patterns===null)throw new Error("Gitea effective required checks unavailable");
  const statuses=await this.latestStatuses(repo,pr.head.sha);
  const checks=statuses.map(s=>({name:s.context,status:s.status==="pending"?"in_progress":"completed",conclusion:s.status as string|null}));
  for(const pattern of patterns??[]){
   const matches=statuses.filter(s=>statusMatches(pattern,s.context));
   if(/[?*]/.test(pattern)||!statuses.some(s=>s.context===pattern))checks.push({name:pattern,status:matches.some(s=>s.status==="pending")?"in_progress":"completed",conclusion:matches.length&&matches.every(s=>s.status==="success")?"success":"failure"});
  }
  const reviews=nativeReviews.map(r=>({...r,state:(r.dismissed&&["APPROVED","REQUEST_CHANGES"].includes(r.state))||(r.stale&&r.state==="APPROVED")?"DISMISSED":r.state==="REQUEST_CHANGES"?"CHANGES_REQUESTED":r.state}));
  const latestHuman=new Map<string,string>();
  for(const r of [...reviews].sort((a,b)=>a.id-b.id))if(r.user.login!==bot.login&&["APPROVED","CHANGES_REQUESTED","DISMISSED"].includes(r.state))latestHuman.set(r.user.login,r.state);
  const current=await this.request(prefix+"/pulls/"+number,z.object({head:z.object({sha:z.string()}),base:z.object({sha:z.string(),ref:z.string()}),state:z.string(),draft:z.boolean().default(false)}));
  if(current.head.sha!==pr.head.sha||current.base.sha!==pr.base.sha||current.base.ref!==pr.base.ref||current.state!==pr.state||current.draft!==pr.draft)throw new Error("Gitea revision changed during approval verification");
  return {pr,checks,nativeRequiredChecks:(patterns??[]).map(name=>({name})),humanChangeRequested:[...latestHuman.values()].includes("CHANGES_REQUESTED"),reviews,botLogin:bot.login};
 }
 override async approve(repo:string,number:number,head:string,marker:string,botLogin:string){
  if(!/^[a-f0-9]{40}$/.test(head)||!/^<!-- openreview:approval:[a-zA-Z0-9_-]+ -->$/.test(marker)||!botLogin)throw new Error("Invalid approval identity or revision");
  const prefix="/repos/"+repo+"/pulls/"+number,bot=await this.publisherLogin();if(bot!==botLogin)throw new Error("Gitea approval publisher changed");
  const current=await this.request(prefix,z.object({state:z.string(),draft:z.boolean().default(false),head:z.object({sha:z.string()}),user:z.object({login:z.string()})}));
  if(current.head.sha!==head||current.state!=="open"||current.draft||current.user.login===bot)throw new Error("Gitea approval revision changed or own pull request");
  const old=(await this.paginate(prefix+"/reviews",approvalReviewSchema)).find(r=>r.commit_id===head&&r.body?.trimEnd().endsWith(marker)&&r.user.login===bot&&r.state==="APPROVED"&&!r.dismissed&&!r.stale);
  if(old)return {id:old.id,reused:true};
  const review=await this.request(prefix+"/reviews",approvalReviewSchema,{method:"POST",body:JSON.stringify({event:"APPROVED",commit_id:head,body:"OpenReview approved this exact revision after all configured approval gates passed. No merge was performed.\n\n"+marker})});
  if(review.commit_id!==head||review.user.login!==bot||review.state!=="APPROVED"||review.dismissed||review.stale)throw new Error("Gitea returned another approval identity or revision");
  return {id:review.id,reused:false};
 }
 override async dismissApproval(repo:string,number:number,id:number){
  const prefix="/repos/"+repo+"/pulls/"+number+"/reviews/"+id,review=await this.request(prefix,approvalReviewSchema),bot=await this.publisherLogin();
  if(review.user.login!==bot||!review.body?.match(/<!-- openreview:approval:[a-zA-Z0-9_-]+ -->\s*$/))throw new Error("Refusing to dismiss an unrelated Gitea review");
  if(review.dismissed)return;if(review.state!=="APPROVED")throw new Error("Gitea approval is no longer active");
  await this.request(prefix+"/dismissals",z.unknown(),{method:"POST",body:JSON.stringify({message:"OpenReview approval invalidated: revision or trusted approval policy changed.",priors:false})});
  if(!(await this.request(prefix,approvalReviewSchema)).dismissed)throw new Error("Gitea approval dismissal was not confirmed");
 }
 override async changeMetadata(repo:string,number:number):Promise<ChangeMetadata>{
  const pr=await this.request("/repos/"+repo+"/pulls/"+number,changeMetadataSchema.extend({draft:z.boolean().default(false)}));
  if(pr.number!==number)throw new Error("Gitea change identity mismatch");return {...pr,draft:pr.draft??false};
 }
 override async openChanges(repo:string,cursor:string|null):Promise<ChangePage>{
  const page=numberedPage(cursor),rows=await this.request(`/repos/${repo}/pulls?state=open&sort=oldest&limit=${catalogPageSize}&page=${page}`,z.array(z.object({number:z.number().int().positive().safe()})).max(catalogPageSize));
  return validateChangePage({numbers:rows.map(r=>r.number),next:rows.length===catalogPageSize?String(page+1):null},cursor);
 }
 override async pullRequest(repo:string,number:number){
  const prefix="/repos/"+repo;
  const pr=await this.request(prefix+"/pulls/"+number,z.object({number:z.number(),title:z.string(),body:z.string().nullable(),draft:z.boolean().default(false),state:z.string(),html_url:z.string(),user:z.object({id:z.number().int().positive().optional(),login:z.string()}),head:z.object({sha:z.string(),ref:z.string()}),base:z.object({sha:z.string(),ref:z.string()}),changed_files:z.number()}));
  const [patch,reviews,comments,commits,statuses]=await Promise.all([
   this.request(prefix+"/pulls/"+number+".diff",z.string()),
   this.paginate(prefix+"/pulls/"+number+"/reviews",z.object({id:z.number(),body:z.string().nullable(),commit_id:z.string(),state:z.string()})),
   this.paginate(prefix+"/issues/"+number+"/comments",z.object({id:z.number(),body:z.string(),user:z.object({login:z.string()})})),
   this.paginate(prefix+"/pulls/"+number+"/commits",z.object({sha:z.string()})),
   this.latestStatuses(repo,pr.head.sha)
  ]);
  const diff=parseDiff(patch);if(diff.length!==pr.changed_files)throw new Error("Gitea diff coverage incomplete; binary/unsupported paths require a smaller review");
  return {...pr,...(pr.user.id?{authorExternalId:String(pr.user.id)}:{}),draft:pr.draft??false,diff,reviews,comments:comments.map(c=>({...c,path:"",line:null})),commits,checks:statuses.map(s=>({name:s.context,status:s.status==="pending"?"in_progress":"completed",conclusion:s.status}))};
 }
 override async publish(repo:string,number:number,sha:string,summary:string,findings:Finding[],marker:string,style="detailed",_revisionKey?:string,unresolvedCount=findings.length){
  const prefix="/repos/"+repo+"/pulls/"+number;
  const current=async()=>{const pr=await this.request(prefix,z.object({head:z.object({sha:z.string()}),state:z.string()}));if(pr.head.sha!==sha||pr.state!=="open")throw new Error("Pull request changed or closed");};
  await current();const publisher=await this.publisherLogin();
  const existing=await this.paginate(prefix+"/reviews",z.object({id:z.number(),body:z.string().nullable(),commit_id:z.string(),state:z.string(),user:z.object({login:z.string()})}));
  const prior=existing.find(r=>r.user.login===publisher&&r.commit_id===sha&&r.state==="COMMENT"&&r.body?.trimEnd().endsWith("<!-- openreview:"+marker+" -->"));if(prior){const comments=await this.findingComments(repo,number,prior.id,findings,sha);await current();return {id:prior.id,reused:true,comments};}
  if(findings.length){const diff=parseDiff(await this.request(prefix+".diff",z.string()));for(const f of findings)if(f.commitSha!==sha||!changedLines(diff.find(d=>d.path===f.filePath)?.patch??"").has(f.startLine))throw new Error("Finding line not in complete current diff");}
  await current();
  const result=await this.request(prefix+"/reviews",z.object({id:z.number(),commit_id:z.string(),user:z.object({login:z.string()})}),{method:"POST",body:JSON.stringify({commit_id:sha,event:"COMMENT",body:"## OpenReview\n\n"+summary+reviewLinks(marker,unresolvedCount)+"\n\n<!-- openreview:"+marker+" -->",comments:findings.map(f=>({path:f.filePath,new_position:f.startLine,old_position:0,body:findingComment(f,style)+(process.env.APP_URL?"\n\n[Fix with your agent]("+process.env.APP_URL+"/fix/"+marker+"?finding="+f.fingerprint+")":"")}))})});
  if(result.user.login!==publisher||result.commit_id!==sha)throw new Error("Gitea returned another publication identity or revision");
  const comments=await this.findingComments(repo,number,result.id,findings,sha);await current();return {id:result.id,reused:false,comments};
 }
 override async reply(repo:string,number:number,body:string,parent?:string|number,marker?:string){
  const prefix="/repos/"+repo,me=await this.request("/user",z.object({login:z.string()}));
  let comments:{id:number;body:string;user:{login:string}}[]=[];
  if(parent!==undefined){
   if(typeof parent!=="number"||!Number.isSafeInteger(parent)||parent<1)throw new Error("Invalid Gitea review comment identity");
   const reviews=await this.paginate(prefix+"/pulls/"+number+"/reviews",z.object({id:z.number().int().positive()}));
   // ponytail: at most 100 review threads per reply; retain a review ID on conversations if older threads exceed this ceiling.
   if(reviews.length>100)throw new Error("Gitea discussion lookup limit exceeded");
   let target:z.infer<typeof reviewCommentSchema>|undefined;
   const all:z.infer<typeof reviewCommentSchema>[]=[];
   for(const review of reviews){const thread=await this.paginate(prefix+"/pulls/"+number+"/reviews/"+review.id+"/comments",reviewCommentSchema);all.push(...thread);target??=thread.find(c=>c.id===parent);}
   if(!target)throw new Error("Gitea parent comment unavailable in this pull request");
   comments=all.filter(c=>c.pull_request_review_id===target.pull_request_review_id&&c.path===target.path&&c.position===target.position);
  }else if(marker)comments=await this.paginate(prefix+"/issues/"+number+"/comments",z.object({id:z.number(),body:z.string(),user:z.object({login:z.string()})}));
  if(marker){const previous=comments.find(c=>c.user.login===me.login&&c.body.trimEnd().endsWith("<!-- openreview:"+marker+" -->"));if(previous)return {id:previous.id};body+="\n\n<!-- openreview:"+marker+" -->";}
  const result=await this.request(parent!==undefined?prefix+"/pulls/"+number+"/comments/"+parent+"/replies":prefix+"/issues/"+number+"/comments",z.object({id:z.number(),user:z.object({login:z.string()})}),{method:"POST",body:JSON.stringify({body})});
  if(result.user.login!==me.login)throw new Error("Gitea returned another reply author");return {id:result.id};
 }
}
