import {expect,test,vi} from "vitest";
import {convexTest} from "convex-test";
import {SignJWT} from "jose";
import {createHash} from "node:crypto";
import schema from "../convex/schema";
import {api,internal} from "../convex/_generated/api";
import {encryptCredential} from "../src/credentials";
import {p4SubmittedInventory} from "../src/p4-index";
const modules=import.meta.glob("../convex/**/*.ts");
const project={id:"payments",name:"Payments",branches:[{id:"main",name:"Main",paths:["//depot/main/..."]}]};
async function setup(){
 const t=convexTest(schema,modules),secret="p4-index-session-secret-at-least-32-characters";
 process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET="p4-index-service";process.env.CREDENTIAL_ENCRYPTION_KEY="a".repeat(64);process.env.SCM_ALLOWED_HOSTS="p4.example";
 const userId=await t.mutation(api.users.login,{secret:"p4-index-service",githubId:1,login:"alice",avatar:""});
 const token=await new SignJWT({}).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setSubject(userId).setExpirationTime("1h").sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:"P4 workspace"});
 const connectionId=await t.mutation(api.providerConnections.save,{token,secret:"p4-index-service",organizationId,kind:"perforce",instance:"https://p4.example",name:"P4",credentials:encryptCredential(JSON.stringify({username:"bot",ticket:"fixture-ticket"}),organizationId+":perforce"),webhookSecret:""});
 await t.mutation(internal.providerConnections.select,{token,connectionId,repositories:[{externalId:"payments",fullName:"payments",defaultBranch:"",group:{externalId:"payments",name:"Payments"}}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 const files=Array.from({length:21},(_,i)=>({path:`//depot/main/file${String(i).padStart(2,"0")}.ts`,content:`export const value${i} = ${i};\n`}));

 files[0].content="export function cents(price: number) { return price * 100; }\n";
 files[1].content="import { cents } from './file00';\nexport const charge = cents(2);\n";
 // Rebuild after setting the cross-file baseline rather than trusting a stale manifest.
 const shelfInventory=p4SubmittedInventory({project,serverId:"main",change:42,manifest:files.map(f=>({code:"stat",depotFile:f.path,headRev:3,headChange:40,headAction:"edit",headType:"text",fileSize:Buffer.byteLength(f.content),digest:createHash("md5").update(f.content).digest("hex")}))});
 const shelfSource=files[0].content.replace("price * 100","price / 100");
 let projectChanged=false,badDigest=false,sourceReads=0,shelfState="needsReview",shelfArchive=44,onShelfRead:(()=>Promise<void>)|undefined;
 const nativeReview={id:12,author:"alice",description:"Change currency calculation",updated:1,pending:true,projects:{payments:["main"]},versions:[{change:43,archiveChange:44,pending:true,time:1}]};
 vi.stubGlobal("fetch",async(input:unknown,init?:RequestInit)=>{
  const u=new URL(String(input));expect(u.origin).toBe("https://p4.example");expect(init?.redirect).toBe("error");expect(init?.method).not.toBe("POST");
  if(u.pathname==="/api/v9/session"){const basic=(init?.headers as Record<string,string>).authorization;return Response.json({isValid:true,user:{User:Buffer.from(basic.slice(6),"base64").toString().split(":")[0]}});}
  if(u.pathname==="/api/v9/projects")return Response.json({projects:[project]});
  if(u.pathname==="/api/v9/projects/payments")return Response.json({project:projectChanged?{...project,branches:[{...project.branches[0],paths:["//other/..."]}]}:project});
  if(u.pathname==="/api/v11/reviews/12")return Response.json({error:null,data:{reviews:[{...nativeReview,state:shelfState,versions:[{...nativeReview.versions[0],archiveChange:shelfArchive}]}]}});
  if(u.pathname==="/api/v11/reviews/12/files")return Response.json({error:null,data:{limited:false,files:[{depotFile:files[0].path,action:"edit",type:"text",rev:3,fileSize:Buffer.byteLength(shelfSource),digest:createHash("md5").update(shelfSource).digest("hex")}]}});
  if(u.pathname.endsWith("/diff")){expect(u.searchParams.get("from")).toBe("#3");expect(u.searchParams.get("to")).toBe("@="+shelfArchive);return Response.json({error:null,data:{isCut:false,isSame:false,header:`--- a/${files[0].path}#3\n+++ b/${files[0].path}@=${shelfArchive}\n`,diffs:[`@@ -1 +1 @@\n-${files[0].content.trimEnd()}\n+${shelfSource.trimEnd()}\n`],paging:{diffs:1,offset:null}}});}
  if(u.pathname.startsWith("/api/v11/files/")){const path=Buffer.from(u.pathname.split("/").at(-1)!,"base64url").toString();const revision=u.searchParams.get("fileRevision");expect(["#3","@="+shelfArchive]).toContain(revision);return Response.json({error:null,data:{filename:path,fileRevision:revision,contentLink:"https://p4.example/view/"+path.slice(2)+(revision==="@="+shelfArchive?"?shelf=44":"")}});}
  if(u.pathname.startsWith("/view/")){sourceReads++;if(u.searchParams.has("shelf")){await onShelfRead?.();return new Response(shelfSource);}return new Response(badDigest?"corrupted source":files.find(f=>"/view/"+f.path.slice(2)===u.pathname)!.content);}
  throw new Error("Unexpected P4 index endpoint");
 });
 const args={token,organizationId,repositoryId:repo._id,instance:"https://p4.example",inventory:JSON.stringify(shelfInventory)};
 return {t,args,userId,connectionId,repo,inventory:shelfInventory,files,setShelfState:(state:string)=>{shelfState=state;},setShelfArchive:(change:number)=>{shelfArchive=change;},setOnShelfRead:(callback:(()=>Promise<void>)|undefined)=>{onShelfRead=callback;},setProjectChanged:(v:boolean)=>{projectChanged=v;},setBadDigest:(v:boolean)=>{badDigest=v;},reads:()=>sourceReads};
}

test("hosted manual P4 index persists verified context across batches and durable recovery while automatic reviews stay disabled",async()=>{
 vi.useFakeTimers();try{
 const {t,args,repo,reads}=await setup();
 await t.mutation(api.onboarding.select,{token:args.token,organizationId:args.organizationId,repositoryIds:[repo._id]});
 expect((await t.query(api.onboarding.status,{token:args.token,organizationId:args.organizationId})).step).toBe(4);
 const {defaults}=await import("../src/review-settings");
 await t.run(ctx=>ctx.db.insert("scopeSettings",{organizationId:args.organizationId,settings:defaults,overrideKeys:[]}));
 expect((await t.query(api.onboarding.status,{token:args.token,organizationId:args.organizationId})).step).toBe(5);
 await expect(t.mutation(api.onboarding.start,{token:args.token,organizationId:args.organizationId})).rejects.toThrow("native Perforce indexing");
 expect((await t.run(ctx=>ctx.db.get(repo._id)))?.enabled).toBe(false);
 const result=await t.action(api.p4IndexJobs.upload,args);expect(result.total).toBe(21);
 await expect(t.action(api.p4IndexJobs.upload,args)).rejects.toThrow("already running");
 await t.action(internal.jobs.indexBatch,{jobId:result.jobId});
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({status:"running",cursor:20,processed:20});
 expect(reads()).toBe(20);
 await t.run(ctx=>ctx.db.patch(result.jobId,{updatedAt:Date.now()-16*60000}));
 await t.mutation(internal.recovery.sweep,{});
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({status:"completed",processed:21,attempts:2});
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({enabled:false,indexStatus:"ready",indexedSha:result.revision});
 const sources=await t.run(ctx=>ctx.db.query("repositoryFiles").collect());expect(sources).toHaveLength(21);
 expect(sources.every(f=>f.path.startsWith("depot/main/")&&f.sha.startsWith("p4:main:3:"))).toBe(true);
 expect((await t.run(ctx=>ctx.db.query("symbols").collect())).length).toBe(21);
 expect(await t.run(async ctx=>(await ctx.storage.get(sources[0].storageId))?.size)).toBeGreaterThan(0);
 await expect(t.mutation(api.repositories.configure,{token:args.token,repositoryId:repo._id,enabled:true})).rejects.toThrow("automatic reviews");
 const ready=await t.query(api.onboarding.status,{token:args.token,organizationId:args.organizationId});
 expect(ready.step).toBe(6);expect(ready.repositories[0]).toMatchObject({nativeIndex:true,ready:true,setupError:null,enabled:false});
 const job=await t.run(ctx=>ctx.db.get(result.jobId));
 await t.run(ctx=>ctx.db.patch(result.jobId,{manifestStorageId:undefined}));
 expect((await t.query(api.onboarding.status,{token:args.token,organizationId:args.organizationId})).step).toBe(5);
 await t.run(ctx=>ctx.db.patch(result.jobId,{manifestStorageId:job!.manifestStorageId}));
 await t.run(ctx=>ctx.db.patch(repo.connectionId!,{credentials:"rotated-credential"}));
 expect((await t.query(api.onboarding.status,{token:args.token,organizationId:args.organizationId})).step).toBe(5);
 await t.run(ctx=>ctx.db.patch(repo.connectionId!,{suspended:true}));
 expect((await t.query(api.onboarding.status,{token:args.token,organizationId:args.organizationId})).step).toBe(2);
 await expect(t.mutation(api.onboarding.select,{token:args.token,organizationId:args.organizationId,repositoryIds:[repo._id]})).rejects.toThrow("suspended");
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("P4 uploads enforce workspace/admin/native project scope; in-flight writes stop on credential and membership revocation",async()=>{
 vi.useFakeTimers();try{
 const {t,args,connectionId,userId,setProjectChanged}=await setup();
 const other=await t.mutation(api.users.createOrganization,{token:args.token,name:"Other"});
 await expect(t.action(api.p4IndexJobs.upload,{...args,organizationId:other})).rejects.toThrow("API key workspace");
 await expect(t.action(api.p4IndexJobs.upload,{...args,instance:"https://other.example"})).rejects.toThrow("another connection");
 const member=await t.run(ctx=>ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",args.organizationId).eq("userId",userId)).unique());
 await t.run(ctx=>ctx.db.patch(member!._id,{role:"viewer"}));await expect(t.action(api.p4IndexJobs.upload,args)).rejects.toThrow("Forbidden");
 await t.run(ctx=>ctx.db.patch(member!._id,{role:"owner"}));
 setProjectChanged(true);await expect(t.action(api.p4IndexJobs.upload,args)).rejects.toThrow("views changed");setProjectChanged(false);
 const result=await t.action(api.p4IndexJobs.upload,args);
 await t.run(ctx=>ctx.db.patch(connectionId,{credentials:"changed-encrypted-credential"}));
 expect(await t.query(internal.repositories.indexAllowed,{jobId:result.jobId})).toBe(false);
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({status:"cancelled"});
 expect(await t.run(ctx=>ctx.db.query("repositoryFiles").collect())).toHaveLength(0);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("P4 digest failures retry visibly; membership loss cancels recovery and completion cannot claim ready",async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId,setBadDigest}=await setup();
 const result=await t.action(api.p4IndexJobs.upload,args);setBadDigest(true);
 await expect(t.action(internal.jobs.indexBatch,{jobId:result.jobId})).rejects.toThrow("digest changed");
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({status:"running",attempts:2,error:expect.stringContaining("digest changed")});
 expect(await t.run(ctx=>ctx.db.get(args.repositoryId))).toMatchObject({indexStatus:"indexing",error:expect.stringContaining("Retrying")});
 const member=await t.run(ctx=>ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",args.organizationId).eq("userId",userId)).unique());
 await t.run(ctx=>ctx.db.delete(member!._id));
 expect(await t.query(internal.repositories.indexAllowed,{jobId:result.jobId})).toBe(false);
 expect(await t.mutation(internal.repositories.finishIndex,{jobId:result.jobId,repositoryId:args.repositoryId,sha:result.revision,paths:[]})).toBe(false);
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({status:"cancelled"});
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("expired index leases can recover once and stale batches cannot advance or finish the replacement",async()=>{
 vi.useFakeTimers();try{
 const {t,args}=await setup(),result=await t.action(api.p4IndexJobs.upload,args);
 expect(await t.mutation(internal.repositories.claimIndexBatch,{jobId:result.jobId,leaseId:"first"})).not.toBeNull();
 expect(await t.mutation(internal.repositories.claimIndexBatch,{jobId:result.jobId,leaseId:"duplicate"})).toBeNull();
 await t.run(ctx=>ctx.db.patch(result.jobId,{batchLease:{id:"first",expiresAt:Date.now()-1}}));
 expect(await t.mutation(internal.repositories.claimIndexBatch,{jobId:result.jobId,leaseId:"replacement"})).not.toBeNull();
 await t.mutation(internal.repositories.indexProgress,{jobId:result.jobId,cursor:20,leaseId:"first"});
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({cursor:0,batchLease:{id:"replacement"}});
 expect(await t.mutation(internal.repositories.finishIndex,{repositoryId:args.repositoryId,jobId:result.jobId,sha:result.revision,paths:[],leaseId:"first"})).toBe(false);
 const storageId=await t.run(ctx=>ctx.storage.store(new Blob(["untrusted stale source"])));
 await t.mutation(internal.repositories.indexedFile,{repositoryId:args.repositoryId,jobId:result.jobId,path:"depot/main/stale.ts",sha:"stale",storageId,chunks:[],symbols:[],relationships:[],leaseId:"first"});
 expect(await t.run(ctx=>ctx.db.query("repositoryFiles").collect())).toHaveLength(0);
 expect(await t.run(async ctx=>(await ctx.storage.get(storageId))===null)).toBe(true);
 await t.run(ctx=>ctx.db.patch(result.jobId,{batchLease:undefined}));await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.run(ctx=>ctx.db.get(result.jobId))).toMatchObject({status:"completed"});
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("hosted shelf preparation uses the completed native index and unchanged cross-file context at the pinned archived revision",async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId,files}=await setup(),indexed=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const job=await t.run(ctx=>ctx.db.get(indexed.jobId));expect(await t.run(async ctx=>(await ctx.storage.get(job!.manifestStorageId!))!==null)).toBe(true);
 const prepared=await t.action(internal.p4ShelfJobs.prepare,{repositoryId:args.repositoryId,requestedBy:userId,reviewId:12});
 expect(prepared).toMatchObject({baselineJobId:indexed.jobId,baseRevision:indexed.revision,version:1,change:44});expect(prepared.revision).toMatch(/^p4:12:1:44:/);
 const artifact=JSON.parse((await t.run(async ctx=>(await ctx.storage.get(prepared.storageId))!.text())));
 expect(artifact.input.files).toHaveLength(21);
 expect(artifact.input.files.find((f:{path:string})=>f.path===files[0].path.slice(2)).content).toContain("price / 100");
 expect(artifact.input.files.find((f:{path:string})=>f.path===files[1].path.slice(2)).content).toBe(files[1].content);
 expect(artifact.input.files.find((f:{path:string})=>f.path===files[1].path.slice(2)).sha).toMatch(/^p4:main:3:/);
 expect(artifact.baseRevisions).toEqual({[files[0].path]:3});expect(artifact.input.diff[0].path).toBe(files[0].path.slice(2));
 expect(artifact.input.baseSha).toBe(indexed.revision);expect(artifact.input.headSha).toBe(prepared.revision);expect(artifact.input.coverageLimits.join("\n")).toContain("hidden inventory cannot be measured");
 await expect(t.action(internal.p4ShelfJobs.prepare,{repositoryId:args.repositoryId,requestedBy:userId,reviewId:12,revision:"obsolete"})).rejects.toThrow("requested revision");
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("hosted shelf preparation rejects stale baselines, changed credentials/permissions/views, wrong source identity and native closure",async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId,files,setShelfState,setProjectChanged,setOnShelfRead}=await setup();
 await expect(t.action(internal.p4ShelfJobs.prepare,{repositoryId:args.repositoryId,requestedBy:userId,reviewId:12})).rejects.toThrow("indexing must complete");
 const indexed=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const prepare={repositoryId:args.repositoryId,requestedBy:userId,reviewId:12,baselineJobId:indexed.jobId};
 setShelfState("approved");await expect(t.action(internal.p4ShelfJobs.prepare,prepare)).rejects.toThrow("open archived");setShelfState("needsReview");
 setProjectChanged(true);await expect(t.action(internal.p4ShelfJobs.prepare,prepare)).rejects.toThrow("views changed");setProjectChanged(false);
 const [file]=await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",args.repositoryId).eq("path",files[0].path.slice(2))).collect());
 await t.run(ctx=>ctx.db.patch(file._id,{sha:"wrong"}));await expect(t.action(internal.p4ShelfJobs.prepare,prepare)).rejects.toThrow("source identity");await t.run(ctx=>ctx.db.patch(file._id,{sha:file.sha}));
 setOnShelfRead(async()=>{await t.run(ctx=>ctx.db.patch(args.repositoryId,{indexStatus:"indexing"}));});
 await expect(t.action(internal.p4ShelfJobs.prepare,prepare)).rejects.toThrow("indexing must complete");setOnShelfRead(undefined);await t.run(ctx=>ctx.db.patch(args.repositoryId,{indexStatus:"ready"}));
 const member=await t.run(ctx=>ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",args.organizationId).eq("userId",userId)).unique());
 setOnShelfRead(async()=>{await t.run(ctx=>ctx.db.patch(member!._id,{role:"viewer"}));});await expect(t.action(internal.p4ShelfJobs.prepare,prepare)).rejects.toThrow("Forbidden");
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("hosted P4 review queues the pinned native shelf, reviews unchanged callers, and passes native publication context",async()=>{
 vi.useFakeTimers();
 const {P4CodeReview}=await import('../src/perforce');const {HttpModel}=await import('../src/engine/model');
 const generate=vi.spyOn(HttpModel.prototype,'generate').mockImplementation(async(request,validator)=>{
  expect(JSON.stringify([request.context,request.input])).toContain('export const charge = cents(2)');
  const finding={title:'Currency scale is inverted',description:'The cents helper now divides the price while its unchanged billing caller requires multiplication.',severity:'high',confidence:1,category:'correctness',filePath:'depot/main/file00.ts',startLine:1,endLine:1,evidence:[{filePath:'depot/main/file00.ts',startLine:1,quote:'export function cents(price: number) { return price / 100; }'},{filePath:'depot/main/file01.ts',startLine:2,quote:'export const charge = cents(2);'}],impact:'Billing receives an amount ten thousand times smaller than expected.',suggestedFix:'Multiply the price by 100.',symbol:'cents'};
  const value=request.task==='review:correctness'?{findings:[finding]}:request.task.startsWith('review:')?{findings:[]}:request.task==='verify'?{decisions:[{index:0,publish:true,confidence:1,reason:'Pinned shelf and unchanged caller demonstrate a scale regression.'}]}:{summary:'Changes currency arithmetic and introduces an integer cents contract regression.',reviewScore:{value:1,reason:'The verified billing regression requires correction before this change is ready.'}};
  return {value:validator.parse(value),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,estimatedCost:0,latencyMs:0,cached:false}};
 });
 vi.stubEnv('APP_URL','https://openreview.example');
 const publish=vi.spyOn(P4CodeReview.prototype,'publish').mockImplementation(async(_snapshot,_summary,findings,_bases,_run,_style,authorize)=>{await authorize?.();return {id:501,reused:false,comments:findings.map(f=>({id:502,fingerprint:f.fingerprint}))};});
 try{
  const {t,args,setShelfArchive,setShelfState}=await setup();const index=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
  const request={token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12};
  const reviewId=await t.action(api.p4ReviewJobs.request,request);
  const queued=await t.run(ctx=>ctx.db.get(reviewId));expect(queued).toMatchObject({status:'queued',baseSha:index.revision});expect(queued!.headSha).toMatch(/^p4:12:1:44:/);expect(queued!.nativeP4!.baselineJobId).toBe(index.jobId);
  expect(await t.action(api.p4ReviewJobs.request,request)).toBe(reviewId);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const detail=await t.query(api.reviews.detail,{token:args.token,reviewId});expect(detail.review).toMatchObject({status:'completed',githubReviewId:501,findingCount:1});expect(detail.findings[0].commitSha).toBe(queued!.headSha);expect(detail.review.summary).toContain('Not executed by OpenReview');expect(detail.canFix).toBe(true);
  expect(publish).toHaveBeenCalledTimes(1);const [snapshot,summary,findings,bases]=publish.mock.calls[0];expect(snapshot.revision).toBe(queued!.headSha);expect(summary).toContain('View review / Re-review');expect(summary).toContain('Fix All');expect(findings[0].filePath).toBe('//depot/main/file00.ts');expect(bases['//depot/main/file00.ts']).toBe(3);expect(detail.modelCalls.length).toBeGreaterThan(0);expect(await t.run(ctx=>ctx.db.query("reviewComments").withIndex("by_review",q=>q.eq("reviewId",reviewId)).collect())).toEqual(expect.arrayContaining([expect.objectContaining({githubId:502,fingerprint:detail.findings[0].fingerprint})]));
  const hash='f'.repeat(64),code='e'.repeat(12);
  await t.mutation(api.bridge.startPair,{secret:'p4-index-service',hash,code,name:'Native fix contract'});
  await t.mutation(api.bridge.approvePair,{token:args.token,organizationId:args.organizationId,code});
  const requestId=await t.mutation(api.bridge.createFix,{token:args.token,reviewId,agent:'codex'});
  const task=await t.action(api.bridgeJobs.claim,{secret:'p4-index-service',hash,requestId});
  expect(task.headSha).toBe(queued!.headSha);expect(task.native).toMatchObject({instance:'https://p4.example',project:'payments',serverId:'main'});expect(task.native!.files).toHaveLength(21);expect(task.native!.files.find(f=>f.depotFile==='//depot/main/file00.ts')).toMatchObject({haveRevision:3,revision:'@=44'});expect(task.prompt).toContain('Do not submit a changelist');
  await expect(t.action(api.bridgeJobs.claim,{secret:'p4-index-service',hash,requestId})).rejects.toThrow('replayed');
  await t.mutation(api.bridge.report,{secret:'p4-index-service',hash,requestId,status:'launched'});expect((await t.query(api.reviews.detail,{token:args.token,reviewId})).findings[0].currentStatus).toBe('open');
  const stale=await t.mutation(api.bridge.createFix,{token:args.token,reviewId,agent:'claude'});setShelfArchive(45);
  await expect(t.action(api.bridgeJobs.claim,{secret:'p4-index-service',hash,requestId:stale})).rejects.toThrow('shelf or project views changed');expect((await t.query(api.bridge.status,{token:args.token,requestId:stale})).status).toBe('failed');setShelfArchive(44);
  const closed=await t.mutation(api.bridge.createFix,{token:args.token,reviewId,agent:'cursor'});setShelfState('approved');await expect(t.action(api.bridgeJobs.claim,{secret:'p4-index-service',hash,requestId:closed})).rejects.toThrow('shelf or project views changed');setShelfState('needsReview');
  const revoked=await t.mutation(api.bridge.createFix,{token:args.token,reviewId,agent:'codex'});
  const m=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org',q=>q.eq('organizationId',args.organizationId)).first());await t.run(ctx=>ctx.db.patch(m!._id,{role:'viewer'}));
  await expect(t.action(api.bridgeJobs.claim,{secret:'p4-index-service',hash,requestId:revoked})).rejects.toThrow('write access revoked');await expect(t.mutation(api.bridge.createFix,{token:args.token,reviewId,agent:'codex'})).rejects.toThrow();await t.run(ctx=>ctx.db.patch(m!._id,{role:m!.role}));
  await expect(t.mutation(api.p4Reviews.retryPublication,{token:args.token,reviewId})).rejects.toThrow('No failed saved');
  await t.run(ctx=>ctx.db.patch(reviewId,{status:'failed',attempts:3,error:'Lost publication response'}));
  const membership=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org',q=>q.eq('organizationId',args.organizationId)).first());
  await t.run(ctx=>ctx.db.patch(membership!._id,{role:'viewer'}));
  await expect(t.mutation(api.p4Reviews.retryPublication,{token:args.token,reviewId})).rejects.toThrow('Forbidden');
  await t.run(ctx=>ctx.db.patch(membership!._id,{role:membership!.role}));
  await t.run(ctx=>ctx.db.patch(args.repositoryId,{indexStatus:'indexing'}));
  await expect(t.mutation(api.p4Reviews.retryPublication,{token:args.token,reviewId})).rejects.toThrow('indexing must complete');
  await t.run(ctx=>ctx.db.patch(args.repositoryId,{indexStatus:'ready'}));
  const calls=generate.mock.calls.length;
  expect(await t.mutation(api.p4Reviews.retryPublication,{token:args.token,reviewId})).toBe(reviewId);
  await expect(t.mutation(api.p4Reviews.retryPublication,{token:args.token,reviewId})).rejects.toThrow('No failed saved');
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(generate.mock.calls.length).toBe(calls);expect(publish).toHaveBeenCalledTimes(2);
  expect((await t.query(api.reviews.detail,{token:args.token,reviewId})).review.status).toBe('completed');
 }finally{generate.mockRestore();publish.mockRestore();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();}
});

test("P4 queued dispatch rejects a changed shelf or revoked requester before model calls and stops retries",async()=>{
 vi.useFakeTimers();const {P4CodeReview}=await import('../src/perforce');const {HttpModel}=await import('../src/engine/model');
 const generate=vi.spyOn(HttpModel.prototype,'generate'),publish=vi.spyOn(P4CodeReview.prototype,'publish');
 try{
  for(const mode of ['revision','membership']){
   const {t,args,userId,setShelfArchive}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
   const id=await t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12});
   if(mode==='revision')setShelfArchive(45);else await t.run(async ctx=>{const member=await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',args.organizationId).eq('userId',userId)).unique();await ctx.db.delete(member!._id);});
   await t.finishAllScheduledFunctions(vi.runAllTimers);
   const review=await t.run(ctx=>ctx.db.get(id));expect(review).toMatchObject(mode==='revision'?{status:'cancelled',attempts:1}:{status:'failed',attempts:3});expect(review!.retryScheduledId).toBeUndefined();expect(review!.resultStorageId).toBeUndefined();
  }
  expect(generate).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
 }finally{generate.mockRestore();publish.mockRestore();vi.unstubAllGlobals();vi.useRealTimers();}
});

test("P4 worker leases serialize publishers and reject stale completion after replacement",async()=>{
 vi.useFakeTimers();try{
  const {t,args}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
  const reviewId=await t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12});
  expect(await t.mutation(internal.p4Reviews.claim,{reviewId,leaseId:'first'})).toBe(true);
  expect(await t.mutation(internal.p4Reviews.claim,{reviewId,leaseId:'overlap'})).toBe(false);
  await t.run(async ctx=>{const r=await ctx.db.get(reviewId);await ctx.db.patch(reviewId,{status:'queued',nativeP4:{...r!.nativeP4!,lease:{id:'first',expiresAt:Date.now()-1}}});});
  expect(await t.mutation(internal.p4Reviews.claim,{reviewId,leaseId:'replacement'})).toBe(true);
  await expect(t.query(internal.p4Reviews.data,{reviewId,leaseId:'first'})).rejects.toThrow('lease expired or replaced');
  expect(await t.mutation(internal.p4Reviews.finish,{reviewId,leaseId:'first',error:'old worker'})).toBe(false);
  await expect(t.mutation(internal.reviews.stage,{reviewId,status:'publishing',workerLease:'first'})).rejects.toThrow('lease expired or replaced');
  expect((await t.run(ctx=>ctx.db.get(reviewId)))!.nativeP4!.lease!.id).toBe('replacement');
  await t.mutation(api.reviews.cancel,{token:args.token,reviewId});await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('durable P4 polling reaches older updated shelves, deduplicates revisions and exposes a complete inventory cycle',async()=>{
 vi.useFakeTimers();try{
 const {t,args,setShelfArchive}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const nativeFetch=globalThis.fetch;
 vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{
  const u=new URL(String(input));
  if(u.pathname==='/api/v11/reviews'){
   const after=u.searchParams.get('after');const id=after===null?13:after==='13'?12:null;
   return Response.json({error:null,data:{reviews:id?[{id,author:'alice',description:'Poll fixture',updated:1,pending:id===12,state:id===12?'needsReview':'archived',projects:{payments:['main']}}]:[],lastSeen:id,totalCount:2}});
  }
  if(u.pathname==='/api/v11/reviews/13')return Response.json({error:null,data:{reviews:[{id:13,author:'alice',description:'Closed fixture',updated:1,pending:false,state:'archived',projects:{payments:['main']},versions:[{change:42,pending:false,time:1}]}]}});
  return nativeFetch(input as RequestInfo,init);
 });
 expect(await t.query(api.p4Polling.list,{token:args.token,organizationId:args.organizationId})).toEqual([]);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});
 const poll=await t.run(ctx=>ctx.db.query('p4Polls').unique()),step={id:poll!._id,generation:poll!.generation};
 const advance=()=>t.action(internal.p4PollJobs.step,step);
 await advance();expect(await t.run(ctx=>ctx.db.get(step.id))).toMatchObject({pending:[13],position:0,cursor:13});
 await advance();await advance();expect(await t.run(ctx=>ctx.db.get(step.id))).toMatchObject({pending:[12],position:0,cursor:12});
 await advance();const first=await t.run(ctx=>ctx.db.query('reviews').unique());expect(first).toMatchObject({prNumber:12,status:'queued',nativeP4:{polling:step}});expect(first!.headSha).toMatch(/^p4:12:1:44:/);
 await t.run(ctx=>ctx.db.patch(first!._id,{status:'completed'})); // This contract exercises polling, not model accuracy/publication.
 await advance();expect(await t.run(ctx=>ctx.db.get(step.id))).toMatchObject({status:'waiting',lastCompleteAt:expect.any(Number),scanned:2,pending:[]});
 for(let i=0;i<5;i++)await advance();expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(1);
 setShelfArchive(45);for(let i=0;i<5;i++)await advance();const rows=await t.run(ctx=>ctx.db.query('reviews').collect());expect(rows).toHaveLength(2);expect(rows[1].headSha).toMatch(/^p4:12:1:45:/);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});expect(await t.run(ctx=>ctx.db.get(rows[1]._id))).toMatchObject({status:'cancelled'});
 await expect(t.query(internal.p4Polling.data,{...step,leaseId:'expired'})).rejects.toThrow('stopped');
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 polling leases recover durably; replaced workers and revoked administrators cannot enqueue or advance',async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});
 const poll=await t.run(ctx=>ctx.db.query('p4Polls').unique()),identity={id:poll!._id,generation:poll!.generation},worker={...identity,leaseId:'first'};
 expect(await t.mutation(internal.p4Polling.claim,worker)).toBe(true);expect(await t.mutation(internal.p4Polling.claim,{...identity,leaseId:'overlap'})).toBe(false);
 await t.mutation(internal.p4Polling.recover,{});expect((await t.run(ctx=>ctx.db.get(identity.id)))!.scheduledId).toBeUndefined();
 await t.run(ctx=>ctx.db.patch(identity.id,{lease:{id:'first',expiresAt:Date.now()-1}}));await t.mutation(internal.p4Polling.recover,{});
 const recovered=await t.run(ctx=>ctx.db.get(identity.id));expect(recovered!.scheduledId).toBeDefined();await t.mutation(internal.p4Polling.recover,{});expect((await t.run(ctx=>ctx.db.get(identity.id)))!.scheduledId).toBe(recovered!.scheduledId);
 const replacement={...identity,leaseId:'replacement'};expect(await t.mutation(internal.p4Polling.claim,replacement)).toBe(true);expect(await t.mutation(internal.p4Polling.progress,{...worker,page:{ids:[12],cursor:12}})).toBe(false);
 const member=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',args.organizationId).eq('userId',userId)).unique());await t.run(ctx=>ctx.db.patch(member!._id,{role:'viewer'}));
 await expect(t.query(internal.p4Polling.data,replacement)).rejects.toThrow('Forbidden');await expect(t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true})).rejects.toThrow('Forbidden');
 await t.mutation(internal.p4Polling.progress,{...replacement,error:'Forbidden'});
 for(let i=0;i<2;i++)await t.action(internal.p4PollJobs.step,identity);
 expect(await t.run(ctx=>ctx.db.get(identity.id))).toMatchObject({status:'failed',attempts:3,error:'Forbidden'});expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(0);
 await t.mutation(internal.p4Polling.recover,{});expect((await t.run(ctx=>ctx.db.get(identity.id)))!.scheduledId).toBeUndefined();
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 polling enforces baseline, generation, native branch and automatic settings',async()=>{
 vi.useFakeTimers();try{
 const {t,args,connectionId}=await setup();
 await expect(t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true})).rejects.toThrow('indexing must complete');
 const index=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});
 const original=await t.run(ctx=>ctx.db.query('p4Polls').unique()),first={id:original!._id,generation:original!.generation,leaseId:'first'};await t.mutation(internal.p4Polling.claim,first);
 const prepared=await t.action(internal.p4ShelfJobs.prepare,{repositoryId:args.repositoryId,requestedBy:original!.requestedBy,reviewId:12});
 const enqueue={repositoryId:args.repositoryId,requestedBy:original!.requestedBy,nativeNumber:12,revision:prepared.revision,baseRevision:index.revision,baselineJobId:index.jobId,inputStorageId:prepared.storageId,connectionId,credentialDigest:original!.credentialDigest,polling:{id:first.id,generation:first.generation},pollLease:first.leaseId,branches:['main']};
 const {defaults}=await import('../src/review-settings');
 await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults,targetBranches:['release*']}});
 await expect(t.mutation(internal.p4Reviews.enqueue,enqueue)).rejects.toThrow('policy');
 await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults,automatic:false}});
 await expect(t.mutation(internal.p4Reviews.enqueue,enqueue)).rejects.toThrow('policy');
 await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults}});
 const automatic=await t.mutation(internal.p4Reviews.enqueue,enqueue);
 await t.mutation(internal.p4Reviews.claim,{reviewId:automatic,leaseId:'automatic-worker'});
 await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults,automatic:false}});
 await expect(t.query(internal.p4Reviews.data,{reviewId:automatic,leaseId:'automatic-worker'})).rejects.toThrow('policy changed');
 const resultBlob=await t.run(ctx=>ctx.storage.store(new Blob(['{}'])));
 await expect(t.mutation(internal.reviews.save,{reviewId:automatic,workerLease:'automatic-worker',storageId:resultBlob,summary:'Fixture',findings:[],resolved:[],usage:[]})).rejects.toThrow('policy changed');
 await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults}});
 const manual=await t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12,force:true});
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});
 expect(await t.run(ctx=>ctx.db.get(automatic))).toMatchObject({status:'cancelled'});expect(await t.run(ctx=>ctx.db.get(manual))).toMatchObject({status:'queued'});
 expect(await t.mutation(internal.p4Polling.progress,{...first,page:{ids:[12],cursor:12}})).toBe(false);
 await t.run(ctx=>ctx.db.patch(connectionId,{credentials:'replaced'}));const current=await t.run(ctx=>ctx.db.get(first.id));const second={id:first.id,generation:current!.generation,leaseId:'second'};await t.mutation(internal.p4Polling.claim,second);await expect(t.query(internal.p4Polling.data,second)).rejects.toThrow('baseline is stale');
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});
 await t.run(ctx=>ctx.db.patch(manual,{status:'cancelled'}));await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('completed P4 submitted refresh atomically adopts enabled polling, revokes stale workers and never enables disabled polling',async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId,inventory}=await setup();
 const first=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect(await t.query(api.p4Index.status,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId})).toMatchObject({projectId:'payments',instance:'https://p4.example',revision:first.revision,indexStatus:'ready'});
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});
 const old=(await t.run(ctx=>ctx.db.query('p4Polls').unique()))!,worker={id:old._id,generation:old.generation,leaseId:'refresh-old-worker'};
 await t.mutation(internal.p4Polling.claim,worker);
 const prepared=await t.action(internal.p4ShelfJobs.prepare,{repositoryId:args.repositoryId,requestedBy:userId,reviewId:12});
 const automatic=await t.mutation(internal.p4Reviews.enqueue,{repositoryId:args.repositoryId,requestedBy:userId,nativeNumber:12,revision:prepared.revision,baseRevision:first.revision,baselineJobId:first.jobId,inputStorageId:prepared.storageId,connectionId:old.connectionId,credentialDigest:old.credentialDigest,polling:{id:old._id,generation:old.generation},pollLease:worker.leaseId,branches:['main']});
 const manual=await t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12,force:true});
 const upload=async(change:number)=>{const {revision:_revision,...meta}=inventory;void _revision;return t.action(api.p4IndexJobs.upload,{...args,inventory:JSON.stringify(p4SubmittedInventory({...meta,change}))});};
 const next=await upload(43);await t.action(internal.jobs.indexBatch,{jobId:next.jobId});await t.action(internal.jobs.indexBatch,{jobId:next.jobId});
 const adopted=(await t.run(ctx=>ctx.db.get(old._id)))!;expect(adopted).toMatchObject({enabled:true,status:'queued',baselineJobId:next.jobId,generation:old.generation+1,pending:[],position:0});expect(adopted.lease).toBeUndefined();
 expect(await t.run(ctx=>ctx.db.get(automatic))).toMatchObject({status:'cancelled'});expect(await t.run(ctx=>ctx.db.get(manual))).toMatchObject({status:'queued'});
 expect(await t.mutation(internal.p4Polling.progress,{...worker,page:{ids:[12],cursor:12}})).toBe(false);await expect(t.query(internal.p4Polling.data,worker)).rejects.toThrow('replaced');
 await expect(upload(42)).rejects.toThrow('move backwards');
 const {revision:_revision,...meta}=inventory;void _revision;
 await expect(t.action(api.p4IndexJobs.upload,{...args,inventory:JSON.stringify(p4SubmittedInventory({...meta,serverId:'foreign',change:44}))})).rejects.toThrow('server identity');
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});const disabled=(await t.run(ctx=>ctx.db.get(old._id)))!;
 const last=await upload(44);await t.action(internal.jobs.indexBatch,{jobId:last.jobId});await t.action(internal.jobs.indexBatch,{jobId:last.jobId});
 expect(await t.run(ctx=>ctx.db.get(old._id))).toMatchObject({enabled:false,status:'disabled',generation:disabled.generation,baselineJobId:next.jobId});
 const member=(await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',args.organizationId).eq('userId',userId)).unique()))!;
 await t.run(ctx=>ctx.db.patch(member._id,{role:'viewer'}));await expect(t.query(api.p4Index.status,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId})).rejects.toThrow('Forbidden');
 await t.run(ctx=>ctx.db.patch(manual,{status:'cancelled'}));await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 polling fails visibly on corrupt pagination or inventory ceiling instead of recording completion',async()=>{
 vi.useFakeTimers();try{
 const {t,args}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});const poll=await t.run(ctx=>ctx.db.query('p4Polls').unique());const worker={id:poll!._id,generation:poll!.generation,leaseId:'fixture'};
 await t.mutation(internal.p4Polling.claim,worker);
 await expect(t.mutation(internal.p4Polling.progress,{...worker,page:{ids:[],cursor:12}})).rejects.toThrow('page identity');
 await t.run(ctx=>ctx.db.patch(worker.id,{pages:100,cursor:12}));await expect(t.mutation(internal.p4Polling.progress,{...worker,page:{ids:[11],cursor:11}})).rejects.toThrow('coverage limit');expect((await t.run(ctx=>ctx.db.get(worker.id)))!.lastCompleteAt).toBeUndefined();
 await t.mutation(internal.p4Polling.progress,{...worker,page:{ids:[],cursor:null}});expect(await t.run(ctx=>ctx.db.get(worker.id))).toMatchObject({status:'waiting',lastCompleteAt:expect.any(Number)});
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 automatic-off polling imports a pinned catalog row and updates revision without model or source reads',async()=>{
 vi.useFakeTimers();try{
 const {t,args,setShelfArchive,reads}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);const baselineReads=reads();
 const {defaults}=await import('../src/review-settings');await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults,automatic:false}});
 const originalFetch=globalThis.fetch,requests:string[]=[];
 vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{const u=new URL(String(input));requests.push(u.pathname);if(u.pathname==='/api/v11/reviews')return Response.json({error:null,data:{reviews:u.searchParams.has('after')?[]:[{id:12,author:'alice',description:'Existing shelf',updated:1,pending:true,state:'needsReview',projects:{payments:['main']}}],lastSeen:u.searchParams.has('after')?null:12,totalCount:1}});return originalFetch(input as RequestInfo,init);});
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});const poll=await t.run(ctx=>ctx.db.query('p4Polls').unique()),identity={id:poll!._id,generation:poll!.generation};
 for(let i=0;i<3;i++)await t.action(internal.p4PollJobs.step,identity);
 const rows=await t.query(api.pulls.list,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,paginationOpts:{numItems:30,cursor:null}});
 expect(rows.page).toHaveLength(1);expect(rows.page[0]).toMatchObject({number:12,author:'alice',state:'open',latest:null,canRequest:true});expect(rows.page[0].headSha).toMatch(/^p4:12:1:44:/);
 vi.advanceTimersByTime(1);setShelfArchive(45);for(let i=0;i<3;i++)await t.action(internal.p4PollJobs.step,identity);
 expect((await t.run(ctx=>ctx.db.query('pullRequests').unique()))?.headSha).toMatch(/^p4:12:1:45:/);
 expect(requests.some(path=>path.includes('/files/')||path.includes('/file/')||path.startsWith('/view/'))).toBe(false);expect(reads()).toBe(baselineReads);
 expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(0);expect(await t.run(ctx=>ctx.db.query('modelCalls').collect())).toHaveLength(0);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('catalog manual P4 requests pin displayed revisions, enforce native admin access and coalesce while automation is off',async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId,setShelfArchive}=await setup(),index=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const {defaults}=await import('../src/review-settings');await t.mutation(api.repositories.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false,settings:{...defaults,automatic:false}});
 const {P4CodeReview}=await import('../src/perforce'),snapshot=await new P4CodeReview('https://p4.example','bot','fixture-ticket').snapshot('payments',12);
 const rowId=await t.run(ctx=>ctx.db.insert('pullRequests',{organizationId:args.organizationId,repositoryId:args.repositoryId,number:12,title:'Unreviewed shelf',author:'alice',url:'https://p4.example/reviews/12',headSha:snapshot.revision,baseSha:index.revision,state:'open',updatedAt:Date.now()}));
 const request={token:args.token,repositoryId:args.repositoryId,prNumber:12,expectedRevision:snapshot.revision,expectedBaseRevision:index.revision};
 const rows=()=>t.query(api.pulls.list,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,paginationOpts:{numItems:30,cursor:null}});
 expect((await rows()).page[0].canRequest).toBe(true);
 await expect(t.action(api.pullReviewJobs.request,{...request,expectedRevision:'stale'})).rejects.toThrow('Revision changed');
 await expect(t.action(api.pullReviewJobs.request,{...request,expectedBaseRevision:'stale'})).rejects.toThrow('Revision changed');
 setShelfArchive(45);await expect(t.action(api.pullReviewJobs.request,request)).rejects.toThrow('requested revision');setShelfArchive(44);
 await t.run(ctx=>ctx.db.patch(rowId,{state:'closed'}));expect((await rows()).page[0].canRequest).toBe(false);await expect(t.action(api.pullReviewJobs.request,request)).rejects.toThrow('Open change unavailable');await t.run(ctx=>ctx.db.patch(rowId,{state:'open'}));
 await t.run(ctx=>ctx.db.patch(rowId,{baseSha:'stale'}));expect((await rows()).page[0].canRequest).toBe(false);await expect(t.action(api.pullReviewJobs.request,{...request,expectedBaseRevision:'stale'})).rejects.toThrow('submitted baseline unavailable');await t.run(ctx=>ctx.db.patch(rowId,{baseSha:index.revision}));
 await t.run(ctx=>ctx.db.patch(rowId,{headSha:'p4-status:12:1:43:1'}));expect((await rows()).page[0].canRequest).toBe(false);await expect(t.action(api.pullReviewJobs.request,{...request,expectedRevision:'p4-status:12:1:43:1'})).rejects.toThrow('Pinned shelf');await t.run(ctx=>ctx.db.patch(rowId,{headSha:snapshot.revision}));
 const member=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',args.organizationId).eq('userId',userId)).unique());
 const teamMember=await t.run(async ctx=>{const repo=await ctx.db.get(args.repositoryId);return ctx.db.insert('teamMembers',{organizationId:args.organizationId,teamId:repo!.teamId!,userId,role:'viewer'});});
 for(const role of ['viewer','member'] as const){await t.run(async ctx=>{await ctx.db.patch(member!._id,{role});await ctx.db.patch(teamMember,{role});});expect((await rows()).page[0].canRequest).toBe(false);await expect(t.action(api.pullReviewJobs.request,request)).rejects.toThrow(/Forbidden|Viewers cannot/);}
 await t.run(ctx=>ctx.db.patch(member!._id,{role:'owner'}));
 const storageCount=()=>t.run(ctx=>ctx.db.system.query('_storage').collect()).then(rows=>rows.length);const before=await storageCount();
 await expect(t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12,expectedRevision:snapshot.revision,expectedBaseRevision:'changed'})).rejects.toThrow('Submitted baseline changed');expect(await storageCount()).toBe(before);
 const id=await t.action(api.pullReviewJobs.request,request);expect(id).not.toBeNull();expect(await t.run(ctx=>ctx.db.get(id!))).toMatchObject({status:'queued',headSha:snapshot.revision,baseSha:index.revision,nativeP4:{requestedBy:userId}});
 expect(await t.action(api.pullReviewJobs.request,request)).toBe(id);expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(1);expect(await t.run(ctx=>ctx.db.query('modelCalls').collect())).toHaveLength(0);
 await t.mutation(api.reviews.cancel,{token:args.token,reviewId:id!});await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 polling records unarchived shelves as skipped without inference or false ready claims',async()=>{
 vi.useFakeTimers();try{
 const {t,args}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const originalFetch=globalThis.fetch;
 vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{
  const u=new URL(String(input));
  if(u.pathname==='/api/v11/reviews')return Response.json({error:null,data:{reviews:u.searchParams.has('after')?[]:[{id:12,author:'alice',description:'No archive fixture',updated:1,pending:true,state:'needsReview',projects:{payments:['main']}}],lastSeen:u.searchParams.has('after')?null:12,totalCount:1}});
  const response=await originalFetch(input as RequestInfo,init);
  if(u.pathname==='/api/v11/reviews/12'){const body=await response.json();delete body.data.reviews[0].versions[0].archiveChange;return Response.json(body);}return response;
 });
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});const poll=await t.run(ctx=>ctx.db.query('p4Polls').unique()),identity={id:poll!._id,generation:poll!.generation};
 for(let i=0;i<3;i++)await t.action(internal.p4PollJobs.step,identity);
 expect(await t.run(ctx=>ctx.db.get(identity.id))).toMatchObject({status:'waiting',skipped:1,diagnostics:[{nativeNumber:12,reason:'No archived pending shelf; stable review revision unavailable'}]});expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toEqual([]);expect(await t.run(ctx=>ctx.db.query('modelCalls').collect())).toEqual([]);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 polling rechecks current closed state and cancels unfinished native reviews with metadata',async()=>{
 vi.useFakeTimers();try{
 const {t,args,setShelfState}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const reviewId=await t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12});
 await t.mutation(internal.p4Reviews.claim,{reviewId,leaseId:'metadata'});const review=await t.run(ctx=>ctx.db.get(reviewId));await t.mutation(internal.reviews.recordPr,{reviewId,workerLease:'metadata',title:'Fixture native review',author:'alice',url:'https://p4.example/reviews/12',headSha:review!.headSha,baseSha:review!.baseSha!,state:'open',commits:[review!.headSha]});
 const originalFetch=globalThis.fetch;vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{const u=new URL(String(input));if(u.pathname==='/api/v11/reviews')return Response.json({error:null,data:{reviews:[{id:12,author:'alice',description:'Listing was open',updated:1,pending:true,state:'needsReview',projects:{payments:['main']}}],lastSeen:12,totalCount:1}});return originalFetch(input as RequestInfo,init);});
 setShelfState('approved');await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:true});const poll=await t.run(ctx=>ctx.db.query('p4Polls').unique()),identity={id:poll!._id,generation:poll!.generation};
 await t.action(internal.p4PollJobs.step,identity);await t.action(internal.p4PollJobs.step,identity);
 expect(await t.run(ctx=>ctx.db.get(reviewId))).toMatchObject({status:'cancelled',finishedAt:expect.any(Number)});expect(await t.run(ctx=>ctx.db.query('pullRequests').unique())).toMatchObject({state:'closed'});expect(await t.run(ctx=>ctx.db.query('modelCalls').collect())).toEqual([]);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:args.repositoryId,enabled:false});await t.finishAllScheduledFunctions(vi.runAllTimers);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native personal identities are encrypted, project/account scoped, revocable and fail closed for viewers or changed connections',async()=>{
 vi.useFakeTimers();try{
 const {t,args,userId,connectionId,repo}=await setup();
 const identityId=await t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'personal-native-ticket'});
 const saved=await t.run(ctx=>ctx.db.get(identityId));expect(saved).toMatchObject({userId,repositoryId:repo._id,connectionId,username:'alice',active:true,generation:1});expect(saved!.credentials).not.toContain('personal-native-ticket');
 const listing=await t.query(api.p4Identities.list,{token:args.token,organizationId:args.organizationId});expect(JSON.stringify(listing)).not.toContain('credentials');expect(listing[0].identity).toMatchObject({username:'alice',active:true});
 await expect(t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'short'})).rejects.toThrow();
 const outsider=await t.mutation(api.users.login,{secret:'p4-index-service',githubId:999,login:'outsider',avatar:''});
 const outsiderToken=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(outsider).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
 await expect(t.action(api.p4IdentityJobs.connect,{token:outsiderToken,repositoryId:repo._id,username:'outsider',ticket:'personal-native-ticket'})).rejects.toThrow('Forbidden');
 await expect(t.mutation(api.p4Identities.revoke,{token:outsiderToken,identityId})).rejects.toThrow('not owned');
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId:args.organizationId,userId:outsider,role:'admin'}));
 await expect(t.action(api.p4IdentityJobs.connect,{token:outsiderToken,repositoryId:repo._id,username:'alice',ticket:'personal-native-ticket'})).rejects.toThrow('another workspace account');
 const member=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',args.organizationId).eq('userId',userId)).unique());
 if(repo.teamId)await t.run(ctx=>ctx.db.insert('teamMembers',{organizationId:args.organizationId,teamId:repo.teamId!,userId,role:'viewer'}));
 await t.run(ctx=>ctx.db.patch(member!._id,{role:'viewer'}));expect((await t.query(api.p4Identities.list,{token:args.token,organizationId:args.organizationId}))[0].canLink).toBe(false);
 await expect(t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'personal-native-ticket'})).rejects.toThrow('Viewers');
 await expect(t.query(internal.p4Identities.data,{id:identityId,generation:1})).rejects.toThrow('Viewers');
 await t.run(ctx=>ctx.db.patch(member!._id,{role:'member'}));await expect(t.query(internal.p4Identities.data,{id:identityId,generation:1})).rejects.toThrow('Team access');
 await t.run(ctx=>ctx.db.patch(member!._id,{role:'owner'}));
 const now=Date.now();vi.setSystemTime(now+25*60*60000);await expect(t.query(internal.p4Identities.data,{id:identityId,generation:1})).rejects.toThrow('expired');vi.setSystemTime(now);
 await t.run(ctx=>ctx.db.patch(connectionId,{credentials:'replaced-connection'}));await expect(t.query(internal.p4Identities.data,{id:identityId,generation:1})).rejects.toThrow('connection authority');
 await t.mutation(api.p4Identities.revoke,{token:args.token,identityId});expect(await t.run(ctx=>ctx.db.get(identityId))).toMatchObject({active:false,generation:2});expect((await t.run(ctx=>ctx.db.get(identityId)))!.credentials).toBeUndefined();
 await expect(t.query(internal.p4Identities.data,{id:identityId,generation:1})).rejects.toThrow('revoked');
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native follow-up evidence is fetched as the linked question author, omits forbidden sources and stops on identity revocation',async()=>{
 vi.useFakeTimers();try{
 const {t,args,repo,userId,connectionId,files,setOnShelfRead}=await setup();
 const index=await t.action(api.p4IndexJobs.upload,args);await t.action(internal.jobs.indexBatch,{jobId:index.jobId});await t.finishAllScheduledFunctions(vi.runAllTimers);
 const prepared=await t.action(internal.p4ShelfJobs.prepare,{repositoryId:repo._id,requestedBy:userId,reviewId:12});
 const {connectionDigest}=await import('../convex/indexAuthority');const connection=await t.run(ctx=>ctx.db.get(connectionId));
 const reviewId=await t.mutation(internal.p4Reviews.enqueue,{repositoryId:repo._id,requestedBy:userId,nativeNumber:12,revision:prepared.revision,baseRevision:prepared.baseRevision,baselineJobId:prepared.baselineJobId,inputStorageId:prepared.storageId,connectionId,credentialDigest:await connectionDigest(connection!.credentials)});await t.run(ctx=>ctx.db.patch(reviewId,{status:'completed'}));
 const nativeFetch=globalThis.fetch;let denied=false,seenPersonal=0;
 vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{
  const u=new URL(String(input)),auth=(init?.headers as Record<string,string>).authorization;
  if(auth==='Basic '+Buffer.from('alice:personal-native-ticket').toString('base64'))seenPersonal++;
  if(u.pathname==='/api/v9/comments')return Response.json({comments:u.searchParams.has('after')?[]:[{id:50,body:'@openreview Explain the cents calculation.',user:'alice',topic:'reviews/12',flags:[],context:{version:1}}],lastSeen:u.searchParams.has('after')?null:50});
  if(denied&&u.pathname.startsWith('/api/v11/files/')&&Buffer.from(u.pathname.split('/').at(-1)!,'base64url').toString()===files[1].path)return new Response('Forbidden',{status:403});
  return nativeFetch(input as RequestInfo,init);
 });
 const identityId=await t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'personal-native-ticket'});
 const request={reviewId,identityId,generation:1,questionId:50};
 const evidence=await t.action(internal.p4IdentityJobs.context,request);expect(evidence.question.user).toBe('alice');expect(evidence.sources.some(s=>s.path===files[0].path.slice(2))).toBe(true);expect(evidence.sources.some(s=>s.path===files[1].path.slice(2))).toBe(true);expect(seenPersonal).toBeGreaterThan(10);expect(evidence.revision).toBe(prepared.revision);
 denied=true;const limited=await t.action(internal.p4IdentityJobs.context,request);expect(limited.sources.some(s=>s.path===files[1].path.slice(2))).toBe(false);expect(limited.coverage.some(s=>s.includes('unavailable to native question author'))).toBe(true);denied=false;
 await expect(t.action(internal.p4IdentityJobs.context,{...request,questionId:999})).rejects.toThrow('linked identity');
 setOnShelfRead(async()=>{setOnShelfRead(undefined);await t.mutation(api.p4Identities.revoke,{token:args.token,identityId});});
 await expect(t.action(internal.p4IdentityJobs.context,request)).rejects.toThrow('revoked');
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

