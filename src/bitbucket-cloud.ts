import {changeMetadataSchema,catalogPageSize,numberedPage,validateChangePage,type ChangeMetadata,type ChangePage} from "./change-metadata";
import { reviewLinks } from "./review-summary";
import {z} from "zod";
import { repositorySourceUrl } from "./source-url";
import {parseDiff,changedLines} from "./engine/diff";
import {findingComment,findingFingerprint} from "./github";
import type {Scm,ScmChange,ScmApprovalSnapshot} from "./gitlab";
import type {Finding,SourceFile} from "./engine/types";
import {runtimeTar} from "./runtime-tar";

const commit=z.string().regex(/^[a-f0-9]{40}$/);
const uuid=z.string().transform(s=>s.replace(/^\{(.+)\}$/,"$1")).pipe(z.string().uuid());
const id=z.number().int().positive().safe();
export function bitbucketCredential(value:string){
 const c=z.object({systemToken:z.string().min(10).max(20000).refine(s=>!/[\s\0]/.test(s)),publisherId:uuid,receivedAt:z.number().finite(),expiresAt:z.number().finite()}).parse(JSON.parse(value));
 if(c.receivedAt>Date.now()+30000||c.expiresAt<=Date.now()||c.expiresAt<=c.receivedAt||c.expiresAt-c.receivedAt>2*60*60000)throw new Error("Bitbucket Forge credentials expired or invalid; wait for the native refresh trigger");
 return c;
}
const filePath=z.string().min(1).max(4000).refine(s=>!/[\0\r\n\\]/.test(s)&&s.split("/").every(p=>p&&p!=="."&&p!==".."),"Invalid Bitbucket source path");
const encodedPath=(p:string)=>filePath.parse(p).split("/").map(encodeURIComponent).join("/");
const branch=z.object({name:z.string().min(1),target:z.object({hash:commit})});
const repository=z.object({uuid,full_name:z.string(),workspace:z.object({uuid})});
const ref=z.object({branch:z.object({name:z.string()}),commit:z.object({hash:commit}),repository});
const participant=z.object({user:z.object({uuid,type:z.string()}),role:z.enum(["PARTICIPANT","REVIEWER"]),approved:z.boolean(),state:z.enum(["approved","changes_requested"]).nullish(),participated_on:z.string().datetime({offset:true}).nullish()}).superRefine((p,ctx)=>{
 if(p.approved!==(p.state==="approved")||(p.state&& !p.participated_on))ctx.addIssue({code:"custom",message:"Bitbucket reviewer state or timestamp unavailable"});
});
const mergeCheck=z.object({type:z.enum(["pullrequest_state_check","current_user_permission_check","git_mergeability_check","standard_merge_check","custom_pre_merge_check","custom_on_merge_check","merge_queue_check"]),status:z.enum(["PASSED","FAILED","PENDING","SKIPPED","UNKNOWN"]),required:z.boolean(),blocking:z.boolean(),check:z.object({kind:z.string().min(1).optional(),id:z.string().min(1).optional()}).optional()});
const receipt=z.object({head:commit,revisionKey:commit,approvedAt:z.string().datetime({offset:true}),botId:uuid}).strict();
const approvalMarker=/^<!-- openreview:approval:[A-Za-z0-9_-]+ -->$/;
function approvalBody(r:z.infer<typeof receipt>,marker:string){return "OpenReview native approval receipt. No merge was performed.\n\n<!-- openreview-bitbucket-approval:"+JSON.stringify(r)+" -->\n\n"+marker;}
function approvalReceipt(body:string){const match=body.match(/^OpenReview native approval receipt\. No merge was performed\.\n\n<!-- openreview-bitbucket-approval:(\{[^\n]+\}) -->\n\n(<!-- openreview:approval:[A-Za-z0-9_-]+ -->)$/);if(!match)return;try{const r=receipt.parse(JSON.parse(match[1]));if(approvalBody(r,match[2])===body)return {...r,marker:match[2]};}catch{}}
const prSchema=z.object({id,title:z.string(),description:z.string().nullish(),draft:z.boolean().optional(),state:z.enum(["OPEN","MERGED","DECLINED","SUPERSEDED"]),author:z.object({uuid,type:z.string().optional()}),source:ref,destination:ref,queued:z.boolean().optional(),participants:z.array(participant).optional()});
const comment=z.object({id,content:z.object({raw:z.string()}),user:z.object({uuid,type:z.string().optional()}),deleted:z.boolean(),pending:z.boolean().optional(),parent:z.object({id}).nullish(),inline:z.object({path:filePath,to:z.number().int().positive().nullish(),from:z.number().int().positive().nullish()}).nullish()});
const entry=z.object({type:z.enum(["commit_file","commit_directory"]),path:filePath,commit:z.object({hash:commit}),size:z.number().int().nonnegative().optional(),attributes:z.array(z.enum(["binary","link","subrepository","executable"])).optional()});

