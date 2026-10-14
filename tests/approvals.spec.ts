import {test,expect,vi,afterEach,beforeEach} from "vitest";
import {convexTest} from "convex-test";
import {SignJWT} from "jose";
import {randomUUID} from "node:crypto";
import schema from "../convex/schema";
import {api,internal} from "../convex/_generated/api";
import {BitbucketCloud} from "../src/bitbucket-cloud";
import {encryptCredential} from "../src/credentials";
import {Github} from "../src/github";
import {approvalDefaults} from "../src/approval";
const modules=import.meta.glob("../convex/**/*.ts"),secret="approval-fixture-secret-at-least-32-characters",head="a".repeat(40),policy={...approvalDefaults,enabled:true,requiredChecks:[{name:"regression",appId:42}]};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function setup(){
 process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET="approval-service";
 const t=convexTest(schema,modules),user=await t.mutation(api.users.login,{secret:"approval-service",githubId:3001,login:"approval-owner",avatar:""});
 const token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:"HS256"}).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:"Approval tests"});
 await t.mutation(api.repositories.connect,{token,secret:"approval-service",organizationId,installationId:9301,account:"approval-owner",accountId:3001,repositories:[{id:9310,fullName:"approval-owner/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 const reviewId=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return ctx.db.insert("reviews",{organizationId,repositoryId:repo._id,prNumber:1,headSha:head,status:"completed",mode:"standard",attempts:1,coverageLimits:[],approvalAssessment:{risk:"low",confidence:1,reason:"Only a documented display label changes in this fixture."},createdAt:Date.now(),updatedAt:Date.now()});});
 const scm=new Github("fixture"),reviews:{id:number;body:string|null;commit_id:string;state:string;user:{login:string;type:string}}[]=[];
 const snapshot={pr:{revisionKey:undefined as string|undefined,number:1,title:"Docs",body:null,draft:false,state:"open",html_url:"https://github.com/approval-owner/example/pull/1",user:{login:"alice"},head:{sha:head,ref:"docs"},base:{sha:"b".repeat(40),ref:"main"},diff:[{path:"docs/start.md",status:"modified",patch:"@@ -1 +1 @@\n-old\n+new"}],comments:[],reviews:[],commits:[],checks:[]},checks:[{name:"regression",appId:42,status:"completed",conclusion:"success"}],nativeRequiredChecks:[],humanChangeRequested:false,reviews,botLogin:"openreview[bot]"};
 vi.spyOn(Github,"installation").mockResolvedValue(scm);
 vi.spyOn(scm,"approvalSnapshot").mockImplementation(async()=>snapshot);
 const approve=vi.spyOn(scm,"approve").mockImplementation(async(_repo,_number,sha,marker)=>{reviews.push({id:101,body:marker,commit_id:sha,state:"APPROVED",user:{login:"openreview[bot]",type:"Bot"}});return {id:101,reused:false};});
 const dismiss=vi.spyOn(scm,"dismissApproval").mockImplementation(async()=>{reviews[0].state="DISMISSED";});
 return {t,token,user,organizationId,repo,reviewId,scm,snapshot,approve,dismiss};
}
test("approval is disabled by default, inherited from trusted admins, and isolated across workspaces",async()=>{
 const s=await setup();expect(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId})).toBeNull();
 const teamId=await s.t.mutation(api.scopes.createTeam,{token:s.token,organizationId:s.organizationId,name:"Team"});
 await s.t.mutation(api.scopes.assign,{token:s.token,repositoryId:s.repo._id,teamId});
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy:approvalDefaults});
 expect(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId})).toBeNull();
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy:approvalDefaults,inherit:true});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;expect((await s.t.query(internal.approvals.data,{id})).policy.enabled).toBe(true);
 const other=await s.t.mutation(api.users.createOrganization,{token:s.token,name:"Other"});
 await expect(s.t.mutation(api.approvals.save,{token:s.token,organizationId:other,repositoryId:s.repo._id,policy})).rejects.toThrow("another workspace");
 await s.t.run(ctx=>ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",s.organizationId).eq("userId",s.user)).unique().then(m=>ctx.db.patch(m!._id,{role:"viewer"})));
 await expect(s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy})).rejects.toThrow("Forbidden");
});
test("duplicate events publish once and a later human objection invalidates the exact provider approval",async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 expect(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId})).toBe(id);
 await s.t.action(internal.approvalJobs.process,{id});
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:"approved",providerReviewId:101});
 expect(s.snapshot.reviews.map(r=>r.body)).toEqual(["<!-- openreview:approval:"+id+" -->"]);
 await s.t.action(internal.approvalJobs.process,{id});
 expect(s.approve).toHaveBeenCalledTimes(1);expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("approved");
 s.snapshot.humanChangeRequested=true;await s.t.action(internal.approvalJobs.process,{id});
 expect(s.dismiss).toHaveBeenCalledWith(s.repo.fullName,1,101);expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("invalidated");
});
test("approval leases, missing checks, and policy changes during publication fail closed",async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 expect(await s.t.mutation(internal.approvals.claim,{id,lease:randomUUID()})).toBe(true);
 expect(await s.t.mutation(internal.approvals.claim,{id,lease:randomUUID()})).toBe(false);
 await s.t.run(ctx=>ctx.db.patch(id,{leaseExpiresAt:0}));
 s.snapshot.checks=[];await s.t.action(internal.approvalJobs.process,{id});expect(s.approve).not.toHaveBeenCalled();
 expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("waiting_checks");
 s.snapshot.checks=[{name:"regression",appId:42,status:"completed",conclusion:"success"}];
 s.approve.mockImplementation(async(_repo,_number,sha,marker)=>{s.snapshot.reviews.push({id:101,body:marker,commit_id:sha,state:"APPROVED",user:{login:"openreview[bot]",type:"Bot"}});await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy:approvalDefaults});return {id:101,reused:false};});
 await s.t.action(internal.approvalJobs.process,{id});expect(s.dismiss).toHaveBeenCalledTimes(1);
 expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("invalidated");
});
test("new revisions invalidate prior approvals and unsupported providers never publish",async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;await s.t.action(internal.approvalJobs.process,{id});
 s.snapshot.pr.head.sha="c".repeat(40);await s.t.action(internal.approvalJobs.process,{id});expect(s.dismiss).toHaveBeenCalledTimes(1);
 const other=await setup();await other.t.mutation(api.approvals.save,{token:other.token,organizationId:other.organizationId,policy});const otherId=(await other.t.mutation(internal.approvals.request,{reviewId:other.reviewId}))!;
 Object.defineProperty(other.scm,"supportsApproval",{value:false});await other.t.action(internal.approvalJobs.process,{id:otherId});expect(other.approve).not.toHaveBeenCalled();expect((await other.t.query(api.approvals.review,{token:other.token,reviewId:other.reviewId}))?.status).toBe("unsupported");
});