async function nativeConversationFixture(){
 const fixture=await setup(),{t,args,repo,userId,connectionId,files}=fixture;
 const index=await t.action(api.p4IndexJobs.upload,args);await t.action(internal.jobs.indexBatch,{jobId:index.jobId});await t.finishAllScheduledFunctions(vi.runAllTimers);
 const prepared=await t.action(internal.p4ShelfJobs.prepare,{repositoryId:repo._id,requestedBy:userId,reviewId:12}),{connectionDigest}=await import('../convex/indexAuthority'),connection=await t.run(ctx=>ctx.db.get(connectionId));
 const reviewId=await t.mutation(internal.p4Reviews.enqueue,{repositoryId:repo._id,requestedBy:userId,nativeNumber:12,revision:prepared.revision,baseRevision:prepared.baseRevision,baselineJobId:prepared.baselineJobId,inputStorageId:prepared.storageId,connectionId,credentialDigest:await connectionDigest(connection!.credentials)});await t.run(ctx=>ctx.db.patch(reviewId,{status:'completed'}));
 const identityId=await t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'personal-native-ticket'});
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:repo._id,enabled:true});const poll=await t.run(ctx=>ctx.db.query('p4Polls').withIndex('by_repo',q=>q.eq('repositoryId',repo._id)).unique());
 await t.mutation(internal.p4Polling.claim,{id:poll!._id,generation:poll!.generation,leaseId:'native-discovery'});
 const nativeFetch=globalThis.fetch;let modelCalls=0,posts=0,lostWrite=false,denied=false;
 const comments:{id:number;body:string;user:string;topic:string;flags:string[];context:{version:number;comment?:number}}[]=[{id:50,body:'@openreview Explain the cents calculation.',user:'alice',topic:'reviews/12',flags:[],context:{version:1}}];
 process.env.LLM_PROVIDER='openai';process.env.LLM_API_KEY='native-conversation-test-key';process.env.LLM_MODEL='gpt-4.1';process.env.LLM_BASE_URL='https://api.openai.com/v1';
 vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{
  const u=new URL(String(input));
  if(u.origin==='https://api.openai.com'){modelCalls++;return Response.json({choices:[{message:{content:JSON.stringify({answer:'The function divides the input price by 100, changing the conversion expected by the integer-cent caller.',citations:[{filePath:files[0].path.slice(2),startLine:1,quote:files[0].content.replace('price * 100','price / 100').trimEnd()}]})}}],usage:{prompt_tokens:300,completion_tokens:100}});}
  if(u.pathname==='/api/v9/comments'){const after=Number(u.searchParams.get('after')??0),page=comments.filter(c=>c.id>after);return Response.json({comments:page,lastSeen:page.length?Math.max(...page.map(c=>c.id)):null});}
  if(u.pathname==='/api/v11/comments/reviews/12'&&init?.method==='POST'){posts++;const payload=JSON.parse(String(init.body)),comment={id:50+posts,body:payload.body,user:'bot',topic:'reviews/12',flags:[],context:{version:1,comment:payload.context.comment}};comments.push(comment);if(lostWrite){lostWrite=false;return new Response('Stored reply, lost response',{status:503});}return Response.json({error:null,data:{comments:[comment]}});}
  if(denied&&u.pathname.startsWith('/api/v11/files/')&&Buffer.from(u.pathname.split('/').at(-1)!,'base64url').toString()===files[0].path)return new Response('Forbidden',{status:403});
  return nativeFetch(input as RequestInfo,init);
 });
 const discovery={reviewId,polling:{id:poll!._id,generation:poll!.generation},pollLease:'native-discovery'};
 return {...fixture,reviewId,identityId,poll:poll!,discovery,modelCalls:()=>modelCalls,posts:()=>posts,comments,loseWrite:()=>{lostWrite=true;},denySource:()=>{denied=true;}};
}