// Reviewing requires an active installation with encrypted, unexpired Forge credentials.
export class BitbucketCloud implements Scm {
 readonly supportsApproval=true;
 private prefix:string;
 private workspace:string;
 private repositoryId:string;
 constructor(private token:string,workspaceId:string,repositoryId:string,private publisherId?:string){
  if(token.length<10||token.length>20000||/[\s\0]/.test(token))throw new Error("Bitbucket app system token required");
  this.workspace=uuid.parse(workspaceId);this.repositoryId=uuid.parse(repositoryId);
  if(publisherId!==undefined)this.publisherId=uuid.parse(publisherId);
  this.prefix="/2.0/repositories/"+encodeURIComponent("{"+this.workspace+"}")+"/"+encodeURIComponent("{"+this.repositoryId+"}");
 }
 private url(endpoint:string){
  const url=new URL(endpoint,"https://api.bitbucket.org");
  const permissionPath="/2.0/workspaces/"+encodeURIComponent("{"+this.workspace+"}")+"/permissions/repositories/"+encodeURIComponent("{"+this.repositoryId+"}");
  if(url.origin!=="https://api.bitbucket.org"||url.username||url.password||url.hash||!(url.pathname===this.prefix||url.pathname.startsWith(this.prefix+"/")||url.pathname===permissionPath))throw new Error("Bitbucket request exceeds authorized repository scope");
  return url;
 }
 private async raw(endpoint:string,limit:number,body?:unknown,method?:"DELETE"){
  const response=await fetch(this.url(endpoint),{method:method??(body===undefined?"GET":"POST"),body:body===undefined?undefined:JSON.stringify(body),headers:{authorization:"Bearer "+this.token,accept:"application/json, text/plain","content-type":"application/json"},redirect:"error",signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error("Bitbucket Cloud source access unavailable ("+response.status+")");
  if(method==="DELETE"){if(response.status!==204)throw new Error("Bitbucket approval withdrawal response unavailable");return Buffer.alloc(0);}
  const reader=response.body?.getReader();if(!reader)throw new Error("Bitbucket response missing");
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error("Bitbucket response exceeds coverage limit");chunks.push(value);}}finally{await reader.cancel();}
  return Buffer.concat(chunks);
 }
 private async read(endpoint:string,limit=4000000,body?:unknown){
  const bytes=await this.raw(endpoint,limit,body);
  try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("Bitbucket response is not UTF-8");}
 }
 private async request<T>(endpoint:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>,body?:unknown){return schema.parse(JSON.parse(await this.read(endpoint,4000000,body)));}
 private async paginate<T>(endpoint:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>){
  const initial=this.url(endpoint),seen=new Set<string>(),result:T[]=[];let next=initial.href;
  // ponytail: 10,000 records per listing; partition traversal if a directory or PR exceeds this ceiling.
  for(let page=0;page<100;page++){
   const url=this.url(next);
   if(url.pathname!==initial.pathname||seen.has(url.href))throw new Error("Bitbucket pagination changed scope or did not advance");
   for(const [key,value] of initial.searchParams)if(key!=="page"&&key!=="pagelen"&&url.searchParams.get(key)!==value)throw new Error("Bitbucket pagination changed revision or coverage");
   if([...url.searchParams.keys()].some(k=>!initial.searchParams.has(k)&&k!=="page"&&k!=="pagelen"))throw new Error("Bitbucket pagination changed filters");
   seen.add(url.href);const data=await this.request(url.href,z.object({values:z.array(schema).max(100),next:z.string().url().optional(),size:z.number().int().nonnegative().optional()}));
   result.push(...data.values);
   if(!data.next){if(data.size!==undefined&&data.size!==result.length)throw new Error("Bitbucket enumeration coverage incomplete");return result;}
   if(!data.values.length)throw new Error("Empty Bitbucket continuation page");next=data.next;
  }
  throw new Error("Bitbucket pagination exceeded; coverage incomplete");
 }
 async assertRepository(repo:string){
  const r=await this.request(this.prefix,repository);
  if(r.uuid!==this.repositoryId||r.workspace.uuid!==this.workspace||r.full_name!==repo)throw new Error("Bitbucket repository identity changed");
  if(repo.split("/").length!==2)throw new Error("Invalid Bitbucket repository name");repo.split("/").forEach(encodedPath);
 }
 sourceUrl(repo:string,revision:string,path:string){commit.parse(revision);return repositorySourceUrl("bitbucket-cloud","https://bitbucket.org",repo,revision,path);}
 async head(repo:string,name:string){await this.assertRepository(repo);const b=await this.request(this.prefix+"/refs/branches/"+encodeURIComponent(z.string().min(1).max(1000).parse(name)),branch);if(b.name!==name)throw new Error("Bitbucket branch identity mismatch");return b.target.hash;}
 async branches(repo:string){await this.assertRepository(repo);const list=await this.paginate(this.prefix+"/refs/branches?pagelen=100",branch);if(new Set(list.map(b=>b.name)).size!==list.length)throw new Error("Duplicate Bitbucket branch");return {branches:list.slice(0,200).map(b=>({name:b.name,sha:b.target.hash,protected:false})),limited:list.length>200};}
 async tree(repo:string,sha:string){
  commit.parse(sha);await this.assertRepository(repo);const pending=[""],seen=new Set<string>(),files:{path:string;sha:string;type:string;size?:number}[]=[];
  // ponytail: 10,000 total entries per traversal; use partitioned durable indexing beyond this ceiling.
  for(let cursor=0;cursor<pending.length;cursor++){
   const directory=pending[cursor],items=await this.paginate(this.prefix+"/src/"+sha+"/"+(directory?encodedPath(directory)+"/":"")+"?pagelen=100",entry);
   for(const e of items){
    const parent=e.path.split("/").slice(0,-1).join("/");
    if(parent!==directory||e.commit.hash!==sha||seen.has(e.path))throw new Error("Bitbucket source scope, revision or path mismatch");seen.add(e.path);
    if(seen.size>10000)throw new Error("Bitbucket source inventory exceeds coverage limit");
    if(e.type==="commit_directory")pending.push(e.path);else files.push({path:e.path,sha,type:"blob",size:e.size});
   }
  }
  return files;
 }
 async blob(repo:string,path:string,sha:string):Promise<SourceFile>{
  commit.parse(sha);await this.assertRepository(repo);const endpoint=this.prefix+"/src/"+sha+"/"+encodedPath(path),meta=await this.request(endpoint+"?format=meta",entry);
  if(meta.path!==path||meta.commit.hash!==sha||meta.type!=="commit_file"||meta.size===undefined)throw new Error("Bitbucket source metadata mismatch");
  if(meta.size>200000)return {path,sha,size:meta.size,content:""};
  if(meta.attributes?.some(a=>["binary","link","subrepository"].includes(a)))return {path,sha,size:meta.size,content:"\0"};
  let content:string;
  try{content=await this.read(endpoint,200000);}catch(error){if(error instanceof Error&&error.message.includes("not UTF-8"))return {path,sha,size:meta.size,content:"\0"};throw error;}
  if(Buffer.byteLength(content)!==meta.size)throw new Error("Bitbucket source size mismatch");return {path,sha,size:meta.size,content};
 }
 async archive(repo:string,sha:string):Promise<Uint8Array>{
  commit.parse(sha);
  const verify=async()=>{await this.assertRepository(repo);const native=await this.request(this.prefix+"/commit/"+sha,z.object({hash:commit}));if(native.hash!==sha)throw new Error("Bitbucket runtime commit identity mismatch");};
  await verify();
  // Traverse the unfiltered native tree; never reconstruct runtime source from review/index content.
  const inventory=await this.tree(repo,sha),files:{path:string;bytes:Uint8Array;executable:boolean}[]=[];let total=0;
  for(const item of inventory){
   const endpoint=this.prefix+"/src/"+sha+"/"+encodedPath(item.path);
   const meta=await this.request(endpoint+"?format=meta",entry.extend({size:z.number().int().nonnegative(),attributes:z.array(z.enum(["binary","link","subrepository","executable"]))}));
   if(meta.type!=="commit_file"||meta.path!==item.path||meta.commit.hash!==sha||item.size!==undefined&&meta.size!==item.size)throw new Error("Bitbucket runtime source metadata mismatch");
   if(meta.attributes.some(attribute=>attribute==="link"||attribute==="subrepository"))throw new Error("Bitbucket runtime source contains unsupported symlink or subrepository semantics");
   if(total+meta.size>20000000)throw new Error("Bitbucket runtime source exceeds 20 MB");
   const bytes=await this.raw(endpoint,Math.min(meta.size,20000000-total));
   if(bytes.length!==meta.size)throw new Error("Bitbucket runtime source size mismatch");
   total+=bytes.length;files.push({path:item.path,bytes,executable:meta.attributes.includes("executable")});
  }
  await verify();return runtimeTar(files);
 }
 async details(repo:string,number:number){
  id.parse(number);await this.assertRepository(repo);const pr=await this.request(this.prefix+"/pullrequests/"+number,prSchema);
  if(pr.id!==number||pr.destination.repository.uuid!==this.repositoryId||pr.destination.repository.workspace.uuid!==this.workspace)throw new Error("Bitbucket PR repository identity mismatch");return pr;
 }
 async comments(repo:string,number:number){await this.details(repo,number);return this.paginate(this.prefix+"/pullrequests/"+number+"/comments?pagelen=100",comment);}
 private publisher(){if(!this.publisherId)throw new Error("Verified Bitbucket Forge app publisher identity required");return this.publisherId;}
 private async guard(repo:string,number:number,sha:string,destination:string){
  const current=await this.details(repo,number);
  if(current.state!=="OPEN"||current.source.commit.hash!==sha||current.destination.commit.hash!==destination)throw new Error("Bitbucket revision changed or closed");
 }
 async publish(repo:string,number:number,sha:string,summary:string,findings:Finding[],marker:string,style="detailed",revisionKey?:string,unresolvedCount=findings.length){
  const publisher=this.publisher();commit.parse(sha);commit.parse(revisionKey);z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(marker);
  const destination=revisionKey!,pr=await this.pullRequest(repo,number),tail="<!-- openreview:"+marker+" -->\n<!-- openreview-revision:"+sha+":"+destination+" -->";
  await this.guard(repo,number,sha,destination);
  for(const f of findings)if(f.commitSha!==sha||!changedLines(pr.diff.find(d=>d.path===f.filePath)?.patch??"").has(f.startLine)||!Number.isSafeInteger(f.startLine)||!/^[a-f0-9]{16,64}$/.test(f.fingerprint))throw new Error("Bitbucket finding line or revision not in complete current diff");
  const notes=await this.comments(repo,number),prefix=this.prefix+"/pullrequests/"+number+"/comments",mapped:{id:number;fingerprint:string}[]=[];
  const authored=(c:z.infer<typeof comment>)=>c.user.uuid===publisher&&c.user.type==="app_user"&&!c.deleted&&!c.pending&&!c.parent;
  for(const f of findings){
   await this.guard(repo,number,sha,destination);
   const prior=notes.find(c=>authored(c)&&c.inline?.path===f.filePath&&c.inline.to===f.startLine&&c.inline.from==null&&findingFingerprint(c.content.raw)===f.fingerprint&&c.content.raw.trimEnd().endsWith(tail));
   if(prior){mapped.push({id:prior.id,fingerprint:f.fingerprint});continue;}
   let text=findingComment(f,style)+"\n\n[Reviewed revision]("+this.sourceUrl(repo,sha,f.filePath)+")";
   if(process.env.APP_URL){const url=new URL(process.env.APP_URL);if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw new Error("Invalid application origin");text+="\n\n[Fix with your agent]("+url.origin+"/fix/"+encodeURIComponent(marker)+"?finding="+f.fingerprint+")";}
   text+="\n\n"+tail;
   const result=await this.request(prefix,comment,{content:{raw:text},inline:{path:f.filePath,to:f.startLine}});
   if(!authored(result)||result.content.raw!==text||result.inline?.path!==f.filePath||result.inline.to!==f.startLine||result.inline.from!=null)throw new Error("Bitbucket published finding identity or anchor mismatch");
   mapped.push({id:result.id,fingerprint:f.fingerprint});await this.guard(repo,number,sha,destination);
  }
  await this.guard(repo,number,sha,destination);
  const prior=notes.find(c=>authored(c)&&!c.inline&&c.content.raw.trimEnd().endsWith(tail));if(prior)return {id:prior.id,reused:true,comments:mapped};
  const text="## OpenReview\n\n"+summary+reviewLinks(marker,unresolvedCount)+"\n\n**Reviewed revision:** [`"+sha.slice(0,7)+"`](https://bitbucket.org/"+repo.split("/").map(encodedPath).join("/")+"/commits/"+sha+")\n\n"+tail;
  const result=await this.request(prefix,comment,{content:{raw:text}});
  if(!authored(result)||result.inline||result.content.raw!==text)throw new Error("Bitbucket published summary identity mismatch");
  await this.guard(repo,number,sha,destination);return {id:result.id,reused:false,comments:mapped};
 }

 private decisions(pr:z.infer<typeof prSchema>){
  const rows=pr.participants??[];if(new Set(rows.map(p=>p.user.uuid)).size!==rows.length)throw new Error("Duplicate Bitbucket reviewer identity");
  return [...rows].sort((a,b)=>a.user.uuid.localeCompare(b.user.uuid));
 }
 private ingestionIdentity(pr:z.infer<typeof prSchema>){return JSON.stringify({state:pr.state,draft:pr.draft,queued:pr.queued,source:pr.source,destination:pr.destination,author:pr.author,participants:this.decisions(pr)});}
 private async approvalAuthority(repo:string,number:number){
  const pr=await this.details(repo,number),bot=this.publisher();
  if(!pr.participants||pr.queued===undefined||pr.draft===undefined)throw new Error("Bitbucket approval participant or queue coverage unavailable");
  this.decisions(pr);
  if(pr.participants.some(p=>p.user.uuid===bot&&p.user.type!=="app_user"))throw new Error("Bitbucket approval publisher type changed");
  return {pr,bot,prefix:this.prefix+"/pullrequests/"+number};
 }
 private async nativeApprovalChecks(prefix:string){
  const result=await this.request(prefix+"/mergeability/checks",z.object({values:z.array(mergeCheck).max(1000),size:z.number().int().nonnegative().optional()}).strict());
  if(result.size!==undefined&&result.size!==result.values.length)throw new Error("Bitbucket merge check coverage incomplete");
  const seen=new Set<string>();
  for(const c of result.values){
   const identity=c.type+(c.type==="standard_merge_check"?":"+z.string().min(1).parse(c.check?.kind):c.type.startsWith("custom_")?":"+z.string().min(1).parse(c.check?.id):"");
   if(seen.has(identity))throw new Error("Duplicate Bitbucket merge check identity");seen.add(identity);
  }
  for(const type of ["pullrequest_state_check","current_user_permission_check","git_mergeability_check"])if(!seen.has(type))throw new Error("Bitbucket native merge conditions unavailable");
  return result.values.filter(c=>c.required||c.blocking||["pullrequest_state_check","current_user_permission_check","git_mergeability_check"].includes(c.type)).map(c=>({name:"OpenReview / Bitbucket "+c.type+(c.type==="standard_merge_check"?" / "+c.check!.kind:c.type.startsWith("custom_")?" / "+c.check!.id:""),status:c.status==="PENDING"?"in_progress":"completed",conclusion:c.status==="PASSED"&&!c.blocking?"success":"failure"}));
 }
 async approvalSnapshot(repo:string,number:number,_extraChecks:{name:string;appId?:number}[]=[]):Promise<ScmApprovalSnapshot>{
  void _extraChecks;
  const pr=await this.pullRequest(repo,number),a=await this.approvalAuthority(repo,number);
  if(pr.head.sha!==a.pr.source.commit.hash||pr.revisionKey!==a.pr.destination.commit.hash)throw new Error("Bitbucket revision changed during approval verification");
  const [native,notes,statuses]=await Promise.all([this.nativeApprovalChecks(a.prefix),this.comments(repo,number),this.paginate(a.prefix+"/statuses?pagelen=100",z.object({key:z.string().min(1),name:z.string().optional(),state:z.enum(["SUCCESSFUL","FAILED","INPROGRESS","STOPPED"]),commit:z.object({hash:commit})}))]);
  if(statuses.some(s=>s.commit.hash!==pr.head.sha)||new Set(statuses.map(s=>s.key)).size!==statuses.length)throw new Error("Bitbucket status revision or identity mismatch");
  const checks=statuses.map(s=>({name:s.key,status:s.state==="INPROGRESS"?"in_progress":"completed",conclusion:s.state==="SUCCESSFUL"?"success":"failure"}));
  if(native.some(c=>checks.some(s=>s.name===c.name)))throw new Error("Bitbucket status collides with native approval gate");
  checks.push(...native);
  const active=this.decisions(a.pr).find(p=>p.user.uuid===a.bot&&p.state==="approved"&&p.user.type==="app_user");
  const reviews=notes.flatMap(n=>{const r=approvalReceipt(n.content.raw);if(!r||r.botId!==a.bot||n.user.uuid!==a.bot||n.user.type!=="app_user"||n.deleted||n.pending||n.parent||n.inline)return [];return [{id:n.id,body:n.content.raw,commit_id:r.head,state:active?.participated_on===r.approvedAt?"APPROVED":"DISMISSED",user:{login:"{"+a.bot+"}",type:"Bot"}}];});
  const current=await this.approvalAuthority(repo,number);if(this.ingestionIdentity(current.pr)!==this.ingestionIdentity(a.pr))throw new Error("Bitbucket revision or decisions changed during approval verification");
  return {pr,checks,nativeRequiredChecks:native.map(c=>({name:c.name})),humanChangeRequested:this.decisions(a.pr).some(p=>p.state==="changes_requested"&&p.user.type!=="app_user"),reviews,botLogin:"{"+a.bot+"}"};
 }
 private async withdraw(repo:string,number:number,approvedAt:string){
  const a=await this.approvalAuthority(repo,number),active=this.decisions(a.pr).find(p=>p.user.uuid===a.bot&&p.state==="approved");
  if(active?.participated_on!==approvedAt)return;
  await this.raw(a.prefix+"/approve",0,undefined,"DELETE");
  const current=await this.approvalAuthority(repo,number);if(this.decisions(current.pr).some(p=>p.user.uuid===a.bot&&p.state==="approved"&&p.participated_on===approvedAt))throw new Error("Bitbucket approval withdrawal was not confirmed");
 }
 async approve(repo:string,number:number,head:string,marker:string,botLogin:string,revisionKey?:string){
  commit.parse(head);commit.parse(revisionKey);if(!approvalMarker.test(marker))throw new Error("Invalid Bitbucket approval marker");
  const a=await this.approvalAuthority(repo,number);
  if(botLogin!=="{"+a.bot+"}")throw new Error("Bitbucket approval publisher changed");
  const guard=(pr:z.infer<typeof prSchema>)=>{if(pr.state!=="OPEN"||pr.draft||pr.queued||pr.source.commit.hash!==head||pr.destination.commit.hash!==revisionKey||pr.author.uuid===a.bot||JSON.stringify(pr.source)!==JSON.stringify(a.pr.source)||JSON.stringify(pr.destination)!==JSON.stringify(a.pr.destination)||JSON.stringify(pr.author)!==JSON.stringify(a.pr.author)||this.decisions(pr).some(p=>p.state==="changes_requested"&&p.user.type!=="app_user"))throw new Error("Bitbucket approval revision changed or human objection");};
  guard(a.pr);
  const notes=await this.comments(repo,number),own=notes.filter(n=>n.user.uuid===a.bot&&n.user.type==="app_user"&&!n.deleted&&!n.pending&&!n.parent&&!n.inline&&n.content.raw.endsWith(marker));
  if(own.length>1)throw new Error("Duplicate Bitbucket approval receipts");
  const active=this.decisions(a.pr).find(p=>p.user.uuid===a.bot&&p.state==="approved");
  if(own.length){const r=approvalReceipt(own[0].content.raw);if(!r||r.botId!==a.bot||r.head!==head||r.revisionKey!==revisionKey||r.approvedAt!==active?.participated_on)throw new Error("Bitbucket approval receipt or native timestamp changed");return {id:own[0].id,reused:true};}
  if(active)throw new Error("Bitbucket bot already approved without this receipt; inspect its native approval before retrying");
  if((await this.nativeApprovalChecks(a.prefix)).some(c=>c.conclusion!=="success"))throw new Error("Bitbucket native approval checks have not passed");
  guard((await this.approvalAuthority(repo,number)).pr);
  const result=await this.request(a.prefix+"/approve",participant,{});
  if(result.user.uuid!==a.bot||result.user.type!=="app_user"||result.state!=="approved"||!result.approved||!result.participated_on)throw new Error("Bitbucket native approval identity unavailable; inspect before retrying");
  const approvedAt=result.participated_on;
  try{
   const current=await this.approvalAuthority(repo,number);guard(current.pr);
   if(!this.decisions(current.pr).some(p=>p.user.uuid===a.bot&&p.state==="approved"&&p.participated_on===approvedAt))throw new Error("Bitbucket native approval was not confirmed");
   const body=approvalBody({head,revisionKey:revisionKey!,approvedAt,botId:a.bot},marker),n=await this.request(a.prefix+"/comments",comment,{content:{raw:body}});
   if(n.user.uuid!==a.bot||n.user.type!=="app_user"||n.deleted||n.pending||n.parent||n.inline||n.content.raw!==body)throw new Error("Bitbucket returned an unrelated approval receipt");
   guard((await this.approvalAuthority(repo,number)).pr);return {id:n.id,reused:false};
  }catch(error){await this.withdraw(repo,number,approvedAt);throw error;}
 }
 async dismissApproval(repo:string,number:number,noteId:string|number){
  id.parse(noteId);const a=await this.approvalAuthority(repo,number),n=await this.request(a.prefix+"/comments/"+noteId,comment),r=approvalReceipt(n.content.raw);
  if(!r||r.botId!==a.bot||n.user.uuid!==a.bot||n.user.type!=="app_user"||n.deleted||n.pending||n.parent||n.inline)throw new Error("Refusing to withdraw an unrelated Bitbucket approval");
  await this.withdraw(repo,number,r.approvedAt);
 }
 async canReply(repo:string,author:string){
  const parsed=uuid.safeParse(author);if(!parsed.success||parsed.data===this.publisherId)return false;await this.assertRepository(repo);
  const query=new URLSearchParams({pagelen:"100",q:'user.uuid="{'+parsed.data+'}"'});
  const permissions=await this.paginate("/2.0/workspaces/"+encodeURIComponent("{"+this.workspace+"}")+"/permissions/repositories/"+encodeURIComponent("{"+this.repositoryId+"}")+"?"+query,z.object({permission:z.enum(["none","read","write","admin"]),user:z.object({uuid,type:z.string(),account_status:z.string()}),repository:z.object({uuid})}));
  if(permissions.some(p=>p.repository.uuid!==this.repositoryId||p.user.uuid!==parsed.data)||permissions.length>1)throw new Error("Bitbucket effective permission identity mismatch");
  return permissions.some(p=>p.user.type==="user"&&p.user.account_status==="active"&&["write","admin"].includes(p.permission));
 }
 async followUp(repo:string,number:number,commentId:number,actor:string){
  const notes=await this.comments(repo,number),note=notes.find(c=>c.id===id.parse(commentId));
  if(!note)throw new Error("Bitbucket event comment not available yet");
  if(note.deleted||note.pending||note.user.type!=="user"||note.user.uuid!==uuid.parse(actor)||note.content.raw.length>16000||!/@openreview\b/i.test(note.content.raw))return null;
  let root=note;const seen=new Set<number>();
  while(root.parent){
   if(seen.has(root.id))throw new Error("Bitbucket comment thread cycle");seen.add(root.id);
   const parent=notes.find(c=>c.id===root.parent!.id&&!c.deleted&&!c.pending);if(!parent)throw new Error("Bitbucket comment parent unavailable");root=parent;
  }
  return {commentId:note.id,author:note.user.uuid,question:note.content.raw,inline:!!note.inline||!!note.parent,parentCommentId:root.id};
 }
 async reply(repo:string,number:number,body:string,parent?:string|number,marker?:string){
  const publisher=this.publisher();if(parent!==undefined)id.parse(parent);
  if(marker!==undefined)z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/).parse(marker);
  const pr=await this.details(repo,number),notes=await this.comments(repo,number);
  if(parent!==undefined&&!notes.some(c=>c.id===parent&&!c.deleted&&!c.pending))throw new Error("Bitbucket parent comment unavailable in this PR");
  const tag=marker?"<!-- openreview:"+marker+" -->":undefined;
  await this.guard(repo,number,pr.source.commit.hash,pr.destination.commit.hash);
  if(tag){const prior=notes.find(c=>c.user.uuid===publisher&&c.user.type==="app_user"&&!c.deleted&&!c.pending&&(c.parent?.id??undefined)===parent&&c.content.raw.trimEnd().endsWith(tag));if(prior)return {id:prior.id};body+="\n\n"+tag;}
  const result=await this.request(this.prefix+"/pullrequests/"+number+"/comments",comment,{content:{raw:body},...(parent===undefined?{}:{parent:{id:parent}})});
  if(result.user.uuid!==publisher||result.user.type!=="app_user"||result.deleted||result.pending||result.content.raw!==body||(result.parent?.id??undefined)!==parent)throw new Error("Bitbucket reply publisher or thread mismatch");
  await this.guard(repo,number,pr.source.commit.hash,pr.destination.commit.hash);return {id:result.id};
 }
 async changeMetadata(repo:string,number:number):Promise<ChangeMetadata>{
  await this.assertRepository(repo);const pr=await this.request(this.prefix+"/pullrequests/"+number,prSchema.omit({participants:true}));
  if(pr.id!==number||pr.destination.repository.uuid!==this.repositoryId||pr.destination.repository.workspace.uuid!==this.workspace)throw new Error("Bitbucket change identity mismatch");
  return changeMetadataSchema.parse({number:pr.id,title:pr.title,html_url:"https://bitbucket.org/"+repo+"/pull-requests/"+number,draft:pr.draft??false,state:pr.state==="OPEN"?"open":pr.state==="MERGED"?"merged":"closed",user:{login:"{"+pr.author.uuid+"}"},head:{sha:pr.source.commit.hash,ref:pr.source.branch.name},base:{sha:pr.destination.commit.hash,ref:pr.destination.branch.name},revisionKey:pr.destination.commit.hash});
 }
 async openChanges(repo:string,cursor:string|null):Promise<ChangePage>{
  await this.assertRepository(repo);const page=numberedPage(cursor),initial=this.url(this.prefix+`/pullrequests?state=OPEN&sort=created_on&pagelen=${catalogPageSize}&page=${page}`);
  const result=await this.request(initial.href,z.object({values:z.array(z.object({id})).max(catalogPageSize),next:z.string().url().optional()}));
  let next:string|null=null;
  if(result.next){const u=this.url(result.next);if(u.pathname!==initial.pathname||u.searchParams.get("state")!=="OPEN"||u.searchParams.get("sort")!=="created_on"||u.searchParams.get("pagelen")!==String(catalogPageSize)||[...u.searchParams.keys()].some(k=>!initial.searchParams.has(k)))throw new Error("Bitbucket catalog continuation changed scope");const n=numberedPage(u.searchParams.get("page"));if(n<=page)throw new Error("Bitbucket catalog cursor did not advance");next=String(n);}
  return validateChangePage({numbers:result.values.map(r=>r.id),next},cursor);
 }
 async pullRequest(repo:string,number:number):Promise<ScmChange>{
  const pr=await this.details(repo,number),spec=pr.source.commit.hash+".."+pr.destination.commit.hash,prPrefix=this.prefix+"/pullrequests/"+number;
  const path=z.object({path:filePath}).nullish();
  const [base,stats,raw,comments,commits,statuses]=await Promise.all([
   this.request(this.prefix+"/merge-base/"+spec,z.object({hash:commit})),
   this.paginate(this.prefix+"/diffstat/"+spec+"?topic=true&renames=true&pagelen=100",z.object({status:z.enum(["added","removed","modified","renamed"]),lines_added:z.number().int().nonnegative(),lines_removed:z.number().int().nonnegative(),old:path,new:path})),
   this.read(this.prefix+"/diff/"+spec+"?topic=true&renames=true&context=3"),
   this.paginate(prPrefix+"/comments?pagelen=100",comment),this.paginate(prPrefix+"/commits?pagelen=100",z.object({hash:commit})),
   this.paginate(prPrefix+"/statuses?pagelen=100",z.object({key:z.string(),name:z.string().optional(),state:z.string()}))
  ]);
  const diff=parseDiff(raw);if(diff.length!==stats.length||new Set(diff.map(f=>f.path)).size!==diff.length)throw new Error("Bitbucket diff coverage incomplete");
  for(const s of stats){
   const name=s.new?.path??s.old?.path,f=diff.find(f=>f.path===name);if(!f||f.previousPath!==(s.old&&s.new&&s.old.path!==s.new.path?s.old.path:undefined))throw new Error("Bitbucket diff path coverage mismatch");
   filePath.parse(f.path);let added=0,removed=0,old=0,next=0,inHunk=false;
   const complete=()=>{if(old!==0||next!==0)throw new Error("Bitbucket diff hunk coverage incomplete");};
   for(const line of f.patch.split("\n")){
    if(line.startsWith("@@")){complete();const h=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);if(!h)throw new Error("Malformed Bitbucket diff hunk");old=Number(h[2]??1);next=Number(h[4]??1);inHunk=true;}
    else if(inHunk&&line.startsWith("+")){added++;next--;}
    else if(inHunk&&line.startsWith("-")){removed++;old--;}
    else if(inHunk&&line.startsWith(" ")){old--;next--;}
    else if(line&& !line.startsWith("\\ No newline at end of file"))throw new Error("Unsupported Bitbucket diff content");
    if(old<0||next<0)throw new Error("Bitbucket diff hunk overflow");
   }
   complete();if(added!==s.lines_added||removed!==s.lines_removed)throw new Error("Bitbucket diff line coverage incomplete");f.status=s.status;
  }
  const current=await this.details(repo,number);
  if(this.ingestionIdentity(current)!==this.ingestionIdentity(pr))throw new Error("Bitbucket revision changed during ingestion");
  return {number:pr.id,title:pr.title,body:pr.description??null,draft:pr.draft??false,state:pr.state==="OPEN"?"open":"closed",html_url:"https://bitbucket.org/"+repo.split("/").map(encodedPath).join("/")+"/pull-requests/"+number,user:{login:"{"+pr.author.uuid+"}"},...(pr.author.type==="user"?{authorExternalId:pr.author.uuid}:{}),head:{sha:pr.source.commit.hash,ref:pr.source.branch.name},base:{sha:base.hash,ref:pr.destination.branch.name},revisionKey:pr.destination.commit.hash,diff,comments:comments.filter(c=>!c.deleted&&!c.pending).map(c=>({id:c.id,body:c.content.raw,path:c.inline?.path??"",line:c.inline?.to??null,user:{login:"{"+c.user.uuid+"}"}})),reviews:this.decisions(pr).filter(p=>p.state).map(p=>({id:p.user.uuid,body:null,commit_id:"",state:p.state==="approved"?"APPROVED":"CHANGES_REQUESTED"})),commits:commits.map(c=>({sha:c.hash})),checks:statuses.map(s=>({name:s.name??s.key,status:s.state==="INPROGRESS"?"in_progress":"completed",conclusion:s.state==="SUCCESSFUL"?"success":s.state==="FAILED"?"failure":s.state.toLowerCase()}))};
 }
}