test("Perforce inherited approval is explicitly unsupported without native reads; direct enabling is rejected",async()=>{
 const s=await setup();
 await s.t.run(async ctx=>{
  const connectionId=await ctx.db.insert("providerConnections",{organizationId:s.organizationId,kind:"perforce",instance:"https://p4.example",name:"P4",credentials:"unreadable-on-purpose",webhookSecret:"",active:true,createdAt:Date.now()});
  await ctx.db.patch(s.repo._id,{connectionId,installationId:undefined,githubId:undefined,externalId:"project"});
 });
 expect((await s.t.query(api.approvals.settings,{token:s.token,organizationId:s.organizationId})).repositoryIds).not.toContain(s.repo._id);
 await expect(s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy})).rejects.toThrow("unavailable for Perforce");
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Native approval must not be contacted"));
 await s.t.action(internal.approvalJobs.process,{id});
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:"unsupported",reasons:["Automatic approval is unavailable for Perforce; native transitions are not revision guarded"]});
 expect(fetch).not.toHaveBeenCalled();expect(s.approve).not.toHaveBeenCalled();
 await s.t.mutation(internal.approvals.forChange,{repositoryId:s.repo._id,prNumber:1});
 await s.t.action(internal.approvalJobs.process,{id});
 expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("unsupported");
 expect(fetch).not.toHaveBeenCalled();
 // Disabled legacy overrides can still be retained or removed to restore inheritance.
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy:approvalDefaults});
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy,inherit:true});
 // An unexpected existing native receipt must preserve withdrawal intent, never be hidden as unsupported.
 await s.t.run(ctx=>ctx.db.patch(id,{status:"revocation_pending",providerReviewId:107}));
 await s.t.action(internal.approvalJobs.process,{id});
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:"revocation_pending",providerReviewId:107});
});

