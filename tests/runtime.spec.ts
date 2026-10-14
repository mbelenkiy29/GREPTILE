import { test,expect,vi,afterEach } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHash,randomUUID,generateKeyPairSync } from "node:crypto";
import schema from "../convex/schema";
import { api,internal } from "../convex/_generated/api";
import { Github } from "../src/github";
import {encryptCredential} from "../src/credentials";
import {gzipSync} from "node:zlib";
const modules=import.meta.glob("../convex/**/*.ts");
const secret="runtime-fixture-session-secret-at-least-32-characters",credential="orw_"+"a".repeat(64),hash=createHash("sha256").update(credential).digest("hex");
const policy={enabled:true,image:"node@sha256:"+"a".repeat(64),command:"node --test",timeout:120,requiredForApproval:true};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test("Data Center native archive preparation reaches the existing authorized worker source endpoint and fails visibly on publisher mismatch",async()=>{
 const previousHosts=process.env.SCM_ALLOWED_HOSTS;process.env.SCM_ALLOWED_HOSTS='bitbucket.fixture';process.env.CREDENTIAL_ENCRYPTION_KEY='runtime-dc-key-at-least-32-characters';
 const bytes=gzipSync('native archive fixture');let archiveReads=0,wrongPublisher=false;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=new URL(String(input));expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-dc-token');
  if(url.pathname.endsWith('/archive')){archiveReads++;expect(url.searchParams.get('at')).toBe('b'.repeat(40));return new Response(bytes,{headers:{'x-ausername':wrongPublisher?'wrong-user':'openreview'}});}
  return Response.json({id:71});
 });
 try{for(wrongPublisher of [false,true]){
  const s=await setup();await s.t.run(async ctx=>{const connectionId=await ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'bitbucket-dc',instance:'https://bitbucket.fixture/bitbucket',name:'Native DC',credentials:encryptCredential(JSON.stringify({token:'fixture-dc-token',username:'openreview'}),s.organizationId+':bitbucket-dc'),webhookSecret:'fixture',active:true,createdAt:Date.now()});await ctx.db.patch(s.repo._id,{connectionId,externalId:'71',fullName:'ACME/payments'});});
  await s.t.mutation(api.runtime.save,{token:s.token,organizationId:s.organizationId,policy});await s.t.mutation(api.runtime.worker,{token:s.token,organizationId:s.organizationId,name:'Fixture worker',hash});await s.t.mutation(internal.runtime.claim,{hash,lease:randomUUID()});expect(await s.t.mutation(internal.runtime.request,{reviewId:s.reviewId})).toBe(true);
  const [job]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});await s.t.action(internal.runtimeJobs.prepare,{id:job._id});const [prepared]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});expect(prepared.evidence).toBeUndefined();
  if(wrongPublisher){expect(prepared.status).toBe('failed');expect(prepared.error).toContain('publisher changed');}
  else{expect(prepared.status).toBe('queued');const lease=randomUUID();expect((await s.t.mutation(internal.runtime.claim,{hash,lease}))?.id).toBe(job._id);const source=await s.t.fetch('/runtime/snapshot',{method:'POST',headers:{authorization:'Bearer '+credential},body:JSON.stringify({id:job._id,lease})});expect(source.status).toBe(200);expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array(bytes));}
 }}finally{if(previousHosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=previousHosts;}
 expect(archiveReads).toBe(2);
});
async function setup(){
 process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET="runtime-service";
 const t=convexTest(schema,modules),user=await t.mutation(api.users.login,{secret:"runtime-service",githubId:1001,login:"runtime-owner",avatar:""});
 const token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:"Runtime tests"});
 await t.mutation(api.repositories.connect,{token,secret:"runtime-service",organizationId,installationId:9001,account:"runtime-owner",accountId:1001,repositories:[{id:9010,fullName:"runtime-owner/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 const reviewId=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return ctx.db.insert("reviews",{organizationId,repositoryId:repo._id,prNumber:1,headSha:"b".repeat(40),status:"ingesting",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});});
 const evidence={headSha:"b".repeat(40),image:policy.image,command:policy.command,exitCode:0,timedOut:false,executionStarted:true,output:"All checks passed",outputTruncated:false,network:"none" as const,memoryMb:512 as const,cpus:1 as const};
 return {t,token,organizationId,repo,reviewId,evidence};
}
async function queued(){
 const s=await setup();
 await s.t.mutation(api.runtime.save,{token:s.token,organizationId:s.organizationId,policy});
 const workerId=await s.t.mutation(api.runtime.worker,{token:s.token,organizationId:s.organizationId,name:"Fixture worker",hash});
 await s.t.mutation(internal.runtime.claim,{hash,lease:randomUUID()});
 expect(await s.t.mutation(internal.runtime.request,{reviewId:s.reviewId})).toBe(true);
 const [job]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});
 await s.t.mutation(internal.runtime.preparing,{id:job._id});
 const sourceStorageId=await s.t.run(ctx=>ctx.storage.store(new Blob(["private-exact-revision-archive"])));
 await s.t.mutation(internal.runtime.ready,{id:job._id,sourceStorageId});
 return {...s,workerId,job,sourceStorageId};
}
test("runtime is opt-in and missing workers yield visible unavailability without fabricated execution",async()=>{
 const {t,token,organizationId,reviewId}=await setup();
 expect(await t.mutation(internal.runtime.request,{reviewId})).toBe(false);
 expect(await t.query(api.runtime.review,{token,reviewId})).toEqual([]);
 await expect(t.mutation(api.runtime.save,{token,organizationId,policy:{...policy,image:"node:latest"}})).rejects.toThrow("digest");
 await t.mutation(api.runtime.save,{token,organizationId,policy});
 expect(await t.mutation(internal.runtime.request,{reviewId})).toBe(false);
 const [job]=await t.query(api.runtime.review,{token,reviewId});expect(job.status).toBe("unavailable");expect(job.evidence).toBeUndefined();
});
test("public review requests cannot fabricate worker runtime evidence",async()=>{
 const {t,token,repo,reviewId,evidence}=await setup();
 await expect(t.mutation(api.reviews.request,{token,repositoryId:repo._id,prNumber:1,headSha:evidence.headSha,runtimeEvidence:evidence})).rejects.toThrow("paired runtime worker");
 const reviews=await t.run(ctx=>ctx.db.query("reviews").collect());
 expect(reviews).toHaveLength(1);expect(reviews[0]._id).toBe(reviewId);expect(reviews[0].runtimeEvidence).toBeUndefined();expect(reviews[0].status).toBe("ingesting");
});
test("runtime claims, source access and completion are bound to one worker, lease, policy and exact revision",async()=>{
 const {t,token,organizationId,reviewId,evidence,job,workerId,sourceStorageId}=await queued(),lease=randomUUID();
 const claimed=await t.mutation(internal.runtime.claim,{hash,lease});expect(claimed?.id).toBe(job._id);
 expect(await t.mutation(internal.runtime.claim,{hash,lease:randomUUID()})).toBeNull();
 expect((await t.query(api.runtime.settings,{token,organizationId})).workers[0]).not.toHaveProperty("tokenHash");
 const source=await t.fetch("/runtime/snapshot",{method:"POST",headers:{authorization:"Bearer "+credential},body:JSON.stringify({id:job._id,lease})});expect(source.status).toBe(200);expect(await source.text()).toBe("private-exact-revision-archive");
 const originalDeadline=(await t.query(api.runtime.review,{token,reviewId}))[0].leaseExpiresAt;
 await t.run(ctx=>ctx.db.patch(workerId,{lastSeen:Date.now()-130000}));
 const heartbeat=await t.fetch("/runtime/heartbeat",{method:"POST",headers:{authorization:"Bearer "+credential},body:JSON.stringify({id:job._id,lease})});expect(heartbeat.status).toBe(200);
 expect((await t.query(api.runtime.settings,{token,organizationId})).workers[0].lastSeen).toBeGreaterThan(Date.now()-120000);
 expect((await t.query(api.runtime.review,{token,reviewId}))[0].leaseExpiresAt).toBe(originalDeadline);
 expect((await t.fetch("/runtime/heartbeat",{method:"POST",headers:{authorization:"Bearer "+credential},body:JSON.stringify({id:job._id,lease:randomUUID()})})).status).toBe(401);
 const otherOrg=await t.mutation(api.users.createOrganization,{token,name:"Other runtime workspace"}),otherCredential="orw_"+"c".repeat(64),otherHash=createHash("sha256").update(otherCredential).digest("hex");
 await t.mutation(api.runtime.worker,{token,organizationId:otherOrg,name:"Other worker",hash:otherHash});
 expect(await t.mutation(internal.runtime.claim,{hash:otherHash,lease:randomUUID()})).toBeNull();
 expect((await t.fetch("/runtime/heartbeat",{method:"POST",headers:{authorization:"Bearer "+otherCredential},body:JSON.stringify({id:job._id,lease})})).status).toBe(401);
 expect((await t.fetch("/runtime/snapshot",{method:"POST",headers:{authorization:"Bearer "+otherCredential},body:JSON.stringify({id:job._id,lease})})).status).toBe(401);
 expect((await t.fetch("/runtime/snapshot",{method:"POST",headers:{authorization:"Bearer "+credential},body:JSON.stringify({id:job._id,lease:randomUUID()})})).status).toBe(401);
 await expect(t.mutation(internal.runtime.complete,{id:job._id,hash,lease,evidence:{...evidence,headSha:"c".repeat(40)}})).rejects.toThrow("approved job");
 await t.mutation(internal.runtime.complete,{id:job._id,hash,lease,evidence});
 expect((await t.query(api.runtime.review,{token,reviewId}))[0].status).toBe("passed");
 expect((await t.query(internal.reviews.data,{reviewId})).review.runtimeEvidence?.headSha).toBe(evidence.headSha);
 expect(await t.run(ctx=>ctx.storage.get(sourceStorageId))).toBeNull();
 await expect(t.query(internal.runtime.authenticatedJob,{id:job._id,hash,lease})).rejects.toThrow("replayed");
 expect((await t.fetch("/runtime/heartbeat",{method:"POST",headers:{authorization:"Bearer "+credential},body:JSON.stringify({id:job._id,lease})})).status).toBe(401);
});
test("runtime policies inherit from trusted scopes and viewers cannot approve commands or register workers",async()=>{
 const {t,token,organizationId,repo,reviewId}=await setup();
 await t.mutation(api.runtime.save,{token,organizationId,policy});
 await t.mutation(api.runtime.save,{token,organizationId,repositoryId:repo._id,policy:{...policy,enabled:false}});
 expect(await t.mutation(internal.runtime.request,{reviewId})).toBe(false);expect(await t.query(api.runtime.review,{token,reviewId})).toEqual([]);
 await t.mutation(api.runtime.save,{token,organizationId,repositoryId:repo._id,policy,inherit:true});
 await t.mutation(internal.runtime.request,{reviewId});expect((await t.query(api.runtime.review,{token,reviewId}))[0].policy.enabled).toBe(true);
 const user=await t.mutation(api.users.login,{secret:"runtime-service",githubId:1002,login:"runtime-viewer",avatar:""});
 const viewer=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
 const invitationId=await t.mutation(api.users.invite,{token,organizationId,githubLogin:"runtime-viewer",role:"viewer"});await t.mutation(api.users.acceptInvitation,{token:viewer,invitationId});
 await expect(t.mutation(api.runtime.save,{token:viewer,organizationId,policy})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.runtime.worker,{token:viewer,organizationId,name:"Unauthorized",hash:"d".repeat(64)})).rejects.toThrow("Forbidden");
});
test("policy changes, stale provider revisions, revoked workers and expired leases cannot attach execution evidence",async()=>{
 const s=await queued(),lease=randomUUID();await s.t.mutation(internal.runtime.claim,{hash,lease});
 await s.t.mutation(api.runtime.save,{token:s.token,organizationId:s.organizationId,policy:{...policy,command:"different approved command"}});
 await expect(s.t.query(internal.runtime.authenticatedJob,{id:s.job._id,hash,lease,source:true})).rejects.toThrow("policy changed");
 await s.t.mutation(internal.runtime.complete,{id:s.job._id,hash,lease,evidence:s.evidence});
 expect((await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId}))[0].status).toBe("cancelled");
 expect((await s.t.query(internal.reviews.data,{reviewId:s.reviewId})).review.runtimeEvidence).toBeUndefined();
 const stale=await queued(),secondLease=randomUUID();await stale.t.mutation(internal.runtime.claim,{hash,lease:secondLease});
 vi.spyOn(Github,"installation").mockResolvedValue(new Github("fixture"));vi.spyOn(Github.prototype,"pullRequest").mockResolvedValue({state:"open",head:{sha:"c".repeat(40)}} as Awaited<ReturnType<Github["pullRequest"]>>);
 await stale.t.action(internal.runtimeJobs.report,{id:stale.job._id,hash,lease:secondLease,evidence:stale.evidence});
 expect((await stale.t.query(api.runtime.review,{token:stale.token,reviewId:stale.reviewId}))[0].status).toBe("cancelled");
 const expired=await queued(),thirdLease=randomUUID();await expired.t.mutation(internal.runtime.claim,{hash,lease:thirdLease});
 await expired.t.run(ctx=>ctx.db.patch(expired.job._id,{leaseExpiresAt:Date.now()-1}));await expired.t.mutation(internal.runtime.recoverPage,{status:"running",cursor:null});
 expect((await expired.t.query(api.runtime.review,{token:expired.token,reviewId:expired.reviewId}))[0].status).toBe("timed_out");
 await expired.t.mutation(api.runtime.revoke,{token:expired.token,workerId:expired.workerId});
 await expect(expired.t.mutation(internal.runtime.claim,{hash,lease:randomUUID()})).rejects.toThrow("revoked");
});