test('native polling discoveries answer once with fetched citations; lost publication reuses the saved answer and native reply',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,reviewId}=f;
 expect(await t.action(internal.p4ConversationJobs.discover,discovery)).toBe(1);expect(await t.action(internal.p4ConversationJobs.discover,discovery)).toBe(0);
 const row=await t.run(ctx=>ctx.db.query('conversations').collect());expect(row).toHaveLength(1);const conversationId=row[0]._id;
 f.loseWrite();await t.action(internal.p4ConversationJobs.reply,{conversationId});expect(await t.run(ctx=>ctx.db.get(conversationId))).toMatchObject({status:'queued',attempts:1,answer:expect.stringContaining('Source:')});expect(f.modelCalls()).toBe(1);expect(f.posts()).toBe(1);
 await t.action(internal.p4ConversationJobs.reply,{conversationId});expect(await t.run(ctx=>ctx.db.get(conversationId))).toMatchObject({status:'completed',attempts:2,nativeP4:{replyId:51}});expect(f.modelCalls()).toBe(1);expect(f.posts()).toBe(1);
 await t.action(internal.p4ConversationJobs.reply,{conversationId});expect(f.posts()).toBe(1);expect(f.modelCalls()).toBe(1);
 expect(await t.run(ctx=>ctx.db.get(reviewId))).toMatchObject({status:'completed',headSha:row[0].nativeP4!.revision});expect(await t.run(ctx=>ctx.db.query('usageEvents').collect())).toHaveLength(1);
 await expect(t.mutation(internal.conversations.finish,{conversationId,status:'completed'})).rejects.toThrow('worker lease');
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native saved replies stop when cited source access is lost, and revoked polling cannot claim queued questions',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,args,repo}=f;await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());
 f.loseWrite();await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});f.denySource();await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(f.posts()).toBe(1);expect(f.modelCalls()).toBe(1);expect((await t.run(ctx=>ctx.db.get(row._id)))!.status).toBe('queued');
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:repo._id,enabled:false});await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'failed',error:expect.stringContaining('polling stopped')});expect(f.posts()).toBe(1);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native recovery replaces expired leases, stale workers cannot persist answers, and identity revocation fails queued recovery',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,args,identityId}=f;await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());
 expect(await t.mutation(internal.p4Conversations.claim,{conversationId:row._id,leaseId:'old-native'})).toBe(true);
 await t.run(async ctx=>{const current=await ctx.db.get(row._id);await ctx.db.patch(row._id,{nativeP4:{...current!.nativeP4!,lease:{id:'old-native',expiresAt:Date.now()-1}}});});
 await t.mutation(internal.p4Conversations.recover,{});expect(await t.mutation(internal.p4Conversations.claim,{conversationId:row._id,leaseId:'new-native'})).toBe(true);
 await expect(t.mutation(internal.p4Conversations.save,{conversationId:row._id,leaseId:'old-native',answer:'Untrusted saved answer',answerText:'Untrusted saved answer',citations:[]})).rejects.toThrow('lease expired');expect(await t.mutation(internal.p4Conversations.finish,{conversationId:row._id,leaseId:'old-native',error:'old failure'})).toBe(false);
 await t.mutation(internal.p4Conversations.finish,{conversationId:row._id,leaseId:'new-native',error:'Transient failure'});await t.mutation(api.p4Identities.revoke,{token:args.token,identityId});await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'failed',error:expect.stringContaining('revoked')});expect(f.modelCalls()).toBe(0);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native answer retry requires its linked author, renewed identity and current polling authority',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,args,identityId,repo}=f;await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());
 await t.mutation(api.p4Identities.revoke,{token:args.token,identityId});await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});
 await expect(t.mutation(api.p4Conversations.retry,{token:args.token,conversationId:row._id})).rejects.toThrow('revoked');
 const outsider=await t.mutation(api.users.login,{secret:'p4-index-service',githubId:999,login:'outsider',avatar:''});await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId:args.organizationId,userId:outsider,role:'admin'}));
 const outsiderToken=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(outsider).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
 await expect(t.mutation(api.p4Conversations.retry,{token:outsiderToken,conversationId:row._id})).rejects.toThrow('Only the linked');
 await t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'personal-native-ticket'});
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:repo._id,enabled:false});await expect(t.mutation(api.p4Conversations.retry,{token:args.token,conversationId:row._id})).rejects.toThrow('polling stopped');
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:repo._id,enabled:true});await t.mutation(api.p4Conversations.retry,{token:args.token,conversationId:row._id});
 expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'queued',attempts:0,nativeP4:{identityGeneration:3}});
 await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'completed',attempts:1,nativeP4:{replyId:51}});expect(f.modelCalls()).toBe(1);expect(f.posts()).toBe(1);
 await expect(t.mutation(api.p4Conversations.retry,{token:args.token,conversationId:row._id})).rejects.toThrow('No failed');
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native pattern commands require a current published finding and apply once without inference across a lost reply',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,args,repo,reviewId}=f;
 f.comments[0].body='@openreview ignore this pattern';f.comments[0].context.comment=49;
 f.comments.push({id:49,body:'Published finding fixture <!-- openreview-finding:native-pattern -->',user:'bot',topic:'reviews/12',flags:[],context:{version:1}});
 const revision=(await t.run(ctx=>ctx.db.get(reviewId)))!.headSha;
 const findingId=await t.run(ctx=>ctx.db.insert('findings',{organizationId:args.organizationId,repositoryId:repo._id,reviewId,prNumber:12,title:'Currency contract mismatch',description:'Native contract fixture',severity:'high',confidence:1,category:'correctness',filePath:'depot/main/file00.ts',startLine:1,endLine:1,commitSha:revision,evidence:[{filePath:'depot/main/file00.ts',startLine:1,quote:'fixture'}],impact:'Incorrect units',suggestedFix:'Preserve cents',symbol:'cents',fingerprint:'native-pattern',agent:'correctness',status:'open',createdAt:Date.now(),updatedAt:Date.now()}));
 await t.run(ctx=>ctx.db.insert('reviewComments',{organizationId:args.organizationId,reviewId,githubId:49,fingerprint:'native-pattern',createdAt:Date.now()}));
 await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());f.loseWrite();await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});
 expect(await t.run(ctx=>ctx.db.query('learnedPreferences').collect())).toMatchObject([{findingId,enabled:true,conversationId:row._id}]);expect(f.modelCalls()).toBe(0);
 f.comments.find(c=>c.id===49)!.user='alice';await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'queued',error:expect.stringContaining('current published finding')});expect(f.posts()).toBe(1);f.comments.find(c=>c.id===49)!.user='bot';
 await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'completed',nativeP4:{command:{kind:'ignore-pattern'}}});
 expect(await t.run(ctx=>ctx.db.query('learnedPreferences').collect())).toHaveLength(1);expect(f.posts()).toBe(1);expect(f.modelCalls()).toBe(0);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native pattern commands without a published finding fail without preferences or inference',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery}=f;f.comments[0].body='@openreview ignore this pattern';await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());
 for(let i=0;i<3;i++)await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});
 expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'failed',error:expect.stringContaining('current published finding')});expect(await t.run(ctx=>ctx.db.query('learnedPreferences').collect())).toHaveLength(0);expect(f.posts()).toBe(0);expect(f.modelCalls()).toBe(0);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native re-review commands publish an acknowledgement then atomically queue one pinned review; replay cannot duplicate it',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,reviewId}=f;f.comments[0].body='@openreview re-review';await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());
 f.loseWrite();await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(1);
 await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});const current=await t.run(ctx=>ctx.db.get(row._id));expect(current).toMatchObject({status:'completed',nativeP4:{command:{kind:'rereview',requestedReviewId:expect.any(String)}}});
 const requested=await t.run(ctx=>ctx.db.get(current!.nativeP4!.command!.requestedReviewId!));expect(requested).toMatchObject({status:'queued',headSha:row.nativeP4!.revision});expect(requested!._id).not.toBe(reviewId);
 await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(2);expect(f.posts()).toBe(1);expect(f.modelCalls()).toBe(0);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('native re-review rejects a non-admin writer before acknowledgement or review creation',async()=>{
 vi.useFakeTimers();try{
 const f=await nativeConversationFixture(),{t,discovery,args,repo}=f;
 const userId=await t.mutation(api.users.login,{secret:'p4-index-service',githubId:999,login:'bob',avatar:''});await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId:args.organizationId,userId,role:'member'}));
 if(repo.teamId)await t.run(ctx=>ctx.db.insert('teamMembers',{organizationId:args.organizationId,teamId:repo.teamId!,userId,role:'member'}));
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET!));await t.action(api.p4IdentityJobs.connect,{token,repositoryId:repo._id,username:'bob',ticket:'personal-native-ticket'});
 f.comments[0].body='@openreview re-review';f.comments[0].user='bob';await t.action(internal.p4ConversationJobs.discover,discovery);const [row]=await t.run(ctx=>ctx.db.query('conversations').collect());
 await t.action(internal.p4ConversationJobs.reply,{conversationId:row._id});expect(await t.run(ctx=>ctx.db.get(row._id))).toMatchObject({status:'queued',error:expect.stringContaining('Forbidden')});expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(1);expect(f.posts()).toBe(0);expect(f.modelCalls()).toBe(0);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test('P4 runtime waits without holding a review lease, publishes recorded native execution, and rejects stale shelves',async()=>{
 vi.useFakeTimers();
 const {randomUUID}=await import('node:crypto'),{P4CodeReview}=await import('../src/perforce'),{HttpModel}=await import('../src/engine/model');
 const policy={enabled:true,image:'node@sha256:'+'a'.repeat(64),command:'cd depot/main && node --test',timeout:120,requiredForApproval:true};
 const generate=vi.spyOn(HttpModel.prototype,'generate').mockImplementation(async(request,validator)=>({value:validator.parse(request.task.startsWith('review:')?{findings:[]}:request.task==='verify'?{decisions:[]}:{summary:'The pinned archived shelf was inspected with the recorded runtime evidence.',reviewScore:{value:5,reason:'No verified findings remain in the reviewed source changes.'}}),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,estimatedCost:0,latencyMs:0,cached:false}}));
 const publish=vi.spyOn(P4CodeReview.prototype,'publish').mockImplementation(async(_snapshot,_summary,_findings,_bases,_run,_style,authorize)=>{await authorize?.();return {id:701,reused:false,comments:[]};});
 try{
  const {t,args,setShelfArchive}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(api.runtime.save,{token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,policy});
  const hash='a'.repeat(64);await t.mutation(api.runtime.worker,{token:args.token,organizationId:args.organizationId,name:'P4 fixture',hash});await t.mutation(internal.runtime.claim,{hash,lease:randomUUID()});
  const request={token:args.token,organizationId:args.organizationId,repositoryId:args.repositoryId,nativeNumber:12};
  const reviewId=await t.action(api.p4ReviewJobs.request,request);await t.finishAllScheduledFunctions(vi.runAllTimers);
  const waiting=await t.run(ctx=>ctx.db.get(reviewId));expect(waiting?.status).toBe('waiting_runtime');expect(waiting?.nativeP4?.lease).toBeUndefined();expect(generate).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  const [job]=await t.query(api.runtime.review,{token:args.token,reviewId});expect(job.status).toBe('queued');expect(job.headSha).toMatch(/^p4:12:1:44:/);
  const lease=randomUUID(),claim=await t.mutation(internal.runtime.claim,{hash,lease});expect(claim?.headSha).toBe(waiting?.headSha);
  expect((await t.query(internal.runtime.authenticatedJob,{id:job._id,hash,lease,source:true})).sourceStorageId).toBeDefined();
  const member=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org',q=>q.eq('organizationId',args.organizationId)).first());await t.run(ctx=>ctx.db.patch(member!._id,{role:'viewer'}));await expect(t.query(internal.runtime.authenticatedJob,{id:job._id,hash,lease,source:true})).rejects.toThrow('Forbidden');await t.run(ctx=>ctx.db.patch(member!._id,{role:member!.role}));
  const evidence={headSha:job.headSha,image:policy.image,command:policy.command,exitCode:0,timedOut:false,executionStarted:true,output:'native exact-shelf check passed',outputTruncated:false,network:'none' as const,memoryMb:512 as const,cpus:1 as const};
  await t.action(internal.runtimeJobs.report,{id:job._id,hash,lease,evidence});await t.finishAllScheduledFunctions(vi.runAllTimers);
  const completed=await t.run(ctx=>ctx.db.get(reviewId));expect(completed?.status).toBe('completed');expect(completed?.runtimeEvidence).toEqual(evidence);expect(completed?.summary).toContain('passed at '+job.headSha);expect(completed?.summary).toContain(policy.command);expect(publish).toHaveBeenCalledTimes(1);
  expect((await t.query(api.runtime.review,{token:args.token,reviewId}))[0].status).toBe('passed');
  const staleId=await t.action(api.p4ReviewJobs.request,{...request,force:true});await t.finishAllScheduledFunctions(vi.runAllTimers);const [stale]=await t.query(api.runtime.review,{token:args.token,reviewId:staleId});
  const secondLease=randomUUID();await t.mutation(internal.runtime.claim,{hash,lease:secondLease});setShelfArchive(45);
  await t.action(internal.runtimeJobs.report,{id:stale._id,hash,lease:secondLease,evidence});expect((await t.query(api.runtime.review,{token:args.token,reviewId:staleId}))[0].status).toBe('cancelled');expect((await t.run(ctx=>ctx.db.get(staleId)))?.runtimeEvidence).toBeUndefined();
 }finally{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();}
});