test("provider-native revision keys gate publication, replay and post-publication races",async()=>{
 const s=await setup();s.snapshot.pr.revisionKey="base-one:start-one";
 await s.t.run(ctx=>ctx.db.patch(s.reviewId,{revisionKey:s.snapshot.pr.revisionKey}));
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 s.snapshot.pr.revisionKey="base-two:start-one";await s.t.action(internal.approvalJobs.process,{id});
 expect(s.approve).not.toHaveBeenCalled();expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.reasons).toContain("Review does not cover the current revision");
 s.snapshot.pr.revisionKey="base-one:start-one";await s.t.action(internal.approvalJobs.process,{id});
 expect(s.approve).toHaveBeenCalledTimes(1);expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("approved");
 s.snapshot.pr.revisionKey="base-two:start-one";await s.t.action(internal.approvalJobs.process,{id});
 expect(s.dismiss).toHaveBeenCalledTimes(1);expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("invalidated");
 const race=await setup();race.snapshot.pr.revisionKey="base-one:start-one";await race.t.run(ctx=>ctx.db.patch(race.reviewId,{revisionKey:race.snapshot.pr.revisionKey}));
 await race.t.mutation(api.approvals.save,{token:race.token,organizationId:race.organizationId,policy});const raceId=(await race.t.mutation(internal.approvals.request,{reviewId:race.reviewId}))!;
 race.approve.mockImplementation(async(_repo,_number,sha,marker)=>{race.snapshot.reviews.push({id:101,body:marker,commit_id:sha,state:"APPROVED",user:{login:"openreview[bot]",type:"Bot"}});race.snapshot.pr.revisionKey="base-two:start-one";return {id:101,reused:false};});
 await race.t.action(internal.approvalJobs.process,{id:raceId});expect(race.dismiss).toHaveBeenCalledTimes(1);expect((await race.t.query(api.approvals.review,{token:race.token,reviewId:race.reviewId}))?.status).toBe("invalidated");
});
test("native approval disappearing during publication never produces an approved job",async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 s.approve.mockImplementation(async()=>({id:101,reused:false}));s.dismiss.mockResolvedValue();
 await s.t.action(internal.approvalJobs.process,{id});
 expect(s.dismiss).toHaveBeenCalledWith(s.repo.fullName,1,101);
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:"invalidated",reasons:["Provider approval was not confirmed after publication"]});
});