test("Origin inline and signed archives reach the authorized durable source path without inventing execution",async()=>{
 const prior=process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS;process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS='origin-cdn.fixture';process.env.CREDENTIAL_ENCRYPTION_KEY='runtime-origin-key-at-least-32-characters';
 const key=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString(),bytes=gzipSync('native archive fixture'),sha='b'.repeat(40);let mode='inline',downloads=0;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=String(input);if(url.startsWith('https://origin-cdn.fixture/')){downloads++;expect(new Headers(init?.headers).get('authorization')).toBeNull();expect(init?.redirect).toBe('error');return new Response(bytes);}
  if(url.endsWith('/access_tokens'))return Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()});
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oit_fixture');
  if(url.endsWith('/repo_fixture'))return Response.json({id:'repo_fixture'});if(url.includes('/git/commits/'))return Response.json({sha});
  expect(url).toBe('https://api.cursor.com/v1/origin/repos/_/repo_fixture/tarball/'+sha);expect(init?.redirect).toBe('manual');
  return mode==='inline'?new Response(bytes):new Response(null,{status:302,headers:{location:'https://'+(mode==='unapproved'?'unapproved.fixture':'origin-cdn.fixture')+'/archive/'+sha+'?signature=fixture'}});
 });
 try{for(mode of ['inline','signed','unapproved']){
  const s=await setup();await s.t.run(async ctx=>{const connectionId=await ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'origin',instance:'https://api.cursor.com',name:'Native Origin',installationId:'i_fixture',namespaceId:'ns_fixture',credentials:encryptCredential(JSON.stringify({appId:'app_fixture',installationId:'i_fixture',privateKey:key}),s.organizationId+':origin'),webhookSecret:'',active:true,createdAt:Date.now()});await ctx.db.patch(s.repo._id,{connectionId,externalId:'repo_fixture',fullName:'acme/source'});await ctx.db.patch(s.reviewId,{revisionKey:'4'});});
  await s.t.mutation(api.runtime.save,{token:s.token,organizationId:s.organizationId,policy});await s.t.mutation(api.runtime.worker,{token:s.token,organizationId:s.organizationId,name:'Fixture worker',hash});await s.t.mutation(internal.runtime.claim,{hash,lease:randomUUID()});expect(await s.t.mutation(internal.runtime.request,{reviewId:s.reviewId})).toBe(true);
  const [job]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});await s.t.action(internal.runtimeJobs.prepare,{id:job._id});const [prepared]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});expect(prepared.evidence).toBeUndefined();expect(prepared.headSha).toBe(sha);expect(prepared.revisionKey).toBe('4');
  if(mode==='unapproved'){expect(prepared.status).toBe('failed');expect(prepared.error).toContain('ORIGIN_ARCHIVE_ALLOWED_HOSTS');}
  else{expect(prepared.status).toBe('queued');const lease=randomUUID();expect((await s.t.mutation(internal.runtime.claim,{hash,lease}))?.id).toBe(job._id);const source=await s.t.fetch('/runtime/snapshot',{method:'POST',headers:{authorization:'Bearer '+credential},body:JSON.stringify({id:job._id,lease})});expect(source.status).toBe(200);expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array(bytes));}
 }}finally{if(prior===undefined)delete process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS;else process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS=prior;}
 expect(downloads).toBe(1);
});