test('mixed Git/P4 clusters fetch source with the personally linked author and retain pinned native provenance',async()=>{
 vi.useFakeTimers();try{
  const {t,args,userId,repo}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(api.repositories.connect,{token:args.token,secret:'p4-index-service',organizationId:args.organizationId,installationId:8100,account:'alice',accountId:1,repositories:[{id:8101,fullName:'alice/context-primary',defaultBranch:'main'}]});
  const main=(await t.query(api.repositories.list,{token:args.token,organizationId:args.organizationId})).find(r=>r.fullName==='alice/context-primary')!;await t.run(ctx=>ctx.db.patch(main._id,{enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40)}));
  await t.mutation(api.scopes.cluster,{token:args.token,organizationId:args.organizationId,name:'Mixed explicit cluster',repositoryIds:[main._id,repo._id]});
  const unlinked=await t.action(internal.repositoryContextJobs.retrieve,{repositoryId:main._id,actor:'alice',authorExternalId:'1',identifiers:['cents']});expect(unlinked.files).toEqual([]);expect(unlinked.coverage.join()).toContain('personal identity');
  const identityId=await t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'author-ticket'});
  const originalFetch=globalThis.fetch,reads:string[]=[];vi.stubGlobal('fetch',async(input:unknown,init?:RequestInit)=>{const u=new URL(String(input));if(u.pathname.startsWith('/view/')){expect(new Headers(init?.headers).get('authorization')).toBe('Basic '+Buffer.from('alice:author-ticket').toString('base64'));reads.push(u.pathname);}return originalFetch(input as RequestInfo,init);});
  const cross=await t.action(internal.repositoryContextJobs.retrieve,{repositoryId:main._id,actor:'alice',authorExternalId:'1',identifiers:['cents']});expect(cross.files).toHaveLength(2);expect(cross.files[0].content).toContain('price * 100');expect(cross.files[0].path).toMatch(/^context\//);expect(cross.files[0].provenance).toMatchObject({repository:repo.fullName,revision:cross.receipt!.sources[0].revision,sourceUrl:'https://p4.example/view/depot/main/file00.ts?v=%233'});expect(reads.sort()).toEqual(['/view/depot/main/file00.ts','/view/depot/main/file01.ts']);
  await t.action(internal.repositoryContextJobs.validate,{receipt:cross.receipt!});expect(reads).toHaveLength(4);
  const context={repositoryId:main._id,scopes:[],repositoryContext:cross.receipt!};await t.mutation(internal.cache.set,{organizationId:args.organizationId,key:'personal-context',result:'authorized',context});
  await t.mutation(api.p4Identities.revoke,{token:args.token,identityId});await expect(t.query(internal.cache.get,{organizationId:args.organizationId,key:'personal-context',context})).rejects.toThrow('revoked');
  const member=await t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',args.organizationId).eq('userId',userId)).unique());await t.run(ctx=>ctx.db.patch(member!._id,{role:'viewer'}));await expect(t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'author-ticket'})).rejects.toThrow('Viewers');
 }finally{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();}
});