test('Origin opaque approval IDs survive durable publication, replay and native-version invalidation',async()=>{
 const {Origin}=await import('../src/origin'),{encryptCredential}=await import('../src/credentials');
 process.env.CREDENTIAL_ENCRYPTION_KEY='origin-approval-fixture-key-at-least-32-characters';
 const s=await setup(),base='b'.repeat(40),reference={id:'pr_fixture',number:'1',repository:{id:'repo_fixture'}};
 let nativeVersion='3',writes=0,dismissals=0;const nativeReviews:Record<string,unknown>[]=[];
 await s.t.run(async ctx=>{
  const connectionId=await ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'origin',instance:'https://api.cursor.com',name:'Origin fixture',installationId:'i_fixture',namespaceId:'ns_fixture',credentials:encryptCredential(JSON.stringify({appId:'app_fixture',installationId:'i_fixture',privateKey:'fixture signing key not used in native-response tests'}),s.organizationId+':origin'),webhookSecret:'',active:true,createdAt:Date.now()});
  await ctx.db.patch(s.repo._id,{connectionId,externalId:'repo_fixture',fullName:'acme/source'});await ctx.db.patch(s.reviewId,{revisionKey:'3'});
 });
 vi.spyOn(Origin.prototype,'request').mockImplementation(async(endpoint,validator,input,method)=>{
  const version={number:nativeVersion,headSha:head,baseSha:base};
  if(endpoint.endsWith('/pulls/1'))return validator.parse({number:'1',repository:{id:'repo_fixture'},title:'Change',state:'open',draft:false,author:{user:{id:'user_alice'}},head:{sha:head,ref:'feature'},base:{sha:base,ref:'main'},version,changedFiles:0});
  if(endpoint.includes('/mergeability'))return validator.parse({pullRequest:reference,verdict:'mergeable',blockers:[],evaluatedPullRequests:[reference],headSha:head,baseRef:'main',baseSha:base,evaluatedAt:new Date().toISOString()});
  if(endpoint.includes('/reviews?'))return validator.parse({pullRequest:reference,reviews:nativeReviews});
  if(endpoint.endsWith('/dismissals')){expect(method).toBe('PUT');expect(endpoint).toContain('/rev_fixture/');dismissals++;nativeReviews[0]={...nativeReviews[0],dismissal:{message:'Invalidated'}};return validator.parse(nativeReviews[0]);}
  if(endpoint.endsWith('/reviews')){writes++;expect(input).toMatchObject({verdict:'approve',versionNumber:'3'});const record={id:'rev_fixture',author:{app:{id:'app_fixture'}},verdict:'approve',body:(input as {body:string}).body,submittedAt:new Date().toISOString(),pullRequestVersion:version};nativeReviews.push(record);return validator.parse(record);}
  return validator.parse({pullRequest:reference,files:[],comments:[],commits:[],checkRuns:[]});
 });
 expect((await s.t.query(api.approvals.settings,{token:s.token,organizationId:s.organizationId})).repositoryIds).toContain(s.repo._id);
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy:{...approvalDefaults,enabled:true}});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 await s.t.action(internal.approvalJobs.process,{id});expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'approved',providerReviewId:'rev_fixture'});
 await s.t.action(internal.approvalJobs.process,{id});expect(writes).toBe(1);
 nativeVersion='4';await s.t.action(internal.approvalJobs.process,{id});expect(dismissals).toBe(1);expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'invalidated',providerReviewId:'rev_fixture'});
});
test("Bitbucket provider factory supports durable approvals, exact destination invalidation and scoped settings",async()=>{
 const s=await setup(),previous=process.env.CREDENTIAL_ENCRYPTION_KEY;process.env.CREDENTIAL_ENCRYPTION_KEY="approval-fixture-encryption-key-32-characters";
 try{
  const workspace="11111111-1111-4111-8111-111111111111",repository="22222222-2222-4222-8222-222222222222",publisher="33333333-3333-4333-8333-333333333333",target="c".repeat(40);
  const connectionId=await s.t.run(ctx=>ctx.db.insert("providerConnections",{organizationId:s.organizationId,kind:"bitbucket-cloud",instance:"https://bitbucket.org",name:"Native Forge fixture",namespaceId:workspace,installationId:"ari:cloud:ecosystem::installation/44444444-4444-4444-8444-444444444444",credentials:encryptCredential(JSON.stringify({systemToken:"fixture-system-token",publisherId:publisher,receivedAt:Date.now(),expiresAt:Date.now()+3600000}),s.organizationId+":bitbucket-cloud"),webhookSecret:"",active:true,suspended:false,createdAt:Date.now()}));
  await s.t.run(async ctx=>{await ctx.db.patch(s.repo._id,{connectionId,externalId:"{"+repository+"}",fullName:"acme/repo"});await ctx.db.patch(s.reviewId,{revisionKey:target});});
  expect((await s.t.query(api.approvals.settings,{token:s.token,organizationId:s.organizationId})).repositoryIds).toContain(s.repo._id);
  const reviews:{id:number;body:string;commit_id:string;state:string;user:{login:string;type:string}}[]=[],snapshot={...s.snapshot,pr:{...s.snapshot.pr,revisionKey:target},reviews,botLogin:"{"+publisher+"}"};
  vi.spyOn(BitbucketCloud.prototype,"approvalSnapshot").mockImplementation(async()=>snapshot);
  const approve=vi.spyOn(BitbucketCloud.prototype,"approve").mockImplementation(async(_repo,_number,sha,marker,login,key)=>{expect(key).toBe(target);reviews.push({id:901,body:marker,commit_id:sha,state:"APPROVED",user:{login,type:"Bot"}});return {id:901,reused:false};});
  const dismiss=vi.spyOn(BitbucketCloud.prototype,"dismissApproval").mockImplementation(async()=>{reviews[0].state="DISMISSED";});
  await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
  const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;await s.t.action(internal.approvalJobs.process,{id});
  expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:"approved",providerReviewId:901});await s.t.action(internal.approvalJobs.process,{id});expect(approve).toHaveBeenCalledTimes(1);
  snapshot.pr.revisionKey="d".repeat(40);await s.t.action(internal.approvalJobs.process,{id});expect(dismiss).toHaveBeenCalledWith("acme/repo",1,901);expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("invalidated");
  await s.t.run(ctx=>ctx.db.patch(connectionId,{suspended:true}));expect((await s.t.query(api.approvals.settings,{token:s.token,organizationId:s.organizationId})).repositoryIds).not.toContain(s.repo._id);
 }finally{if(previous===undefined)delete process.env.CREDENTIAL_ENCRYPTION_KEY;else process.env.CREDENTIAL_ENCRYPTION_KEY=previous;}
});

 test("Data Center provider factory preserves durable approval receipts and revision invalidation",async()=>{
 const {BitbucketDC}=await import("../src/bitbucket-dc"),s=await setup(),previous=process.env.CREDENTIAL_ENCRYPTION_KEY,allowed=process.env.SCM_ALLOWED_HOSTS;
 process.env.CREDENTIAL_ENCRYPTION_KEY="approval-fixture-encryption-key-32-characters";process.env.SCM_ALLOWED_HOSTS="bitbucket.example";
 try{
  const target="c".repeat(40),connectionId=await s.t.run(ctx=>ctx.db.insert("providerConnections",{organizationId:s.organizationId,kind:"bitbucket-dc",instance:"https://bitbucket.example",name:"Data Center native fixture",credentials:encryptCredential(JSON.stringify({token:"fixture-native-token",username:"openreview"}),s.organizationId+":bitbucket-dc"),webhookSecret:"",active:true,createdAt:Date.now()}));
  await s.t.run(async ctx=>{await ctx.db.patch(s.repo._id,{connectionId,externalId:"71",fullName:"ACME/payments"});await ctx.db.patch(s.reviewId,{revisionKey:target});});
  expect((await s.t.query(api.approvals.settings,{token:s.token,organizationId:s.organizationId})).repositoryIds).toContain(s.repo._id);
  const reviews:{id:number;body:string;commit_id:string;state:string;user:{login:string;type:string}}[]=[],snapshot={...s.snapshot,pr:{...s.snapshot.pr,revisionKey:target},reviews,botLogin:"openreview"};
  vi.spyOn(BitbucketDC.prototype,"approvalSnapshot").mockImplementation(async()=>snapshot);
  const approve=vi.spyOn(BitbucketDC.prototype,"approve").mockImplementation(async(_repo,_number,sha,marker,login,key)=>{expect(key).toBe(target);reviews.push({id:81,body:marker,commit_id:sha,state:"APPROVED",user:{login,type:"Bot"}});return {id:81,reused:false};});
  const dismiss=vi.spyOn(BitbucketDC.prototype,"dismissApproval").mockImplementation(async()=>{reviews[0].state="DISMISSED";});
  await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
  const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;await s.t.action(internal.approvalJobs.process,{id});
  expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:"approved",providerReviewId:81});await s.t.action(internal.approvalJobs.process,{id});expect(approve).toHaveBeenCalledTimes(1);
  snapshot.pr.revisionKey="d".repeat(40);await s.t.action(internal.approvalJobs.process,{id});expect(dismiss).toHaveBeenCalledWith("ACME/payments",1,81);expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.status).toBe("invalidated");
 }finally{if(previous===undefined)delete process.env.CREDENTIAL_ENCRYPTION_KEY;else process.env.CREDENTIAL_ENCRYPTION_KEY=previous;if(allowed===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=allowed;}
 });