test('Bitbucket Cloud raw native runtime source reaches durable worker snapshot and unsupported files leave no execution evidence',async()=>{
 process.env.CREDENTIAL_ENCRYPTION_KEY='runtime-bitbucket-cloud-key-at-least-32-characters';
 const workspace='11111111-1111-4111-8111-111111111111',repositoryId='22222222-2222-4222-8222-222222222222',sha='b'.repeat(40);let unsupported=false;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=new URL(String(input));expect(url.hostname).toBe('api.bitbucket.org');expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-system-token');
  if(url.pathname.includes('/commit/'))return Response.json({hash:sha});
  if(!url.pathname.includes('/src/'))return Response.json({uuid:'{'+repositoryId+'}',workspace:{uuid:'{'+workspace+'}'},full_name:'acme/source'});
  const entry={path:'file.bin',type:'commit_file',size:3,attributes:unsupported?['link']:['binary'],commit:{hash:sha}};
  if(url.pathname.endsWith('/'))return Response.json({values:[entry],size:1});if(url.searchParams.get('format')==='meta')return Response.json(entry);return new Response(new Uint8Array([0,255,1]));
 });
 for(unsupported of [false,true]){
  const s=await setup();await s.t.run(async ctx=>{const connectionId=await ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'bitbucket-cloud',instance:'https://api.bitbucket.org',name:'Cloud fixture',namespaceId:workspace,credentials:encryptCredential(JSON.stringify({systemToken:'fixture-system-token',publisherId:workspace,receivedAt:Date.now(),expiresAt:Date.now()+3600000}),s.organizationId+':bitbucket-cloud'),webhookSecret:'',active:true,createdAt:Date.now()});await ctx.db.patch(s.repo._id,{connectionId,externalId:'{'+repositoryId+'}',fullName:'acme/source'});});
  await s.t.mutation(api.runtime.save,{token:s.token,organizationId:s.organizationId,policy});await s.t.mutation(api.runtime.worker,{token:s.token,organizationId:s.organizationId,name:'Fixture worker',hash});await s.t.mutation(internal.runtime.claim,{hash,lease:randomUUID()});expect(await s.t.mutation(internal.runtime.request,{reviewId:s.reviewId})).toBe(true);
  const [job]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});await s.t.action(internal.runtimeJobs.prepare,{id:job._id});const [prepared]=await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId});expect(prepared.evidence).toBeUndefined();
  if(unsupported){expect(prepared.status).toBe('failed');expect(prepared.error).toContain('unsupported symlink');}
  else{expect(prepared.status).toBe('queued');const lease=randomUUID();expect((await s.t.mutation(internal.runtime.claim,{hash,lease}))?.id).toBe(job._id);const source=await s.t.fetch('/runtime/snapshot',{method:'POST',headers:{authorization:'Bearer '+credential},body:JSON.stringify({id:job._id,lease})});expect(source.status).toBe(200);const {gunzipSync}=await import('node:zlib'),tar=gunzipSync(await source.arrayBuffer());expect(tar.subarray(0,15).toString()).toContain('source/file.bin');expect(tar.subarray(512,515)).toEqual(Buffer.from([0,255,1]));}
 }
});