test('a native P4 review uses authorized Git source context and publishes evidence with its repository and revision',async()=>{
 vi.useFakeTimers();const {Github}=await import('../src/github'),{HttpModel}=await import('../src/engine/model'),{P4CodeReview}=await import('../src/perforce');let sourcePath='';
 vi.spyOn(Github,'installation').mockResolvedValue(new Github('fixture'));
 vi.spyOn(Github.prototype,'tree').mockResolvedValue([{path:'README.md',type:'blob',sha:'c'.repeat(40),size:60}]);
 vi.spyOn(Github.prototype,'blob').mockResolvedValue({path:'README.md',sha:'c'.repeat(40),content:'Invoice totals must use integer cents.\n'});
 vi.spyOn(HttpModel.prototype,'generate').mockImplementation(async(request,validator)=>{
  const finding={title:'Currency scale violates the consumer contract',description:'The archived helper divides price while the explicitly selected consumer repository requires integer cents.',severity:'high',confidence:1,category:'correctness',filePath:'depot/main/file00.ts',startLine:1,endLine:1,evidence:[{filePath:'depot/main/file00.ts',startLine:1,quote:'export function cents(price: number) { return price / 100; }'},{filePath:sourcePath,startLine:1,quote:'Invoice totals must use integer cents.'}],impact:'The consumer receives an amount ten thousand times smaller than expected.',suggestedFix:'Multiply the price by 100.',symbol:'cents'};
  const value=request.task==='review:correctness'?{findings:[finding]}:request.task.startsWith('review:')?{findings:[]}:request.task==='verify'?{decisions:[{index:0,publish:true,confidence:1,reason:'The pinned shelf and selected consumer documentation require incompatible units.'}]}:{summary:'The selected consumer context confirms an integer cents regression in the archived helper.',reviewScore:{value:1,reason:'The verified consumer contract regression requires correction before merging.'}};
  return {value:validator.parse(value),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,estimatedCost:0,latencyMs:0,cached:false}};
 });
 const publish=vi.spyOn(P4CodeReview.prototype,'publish').mockImplementation(async(_snapshot,_summary,findings,_bases,_run,_style,authorize)=>{await authorize?.();return {id:901,reused:false,comments:findings.map(f=>({id:902,fingerprint:f.fingerprint}))};});
 try{
  const {t,args,repo}=await setup();await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(api.repositories.connect,{token:args.token,secret:'p4-index-service',organizationId:args.organizationId,installationId:9100,account:'alice',accountId:1,repositories:[{id:9101,fullName:'alice/consumer',defaultBranch:'main'}]});
  const source=(await t.query(api.repositories.list,{token:args.token,organizationId:args.organizationId})).find(r=>r.fullName==='alice/consumer')!;await t.run(ctx=>ctx.db.patch(source._id,{enabled:true,indexStatus:'ready',indexedSha:'b'.repeat(40)}));sourcePath='context/'+source._id+'/'+'b'.repeat(40)+'/README.md';
  await t.run(async ctx=>{const storageId=await ctx.storage.store(new Blob(['Invoice totals must use integer cents.\n']));await ctx.db.insert('repositoryFiles',{organizationId:args.organizationId,repositoryId:source._id,path:'README.md',sha:'c'.repeat(40),storageId,language:'markdown',updatedAt:Date.now()});});
  await t.mutation(api.scopes.cluster,{token:args.token,organizationId:args.organizationId,name:'Native consumer context',repositoryIds:[repo._id,source._id]});await t.action(api.p4IdentityJobs.connect,{token:args.token,repositoryId:repo._id,username:'alice',ticket:'author-ticket'});
  const reviewId=await t.action(api.p4ReviewJobs.request,{token:args.token,organizationId:args.organizationId,repositoryId:repo._id,nativeNumber:12});await t.finishAllScheduledFunctions(vi.runAllTimers);
  const detail=await t.query(api.reviews.detail,{token:args.token,reviewId});expect(detail.review.status).toBe('completed');expect(detail.findings).toHaveLength(1);expect(detail.findings[0].evidence).toEqual(expect.arrayContaining([expect.objectContaining({repository:'alice/consumer',revision:'b'.repeat(40),sourceUrl:'https://github.com/alice/consumer/blob/'+'b'.repeat(40)+'/README.md'})]));expect(detail.review.summary).toContain('Fetched repository sources supplied as review context:');expect(publish).toHaveBeenCalledTimes(1);
  const saved=await t.run(async ctx=>JSON.parse(await (await ctx.storage.get((await ctx.db.get(reviewId))!.resultStorageId!))!.text()));expect(saved.repositoryContext.actor).toBe('alice');expect(saved.repositoryContext.sources[0].revision).toBe('b'.repeat(40));
 }finally{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();}
});