test('policy saves refresh blocked approval diagnostics without a manual request',async()=>{
 const s=await setup();await s.t.run(async ctx=>{for(const job of await ctx.db.system.query('_scheduled_functions').collect())await ctx.scheduler.cancel(job._id);await ctx.db.patch(s.reviewId,{approvalAssessment:{risk:'low',confidence:.98,reason:'Recorded uncertainty'}});});
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;await s.t.action(internal.approvalJobs.process,{id});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.reasons).toEqual(['Maximum review confidence is required']);
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy:{...policy,excludedAuthors:['alice']}});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.reasons).toContain('Approval exclusion rule matched');
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy:approvalDefaults,inherit:true});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.reasons).toEqual(['Maximum review confidence is required']);expect(s.approve).not.toHaveBeenCalled();
});

test('blocked-policy rechecks page beyond 100 and stay within workspace and repository scope',async()=>{
 const s=await setup();await s.t.run(async ctx=>{for(const job of await ctx.db.system.query('_scheduled_functions').collect())await ctx.scheduler.cancel(job._id);});
 const otherOrg=await s.t.mutation(api.users.createOrganization,{token:s.token,name:'Independent approval workspace'});
 const records=await s.t.run(async ctx=>{
  const {_id:unusedId,_creationTime:unusedTime,...repoFields}=s.repo;void unusedId;void unusedTime;
  const unrelatedRepo=await ctx.db.insert('repositories',{...repoFields,fullName:'approval-owner/unrelated',githubId:9311});
  const foreignRepo=await ctx.db.insert('repositories',{...repoFields,organizationId:otherOrg,fullName:'approval-owner/foreign',githubId:9312});
  const make=async(repositoryId:typeof s.repo._id,organizationId:typeof s.organizationId,prNumber:number)=>{
   const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId,prNumber,headSha:head,status:'completed',mode:'standard',attempts:1,coverageLimits:[],approvalAssessment:{risk:'low',confidence:.98,reason:'Recorded uncertainty'},createdAt:Date.now(),updatedAt:Date.now()});
   return ctx.db.insert('approvalJobs',{organizationId,repositoryId,reviewId,prNumber,headSha:head,policyKey:'old',status:'blocked',reasons:['stale reason'],createdAt:Date.now(),updatedAt:Date.now()});
  };
  const selected=[];for(let i=0;i<101;i++)selected.push(await make(s.repo._id,s.organizationId,i+2));
  return {selected,unrelated:await make(unrelatedRepo,s.organizationId,200),foreign:await make(foreignRepo,otherOrg,201)};
 });
 await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,repositoryId:s.repo._id,policy:{...policy,excludedAuthors:['alice']}});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 await s.t.run(async ctx=>{
  for(const id of records.selected)expect((await ctx.db.get(id))?.reasons).toContain('Approval exclusion rule matched');
  expect((await ctx.db.get(records.unrelated))?.reasons).toEqual(['stale reason']);expect((await ctx.db.get(records.foreign))?.reasons).toEqual(['stale reason']);
 });expect(s.approve).not.toHaveBeenCalled();
});