test('runtime HTTP distinguishes rejected worker credentials from expired job leases',async()=>{
 const s=await queued(),lease=randomUUID();
 await s.t.mutation(internal.runtime.claim,{hash,lease});
 const request=(path:string,body:unknown)=>s.t.fetch('/runtime/'+path,{method:'POST',headers:{authorization:'Bearer '+credential},body:JSON.stringify(body)});
 const stale=await request('heartbeat',{id:s.job._id,lease:randomUUID()});expect(stale.status).toBe(401);expect(await stale.json()).not.toHaveProperty('code');
 await s.t.mutation(api.runtime.revoke,{token:s.token,workerId:s.workerId});
 for(const [path,body] of [['claim',{lease}],['heartbeat',{id:s.job._id,lease}],['snapshot',{id:s.job._id,lease}],['report',{id:s.job._id,lease,error:'No execution'}]] as const){
  const denied=await request(path,body);expect(denied.status).toBe(401);expect(await denied.json()).toMatchObject({code:'worker_credential_rejected'});
 }
 await s.t.run(ctx=>ctx.db.patch(s.workerId,{revoked:false,expiresAt:0}));
 expect(await (await request('claim',{lease})).json()).toMatchObject({code:'worker_credential_rejected'});
 const unknown=await s.t.fetch('/runtime/claim',{method:'POST',headers:{authorization:'Bearer orw_'+'b'.repeat(64)},body:JSON.stringify({lease})});expect(await unknown.json()).toMatchObject({code:'worker_credential_rejected'});
 expect((await s.t.query(api.runtime.review,{token:s.token,reviewId:s.reviewId}))[0].evidence).toBeUndefined();
});