test("P4 ticket renewal verifies the existing bot and selected projects, rejects races and invalidates old native authority",async()=>{
 vi.useFakeTimers();try{
 const {t,args,repo,connectionId,userId}=await setup();
 const index=await t.action(api.p4IndexJobs.upload,args);await t.finishAllScheduledFunctions(vi.runAllTimers);
 const original=(await t.run(ctx=>ctx.db.get(connectionId)))!;
 const {connectionDigest}=await import("../convex/indexAuthority");
 const credentialDigest=await connectionDigest(original.credentials);
 const viewerId=await t.mutation(api.users.login,{secret:"p4-index-service",githubId:2,login:"viewer",avatar:""});
 const viewerToken=await new SignJWT({}).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setSubject(viewerId).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
 await t.run(ctx=>ctx.db.insert("organizationMembers",{organizationId:repo.organizationId,userId:viewerId,role:"viewer"}));
 await expect(t.action(api.providerJobs.refreshP4Ticket,{token:viewerToken,connectionId,ticket:"renewed-ticket-fixture"})).rejects.toThrow("Forbidden");
 expect((await t.run(ctx=>ctx.db.get(connectionId)))!.credentials).toBe(original.credentials);
 await t.mutation(api.p4Polling.configure,{token:args.token,repositoryId:repo._id,enabled:true});
 const poll=(await t.run(ctx=>ctx.db.query("p4Polls").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).unique()))!;
 await expect(t.mutation(internal.providerConnections.refreshP4,{token:args.token,id:connectionId,previousCredentials:"stale-credential",credentials:"new",projectIds:["payments"]})).rejects.toThrow("changed");
 await expect(t.mutation(internal.providerConnections.refreshP4,{token:args.token,id:connectionId,previousCredentials:original.credentials,credentials:"new",projectIds:[]})).rejects.toThrow("selection changed");
 expect((await t.run(ctx=>ctx.db.get(connectionId)))!.credentials).toBe(original.credentials);
 const {P4CodeReview}=await import("../src/perforce");
 const denied=vi.spyOn(P4CodeReview.prototype,"authenticatedIdentity").mockRejectedValueOnce(new Error("Native bot identity mismatch"));
 try{await expect(t.action(api.providerJobs.refreshP4Ticket,{token:args.token,connectionId,ticket:"renewed-ticket-fixture"})).rejects.toThrow("identity mismatch");}finally{denied.mockRestore();}
 const projects=vi.spyOn(P4CodeReview.prototype,"projects").mockResolvedValueOnce([]);
 try{await expect(t.action(api.providerJobs.refreshP4Ticket,{token:args.token,connectionId,ticket:"renewed-ticket-fixture"})).rejects.toThrow("every selected project");}finally{projects.mockRestore();}
 await t.action(api.providerJobs.refreshP4Ticket,{token:args.token,connectionId,ticket:"fixture-ticket"});
 expect((await t.run(ctx=>ctx.db.get(connectionId)))!.credentials).toBe(original.credentials);
 expect((await t.run(ctx=>ctx.db.get(poll._id)))!.enabled).toBe(true);
 await t.action(api.providerJobs.refreshP4Ticket,{token:args.token,connectionId,ticket:"renewed-ticket-fixture"});
 const renewed=(await t.run(ctx=>ctx.db.get(connectionId)))!;
 const {decryptCredential}=await import("../src/credentials");
 expect(JSON.parse(decryptCredential(renewed.credentials,repo.organizationId+":perforce"))).toEqual({username:"bot",ticket:"renewed-ticket-fixture"});
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"not_indexed",enabled:false,indexedSha:index.revision});
 expect(await t.run(ctx=>ctx.db.get(poll._id))).toMatchObject({enabled:false,status:"disabled",generation:poll.generation+1});
 expect((await t.run(ctx=>ctx.db.system.get(poll.scheduledId!)))!.state.kind).toBe("canceled");
 expect((await t.run(ctx=>ctx.db.get(index.jobId)))!.nativeDepot!.credentialDigest).toBe(credentialDigest);
 await expect(t.query(internal.p4Index.baseline,{repositoryId:repo._id,requestedBy:userId})).rejects.toThrow();
 const audit=await t.run(ctx=>ctx.db.query("auditEvents").collect());expect(audit.some(a=>a.action==="p4.bot_ticket_refreshed")).toBe(true);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