test('post-publication verification failure withdraws the persisted native receipt',async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 vi.mocked(s.scm.approvalSnapshot!).mockResolvedValueOnce(s.snapshot).mockImplementation(async()=>{
  expect((await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId}))?.providerReviewId).toBe(101);
  throw Error('Native verification unavailable');
 });
 await s.t.action(internal.approvalJobs.process,{id});
 expect(s.approve).toHaveBeenCalledTimes(1);expect(s.dismiss).toHaveBeenCalledTimes(1);
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'invalidated',providerReviewId:101});
 expect(s.snapshot.reviews[0].state).toBe('DISMISSED');
});

test('failed withdrawals retain durable intent and retry without re-approval when gates recover',async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 vi.mocked(s.scm.approvalSnapshot!).mockResolvedValueOnce(s.snapshot).mockRejectedValueOnce(Error('Native verification unavailable'));
 s.dismiss.mockRejectedValueOnce(Error('Temporary provider outage'));
 await s.t.action(internal.approvalJobs.process,{id});
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'revocation_pending',providerReviewId:101});
 expect(s.snapshot.reviews[0].state).toBe('APPROVED');
 // Concurrent retry cannot steal a live withdrawal lease.
 expect(await s.t.mutation(internal.approvals.claim,{id,lease:'active-withdrawal'})).toBe(true);
 expect(await s.t.mutation(internal.approvals.claim,{id,lease:'duplicate-withdrawal'})).toBe(false);
 await s.t.run(ctx=>ctx.db.patch(id,{leaseExpiresAt:0}));
 await s.t.action(internal.approvalJobs.process,{id});
 expect(s.approve).toHaveBeenCalledTimes(1);expect(s.dismiss).toHaveBeenCalledTimes(2);
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'invalidated',providerReviewId:101});
 await s.t.action(internal.approvalJobs.process,{id});expect(s.approve).toHaveBeenCalledTimes(1);
});