test("runtime recovery traverses all statuses beyond 1,000 healthy jobs, cleans source and preserves live work on overlapping sweeps",async()=>{
 vi.useFakeTimers();const s=await setup(),now=Date.now(),statuses=["preparing","fetching","queued","running"] as const;
 const expired=await s.t.run(async ctx=>{
  // A terminal review isolates recovery traversal from a new model review.
  await ctx.db.patch(s.reviewId,{status:"completed"});
  const common={organizationId:s.organizationId,repositoryId:s.repo._id,reviewId:s.reviewId,headSha:"b".repeat(40),policy,policyKey:"fixture",attempts:0,createdAt:now,updatedAt:now};
  const targets=[];
  for(const status of statuses){
   for(let i=0;i<1000;i++)await ctx.db.insert("runtimeJobs",{...common,status,...(status==="running"?{lease:"live",leaseExpiresAt:now+600000}:{})});
   const sourceStorageId=await ctx.storage.store(new Blob(["discard expired exact-revision source"]));
   targets.push({id:await ctx.db.insert("runtimeJobs",{...common,status,updatedAt:now-300001,sourceStorageId,...(status==="running"?{lease:"expired",leaseExpiresAt:now-1}:{})}),sourceStorageId});
  }
  return targets;
 });
 for(const status of statuses){
  let cursor:string|null=null,pages=0,recovered=0;
  for(;;){const page:{isDone:boolean;cursor:string;recovered:number}=await s.t.mutation(internal.runtime.recoverPage,{status,cursor});pages++;recovered+=page.recovered;if(page.isDone)break;cursor=page.cursor;}
  expect(pages).toBe(11);expect(recovered).toBe(1);
 }
 for(let i=0;i<expired.length;i++){
  const job=await s.t.run(ctx=>ctx.db.get(expired[i].id));expect(job?.status).toBe(statuses[i]==="running"?"timed_out":"unavailable");expect(job?.evidence).toBeUndefined();expect(job?.sourceStorageId).toBeUndefined();expect(job?.lease).toBeUndefined();
  expect(await s.t.run(ctx=>ctx.storage.get(expired[i].sourceStorageId))).toBeNull();
 }
 const late=await s.t.run(ctx=>ctx.db.insert("runtimeJobs",{organizationId:s.organizationId,repositoryId:s.repo._id,reviewId:s.reviewId,headSha:"b".repeat(40),policy,policyKey:"fixture",status:"queued",attempts:0,createdAt:now,updatedAt:now-300001}));
 await s.t.mutation(internal.runtime.recover,{});await s.t.mutation(internal.runtime.recover,{});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 expect((await s.t.run(ctx=>ctx.db.get(late)))?.status).toBe("unavailable");
 for(const status of statuses)expect(await s.t.run(ctx=>ctx.db.query("runtimeJobs").withIndex("by_status",q=>q.eq("status",status)).collect())).toHaveLength(1000);
 expect(await s.t.run(ctx=>ctx.db.query("modelCalls").collect())).toHaveLength(0);
 expect((await s.t.run(ctx=>ctx.db.get(s.reviewId)))?.runtimeEvidence).toBeUndefined();
});