test("P4 approval inspection rejects viewers and rechecks connection credentials and suspension after native retrieval",async()=>{
 vi.useFakeTimers();try{
 const s=await setup(),{P4CodeReview}=await import('../src/perforce');
 const args={token:s.args.token,connectionId:s.connectionId,projectId:'payments',nativeNumber:12};
 const result={reviewNumber:12,version:1,revision:'p4:12:1:44:fixture',state:'needsReview',pending:true,nativeApprovalAvailable:true,nativeBlockers:[],coverage:['Native protections can hide files'],inspectedAt:Date.now()};
 const inspect=vi.spyOn(P4CodeReview.prototype,'approvalInspection').mockResolvedValue(result);
 const member=await s.t.run(ctx=>ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',s.args.organizationId).eq('userId',s.userId)).unique());
 await s.t.run(ctx=>ctx.db.patch(member!._id,{role:'viewer'}));
 await expect(s.t.action(api.providerJobs.p4ApprovalInspection,args)).rejects.toThrow('Forbidden');expect(inspect).not.toHaveBeenCalled();
 await s.t.run(ctx=>ctx.db.patch(member!._id,{role:'owner'}));
 expect(await s.t.action(api.providerJobs.p4ApprovalInspection,args)).toEqual(result);
 const original=await s.t.run(ctx=>ctx.db.get(s.connectionId));
 inspect.mockImplementationOnce(async()=>{await s.t.run(ctx=>ctx.db.patch(s.connectionId,{credentials:'changed-encrypted-credential'}));return result;});
 await expect(s.t.action(api.providerJobs.p4ApprovalInspection,args)).rejects.toThrow('connection changed');
 await s.t.run(ctx=>ctx.db.patch(s.connectionId,{credentials:original!.credentials}));
 inspect.mockImplementationOnce(async()=>{await s.t.run(ctx=>ctx.db.patch(s.connectionId,{suspended:true}));return result;});
 await expect(s.t.action(api.providerJobs.p4ApprovalInspection,args)).rejects.toThrow('disabled or suspended');
 await s.t.run(ctx=>ctx.db.patch(s.connectionId,{suspended:false}));
 inspect.mockImplementationOnce(async()=>{await s.t.run(ctx=>ctx.db.patch(member!._id,{role:'viewer'}));return result;});
 await expect(s.t.action(api.providerJobs.p4ApprovalInspection,args)).rejects.toThrow('Forbidden');
 }finally{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();}
});