test('an uncertain native publication recovers only its own marker and retries receipt discovery',async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 s.approve.mockImplementation(async(_repo,_number,sha,marker)=>{
  s.snapshot.reviews.push({id:101,body:marker,commit_id:sha,state:'APPROVED',user:{login:'openreview[bot]',type:'Bot'}});
  s.snapshot.reviews.push({id:102,body:'human approval',commit_id:sha,state:'APPROVED',user:{login:'human',type:'User'}});
  throw Error('Response lost after native write');
 });
 vi.mocked(s.scm.approvalSnapshot!).mockResolvedValueOnce(s.snapshot).mockRejectedValueOnce(Error('Native receipt unavailable'));
 await s.t.action(internal.approvalJobs.process,{id});
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'revocation_pending'});
 expect(s.dismiss).not.toHaveBeenCalled();
 await s.t.action(internal.approvalJobs.process,{id});
 expect(s.dismiss).toHaveBeenCalledWith(s.repo.fullName,1,101);expect(s.approve).toHaveBeenCalledTimes(1);
 expect(s.snapshot.reviews[1].state).toBe('APPROVED');
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'invalidated',providerReviewId:101});
});

test('periodic withdrawal recovery reaches expired work behind 1000 live leases',async()=>{
 const s=await setup();await s.t.run(async ctx=>{for(const job of await ctx.db.system.query('_scheduled_functions').collect())await ctx.scheduler.cancel(job._id);});
 s.snapshot.reviews.push({id:101,body:'owned receipt',commit_id:head,state:'APPROVED',user:{login:'openreview[bot]',type:'Bot'}});
 const records=await s.t.run(async ctx=>{
  const fields={organizationId:s.organizationId,repositoryId:s.repo._id,reviewId:s.reviewId,prNumber:1,headSha:head,policyKey:'original',status:'revocation_pending',providerReviewId:101,reasons:['Withdrawal unavailable'],createdAt:Date.now(),updatedAt:Date.now()};
  const live=[];for(let i=0;i<1000;i++)live.push(await ctx.db.insert('approvalJobs',{...fields,lease:'busy-'+i,leaseExpiresAt:Date.now()+3600000}));
  const expired=await ctx.db.insert('approvalJobs',{...fields,lease:'interrupted',leaseExpiresAt:0});
  return {live,expired};
 });
 await s.t.mutation(internal.approvals.sweep,{});
 await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 await s.t.run(async ctx=>{
  expect((await ctx.db.get(records.expired))?.status).toBe('invalidated');
  for(const id of records.live)expect(await ctx.db.get(id)).toMatchObject({status:'revocation_pending',leaseExpiresAt:expect.any(Number)});
 });expect(s.approve).not.toHaveBeenCalled();expect(s.dismiss).toHaveBeenCalledTimes(1);
});

test('legacy failed jobs with native receipts are withdrawn rather than accepted on retry',async()=>{
 const s=await setup();await s.t.mutation(api.approvals.save,{token:s.token,organizationId:s.organizationId,policy});
 const id=(await s.t.mutation(internal.approvals.request,{reviewId:s.reviewId}))!;
 s.snapshot.reviews.push({id:101,body:'existing receipt',commit_id:head,state:'APPROVED',user:{login:'openreview[bot]',type:'Bot'}});
 await s.t.run(ctx=>ctx.db.patch(id,{status:'failed',providerReviewId:101,reasons:['Prior verification failed']}));
 await s.t.action(internal.approvalJobs.process,{id});
 expect(s.approve).not.toHaveBeenCalled();expect(s.dismiss).toHaveBeenCalledWith(s.repo.fullName,1,101);
 expect(await s.t.query(api.approvals.review,{token:s.token,reviewId:s.reviewId})).toMatchObject({status:'invalidated',providerReviewId:101});
});
