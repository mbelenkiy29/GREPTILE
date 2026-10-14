import { beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import { createHmac,createHash,generateKeyPairSync,sign } from "node:crypto";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type {Id} from "../convex/_generated/dataModel";
import { encryptCredential, decryptCredential } from "../src/credentials";
import { BitbucketCloud } from "../src/bitbucket-cloud";
import { BitbucketDC } from "../src/bitbucket-dc";
import { Gitlab } from "../src/gitlab";
import { Github } from "../src/github";
import { Gitea } from "../src/gitea";
import { Origin } from "../src/origin";
import {Linear} from "../src/linear";
import { defaults } from "../src/review-settings";
import { HttpModel } from "../src/engine/model";

const modules = import.meta.glob("../convex/**/*.ts");
async function bridgeFinding(t: Awaited<ReturnType<typeof setup>>["t"], repositoryId: Id<"repositories">, reviewId: Id<"reviews">, confidence=1) {
 return t.run(async ctx=>{
  const review=(await ctx.db.get(reviewId))!;
  return ctx.db.insert("findings",{organizationId:review.organizationId,repositoryId,reviewId,prNumber:review.prNumber,title:"Preserve integer cents",description:"Converting cents here undercharges orders.",severity:"high",confidence,category:"data",filePath:"total.ts",startLine:1,endLine:1,commitSha:review.headSha,evidence:[{filePath:"total.ts",startLine:1,quote:"return total / 100;"}],impact:"Undercharge",suggestedFix:"Preserve cents",agent:"data",symbol:"total",fingerprint:crypto.randomUUID(),status:"open",createdAt:Date.now(),updatedAt:Date.now()});
 });
}
const secret = "integration-session-secret-at-least-32-characters";
beforeEach(() => {
  process.env.SESSION_SECRET = secret;
  process.env.SERVICE_SECRET = "integration-service-secret";
  process.env.GITHUB_WEBHOOK_SECRET = "integration-webhook-secret";
});
test("Forge installation authorization is admin scoped, revocable, expiring, atomic and cannot transfer installation ownership",async()=>{
 const {t,alice,bob,organizationId}=await setup(),service="integration-service-secret";
 const tokenHash="a".repeat(64),workspaceId="11111111-1111-4111-8111-111111111111",installationId="ari:cloud:ecosystem::installation/22222222-2222-4222-8222-222222222222";
 await expect(t.mutation(api.providerInstalls.beginBitbucket,{token:bob,organizationId,tokenHash})).rejects.toThrow("Forbidden");
 const grant=await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash});
 await expect(t.query(api.providerInstalls.inspect,{secret:"wrong",tokenHash})).rejects.toThrow("Unauthorized service");
 expect(await t.query(api.providerInstalls.inspect,{secret:service,tokenHash})).toMatchObject({organizationId});
 const args={secret:service,tokenHash,installationId,workspaceId,credentials:"encrypted-fixture",invocationId:"fit-one",invocationExpiresAt:Date.now()+20000};
 await expect(t.mutation(api.providerInstalls.connectBitbucket,{...args,secret:"wrong"})).rejects.toThrow("Unauthorized service");
 const id=await t.mutation(api.providerInstalls.connectBitbucket,args);
 await expect(t.mutation(api.providerInstalls.connectBitbucket,args)).rejects.toThrow("consumed");
 const connection=await t.run(ctx=>ctx.db.get(id));expect(connection).toMatchObject({kind:"bitbucket-cloud",namespaceId:workspaceId,organizationId,active:true,suspended:true});
 const refresh={secret:service,id,installationId,workspaceId,previousCredentials:"encrypted-fixture",credentials:"renewed-fixture",invocationId:"refresh-one",invocationExpiresAt:Date.now()+20000};
 await expect(t.query(api.providerInstalls.bitbucketInstallation,{secret:"wrong",installationId,workspaceId})).rejects.toThrow("Unauthorized service");
 await expect(t.query(api.providerInstalls.bitbucketInstallation,{secret:service,installationId,workspaceId:"foreign"})).rejects.toThrow("unavailable");
 expect(await t.query(api.providerInstalls.bitbucketInstallation,{secret:service,installationId,workspaceId})).toMatchObject({id,organizationId});
 await expect(t.mutation(api.providerInstalls.refreshBitbucket,{...refresh,workspaceId:"foreign"})).rejects.toThrow("authorized");
 await expect(t.mutation(api.providerInstalls.refreshBitbucket,{...refresh,invocationExpiresAt:Date.now()-1})).rejects.toThrow("authorized");
 await t.mutation(api.providerInstalls.refreshBitbucket,refresh);
 expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({credentials:"renewed-fixture",suspended:true});
 await expect(t.mutation(api.providerInstalls.refreshBitbucket,{...refresh,invocationId:"delayed"})).rejects.toThrow("authorized");
 await expect(t.mutation(api.providerInstalls.refreshBitbucket,{...refresh,previousCredentials:"renewed-fixture"})).rejects.toThrow("consumed");
 expect((await t.run(ctx=>ctx.db.get(grant.id)))!.consumed).toBe(true);
 const other=await t.mutation(api.users.createOrganization,{token:bob,name:"Other"}),otherHash="b".repeat(64);
 await t.mutation(api.providerInstalls.beginBitbucket,{token:bob,organizationId:other,tokenHash:otherHash});
 await expect(t.mutation(api.providerInstalls.connectBitbucket,{...args,tokenHash:otherHash,invocationId:"fit-two"})).rejects.toThrow("another workspace");
 expect(await t.query(api.providerInstalls.inspect,{secret:service,tokenHash:otherHash})).toMatchObject({organizationId:other});
 const renewHash="c".repeat(64);await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash:renewHash});
 await expect(t.mutation(api.providerInstalls.connectBitbucket,{...args,tokenHash:renewHash})).rejects.toThrow("invocation already consumed");
 expect(await t.mutation(api.providerInstalls.connectBitbucket,{...args,tokenHash:renewHash,invocationId:"fit-renew",credentials:"new-encrypted-fixture"})).toBe(id);
 const revokedHash="d".repeat(64),revoked=await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash:revokedHash});
 await t.mutation(api.providerInstalls.revoke,{token:alice,id:revoked.id});await expect(t.query(api.providerInstalls.inspect,{secret:service,tokenHash:revokedHash})).rejects.toThrow("consumed");
 const expiredHash="e".repeat(64),expired=await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash:expiredHash});
 await t.run(ctx=>ctx.db.patch(expired.id,{expiresAt:Date.now()-1}));await expect(t.query(api.providerInstalls.inspect,{secret:service,tokenHash:expiredHash})).rejects.toThrow("expired");
 await t.mutation(internal.providerInstalls.expire,{id:expired.id});expect(await t.run(ctx=>ctx.db.get(expired.id))).toBeNull();
 const changedHash="f".repeat(64);await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash:changedHash});
 const member=await t.run(ctx=>ctx.db.query("organizationMembers").filter(q=>q.eq(q.field("organizationId"),organizationId)).first());
 await t.run(ctx=>ctx.db.patch(member!._id,{role:"viewer"}));
 await expect(t.query(api.providerInstalls.inspect,{secret:service,tokenHash:changedHash})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.providerInstalls.connectBitbucket,{...args,tokenHash:changedHash,invocationId:"fit-demoted"})).rejects.toThrow("Forbidden");
 await t.run(ctx=>ctx.db.patch(member!._id,{role:"owner"}));
 await expect(t.mutation(api.providerInstalls.connectBitbucket,{...args,tokenHash:changedHash,invocationId:"fit-expired",invocationExpiresAt:Date.now()-1})).rejects.toThrow("Invalid verified");
 const listed=(await t.query(api.providerConnections.list,{token:alice,organizationId}))[0];expect(listed).not.toHaveProperty("credentials");
 await t.mutation(api.providerConnections.disconnect,{token:alice,id});expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({active:false,credentials:""});
 await expect(t.mutation(api.providerInstalls.refreshBitbucket,{...refresh,previousCredentials:"",invocationId:"after-disconnect"})).rejects.toThrow("authorized");
 await expect(t.mutation(api.providerConnections.save,{token:alice,secret:service,organizationId,kind:"bitbucket-cloud",instance:"https://api.bitbucket.org",name:"Bypass",credentials:"fixture",webhookSecret:""})).rejects.toThrow("Invalid connection");
});
test("Bitbucket Forge discovery, selection and indexing use bound unexpired native credentials",async()=>{
 vi.useFakeTimers();
 const {t,alice,bob,organizationId}=await setup(),workspaceId="11111111-1111-4111-8111-111111111111",repositoryId="22222222-2222-4222-8222-222222222222",publisherId="33333333-3333-4333-8333-333333333333",sha="a".repeat(40),secret="integration-service-secret";
 const previousKey=process.env.CREDENTIAL_ENCRYPTION_KEY;process.env.CREDENTIAL_ENCRYPTION_KEY="bitbucket-fixture-encryption-key-32-characters";
 try{
  const credentials=(expiresAt=Date.now()+60*60000)=>encryptCredential(JSON.stringify({systemToken:"fixture-system-token",publisherId,receivedAt:Date.now(),expiresAt}),organizationId+":bitbucket-cloud");
  await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash:"9".repeat(64)});
  const id=await t.mutation(api.providerInstalls.connectBitbucket,{secret,tokenHash:"9".repeat(64),installationId:"ari:cloud:ecosystem::installation/44444444-4444-4444-8444-444444444444",workspaceId,credentials:credentials(),invocationId:"factory-fixture",invocationExpiresAt:Date.now()+20000});
  await expect(t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id})).rejects.toThrow("native Forge event");
  await expect(t.action(api.providerJobs.activateBitbucket,{token:bob,connectionId:id})).rejects.toThrow("Forbidden");
  const installationId="ari:cloud:ecosystem::installation/44444444-4444-4444-8444-444444444444",previousCredentials=(await t.run(ctx=>ctx.db.get(id)))!.credentials;
  const proof={secret,installationId,workspaceId,invocationId:"setup-product",invocationExpiresAt:Date.now()+20000,body:JSON.stringify({eventType:"avi:bitbucket:push:repository",timestamp:new Date().toISOString(),actor:{type:"user",uuid:publisherId,accountId:"fixture-user"},workspace:{uuid:workspaceId},repository:{uuid:repositoryId},push:{ref:"main",closed:false,after:sha}})};
  expect(await t.mutation(api.providerInstalls.bitbucketEvent,proof)).toBeNull();expect(await t.run(ctx=>ctx.db.query("providerEvents").collect())).toHaveLength(0);
  await expect(t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id})).rejects.toThrow("scheduled token renewal");
  await t.mutation(api.providerInstalls.refreshBitbucket,{secret,id,installationId,workspaceId,previousCredentials,credentials:credentials(),invocationId:"setup-renewal",invocationExpiresAt:Date.now()+20000});
  expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({suspended:true,forgeEventAt:Date.now(),forgeRefreshAt:Date.now()});
  const native={uuid:"{"+repositoryId+"}",full_name:"acme/repo",slug:"repo",scm:"git",workspace:{uuid:"{"+workspaceId+"}",slug:"acme",name:"Acme"},mainbranch:{name:"main"}};
  const catalog="/2.0/repositories/{"+workspaceId+"}",prefix=catalog+"/{"+repositoryId+"}";let calls=0,catalogFails=true;
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,options)=>{
   calls++;const url=new URL(String(input)),path=decodeURIComponent(url.pathname);expect(url.origin).toBe("https://api.bitbucket.org");expect(options?.redirect).toBe("error");expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-system-token");
   if(path===catalog)return catalogFails?new Response("Unavailable",{status:403}):Response.json({values:[native]});
   if(path===prefix)return Response.json(native);
   if(path===prefix+"/refs/branches/main")return Response.json({name:"main",target:{hash:sha}});
   if(path===prefix+"/refs/branches")return Response.json({values:[{name:"main",target:{hash:sha}}]});
   if(path===prefix+"/src/"+sha+"/")return Response.json({values:[]});
   throw new Error("Unexpected native path "+path);
  });
  await expect(t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id})).rejects.toThrow("403");expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({suspended:true});
  catalogFails=false;await t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id});expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({suspended:false});expect((await t.run(ctx=>ctx.db.get(id)))!.error).toBeUndefined();
  expect(await t.action(api.providerJobs.discover,{token:alice,connectionId:id})).toMatchObject([{externalId:native.uuid,fullName:native.full_name}]);
  await t.action(api.providerJobs.select,{token:alice,connectionId:id,externalIds:[native.uuid]});
  const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});expect(repo.connectionId).toBe(id);expect(repo.externalId).toBe(native.uuid);
  await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true});
  await t.action(internal.jobs.index,{repositoryId:repo._id});
  const job=await t.run(ctx=>ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).first());expect(job).toMatchObject({sha,status:"running"});
  await t.action(internal.jobs.indexBatch,{jobId:job!._id});expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexedSha:sha,indexStatus:"ready"});
  await t.run(ctx=>ctx.db.patch(id,{credentials:credentials(Date.now()-1)}));const before=calls;
  await expect(t.action(api.providerJobs.discover,{token:alice,connectionId:id})).rejects.toThrow("expired");expect(calls).toBe(before);
  await expect(t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id})).rejects.toThrow("expired");expect(calls).toBe(before);
  await t.run(ctx=>ctx.db.patch(id,{suspended:true,credentials:credentials()}));await expect(t.action(api.providerJobs.discover,{token:alice,connectionId:id})).rejects.toThrow("suspended");expect(calls).toBe(before);
  await t.run(ctx=>ctx.db.patch(id,{forgeRefreshAt:Date.now()-91*60000}));await expect(t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id})).rejects.toThrow("scheduled token renewal");expect(calls).toBe(before);
  await t.run(ctx=>ctx.db.patch(id,{forgeRefreshAt:Date.now(),forgeEventAt:Date.now()-25*60*60000}));await expect(t.action(api.providerJobs.activateBitbucket,{token:alice,connectionId:id})).rejects.toThrow("native Forge event");expect(calls).toBe(before);
  await t.run(ctx=>ctx.db.patch(id,{forgeEventAt:Date.now()}));await expect(t.mutation(internal.providerInstalls.activateBitbucket,{token:alice,id,credentials:"stale-encrypted"})).rejects.toThrow("changed during activation");
 }finally{vi.useRealTimers();if(previousKey===undefined)delete process.env.CREDENTIAL_ENCRYPTION_KEY;else process.env.CREDENTIAL_ENCRYPTION_KEY=previousKey;}
});
test("Forge events are atomic, tenant bound, replay safe and dispatch current revisions and fetched human commands",async()=>{
 vi.useFakeTimers();const previousKey=process.env.CREDENTIAL_ENCRYPTION_KEY;process.env.CREDENTIAL_ENCRYPTION_KEY="event-fixture-encryption-key-32-characters";
 try{
  const {t,alice,organizationId}=await setup(),workspaceId="11111111-1111-4111-8111-111111111111",nativeRepo="22222222-2222-4222-8222-222222222222",author="33333333-3333-4333-8333-333333333333",installationId="ari:cloud:ecosystem::installation/44444444-4444-4444-8444-444444444444",head="b".repeat(40),target="c".repeat(40),secret="integration-service-secret";
  await t.mutation(api.providerInstalls.beginBitbucket,{token:alice,organizationId,tokenHash:"8".repeat(64)});
  const connectionId=await t.mutation(api.providerInstalls.connectBitbucket,{secret,tokenHash:"8".repeat(64),installationId,workspaceId,credentials:encryptCredential(JSON.stringify({systemToken:"fixture-system-token",publisherId:author,receivedAt:Date.now(),expiresAt:Date.now()+3600000}),organizationId+":bitbucket-cloud"),invocationId:"connect-events",invocationExpiresAt:Date.now()+20000});
  const payload={eventType:"avi:bitbucket:created:pullrequest",timestamp:"2026-03-23T06:03:12.361017Z",actor:{type:"user",uuid:author,accountId:"native-user"},workspace:{uuid:workspaceId},repository:{uuid:nativeRepo},pullrequest:{id:1,state:"OPEN",source:{branch:"feature",commit:{hash:"a".repeat(40)}},destination:{branch:"main",commit:{hash:target}}}};
  const args={secret,installationId,workspaceId,invocationId:"product-one",invocationExpiresAt:Date.now()+20000,body:JSON.stringify(payload)};
  expect(await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"setup-only"})).toBeNull();
  expect(await t.run(ctx=>ctx.db.query("providerEvents").collect())).toHaveLength(0);
  // This worker test isolates dispatch; the discovery test covers the real activation path.
  await t.run(ctx=>ctx.db.patch(connectionId,{suspended:false}));
  await t.mutation(internal.providerConnections.select,{token:alice,connectionId,repositories:[{externalId:"{"+nativeRepo+"}",fullName:"acme/repo",defaultBranch:"main",remoteUrl:"https://bitbucket.org/acme/repo.git"}]});
  const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true,indexStatus:"ready",indexedSha:target}));
  const settings=await t.run(ctx=>ctx.db.query("repositorySettings").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).unique());
  await t.run(ctx=>ctx.db.patch(settings!._id,{inherit:false,settings:{...defaults,automatic:true,rereview:true}}));
  await expect(t.mutation(api.providerInstalls.bitbucketEvent,{...args,secret:"wrong"})).rejects.toThrow("Unauthorized service");
  await expect(t.mutation(api.providerInstalls.bitbucketEvent,{...args,body:JSON.stringify({...payload,workspace:{uuid:nativeRepo}})})).rejects.toThrow("workspace mismatch");
  await expect(t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationExpiresAt:Date.now()-1})).rejects.toThrow("not authorized");
  const eventId=await t.mutation(api.providerInstalls.bitbucketEvent,args);
  await expect(t.mutation(api.providerInstalls.bitbucketEvent,args)).rejects.toThrow("consumed");
  expect(await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"retry-with-new-fit",body:JSON.stringify({...payload,unused:"native-extra-field"})})).toBe(eventId);
  expect(await t.run(ctx=>ctx.db.query("providerEvents").collect())).toHaveLength(1);
  const pull=vi.spyOn(BitbucketCloud.prototype,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://bitbucket.org/acme/repo/pull-requests/1",user:{login:author},head:{sha:head,ref:"feature"},base:{sha:"d".repeat(40),ref:"main"},revisionKey:target,diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(BitbucketCloud.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
  const permission=vi.spyOn(BitbucketCloud.prototype,"canReply").mockResolvedValue(true),follow=vi.spyOn(BitbucketCloud.prototype,"followUp").mockResolvedValue({commentId:10,author,question:"@openreview review security",inline:true,parentCommentId:5});
  await t.action(internal.providerJobs.event,{id:eventId!});expect(await t.run(ctx=>ctx.db.get(eventId!))).toMatchObject({status:"completed",attempts:1});
  const [review]=await t.run(ctx=>ctx.db.query("reviews").collect());expect(review).toMatchObject({repositoryId:repo._id,headSha:head,revisionKey:target});
  await t.action(internal.providerJobs.event,{id:eventId!});expect(pull).toHaveBeenCalledTimes(1);
  const comment={...payload,eventType:"avi:bitbucket:created:pullrequest-comment",comment:{id:10,body:"ignored injected comment"}};
  const commentId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"comment-event",body:JSON.stringify(comment)});await t.action(internal.providerJobs.event,{id:commentId!});
  expect(follow).toHaveBeenCalledWith(repo.fullName,1,10,author);expect(permission).toHaveBeenCalledWith(repo.fullName,author);
  expect(await t.run(ctx=>ctx.db.query("conversations").collect())).toMatchObject([{question:"@openreview review security",author,githubCommentId:10}]);
  permission.mockResolvedValue(false);
  const deniedId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"denied-event",body:JSON.stringify({...comment,timestamp:"2026-03-23T06:03:13Z"})});await t.action(internal.providerJobs.event,{id:deniedId!});expect(await t.run(ctx=>ctx.db.get(deniedId!))).toMatchObject({status:"failed",error:"Comment author requires Bitbucket repository write access"});
  const calls=follow.mock.calls.length,selfId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"self-event",body:JSON.stringify({...comment,selfGenerated:true})});await t.action(internal.providerJobs.event,{id:selfId!});expect(follow.mock.calls).toHaveLength(calls);
  permission.mockResolvedValue(true);follow.mockResolvedValue({commentId:11,author,question:"@openreview explain these units",inline:true,parentCommentId:5});
  const answerId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"answer-event",body:JSON.stringify({...comment,comment:{id:11}})});await t.action(internal.providerJobs.event,{id:answerId!});
  const scheduled=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(scheduled.filter(j=>j.name.includes("conversationJobs:reply"))).toHaveLength(1);expect(scheduled.find(j=>j.name.includes("conversationJobs:reply"))!.args[0]).toMatchObject({repositoryId:repo._id,prNumber:1,commentId:11,question:"@openreview explain these units",parentCommentId:5,inline:true});
  for(const branch of ["feature","main"]){
   const pushId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"push-"+branch,body:JSON.stringify({...payload,eventType:"avi:bitbucket:push:repository",pullrequest:undefined,push:{ref:branch,closed:false,after:head}})});await t.action(internal.providerJobs.event,{id:pushId!});
  }
  expect((await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).filter(j=>j.name.includes("jobs:index"))).toHaveLength(1);
  const current={...await pull.mock.results[0].value,head:{sha:"e".repeat(40),ref:"feature"}};pull.mockResolvedValue(current);
  const update={...payload,eventType:"avi:bitbucket:updated:pullrequest",changes:{source:{commit:{before:payload.pullrequest.source.commit,after:{hash:"f".repeat(40)}}}}};
  await t.run(ctx=>ctx.db.patch(settings!._id,{inherit:false,settings:{...defaults,automatic:true,rereview:false}}));
  const pausedId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"update-paused",body:JSON.stringify(update)});await t.action(internal.providerJobs.event,{id:pausedId!});
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(2);
  await t.run(ctx=>ctx.db.patch(settings!._id,{inherit:false,settings:{...defaults,automatic:true,rereview:true}}));
  const updatedId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"update-current",body:JSON.stringify({...update,timestamp:"2026-03-23T06:03:14Z"})});await t.action(internal.providerJobs.event,{id:updatedId!});
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toMatchObject([{headSha:head},{headSha:head},{headSha:current.head.sha,revisionKey:target}]);
  const duplicateId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"update-same-revision",body:JSON.stringify({...update,timestamp:"2026-03-23T06:03:15Z"})});await t.action(internal.providerJobs.event,{id:duplicateId!});
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(3);
  pull.mockResolvedValue({...await pull.mock.results[0].value,state:"closed"});
  const closedId=await t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"closed-event",body:JSON.stringify({...payload,eventType:"avi:bitbucket:fulfilled:pullrequest"})});await t.action(internal.providerJobs.event,{id:closedId!});expect(await t.run(ctx=>ctx.db.get(closedId!))).toMatchObject({status:"completed"});
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(3);
  const approvalId=await t.run(ctx=>ctx.db.insert("approvalJobs",{organizationId,repositoryId:repo._id,reviewId:review._id,prNumber:1,headSha:head,policyKey:"fixture",status:"approved",reasons:[],providerReviewId:901,createdAt:Date.now(),updatedAt:Date.now()}));
  const beforePulls=pull.mock.calls.length,beforeReviews=(await t.run(ctx=>ctx.db.query("reviews").collect())).length;
  const reviewerPayload={...payload,eventType:"avi:bitbucket:updated:pullrequest-reviewer-status",actor:{type:"system"},pullrequest:{...payload.pullrequest,source:{branch:"feature",commit:{hash:head.slice(0,12)}},destination:{branch:"main",commit:{hash:target.slice(0,12)}}},reviewers:{truncated:true,value:[]}};
  const reviewerArgs={...args,invocationId:"reviewer-event",body:JSON.stringify(reviewerPayload)};
  const reviewerId=await t.mutation(api.providerInstalls.bitbucketEvent,reviewerArgs);await t.action(internal.providerJobs.event,{id:reviewerId!});
  expect(await t.run(ctx=>ctx.db.get(reviewerId!))).toMatchObject({status:"completed"});expect(pull).toHaveBeenCalledTimes(beforePulls);expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(beforeReviews);
  const approvalSchedules=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(approvalSchedules.some(j=>j.name.includes("approvalJobs:process")&&(j.args[0] as {id:string}).id===approvalId)).toBe(true);
  await expect(t.mutation(api.providerInstalls.bitbucketEvent,reviewerArgs)).rejects.toThrow("consumed");
  expect(await t.mutation(api.providerInstalls.bitbucketEvent,{...reviewerArgs,invocationId:"reviewer-same-native-event"})).toBe(reviewerId);
  await expect(t.mutation(api.providerInstalls.bitbucketEvent,{...reviewerArgs,invocationId:"reviewer-wrong-tenant",body:JSON.stringify({...reviewerPayload,workspace:{uuid:nativeRepo}})})).rejects.toThrow("workspace mismatch");
  const running=await t.run(async ctx=>{
   const jobId=await ctx.db.insert("indexJobs",{organizationId,repositoryId:repo._id,sha:head,status:"running",total:1,processed:0,changed:0,attempts:0,createdAt:Date.now(),updatedAt:Date.now()});
   const schedule=await ctx.scheduler.runAfter(10000,internal.jobs.index,{repositoryId:repo._id});await ctx.db.patch(repo._id,{indexStatus:"indexing",indexScheduledId:schedule});return {jobId,schedule};
  });
  const removal={secret,installationId,workspaceId,invocationId:"uninstall-native",invocationExpiresAt:Date.now()+20000};
  await expect(t.mutation(api.providerInstalls.uninstallBitbucket,{...removal,workspaceId:nativeRepo})).rejects.toThrow("workspace mismatch");
  await expect(t.mutation(api.providerInstalls.uninstallBitbucket,{...removal,secret:"wrong"})).rejects.toThrow("Unauthorized service");
  await t.mutation(api.providerInstalls.uninstallBitbucket,removal);
  expect(await t.run(ctx=>ctx.db.get(connectionId))).toMatchObject({active:false,suspended:true,credentials:"",error:"Bitbucket Forge installation removed"});
  expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({enabled:false,indexStatus:"cancelled",indexedSha:target});expect(await t.run(ctx=>ctx.db.get(running.jobId))).toMatchObject({status:"cancelled"});
  expect(await t.run(ctx=>ctx.db.system.get(running.schedule))).toMatchObject({state:{kind:"canceled"}});
  await expect(t.mutation(api.providerInstalls.uninstallBitbucket,removal)).rejects.toThrow("consumed");await t.mutation(api.providerInstalls.uninstallBitbucket,{...removal,invocationId:"uninstall-retry"});
  await expect(t.query(api.providerInstalls.bitbucketInstallation,{secret,workspaceId,installationId})).rejects.toThrow("unavailable");
  await t.mutation(api.providerConnections.disconnect,{token:alice,id:connectionId});await expect(t.mutation(api.providerInstalls.bitbucketEvent,{...args,invocationId:"disconnected-event"})).rejects.toThrow("not authorized");
 }finally{vi.useRealTimers();if(previousKey===undefined)delete process.env.CREDENTIAL_ENCRYPTION_KEY;else process.env.CREDENTIAL_ENCRYPTION_KEY=previousKey;vi.restoreAllMocks();}
});
test("Origin installation receipts are atomic, one use, and cannot transfer another workspace's installation",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const args={token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_fixture",namespaceId:"ns_fixture",credentials:"encrypted-fixture",jti:"receipt-one",expiresAt:Date.now()+240000};
 const id=await t.mutation(api.providerConnections.connectOrigin,args);
 await expect(t.mutation(api.providerConnections.connectOrigin,args)).rejects.toThrow("consumed");
 const other=await t.mutation(api.users.createOrganization,{token:bob,name:"Other"});
 await expect(t.mutation(api.providerConnections.connectOrigin,{...args,token:bob,organizationId:other,jti:"receipt-two"})).rejects.toThrow("another workspace");
 await expect(t.mutation(api.providerConnections.connectOrigin,{...args,token:bob,jti:"receipt-three"})).rejects.toThrow("Forbidden");
 await t.mutation(internal.providerConnections.originLifecycle,{id,eventType:"installation.suspended"});
 await expect(t.query(internal.providerConnections.data,{id})).rejects.toThrow("suspended");
 await t.mutation(internal.providerConnections.originLifecycle,{id,eventType:"installation.unsuspended"});
 expect((await t.query(internal.providerConnections.data,{id})).active).toBe(true);
 await t.mutation(internal.providerConnections.originLifecycle,{id,eventType:"installation.deleted"});
 const stored=await t.run(ctx=>ctx.db.get(id));expect(stored?.credentials).toBe("");expect(stored?.active).toBe(false);
});
test("P4 project inspection is admin scoped, uses encrypted tickets and never manufactures Git repository identities",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const originalHosts=process.env.SCM_ALLOWED_HOSTS,originalKey=process.env.CREDENTIAL_ENCRYPTION_KEY;
 process.env.SCM_ALLOWED_HOSTS="p4.example";process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";
 let reviewBranch="main";
 const projects=[{id:"payments",name:"Payments",branches:[{id:"main",name:"Main",paths:["//depot/main/...","-//depot/main/private/..."]}]}];
 const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  const url=new URL(String(input));expect(url.origin).toBe("https://p4.example");
  expect((init?.headers as Record<string,string>).authorization).toBe("Basic "+Buffer.from("review-bot:fixture-ticket").toString("base64"));expect(init?.redirect).toBe("error");
  if(url.pathname==="/api/v9/projects/payments")return Response.json({project:projects[0]});
  if(url.pathname==="/api/v11/reviews"){expect(url.searchParams.get("project")).toBe("payments");return Response.json({error:null,data:{reviews:[{id:12,author:"alice",description:"Cents",updated:1,pending:true,state:"needsReview",projects:{payments:[reviewBranch]}}],lastSeen:12,totalCount:1}});}
  expect(url.pathname).toBe("/api/v9/projects");return Response.json({projects});
 });
 try{
  const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"perforce",instance:"https://p4.example",name:"P4",credentials:encryptCredential(JSON.stringify({username:"review-bot",ticket:"fixture-ticket"}),organizationId+":perforce"),webhookSecret:""});
  expect(await t.action(api.providerJobs.p4Projects,{token:alice,connectionId})).toEqual(projects);
  const page=await t.action(api.providerJobs.p4Reviews,{token:alice,connectionId,projectId:"payments"});expect(page.cursor).toBe(12);expect(page.reviews[0].id).toBe(12);
  reviewBranch="unknown";await expect(t.action(api.providerJobs.p4Reviews,{token:alice,connectionId,projectId:"payments"})).rejects.toThrow("branch identity");reviewBranch="main";
  expect(await t.query(api.repositories.list,{token:alice,organizationId})).toEqual([]);
  const before=fetch.mock.calls.length;
  await expect(t.action(api.providerJobs.p4Projects,{token:bob,connectionId})).rejects.toThrow("Forbidden");expect(fetch).toHaveBeenCalledTimes(before);
  await expect(t.action(api.providerJobs.p4Reviews,{token:bob,connectionId,projectId:"payments"})).rejects.toThrow("Forbidden");expect(fetch).toHaveBeenCalledTimes(before);
  await expect(t.action(api.providerJobs.webhook,{secret:"integration-service-secret",connectionId,externalId:"forged-hook",signature:"unused",body:"{}"})).rejects.toThrow("unavailable");
  const records=await t.query(api.providerConnections.list,{token:alice,organizationId});expect(records[0]).not.toHaveProperty("credentials");expect(records[0]).not.toHaveProperty("webhookSecret");
  await t.mutation(api.providerConnections.disconnect,{token:alice,id:connectionId});
  await expect(t.action(api.providerJobs.p4Projects,{token:alice,connectionId})).rejects.toThrow("unavailable");expect(fetch).toHaveBeenCalledTimes(before);
  await expect(t.action(api.providerJobs.p4Reviews,{token:alice,connectionId,projectId:"payments"})).rejects.toThrow("unavailable");expect(fetch).toHaveBeenCalledTimes(before);
  expect((await t.run(ctx=>ctx.db.get(connectionId)))?.credentials).toBe("");
 }finally{fetch.mockRestore();if(originalHosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=originalHosts;if(originalKey===undefined)delete process.env.CREDENTIAL_ENCRYPTION_KEY;else process.env.CREDENTIAL_ENCRYPTION_KEY=originalKey;}
});
test("Bitbucket signed events deduplicate per connection, reject header mismatches, and route target repository identities",async()=>{
 vi.useFakeTimers();
 process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";
 process.env.SCM_ALLOWED_HOSTS="bitbucket.example";
 const {t,alice,organizationId}=await setup();
 const webhookSecret="fixture-webhook-secret-at-least-32-characters";
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"bitbucket-dc",instance:"https://bitbucket.example",name:"Bitbucket",credentials:encryptCredential(JSON.stringify({token:"fixture-token",username:"openreview"}),organizationId+":bitbucket-dc"),webhookSecret:encryptCredential(webhookSecret,organizationId+":bitbucket-dc:webhook")});
 const repositoryId=await t.run(async ctx=>{
  const id=await ctx.db.insert("repositories",{organizationId,connectionId,externalId:"71",fullName:"ACME/payments",defaultBranch:"main",enabled:true,indexStatus:"not_indexed",createdAt:Date.now()});
  await ctx.db.insert("repositorySettings",{repositoryId:id,organizationId,inherit:false,settings:{...defaults,automatic:true}});return id;
 });
 const head="b".repeat(40),target="c".repeat(40);
 const pull=vi.spyOn(BitbucketDC.prototype,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://bitbucket.example/projects/ACME/repos/payments/pull-requests/1",user:{login:"alice"},head:{sha:head,ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},revisionKey:target,diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(BitbucketDC.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
 try{
  const body=JSON.stringify({eventKey:"pr:opened",pullRequest:{id:1,fromRef:{repository:{id:999}},toRef:{repository:{id:71}}}});
  const args={secret:"integration-service-secret",connectionId,externalId:"dc-delivery",eventType:"pr:opened",body,signature:"sha256="+createHmac("sha256",webhookSecret).update(body).digest("hex")};
  await expect(t.action(api.providerJobs.webhook,{...args,signature:"sha256="+"0".repeat(64)})).rejects.toThrow("signature");
  await expect(t.action(api.providerJobs.webhook,{...args,eventType:"repo:refs_changed"})).rejects.toThrow("mismatch");
  await t.action(api.providerJobs.webhook,args);await t.action(api.providerJobs.webhook,args);
  const events=await t.run(ctx=>ctx.db.query("providerEvents").collect());expect(events).toHaveLength(1);
  await t.action(internal.providerJobs.event,{id:events[0]._id});
  const reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(1);expect(reviews[0].repositoryId).toBe(repositoryId);expect(reviews[0].headSha).toBe(head);expect(reviews[0].revisionKey).toBe(target);
  for(const eventKey of ["pr:reviewer:approved","pr:reviewer:unapproved","pr:reviewer:updated","pr:reviewer:needs_work","pr:reviewer:changes_requested"]){
   const decisionBody=JSON.stringify({eventKey,pullRequest:{id:1,toRef:{repository:{id:71}}}});
   await t.action(api.providerJobs.webhook,{...args,externalId:eventKey,eventType:eventKey,body:decisionBody,signature:"sha256="+createHmac("sha256",webhookSecret).update(decisionBody).digest("hex")});
   const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",eventKey)).unique());
   await t.action(internal.providerJobs.event,{id:event!._id});
  }
  expect(pull).toHaveBeenCalledTimes(1);expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);
  const unknownBody=JSON.stringify({eventKey:"pr:opened",pullRequest:{id:1,toRef:{repository:{id:999}}}});
  await t.action(api.providerJobs.webhook,{...args,externalId:"unknown-target",body:unknownBody,signature:"sha256="+createHmac("sha256",webhookSecret).update(unknownBody).digest("hex")});
  const unknown=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId","unknown-target")).unique());
  await t.action(internal.providerJobs.event,{id:unknown!._id});expect(pull).toHaveBeenCalledTimes(1);
  await t.mutation(api.providerConnections.disconnect,{token:alice,id:connectionId});await expect(t.action(api.providerJobs.webhook,args)).rejects.toThrow("disabled");
 }finally{pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;delete process.env.SCM_ALLOWED_HOSTS;}
});
test("provider event leases prevent duplicate claims and bound recovery after a crash",async()=>{
 const {t,alice,organizationId}=await setup();
 const connectionId=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_lease",namespaceId:"ns_lease",credentials:"encrypted",jti:"lease-receipt",expiresAt:Date.now()+240000});
 const id=await t.run(ctx=>ctx.db.insert("providerEvents",{connectionId,externalId:"delivery",body:"{}",status:"queued",attempts:0,createdAt:Date.now()}));
 expect(await t.mutation(internal.providerConnections.claimEvent,{id})).toBe(true);
 expect(await t.mutation(internal.providerConnections.claimEvent,{id})).toBe(false);
 await t.run(ctx=>ctx.db.patch(id,{updatedAt:Date.now()-16*60000}));
 expect(await t.mutation(internal.providerConnections.claimEvent,{id})).toBe(true);
 await t.run(ctx=>ctx.db.patch(id,{attempts:3,updatedAt:Date.now()-16*60000}));
 expect(await t.mutation(internal.providerConnections.claimEvent,{id})).toBe(false);
 expect((await t.run(ctx=>ctx.db.get(id)))?.status).toBe("failed");
});
test("Bitbucket re-review commands use native effective access and one atomic receipt across delivery IDs",async()=>{
 vi.useFakeTimers();process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";process.env.SCM_ALLOWED_HOSTS="bitbucket.example";
 const {t,alice,organizationId}=await setup(),hook="bitbucket-command-secret",head="b".repeat(40),target="c".repeat(40);
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"bitbucket-dc",instance:"https://bitbucket.example",name:"Commands",credentials:encryptCredential(JSON.stringify({token:"fixture-token",username:"openreview"}),organizationId+":bitbucket-dc"),webhookSecret:encryptCredential(hook,organizationId+":bitbucket-dc:webhook")});
 const repositoryId=await t.run(ctx=>ctx.db.insert("repositories",{organizationId,connectionId,externalId:"71",fullName:"ACME/payments",defaultBranch:"main",enabled:true,indexStatus:"not_indexed",createdAt:Date.now()}));
 let authorized=true;
 const transport=vi.spyOn(globalThis,"fetch").mockImplementation(async(raw)=>{
  const url=new URL(String(raw));
  if(url.pathname.endsWith("/repos/payments"))return Response.json({id:71});
  expect(url.pathname).toBe("/rest/api/latest/users");expect(url.searchParams.get("filter")).toBe("alice");expect(url.searchParams.get("permission")).toBe("REPO_WRITE");expect(url.searchParams.get("permission.projectKey")).toBe("ACME");expect(url.searchParams.get("permission.repositorySlug")).toBe("payments");
  return Response.json({values:authorized?[{name:"alice",active:true,type:"NORMAL"}]:[],isLastPage:true});
 });
 const pull=vi.spyOn(BitbucketDC.prototype,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://bitbucket.example/projects/ACME/repos/payments/pull-requests/1",user:{login:"alice"},head:{sha:head,ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},revisionKey:target,diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(BitbucketDC.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
 let sequence=0;
 const deliver=async(commentId:number)=>{
  const externalId="command-"+(++sequence),eventType="pr:comment:added",body=JSON.stringify({eventKey:eventType,pullRequest:{id:1,toRef:{repository:{id:71}}},actor:{name:"alice"},comment:{id:commentId,text:"@openreview review security",author:{name:"alice",active:true}}});
  await t.action(api.providerJobs.webhook,{secret:"integration-service-secret",connectionId,externalId,eventType,body,signature:"sha256="+createHmac("sha256",hook).update(body).digest("hex")});
  const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());await t.action(internal.providerJobs.event,{id:event!._id});return t.run(ctx=>ctx.db.get(event!._id));
 };
 try{
  expect((await deliver(11))?.status).toBe("completed");expect((await deliver(11))?.status).toBe("completed");
  let reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(1);expect(reviews[0]).toMatchObject({repositoryId,headSha:head,revisionKey:target,category:"security"});
  expect(await t.run(ctx=>ctx.db.query("conversations").collect())).toHaveLength(1);
  authorized=false;expect((await deliver(12))?.status).toBe("failed");expect(pull).toHaveBeenCalledTimes(2);
  authorized=true;await deliver(12);reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(2);expect(reviews[0].status).toBe("cancelled");expect(await t.run(ctx=>ctx.db.query("conversations").collect())).toHaveLength(2);
 }finally{transport.mockRestore();pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;delete process.env.SCM_ALLOWED_HOSTS;}
});
test("Gitea signed timeline events require matching PR, actor and write access; synchronized revisions honor re-review settings",async()=>{
 vi.useFakeTimers();process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";process.env.SCM_ALLOWED_HOSTS="gitea.example";
 const {t,alice,organizationId}=await setup(),hook="fixture-gitea-hook";
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"gitea",instance:"https://gitea.example",name:"Gitea",credentials:encryptCredential("fixture-token",organizationId+":gitea"),webhookSecret:encryptCredential(hook,organizationId+":gitea:webhook")});
 const {repositoryId,settingsId}=await t.run(async ctx=>{const repositoryId=await ctx.db.insert("repositories",{organizationId,connectionId,externalId:"123",fullName:"acme/repo",defaultBranch:"main",enabled:true,indexStatus:"not_indexed",createdAt:Date.now()});const settingsId=await ctx.db.insert("repositorySettings",{organizationId,repositoryId,inherit:false,settings:{...defaults,rereview:false}});return {repositoryId,settingsId};});
 const permission=vi.spyOn(Gitea.prototype,"canReply").mockResolvedValue(true),pull=vi.spyOn(Gitea.prototype,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://gitea.example/acme/repo/pulls/1",user:{login:"alice"},head:{sha:"b".repeat(40),ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},changed_files:0,diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(Gitea.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
 let sequence=0;
 const deliver=async(eventType:string,extra:Record<string,unknown>)=>{
  const externalId="gitea-"+(++sequence),body=JSON.stringify({repository:{id:123},...extra}),args={secret:"integration-service-secret",connectionId,externalId,eventType,body,signature:createHmac("sha256",hook).update(body).digest("hex")};
  await t.action(api.providerJobs.webhook,args);await t.action(api.providerJobs.webhook,args);
  const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());await t.action(internal.providerJobs.event,{id:event!._id});return t.run(ctx=>ctx.db.get(event!._id));
 };
 const follow=vi.spyOn(Gitea.prototype,"followUps").mockImplementation(async(_repo,_number,_author,target)=>"commentId" in target?[{commentId:target.commentId,body:target.body,inline:false}]:[{commentId:21,body:"@openreview why?",inline:true,parentCommentId:10},{commentId:22,body:"@openreview review security",inline:true,parentCommentId:10}]);
 const note={action:"created",is_pull:true,issue:{number:1},pull_request:{number:1},sender:{login:"alice"},comment:{id:11,body:"@openreview why?",user:{login:"alice"}}};
 try{
  await deliver("pull_request_comment",note);
  let jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(jobs.filter(j=>j.name.includes("conversationJobs:reply"))).toHaveLength(1);expect(jobs.find(j=>j.name.includes("conversationJobs:reply"))!.args[0]).toMatchObject({repositoryId,prNumber:1,commentId:11,inline:false});
  for(const extra of [{action:"edited"},{is_pull:false},{sender:{login:"other"}},{pull_request:{number:2}},{repository:{id:999}}])await deliver("pull_request_comment",{...note,...extra});expect(permission).toHaveBeenCalledTimes(1);
  permission.mockResolvedValue(false);expect((await deliver("pull_request_comment",note))?.status).toBe("failed");permission.mockResolvedValue(true);
  await deliver("pull_request_sync",{action:"synchronized",number:1,pull_request:{number:1}});expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(0);
  await t.run(ctx=>ctx.db.patch(settingsId,{settings:defaults}));await deliver("pull_request_sync",{action:"synchronized",number:1,pull_request:{number:1}});expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);
  await deliver("issue_comment",{...note,comment:{...note.comment,id:12,body:"@openreview review security"}});expect((await t.run(ctx=>ctx.db.query("reviews").collect())).some(r=>r.category==="security")).toBe(true);
  await deliver("push",{ref:"refs/heads/feature"});await deliver("push",{ref:"refs/heads/main"});jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(jobs.filter(j=>j.name.includes("jobs:index"))).toHaveLength(1);expect(jobs.filter(j=>j.name.includes("conversationJobs:reply"))).toHaveLength(1);
  const reviewed={action:"reviewed",number:1,pull_request:{number:1},sender:{login:"alice"},review:{type:"pull_request_review_comment",content:""}};
  await deliver("pull_request_review_comment",reviewed);
  jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(jobs.some(j=>j.name.includes("conversationJobs:reply")&&j.args[0].commentId===21&&j.args[0].parentCommentId===10&&j.args[0].inline===true)).toBe(true);
  const count=(await t.run(ctx=>ctx.db.query("reviews").collect())).length;
  await deliver("pull_request_review_comment",reviewed);expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(count);
  await deliver("pull_request_comment",reviewed);expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(count);
  expect(follow.mock.calls.at(-1)?.[3]).toEqual({reviewContent:"",state:"COMMENT"});
  const priorCalls=follow.mock.calls.length;await deliver("pull_request_review_approved",reviewed);expect(follow).toHaveBeenCalledTimes(priorCalls);
  const commands=await t.run(ctx=>ctx.db.query("conversations").collect());expect(commands.filter(c=>c.githubCommentId===22)).toHaveLength(1);
  follow.mockRejectedValueOnce(new Error("Gitea comment changed or review unavailable"));expect((await deliver("pull_request_review_comment",reviewed))?.status).toBe("failed");
  const calls=follow.mock.calls.length;permission.mockResolvedValue(false);expect((await deliver("pull_request_review_comment",reviewed))?.status).toBe("completed");expect(follow).toHaveBeenCalledTimes(calls);
 }finally{follow.mockRestore();permission.mockRestore();pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;delete process.env.SCM_ALLOWED_HOSTS;}
});
test("Gitea signed revision and human-review events recheck approvals with automatic reviews disabled",async()=>{
 vi.useFakeTimers();process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";process.env.SCM_ALLOWED_HOSTS="gitea.example";
 const {t,alice,organizationId}=await setup(),hook="fixture-gitea-approval-hook",head="a".repeat(40);
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"gitea",instance:"https://gitea.example",name:"Gitea",credentials:encryptCredential("fixture-token",organizationId+":gitea"),webhookSecret:encryptCredential(hook,organizationId+":gitea:webhook")});
 const {repositoryId,reviewId,approvalId}=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert("repositories",{organizationId,connectionId,externalId:"123",fullName:"acme/repo",defaultBranch:"main",enabled:true,indexStatus:"ready",createdAt:Date.now()});
  await ctx.db.insert("repositorySettings",{organizationId,repositoryId,inherit:false,settings:{...defaults,automatic:false,rereview:false}});
  const reviewId=await ctx.db.insert("reviews",{organizationId,repositoryId,prNumber:1,headSha:head,status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  const approvalId=await ctx.db.insert("approvalJobs",{organizationId,repositoryId,reviewId,prNumber:1,headSha:head,policyKey:"fixture",status:"approved",providerReviewId:90,reasons:[],createdAt:Date.now(),updatedAt:Date.now()});return {repositoryId,reviewId,approvalId};
 });
 const pull=vi.spyOn(Gitea.prototype,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://gitea.example/acme/repo/pulls/1",user:{login:"alice"},head:{sha:"b".repeat(40),ref:"feature"},base:{sha:head,ref:"main"},changed_files:0,diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(Gitea.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
 let sequence=0;
 const deliver=async(eventType:string,extra:Record<string,unknown>,externalId="gitea-approval-"+(++sequence))=>{
  const body=JSON.stringify({repository:{id:123},...extra}),args={secret:"integration-service-secret",connectionId,externalId,eventType,body,signature:createHmac("sha256",hook).update(body).digest("hex")};
  await t.action(api.providerJobs.webhook,args);await t.action(api.providerJobs.webhook,args);
  const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());await t.action(internal.providerJobs.event,{id:event!._id});if((await t.run(ctx=>ctx.db.get(event!._id)))?.status==="completed")await t.action(internal.providerJobs.event,{id:event!._id});return event;
 };
 const count=async()=>(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).filter(j=>j.name.includes("approvalJobs:process")&&j.args[0].id===approvalId).length;
 try{
  await deliver("pull_request_sync",{action:"synchronized",number:1,pull_request:{number:1}});expect(await count()).toBe(1);
  await deliver("pull_request_review_rejected",{action:"reviewed",number:1,pull_request:{number:1},review:{type:"pull_request_review_rejected",content:"Changes requested"}});expect(await count()).toBe(2);
  await deliver("pull_request",{action:"closed",pull_request:{number:1}});expect(await count()).toBe(3);
  for(const extra of [{repository:{id:999},pull_request:{number:1}},{pull_request:{number:2}}]){
   await deliver("pull_request",extra);
  }
  await deliver("issue_comment",{action:"created",issue:{number:1}});expect(await count()).toBe(3);
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);expect((await t.run(ctx=>ctx.db.get(reviewId)))?.status).toBe("completed");
  // A native outage must not prevent the already-authorized safety job being scheduled.
  pull.mockRejectedValueOnce(new Error("Native PR unavailable"));const failed=await deliver("pull_request_sync",{action:"synchronized",pull_request:{number:1}});expect((await t.run(ctx=>ctx.db.get(failed!._id)))?.status).toBe("failed");expect(await count()).toBe(4);
  await t.run(ctx=>ctx.db.patch(repositoryId,{enabled:false}));await deliver("pull_request_sync",{action:"synchronized",pull_request:{number:1}});expect(await count()).toBe(4);
 }finally{pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;delete process.env.SCM_ALLOWED_HOSTS;}
});
test("Enterprise signed events bind installations, route PR conversations and recheck approvals when automatic reviews are off",async()=>{
 vi.useFakeTimers();process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";process.env.SCM_ALLOWED_HOSTS="github.example";
 const {t,alice,organizationId}=await setup(),hook="fixture-enterprise-webhook";
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"github-enterprise",instance:"https://github.example",name:"Enterprise",credentials:encryptCredential(JSON.stringify({appId:"1",privateKey:"fixture-key",installationId:77}),organizationId+":github-enterprise"),webhookSecret:encryptCredential(hook,organizationId+":github-enterprise:webhook")});
 const {repositoryId,settingsId,approvalId}=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert("repositories",{organizationId,connectionId,externalId:"123",fullName:"acme/repo",defaultBranch:"main",enabled:true,indexStatus:"not_indexed",createdAt:Date.now()});
  const settingsId=await ctx.db.insert("repositorySettings",{organizationId,repositoryId,inherit:false,settings:{...defaults,automatic:false,rereview:false}});
  const reviewId=await ctx.db.insert("reviews",{organizationId,repositoryId,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  const approvalId=await ctx.db.insert("approvalJobs",{organizationId,repositoryId,reviewId,prNumber:1,headSha:"a".repeat(40),policyKey:"fixture",status:"approved",providerReviewId:90,reasons:[],createdAt:Date.now(),updatedAt:Date.now()});return {repositoryId,settingsId,approvalId};
 });
 const scm=new Github("fixture"),installation=vi.spyOn(Github,"installation").mockResolvedValue(scm),permission=vi.spyOn(scm,"canReply").mockResolvedValue(true);
 const pull=vi.spyOn(scm,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://github.example/acme/repo/pull/1",user:{login:"alice"},head:{sha:"b".repeat(40),ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(scm,"changeMetadata").mockImplementation((...args)=>pull(...args));
 let sequence=0;
 const deliver=async(eventType:string,extra:Record<string,unknown>)=>{
  const externalId="enterprise-"+(++sequence),body=JSON.stringify({installation:{id:77},repository:{id:123},...extra}),args={secret:"integration-service-secret",connectionId,externalId,eventType,body,signature:"sha256="+createHmac("sha256",hook).update(body).digest("hex")};
  await t.action(api.providerJobs.webhook,args);await t.action(api.providerJobs.webhook,args);
  const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());await t.action(internal.providerJobs.event,{id:event!._id});return t.run(ctx=>ctx.db.get(event!._id));
 };
 const comment={id:11,body:"@openreview why?",in_reply_to_id:10,user:{login:"alice",type:"User"}};
 try{
  await deliver("pull_request_review_comment",{action:"created",pull_request:{number:1},comment});
  const scheduled=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());
  expect(scheduled.filter(j=>j.name.includes("conversationJobs:reply"))[0].args[0]).toMatchObject({repositoryId,prNumber:1,commentId:11,parentCommentId:10,inline:true});
  expect(installation).toHaveBeenCalledWith(77,{appId:"1",privateKey:"fixture-key",base:"https://github.example/api/v3"});expect(permission).toHaveBeenCalledWith("acme/repo","alice");
  await deliver("issue_comment",{action:"created",issue:{number:1,pull_request:{}},comment:{...comment,id:12}});
  await deliver("issue_comment",{action:"created",issue:{number:1},comment});
  await deliver("pull_request_review_comment",{action:"edited",pull_request:{number:1},comment});
  await deliver("pull_request_review_comment",{action:"created",pull_request:{number:1},comment:{...comment,user:{login:"bot",type:"Bot"}}});
  await deliver("issue_comment",{action:"created",repository:{id:999},issue:{number:1,pull_request:{}},comment});
  expect(permission).toHaveBeenCalledTimes(2);
  expect((await deliver("issue_comment",{action:"created",installation:{id:999},issue:{number:1,pull_request:{}},comment}))?.status).toBe("failed");
  permission.mockResolvedValue(false);expect((await deliver("issue_comment",{action:"created",issue:{number:1,pull_request:{}},comment}))?.status).toBe("failed");permission.mockResolvedValue(true);
  await deliver("pull_request",{action:"synchronize",pull_request:{number:1}});
  await deliver("pull_request_review",{action:"submitted",pull_request:{number:1},review:{id:30,body:"Human objection",user:{login:"alice",type:"User"}}});
  let jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(jobs.filter(j=>j.name.includes("approvalJobs:process")&&j.args[0].id===approvalId)).toHaveLength(2);
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);
  await deliver("pull_request_review",{action:"submitted",pull_request:{number:1},review:{id:31,body:"@openreview why?",user:{login:"alice",type:"User"}}});
  jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(jobs.filter(j=>j.name.includes("conversationJobs:reply"))).toHaveLength(3);expect(jobs.some(j=>j.name.includes("conversationJobs:reply")&&j.args[0].commentId===-31)).toBe(true);
  await deliver("issue_comment",{action:"created",issue:{number:1,pull_request:{}},comment:{...comment,id:13,body:"@openreview review security"}});
  let reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(2);expect(reviews[1].category).toBe("security");
  await deliver("issue_comment",{action:"created",issue:{number:1,pull_request:{}},comment:{...comment,id:13,body:"@openreview review security"}});
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(2);
  await t.run(ctx=>ctx.db.patch(settingsId,{settings:{...defaults,rereview:false}}));
  await deliver("pull_request",{action:"synchronize",pull_request:{number:1}});reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(2);
  await deliver("push",{ref:"refs/heads/feature"});await deliver("push",{ref:"refs/heads/main"});
  jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(jobs.filter(j=>j.name.includes("jobs:index"))).toHaveLength(1);
 }finally{installation.mockRestore();permission.mockRestore();pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;delete process.env.SCM_ALLOWED_HOSTS;}
});
test("GitLab automatic events respect effective review policies and index only the default branch",async()=>{
 vi.useFakeTimers();process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";
 const {t,alice,organizationId}=await setup(),hook="fixture-gitlab-policy-hook";
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"gitlab",instance:"https://gitlab.com",name:"GitLab policies",credentials:encryptCredential("fixture-token",organizationId+":gitlab"),webhookSecret:encryptCredential(hook,organizationId+":gitlab:webhook")});
 await t.mutation(internal.providerConnections.select,{token:alice,connectionId,repositories:[{externalId:"123",fullName:"group/repo",defaultBranch:"main",remoteUrl:"https://gitlab.com/group/repo.git"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 let settings={...defaults,targetBranches:["main"],ignoredBranches:["wip/**"],rereview:false};
 await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true,settings});
 const snapshot={number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://gitlab.com/group/repo/-/merge_requests/1",user:{login:"alice"},head:{sha:"b".repeat(40),ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},revisionKey:"a".repeat(40)+":"+"a".repeat(40),diff:[],comments:[],reviews:[],commits:[],checks:[]};
 const pull=vi.spyOn(Gitlab.prototype,"pullRequest").mockResolvedValue(snapshot);
 vi.spyOn(Gitlab.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
 let sequence=0;
 const deliver=async(attributes:Record<string,unknown>,change:Partial<typeof snapshot>={})=>{
  const externalId="policy-"+(++sequence);pull.mockResolvedValue({...snapshot,...change,head:change.head??{...snapshot.head,sha:sequence.toString(16).padStart(40,"0")}});
  const body=JSON.stringify({object_kind:"merge_request",project:{id:123},object_attributes:{iid:1,...attributes}});
  await t.action(api.providerJobs.webhook,{secret:"integration-service-secret",connectionId,externalId,signature:hook,body});
  const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());
  await t.action(internal.providerJobs.event,{id:event!._id});expect((await t.run(ctx=>ctx.db.get(event!._id)))?.status).toBe("completed");
 };
 const reviews=()=>t.run(ctx=>ctx.db.query("reviews").collect());
 try{
  await deliver({action:"open",oldrev:null});expect(await reviews()).toHaveLength(1);
  await deliver({action:"update",oldrev:"b".repeat(40)});
  await deliver({action:"open"},{base:{...snapshot.base,ref:"release"}});
  await deliver({action:"open"},{head:{sha:"c".repeat(40),ref:"wip/units"}});
  await deliver({action:"open"},{draft:true});
  const [initialReview]=await reviews();const approvalId=await t.run(ctx=>ctx.db.insert("approvalJobs",{organizationId,repositoryId:repo._id,reviewId:initialReview._id,prNumber:1,headSha:initialReview.headSha,policyKey:"fixture",status:"approved",providerReviewId:11,reasons:[],createdAt:Date.now(),updatedAt:Date.now()}));
  expect((await t.query(api.approvals.settings,{token:alice,organizationId})).repositoryIds).toContain(repo._id);
  await deliver({action:"approval"});await deliver({action:"unapproved"});
  expect((await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).filter(j=>j.name.includes("approvalJobs:process")&&j.args[0].id===approvalId)).toHaveLength(2);
  await deliver({action:"close"},{state:"closed"});expect(await reviews()).toHaveLength(1);
  settings={...settings,rereview:true};await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true,settings});
  await deliver({action:"update",oldrev:"b".repeat(40)});expect(await reviews()).toHaveLength(2);
  await deliver({action:"reopen"});expect(await reviews()).toHaveLength(3);
  settings={...settings,automatic:false};await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true,settings});
  await deliver({action:"open"});expect(await reviews()).toHaveLength(3);
  const before=(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).filter(j=>j.name.includes("jobs:index")).length;
  for(const ref of ["refs/heads/feature","refs/heads/main"]){
   const externalId="push-"+(++sequence);await t.action(api.providerJobs.webhook,{secret:"integration-service-secret",connectionId,externalId,signature:hook,body:JSON.stringify({object_kind:"push",project:{id:123},ref})});
   const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());await t.action(internal.providerJobs.event,{id:event!._id});
  }
  expect((await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).filter(j=>j.name.includes("jobs:index"))).toHaveLength(before+1);
 }finally{pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;}
});
test("GitLab note events route authorized native discussions and ignore edits, internal notes and actor mismatches",async()=>{
 vi.useFakeTimers();process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-encryption-key-at-least-32-characters";
 const {t,alice,organizationId}=await setup(),hook="fixture-gitlab-webhook";
 const connectionId=await t.mutation(api.providerConnections.save,{token:alice,secret:"integration-service-secret",organizationId,kind:"gitlab",instance:"https://gitlab.com",name:"GitLab",credentials:encryptCredential("fixture-token",organizationId+":gitlab"),webhookSecret:encryptCredential(hook,organizationId+":gitlab:webhook")});
 const repositoryId=await t.run(ctx=>ctx.db.insert("repositories",{organizationId,connectionId,externalId:"123",fullName:"group/repo",defaultBranch:"main",enabled:true,indexStatus:"not_indexed",createdAt:Date.now()}));
 const permission=vi.spyOn(Gitlab.prototype,"canReply").mockResolvedValue(true),parent=vi.spyOn(Gitlab.prototype,"discussionParent").mockResolvedValue(10);
 const pull=vi.spyOn(Gitlab.prototype,"pullRequest").mockResolvedValue({number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://gitlab.com/group/repo/-/merge_requests/1",user:{login:"alice"},head:{sha:"b".repeat(40),ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},revisionKey:"a".repeat(40)+":"+"a".repeat(40),diff:[],comments:[],reviews:[],commits:[],checks:[]});
 vi.spyOn(Gitlab.prototype,"changeMetadata").mockImplementation((...args)=>pull(...args));
 const base={object_kind:"note",project:{id:123},user:{id:2,username:"alice"},merge_request:{iid:1,target_project_id:123},object_attributes:{id:11,note:"@openreview why?",noteable_type:"MergeRequest",author_id:2,action:"create",system:false,internal:false}};
 let sequence=0;
 const deliver=async(payload:typeof base)=>{
  const externalId="note-"+(++sequence);await t.action(api.providerJobs.webhook,{secret:"integration-service-secret",connectionId,externalId,eventType:"Note Hook",signature:hook,body:JSON.stringify(payload)});
  const event=await t.run(ctx=>ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",connectionId).eq("externalId",externalId)).unique());
  await t.action(internal.providerJobs.event,{id:event!._id});return t.run(ctx=>ctx.db.get(event!._id));
 };
 try{
  expect((await deliver(base))?.status).toBe("completed");
  const scheduled=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());
  const replies=scheduled.filter(j=>j.name.includes("conversationJobs:reply"));expect(replies).toHaveLength(1);
  expect(replies[0].args[0]).toMatchObject({repositoryId,prNumber:1,commentId:11,parentCommentId:10,inline:true,author:"alice"});
  expect(parent).toHaveBeenCalledWith("group/repo",1,11,"alice","@openreview why?");
  for(const attributes of [{action:"update"},{internal:true},{system:true},{author_id:3}])await deliver({...base,object_attributes:{...base.object_attributes,...attributes}});
  await deliver({...base,merge_request:{...base.merge_request,target_project_id:999}});
  expect(permission).toHaveBeenCalledTimes(1);expect(parent).toHaveBeenCalledTimes(1);
  permission.mockResolvedValue(false);expect((await deliver(base))?.status).toBe("failed");expect(parent).toHaveBeenCalledTimes(1);
  permission.mockResolvedValue(true);parent.mockRejectedValueOnce(new Error("GitLab comment changed or discussion unavailable"));expect((await deliver(base))?.status).toBe("failed");
  await deliver({...base,object_attributes:{...base.object_attributes,id:12,note:"@openreview review security"}});
  const reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(1);expect(reviews[0].category).toBe("security");expect(reviews[0].revisionKey).toBe("a".repeat(40)+":"+"a".repeat(40));
  await deliver({...base,object_attributes:{...base.object_attributes,id:12,note:"@openreview review security"}});
  expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);
  const final=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());expect(final.filter(j=>j.name.includes("conversationJobs:reply"))).toHaveLength(1);
 }finally{permission.mockRestore();parent.mockRestore();pull.mockRestore();vi.useRealTimers();delete process.env.CREDENTIAL_ENCRYPTION_KEY;}
});
test("provider version changes enqueue a new review even when the Git head stays the same",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:77,account:"alice",accountId:1,repositories:[{id:777,fullName:"alice/versioned",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const args={repositoryId:repo._id,prNumber:1,headSha:"a".repeat(40),revisionKey:"1"};
 const first=await t.mutation(internal.reviews.enqueue,args);
 expect(await t.mutation(internal.reviews.enqueue,args)).toBe(first);
 const next=await t.mutation(internal.reviews.enqueue,{...args,revisionKey:"2"});
 expect(next).not.toBe(first);
 expect((await t.query(internal.reviews.data,{reviewId:first!})).review.status).toBe("cancelled");
});
test("Origin webhook routing trusts only the signed app, installation, and delivery identity",async()=>{
 const {t,alice,organizationId}=await setup();
 process.env.ORIGIN_APP_ID="app_fixture";
 const connectionId=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_signed",namespaceId:"ns_signed",credentials:"encrypted",jti:"signed-receipt",expiresAt:Date.now()+240000});
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 vi.stubGlobal("fetch",async(url:string)=>{expect(url).toBe("https://api.cursor.com/v1/origin/keys");return Response.json({keys:[{...publicKey.export({format:"jwk"}),alg:"EdDSA",kid:"fixture-key"}]});});
 const externalId="delivery_signed",timestamp=String(Math.floor(Date.now()/1000));
 const deliver=async(body:string)=>{
  const digest=Buffer.from(createHash("sha256").update(externalId+"."+timestamp+"."+body).digest("hex"));
  return t.action(api.providerJobs.originWebhook,{secret:"integration-service-secret",externalId,timestamp,body,signature:"v1ed,"+sign(null,digest,privateKey).toString("base64")});
 };
 try{
  const envelope={deliveryId:externalId,appId:"app_fixture",installationId:"inst_signed",event:{type:"repository.pushed",payload:{repository:{id:"repo_signed"}}}};
  await expect(deliver(JSON.stringify({...envelope,appId:"app_other"}))).rejects.toThrow("identity");
  await expect(deliver(JSON.stringify({...envelope,deliveryId:"other"}))).rejects.toThrow("identity");
  await deliver(JSON.stringify(envelope));await deliver(JSON.stringify(envelope));
  const events=await t.run(ctx=>ctx.db.query("providerEvents").collect());expect(events).toHaveLength(1);expect(events[0].connectionId).toBe(connectionId);
 }finally{vi.unstubAllGlobals();delete process.env.ORIGIN_APP_ID;}
});
async function setup() {
  const t = convexTest(schema, modules);
  const a = await t.mutation(api.users.login, {
    secret: "integration-service-secret",
    githubId: 1,
    login: "alice",
    avatar: "",
  });
  const b = await t.mutation(api.users.login, {
    secret: "integration-service-secret",
    githubId: 2,
    login: "bob",
    avatar: "",
  });
  const token = (id: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("openreview")
      .setAudience("openreview")
      .setSubject(id)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
  const alice = await token(a),
    bob = await token(b);
  const organizationId = await t.mutation(api.users.createOrganization, {
    token: alice,
    name: "Alice workspace",
  });
  return { t, alice, bob, organizationId };
}
test("bridge pairing preview grants no access and approval rechecks account, device and expiry",async()=>{
 const {t,alice,bob,organizationId}=await setup(),code="abcdef123456",hash="e".repeat(64);
 const deviceId=await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash,code,name:"Linux acceptance"});
 const before=await t.run(ctx=>ctx.db.get(deviceId));
 const preview=await t.mutation(api.bridge.previewPair,{token:alice,organizationId,code:"ABCDEF-123456"});
 expect(preview).toMatchObject({deviceId,name:"Linux acceptance",account:"alice",organizationId,workspace:"Alice workspace"});
 expect(Object.keys(preview).sort()).toEqual(["account","deviceId","expiresAt","name","organizationId","userId","workspace"].sort());
 expect(await t.run(ctx=>ctx.db.get(deviceId))).toEqual(before);
 expect(await t.mutation(api.bridge.pairStatus,{secret:"integration-service-secret",hash})).toEqual({paired:false});
 await expect(t.mutation(api.bridge.previewPair,{token:bob,organizationId,code})).rejects.toThrow();
 const bobUser=(await t.query(api.users.me,{token:bob})).user;
 const membership=await t.run(ctx=>ctx.db.insert("organizationMembers",{organizationId,userId:bobUser._id,role:"viewer"}));
 await expect(t.mutation(api.bridge.previewPair,{token:bob,organizationId,code})).rejects.toThrow("write access");
 await t.run(ctx=>ctx.db.patch(membership,{role:"member"}));
 await expect(t.mutation(api.bridge.approvePair,{token:bob,organizationId,code,expectedDeviceId:deviceId,expectedUserId:preview.userId})).rejects.toThrow("account changed");
 const other=await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash:"f".repeat(64),code:"123456abcdef",name:"Other device"});
 await expect(t.mutation(api.bridge.approvePair,{token:alice,organizationId,code,expectedDeviceId:other,expectedUserId:preview.userId})).rejects.toThrow("Invalid or expired");
 await t.run(ctx=>ctx.db.patch(deviceId,{expiresAt:Date.now()-1}));
 await expect(t.mutation(api.bridge.approvePair,{token:alice,organizationId,code,expectedDeviceId:deviceId,expectedUserId:preview.userId})).rejects.toThrow("Invalid or expired");
 await t.run(ctx=>ctx.db.patch(deviceId,{expiresAt:Date.now()+60000}));
 await t.mutation(api.bridge.approvePair,{token:alice,organizationId,code,expectedDeviceId:deviceId,expectedUserId:preview.userId});
 expect(await t.run(ctx=>ctx.db.get(deviceId))).toMatchObject({userId:preview.userId,organizationId,revoked:false});
 await expect(t.mutation(api.bridge.previewPair,{token:alice,organizationId,code})).rejects.toThrow("Invalid or expired");
 await t.run(ctx=>ctx.db.patch(other,{revoked:true}));
 await expect(t.mutation(api.bridge.previewPair,{token:alice,organizationId,code:"123456abcdef"})).rejects.toThrow("Invalid or expired");
});
test("onboarding distinguishes duplicate repository names without exposing connection credentials or foreign identity",async()=>{
 const {t,alice,organizationId}=await setup();
 const foreign=await t.run(ctx=>ctx.db.insert('organizations',{name:'Foreign provider identity',createdAt:Date.now()}));
 const ids=await t.run(async ctx=>{
  const connections=[];
  for(const [kind,instance,name,org] of [['gitlab','https://gitlab.example/team','GitLab acceptance',organizationId],['gitea','https://gitea.example','Gitea acceptance',organizationId],['gitlab','https://private.example','Private connection',foreign]] as const){
   connections.push(await ctx.db.insert('providerConnections',{organizationId:org,kind,instance,name,credentials:'private-credential',webhookSecret:'private-webhook',active:true,createdAt:Date.now()}));
  }
  const repos=[];
  for(const connectionId of connections)repos.push(await ctx.db.insert('repositories',{organizationId,connectionId,externalId:'123',fullName:'alice/example',defaultBranch:'main',enabled:false,indexStatus:'pending',createdAt:Date.now()}));
  return repos;
 });
 for(const state of [await t.query(api.onboarding.status,{token:alice,organizationId}),await t.query(api.dashboard.overview,{token:alice,organizationId}),await t.query(api.scopes.list,{token:alice,organizationId})]){
 expect(state.repositories.find(r=>r._id===ids[0])?.provider).toEqual({kind:'gitlab',instance:'https://gitlab.example/team',name:'GitLab acceptance',externalId:'123'});
 expect(state.repositories.find(r=>r._id===ids[1])?.provider).toEqual({kind:'gitea',instance:'https://gitea.example',name:'Gitea acceptance',externalId:'123'});
 expect(state.repositories.find(r=>r._id===ids[2])?.provider).toBeNull();
 const serialized=JSON.stringify(state);for(const privateValue of ['private-credential','private-webhook','private.example','Private connection'])expect(serialized).not.toContain(privateValue);
 }
});
test("onboarding saves selection before indexing, derives live progress and rejects revoked or foreign provider access",async()=>{
 vi.useFakeTimers();try{
 const {t,alice,bob,organizationId}=await setup();
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(2);
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:201,account:"alice",accountId:1,repositories:[]});
 expect(await t.query(api.onboarding.status,{token:alice,organizationId})).toMatchObject({step:3,repositories:[]});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:201,account:"alice",accountId:1,repositories:[{id:201,fullName:"alice/setup",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(3);
 await expect(t.mutation(api.onboarding.select,{token:bob,organizationId,repositoryIds:[repo._id]})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.onboarding.select,{token:alice,organizationId,repositoryIds:[repo._id,repo._id]})).rejects.toThrow("duplicates");
 await t.mutation(api.onboarding.select,{token:alice,organizationId,repositoryIds:[repo._id]});
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(4);
 expect((await t.run(ctx=>ctx.db.get(repo._id)))?.enabled).toBe(false);
 expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
 await expect(t.mutation(api.onboarding.start,{token:alice,organizationId})).rejects.toThrow("behavior");
 await t.run(ctx=>ctx.db.insert("scopeSettings",{organizationId,settings:defaults,overrideKeys:[]}));
 await t.mutation(api.onboarding.start,{token:alice,organizationId});
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(5);
 expect((await t.run(ctx=>ctx.db.get(repo._id)))?.indexStatus).toBe("queued");
 const scheduled=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());
 await t.mutation(api.onboarding.start,{token:alice,organizationId});
 expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(scheduled.length);
 await t.run(async ctx=>{const current=await ctx.db.get(repo._id);await ctx.scheduler.cancel(current!.indexScheduledId!);});
 await t.mutation(api.onboarding.start,{token:alice,organizationId});
 expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(scheduled.length+1);
 const nativeFailure=vi.spyOn(Github,"installation").mockRejectedValue(new Error("Native repository access failed"));
 try{await expect(t.action(internal.jobs.index,{repositoryId:repo._id})).rejects.toThrow("Native repository access failed");}finally{nativeFailure.mockRestore();}
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"failed",error:"Native repository access failed"});
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(5);
 await t.mutation(api.onboarding.start,{token:alice,organizationId});
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"queued"});
 await t.run(ctx=>ctx.db.patch(repo._id,{indexStatus:"ready",indexedSha:"a".repeat(40)}));
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(6);
 const hiddenRepoId=await t.run(async ctx=>{
  const teamId=await ctx.db.insert("teams",{organizationId,name:"Private setup team",createdAt:Date.now()});
  const {_id,_creationTime,...fields}=repo;void _id;void _creationTime;
  return ctx.db.insert("repositories",{...fields,githubId:203,fullName:"alice/private-setup",teamId,enabled:true,indexStatus:"ready",indexedSha:"b".repeat(40)});
 });
 await t.mutation(api.onboarding.select,{token:alice,organizationId,repositoryIds:[repo._id,hiddenRepoId]});
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(6);
 await t.run(async ctx=>{const viewer=await ctx.db.query("users").filter(q=>q.eq(q.field("login"),"bob")).unique();await ctx.db.insert("organizationMembers",{organizationId,userId:viewer!._id,role:"viewer"});});
 const viewerSetup=await t.query(api.onboarding.status,{token:bob,organizationId});
 expect(viewerSetup).toMatchObject({step:3,unavailableSelection:true});
 expect(viewerSetup.repositories.some(r=>r._id===hiddenRepoId)).toBe(false);
 await t.mutation(api.onboarding.select,{token:alice,organizationId,repositoryIds:[repo._id]});

 const installation=await t.run(ctx=>ctx.db.query("githubInstallations").withIndex("by_installation",q=>q.eq("installationId",201)).unique());
 await t.run(ctx=>ctx.db.patch(installation!._id,{active:false}));
 expect((await t.query(api.onboarding.status,{token:alice,organizationId})).step).toBe(2);
 await expect(t.mutation(api.onboarding.start,{token:alice,organizationId})).rejects.toThrow("unavailable");
 await expect(t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true})).rejects.toThrow("unavailable");
 await expect(t.mutation(api.repositories.reindex,{token:alice,repositoryId:repo._id})).rejects.toThrow("unavailable");
 const other=await t.mutation(api.users.createOrganization,{token:bob,name:"Other"});
 await expect(t.mutation(api.onboarding.select,{token:bob,organizationId:other,repositoryIds:[repo._id]})).rejects.toThrow("outside");
 }finally{vi.useRealTimers();}
});
test("index retry exposes queued recovery atomically and avoids duplicate workers",async()=>{
 vi.useFakeTimers();try{
 const {t,alice,bob,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:204,account:"alice",accountId:1,repositories:[{id:204,fullName:"alice/retry",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 await expect(t.mutation(api.repositories.reindex,{token:alice,repositoryId:repo._id})).rejects.toThrow("Enable");
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true,indexStatus:"failed",error:"Provider unavailable"}));
 await expect(t.mutation(api.repositories.reindex,{token:bob,repositoryId:repo._id})).rejects.toThrow("Forbidden");
 await t.mutation(api.repositories.reindex,{token:alice,repositoryId:repo._id});
 const queued=await t.run(ctx=>ctx.db.get(repo._id));
 expect(queued).toMatchObject({indexStatus:"queued"});expect(queued?.error).toBeUndefined();expect(queued?.indexScheduledId).toBeDefined();
 const schedules=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());
 await t.mutation(api.repositories.reindex,{token:alice,repositoryId:repo._id});
 expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(schedules.length);
 await t.run(async ctx=>{await ctx.scheduler.cancel(queued!.indexScheduledId!);});
 await t.mutation(api.repositories.reindex,{token:alice,repositoryId:repo._id});
 const renewed=await t.run(ctx=>ctx.db.get(repo._id));expect(renewed?.indexScheduledId).not.toBe(queued?.indexScheduledId);
 await t.run(ctx=>ctx.db.patch(repo._id,{indexStatus:"indexing"}));
 await t.mutation(api.repositories.reindex,{token:alice,repositoryId:repo._id});
 expect((await t.run(ctx=>ctx.db.get(repo._id)))?.indexScheduledId).toBe(renewed?.indexScheduledId);
 }finally{vi.useRealTimers();}
});
test("index preparation storage failures and missing manifests leave recoverable failed jobs",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:202,account:"alice",accountId:1,repositories:[{id:202,fullName:"alice/storage-failure",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 vi.spyOn(Github,"installation").mockResolvedValue(new Github("test-only-token"));
 vi.spyOn(Github.prototype,"head").mockResolvedValue("a".repeat(40));
 vi.spyOn(Github.prototype,"tree").mockResolvedValue([]);
 vi.spyOn(Github.prototype,"branches").mockResolvedValue({branches:[],limited:false});
 const storageFailure=vi.spyOn(globalThis,"Blob").mockImplementation(function(){throw new Error("Manifest storage failed");});
 try{await expect(t.action(internal.jobs.index,{repositoryId:repo._id})).rejects.toThrow("Manifest storage failed");}finally{storageFailure.mockRestore();}
 const failed=await t.run(ctx=>ctx.db.query("indexJobs").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).first());
 expect(failed).toMatchObject({status:"failed",error:"Manifest storage failed"});
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"failed",error:"Manifest storage failed"});
 const jobId=await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"b".repeat(40),total:1});
 expect(jobId).toBeTruthy();
 await t.mutation(internal.repositories.indexPreparationFailed,{repositoryId:repo._id,jobId:failed!._id,error:"Stale failure"});
 const current=await t.run(ctx=>ctx.db.get(repo._id));expect(current?.indexStatus).toBe("indexing");expect(current?.error).toBeUndefined();
 for(let attempt=0;attempt<3;attempt++)await expect(t.action(internal.jobs.indexBatch,{jobId:jobId!})).rejects.toThrow("Index manifest unavailable");
 expect(await t.query(internal.repositories.indexJob,{jobId:jobId!})).toMatchObject({status:"failed",attempts:3,error:"Index manifest unavailable"});
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"failed",error:"Index manifest unavailable"});
 const mismatchId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"c".repeat(40),total:0}))!;
 const manifestStorageId=await t.run(ctx=>ctx.storage.store(new Blob([JSON.stringify({sha:"different",gitignore:"",entries:[]})])));
 await t.run(ctx=>ctx.db.patch(mismatchId,{manifestStorageId}));
 await expect(t.action(internal.jobs.indexBatch,{jobId:mismatchId})).rejects.toThrow("Index manifest revision does not match its job");
 expect(await t.query(internal.repositories.indexJob,{jobId:mismatchId})).toMatchObject({status:"running",attempts:2,error:"Index manifest revision does not match its job"});
});
test("unchanged source receives a graph-version upgrade once without knowledge or model work",async()=>{
 vi.useFakeTimers();vi.stubEnv("EMBEDDING_MODEL","graph-cache-fixture");try{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:209,account:"alice",accountId:1,repositories:[{id:209,fullName:"alice/graph-version",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const version=(await import('../src/engine/index-version')).INDEX_GRAPH_VERSION;
 const files=[{path:"value.ts",sha:"value-blob",content:"export const result=7;"},{path:"value.test.cts",sha:"test-blob",content:"const subject=require('./value.js');"}];
 await t.run(async ctx=>{for(const [i,f] of files.entries()){const storageId=await ctx.storage.store(new Blob([f.content]));await ctx.db.insert("repositoryFiles",{organizationId,repositoryId:repo._id,path:f.path,sha:f.sha,storageId,language:"ts",updatedAt:Date.now(),...(i===0?{graphVersion:version}:{})});if(i===0)await ctx.db.insert("graphModuleReferences",{repositoryId:repo._id,path:f.path,sha:f.sha,graphVersion:version,references:[]});await ctx.db.insert("chunkEmbeddings",{organizationId,repositoryId:repo._id,path:f.path,sha:f.sha,model:"graph-cache-fixture",scope:repo._id+":graph-cache-fixture",startLine:1,endLine:1,vector:Array(1536).fill(0),updatedAt:Date.now()});}});
 const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Graph-only upgrade must not call inference"));
 const native=new Github("fixture"),fetchBlob=vi.spyOn(native,"blob").mockImplementation(async(_repo,path,sha)=>{const f=files.find(f=>f.path===path)!;expect(sha).toBe(f.sha);return f;});vi.spyOn(Github,"installation").mockResolvedValue(native);
 const run=async()=>{const jobId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"pinned-head",total:2,knowledgePaths:[]}))!;await t.run(async ctx=>{const manifestStorageId=await ctx.storage.store(new Blob([JSON.stringify({sha:"pinned-head",gitignore:"",changedPaths:[],entries:files.map(({path,sha})=>({path,sha}))})]));await ctx.db.patch(jobId,{manifestStorageId});});await t.action(internal.jobs.indexBatch,{jobId});return jobId;};
 const first=await run();expect(fetchBlob).toHaveBeenCalledTimes(1);
 expect(await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).collect())).toEqual(expect.arrayContaining([expect.objectContaining({path:"value.test.cts",sha:"test-blob",graphVersion:version})]));
 const edges=await t.run(ctx=>ctx.db.query("relationships").collect());expect(edges).toEqual(expect.arrayContaining([expect.objectContaining({from:"value.test.cts",to:"value.ts",kind:"imports"}),expect.objectContaining({from:"value.ts",to:"value.test.cts",kind:"tested-by"})]));
 expect(await t.run(ctx=>ctx.db.get(first))).toMatchObject({status:"completed",changed:0,processed:2});
 await run();expect(fetchBlob).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
 expect(await t.run(ctx=>ctx.db.query("modelCalls").collect())).toEqual([]);expect(await t.run(ctx=>ctx.db.query("usageEvents").collect())).toEqual([]);expect(await t.run(ctx=>ctx.db.query("knowledgeEntries").collect())).toEqual([]);
 }finally{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();}
});
test("unchanged importers update stored edges as targets appear, take precedence and disappear",async()=>{
 vi.useFakeTimers();vi.stubEnv("EMBEDDING_MODEL","");try{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:210,account:"alice",accountId:1,repositories:[{id:210,fullName:"alice/graph-inventory",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const importer={path:"total.test.cts",sha:"unchanged-test",content:"const subject=require('./total.js');"};
 const tsTarget={path:"total.ts",sha:"ts-target",content:"export const value=7;"},jsTarget={path:"total.js",sha:"js-target",content:"exports.value=8;"},unrelated={path:"other.ts",sha:"other",content:"export const other=9;"};
 let files=[importer,unrelated];
 const native=new Github("fixture"),fetchBlob=vi.spyOn(native,"blob").mockImplementation(async(_repo,path,sha)=>{const f=files.find(f=>f.path===path)!;expect(sha).toBe(f.sha);return f;});vi.spyOn(Github,"installation").mockResolvedValue(native);
 const run=async(expectedTarget:string)=>{const jobId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"fixture-head",total:files.length,knowledgePaths:[]}))!;await t.run(async ctx=>{const manifestStorageId=await ctx.storage.store(new Blob([JSON.stringify({sha:"fixture-head",gitignore:"",changedPaths:[],entries:files.map(({path,sha})=>({path,sha}))})]));await ctx.db.patch(jobId,{manifestStorageId});});await t.action(internal.jobs.indexBatch,{jobId});const edges=await t.run(ctx=>ctx.db.query("relationships").withIndex("by_source",q=>q.eq("repositoryId",repo._id).eq("sourcePath",importer.path)).collect());expect(edges.filter(e=>e.kind==="imports").map(e=>e.to)).toEqual([expectedTarget]);expect(edges.filter(e=>e.kind==="tested-by").map(e=>e.from)).toEqual([expectedTarget]);return jobId;};
 await run("total.js");const otherId=(await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path",unrelated.path)).unique()))!.storageId;
 files=[importer,unrelated,tsTarget];await run("total.ts");
 files=[importer,unrelated,tsTarget,jsTarget];await run("total.js");
 files=[importer,unrelated,tsTarget];await run("total.ts");
 files=[importer,unrelated];const removed=await run("total.js");expect(await t.run(ctx=>ctx.db.get(removed))).toMatchObject({changed:0,status:"completed"});
 expect(fetchBlob.mock.calls.filter(call=>call[1]===importer.path)).toHaveLength(5);expect(fetchBlob.mock.calls.filter(call=>call[1]===unrelated.path)).toHaveLength(1);
 expect((await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path",unrelated.path)).unique()))!.storageId).toBe(otherId);
 await run("total.js");expect(fetchBlob.mock.calls.filter(call=>call[1]===importer.path)).toHaveLength(5);
 const receipts=await t.query(internal.repositories.indexModuleReferences,{repositoryId:repo._id,paths:[importer.path,tsTarget.path,jsTarget.path]});expect(receipts[0]?.references).toEqual([{specifier:"./total.js",resolvedPath:"total.js"}]);expect(receipts.slice(1)).toEqual([null,null]);
 await t.run(ctx=>ctx.db.patch(receipts[0]!._id,{sha:"wrong-source"}));await run("total.js");expect(fetchBlob.mock.calls.filter(call=>call[1]===importer.path)).toHaveLength(6);
 const repaired=(await t.query(internal.repositories.indexModuleReferences,{repositoryId:repo._id,paths:[importer.path]}))[0]!;expect(repaired.sha).toBe(importer.sha);
 await t.run(ctx=>ctx.db.delete(repaired._id));await run("total.js");expect(fetchBlob.mock.calls.filter(call=>call[1]===importer.path)).toHaveLength(7);
 await expect(t.query(internal.repositories.indexModuleReferences,{repositoryId:repo._id,paths:Array(21).fill(importer.path)})).rejects.toThrow("exceeds 20");
 }finally{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();}
});
test("superseded index batches cannot replace files, embeddings, or the current revision",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:203,account:"alice",accountId:1,repositories:[{id:203,fullName:"alice/superseded",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const oldId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"old",total:1}))!;
 await t.run(ctx=>ctx.db.patch(oldId,{updatedAt:Date.now()-16*60000}));
 const jobId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"current",total:1}))!;
 expect(await t.query(internal.repositories.indexJob,{jobId:oldId})).toMatchObject({status:"cancelled"});
 const storageId=await t.run(ctx=>ctx.storage.store(new Blob(["current source"])));
 const file={repositoryId:repo._id,jobId,path:"keep.ts",sha:"current-blob",storageId,chunks:[],symbols:[],relationships:[]};
 await t.mutation(internal.repositories.indexedFile,file);
 expect(await t.mutation(internal.embeddings.saveChunks,{repositoryId:repo._id,jobId,path:file.path,sha:file.sha,model:"test",chunks:[{startLine:1,endLine:1,vector:Array(1536).fill(1)}]})).toBe(true);
 await t.mutation(internal.repositories.indexedFile,{...file,jobId:oldId,sha:"stale-blob"});
 await t.mutation(internal.repositories.removeIndexedFile,{repositoryId:repo._id,jobId:oldId,path:file.path});
 expect(await t.mutation(internal.embeddings.saveChunks,{repositoryId:repo._id,jobId:oldId,path:file.path,sha:"stale-blob",model:"test",chunks:[{startLine:1,endLine:1,vector:Array(1536).fill(0)}]})).toBe(false);
 const finish={repositoryId:repo._id,jobId:oldId,sha:"old"};
 expect(await t.mutation(internal.repositories.finishIndex,finish)).toBe(false);
 expect(await t.mutation(internal.repositories.finishIndex,{...finish,error:"Late error"})).toBe(false);
 expect(await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path",file.path)).unique())).toMatchObject({sha:"current-blob"});
 expect(await t.query(internal.embeddings.chunkState,{repositoryId:repo._id,path:file.path})).toEqual({sha:file.sha,model:"test",chunks:1});
 expect((await t.run(ctx=>ctx.db.query("chunkEmbeddings").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path",file.path)).unique()))?.vector).toEqual(Array(1536).fill(1));
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"indexing"});
 expect(await t.mutation(internal.repositories.finishIndex,{...finish,jobId,sha:"current",processed:1})).toBe(true);
 expect(await t.mutation(internal.repositories.finishIndex,{...finish,jobId,sha:"current",error:"Late duplicate failure"})).toBe(false);
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({indexStatus:"ready",indexedSha:"current"});
});
test("disabled repositories cancel indexing batches, late completion and recovery without provider access",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:204,account:"alice",accountId:1,repositories:[{id:204,fullName:"alice/disabled",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 const native=vi.spyOn(Github,"installation").mockRejectedValue(new Error("Provider must not be contacted"));
 for(const path of ["batch","completion","recovery"]){
  await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
  const jobId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:path,total:1}))!;
  await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:false});
  if(path==="batch")await t.action(internal.jobs.indexBatch,{jobId});
  else if(path==="completion")expect(await t.mutation(internal.repositories.finishIndex,{repositoryId:repo._id,jobId,sha:path,error:"Late failure"})).toBe(false);
  else{await t.run(ctx=>ctx.db.patch(jobId,{attempts:3,updatedAt:Date.now()-16*60000}));await t.mutation(internal.recovery.sweep,{});}
  expect(await t.query(internal.repositories.indexJob,{jobId})).toMatchObject({status:"cancelled"});
  const saved=await t.run(ctx=>ctx.db.get(repo._id));expect(saved?.enabled).toBe(false);expect(saved?.indexStatus).toBe("cancelled");expect(saved?.error).toBeUndefined();
 }
 expect(native).not.toHaveBeenCalled();
 await t.run(ctx=>ctx.db.patch(repo._id,{indexedSha:"previous-indexed-revision"}));
 await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true});
 expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({enabled:true,indexStatus:"queued",indexedSha:"previous-indexed-revision"});
});
test("disable and provider revocation immediately cancel scheduled and running indexing",async()=>{
 for(const mode of ["configure","archive","installation-delete","installation-suspend","repository-remove","disconnect","origin-delete","origin-suspend"]){
  const {t,alice,organizationId}=await setup();
  await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:205,account:"alice",accountId:1,repositories:[{id:205,fullName:"alice/immediate-cancel",defaultBranch:"main"}]});
  const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
  let connectionId:Id<"providerConnections">|undefined;
  if(["disconnect","origin-delete","origin-suspend"].includes(mode)){
   connectionId=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_cancel",namespaceId:"ns_cancel",credentials:"fixture",jti:"cancel-receipt",expiresAt:Date.now()+240000});
   await t.run(ctx=>ctx.db.patch(repo._id,{connectionId,externalId:"r_cancel"}));
  }
  await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true});
  const scheduledId=(await t.run(ctx=>ctx.db.get(repo._id)))!.indexScheduledId!;
  const jobId=(await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha:"current",total:1}))!;
  if(mode==="configure")await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:false});
  else if(mode==="archive")await t.mutation(internal.webhooks.lifecycle,{repositoryId:repo._id,action:"archived"});
  else if(mode.startsWith("installation-"))await t.mutation(internal.webhooks.installationEvent,{installationId:205,action:mode==="installation-delete"?"deleted":"suspend",repositories:[]});
  else if(mode==="repository-remove")await t.mutation(internal.webhooks.installationEvent,{installationId:205,action:"removed",repositories:[{id:205,fullName:repo.fullName,defaultBranch:"main"}]});
  else if(mode==="disconnect")await t.mutation(api.providerConnections.disconnect,{token:alice,id:connectionId!});
  else await t.mutation(internal.providerConnections.originLifecycle,{id:connectionId!,eventType:mode==="origin-delete"?"installation.deleted":"installation.suspended"});
  expect(await t.query(internal.repositories.indexJob,{jobId})).toMatchObject({status:"cancelled"});
  expect((await t.run(ctx=>ctx.db.system.get(scheduledId)))?.state.kind).toBe("canceled");
  expect(await t.run(ctx=>ctx.db.get(repo._id))).toMatchObject({enabled:mode==="origin-suspend",indexStatus:"cancelled"});
 }
});
test("Linear connections restrict administration and scope, guard cached context and remove access immediately on disconnect",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const connectionArgs={token:alice,organizationId,externalId:"linear-workspace",name:"Requirements",credentials:"encrypted-fixture",expiresAt:Date.now()+86400000};
 await expect(t.mutation(internal.integrations.save,{...connectionArgs,token:bob})).rejects.toThrow("Forbidden");
 const id=await t.mutation(internal.integrations.save,connectionArgs);
 const receipt={token:alice,organizationId,jti:"linear:"+"a".repeat(43),expiresAt:Date.now()+240000};
 await t.mutation(internal.integrations.receipt,receipt);await expect(t.mutation(internal.integrations.receipt,receipt)).rejects.toThrow("consumed");
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:77,account:"alice",accountId:1,repositories:[{id:779,fullName:"alice/linear",defaultBranch:"main"}]});
 const repositoryId=(await t.query(api.dashboard.overview,{token:alice,organizationId})).repositories[0]._id;
 const scope={token:alice,id,generation:1,teamIds:["team-a"],projectIds:["project-a"],repositoryIds:[repositoryId]};
 await expect(t.mutation(internal.integrations.scope,{...scope,token:bob})).rejects.toThrow("Forbidden");
 const foreignOrg=await t.mutation(api.users.createOrganization,{token:alice,name:"Other workspace"});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId:foreignOrg,installationId:78,account:"alice",accountId:1,repositories:[{id:780,fullName:"alice/other",defaultBranch:"main"}]});
 const foreignRepo=(await t.query(api.dashboard.overview,{token:alice,organizationId:foreignOrg})).repositories[0]._id;
 await expect(t.mutation(internal.integrations.scope,{...scope,repositoryIds:[foreignRepo]})).rejects.toThrow("another workspace");
 await t.mutation(internal.integrations.scope,scope);
 const context={repositoryId,scopes:[{id,generation:2}]};
 await t.mutation(internal.cache.set,{organizationId,key:"requirements-fixture",result:"fetched requirements",context});
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 await expect(t.action(api.integrationJobs.discover,{token:bob,id})).rejects.toThrow("Forbidden");
 const publicData=(await t.query(api.integrations.list,{token:bob,organizationId}))[0];expect(publicData).not.toHaveProperty("credentials");
 await expect(t.mutation(api.integrations.disconnect,{token:bob,id})).rejects.toThrow("Forbidden");
 await t.mutation(internal.integrations.scope,{...scope,generation:2,projectIds:[]});
 await expect(t.query(internal.cache.get,{organizationId,key:"requirements-fixture",context})).rejects.toThrow("scope changed");
 await t.mutation(api.integrations.disconnect,{token:alice,id});
 await expect(t.mutation(internal.cache.set,{organizationId,key:"inflight",result:"old context",context})).rejects.toThrow("scope changed");
 const disconnected=await t.run(ctx=>ctx.db.get(id));expect(disconnected).toMatchObject({active:false,credentials:"",repositoryIds:[],teamIds:[]});
 const job=await t.run(ctx=>ctx.db.query("integrationRevocations").withIndex("by_connection",q=>q.eq("connectionId",id)).unique());expect(job!.credentials).toBe("encrypted-fixture");
 await expect(t.mutation(internal.integrations.save,connectionArgs)).rejects.toThrow("revocation is pending");
 await t.mutation(internal.integrations.claimRevocation,{id:job!._id,lease:"one"});expect(await t.mutation(internal.integrations.claimRevocation,{id:job!._id,lease:"duplicate"})).toBeNull();
 await t.mutation(internal.integrations.revocationResult,{id:job!._id,lease:"wrong",success:true});expect((await t.query(internal.integrations.revocation,{id:job!._id}))!.status).toBe("queued");
 await t.mutation(internal.integrations.revocationResult,{id:job!._id,lease:"one",success:false});
 await t.mutation(internal.integrations.claimRevocation,{id:job!._id,lease:"two"});await t.mutation(internal.integrations.revocationResult,{id:job!._id,lease:"two",success:true});
 expect(await t.query(internal.integrations.revocation,{id:job!._id})).toMatchObject({status:"completed",credentials:"",attempts:2});
 expect((await t.run(ctx=>ctx.db.get(id)))!.error).toBeUndefined();
});
test("Linear manual refresh denies viewers, rotates credentials and retains selected scope",async()=>{
 const {t,alice,bob,organizationId}=await setup();process.env.CREDENTIAL_ENCRYPTION_KEY="b".repeat(64);process.env.LINEAR_CLIENT_ID="public-linear-client";
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 const expiresAt=Date.now()+86400000,credentials=encryptCredential(JSON.stringify({accessToken:"original-access-token",refreshToken:"original-refresh-token",expiresAt}),organizationId+":linear");
 const id=await t.mutation(internal.integrations.save,{token:alice,organizationId,externalId:"org-native",name:"Engineering",credentials,expiresAt});
 await t.mutation(internal.integrations.scope,{token:alice,id,generation:1,teamIds:["team-native"],projectIds:[],repositoryIds:[]});
 const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(JSON.stringify({access_token:"rotated-access-token",refresh_token:"rotated-refresh-token",token_type:"Bearer",expires_in:86400,scope:"read"}),{status:200}));
 const identity=vi.spyOn(Linear.prototype,"identity").mockResolvedValue({organization:{id:"org-native",name:"Engineering",urlKey:"engineering"},viewer:{id:"native-admin"}});
 try {
  await expect(t.action(api.integrationJobs.refresh,{token:bob,id})).rejects.toThrow("Forbidden");expect(fetcher).not.toHaveBeenCalled();
  const result=await t.action(api.integrationJobs.refresh,{token:alice,id});expect(fetcher).toHaveBeenCalledTimes(1);
  const body=fetcher.mock.calls[0][1]!.body as URLSearchParams;expect(body.get("grant_type")).toBe("refresh_token");expect(body.get("refresh_token")).toBe("original-refresh-token");
  const saved=(await t.run(ctx=>ctx.db.get(id)))!;expect(saved).toMatchObject({active:true,generation:2,teamIds:["team-native"],projectIds:[],repositoryIds:[],expiresAt:result.expiresAt});expect(saved.refreshLease).toBeUndefined();
  expect(JSON.parse(decryptCredential(saved.credentials,organizationId+":linear"))).toMatchObject({accessToken:"rotated-access-token",refreshToken:"rotated-refresh-token"});
  identity.mockImplementationOnce(async()=>{await t.mutation(internal.integrations.scope,{token:alice,id,generation:2,teamIds:[],projectIds:[],repositoryIds:[]});return {organization:{id:"org-native",name:"Engineering",urlKey:"engineering"},viewer:{id:"native-admin"}};});
  await expect(t.action(api.integrationJobs.refresh,{token:alice,id})).rejects.toThrow("scope changed during refresh");
 }finally {fetcher.mockRestore();identity.mockRestore();}
});
test("Linear retrieval preserves native provenance, refresh leases and rejects an in-flight scope change",async()=>{
 const {t,alice,organizationId}=await setup();process.env.CREDENTIAL_ENCRYPTION_KEY="b".repeat(64);
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:77,account:"alice",accountId:1,repositories:[{id:781,fullName:"alice/requirements",defaultBranch:"main"}]});
 const repositoryId=(await t.query(api.dashboard.overview,{token:alice,organizationId})).repositories[0]._id;
 const credentials=encryptCredential(JSON.stringify({accessToken:"native-access-token",refreshToken:"native-refresh-token",expiresAt:Date.now()+86400000}),organizationId+":linear");
 const id=await t.mutation(internal.integrations.save,{token:alice,organizationId,externalId:"org-native",name:"Engineering",credentials,expiresAt:Date.now()+86400000});
 const scope={token:alice,id,generation:1,teamIds:["team-native"],projectIds:[],repositoryIds:[repositoryId]};await t.mutation(internal.integrations.scope,scope);
 expect(await t.mutation(internal.integrations.claimRefresh,{id,credentials,lease:"first"})).toBe(true);expect(await t.mutation(internal.integrations.claimRefresh,{id,credentials,lease:"second"})).toBe(false);
 expect(await t.mutation(internal.integrations.refreshed,{id,lease:"wrong",credentials:"wrong",expiresAt:Date.now()+86400000})).toBe(false);await t.mutation(internal.integrations.refreshFailed,{id,lease:"first"});
 const issue=vi.spyOn(Linear.prototype,"issue").mockResolvedValue({id:"native-issue",identifier:"ENG-42",title:"Return cents",description:"Amounts must be integer cents.",updatedAt:"2026-10-02T12:00:00.000Z",url:"https://linear.app/engineering/issue/ENG-42/return-cents",team:{id:"team-native"},project:null});
 try{
  const result=await t.action(internal.integrationJobs.requirements,{repositoryId,references:"Fix ENG-42 (ENG-42)"});expect(issue).toHaveBeenCalledTimes(1);expect(issue).toHaveBeenCalledWith("ENG-42",{organizationId:"org-native",teamIds:["team-native"],projectIds:[]});expect(result.files[0].provenance).toMatchObject({revision:"2026-10-02T12:00:00.000Z",sourceUrl:"https://linear.app/engineering/issue/ENG-42/return-cents"});expect(result.scopes).toEqual([{id,generation:2}]);
  issue.mockImplementationOnce(async()=>{await t.mutation(internal.integrations.scope,{...scope,generation:2,teamIds:[]});throw new Error("changed");});
  await expect(t.action(internal.integrationJobs.requirements,{repositoryId,references:"ENG-42"})).rejects.toThrow("scope changed");
 }finally{issue.mockRestore();}
});
test("Linear revocation recovers an interrupted action and erases credentials after bounded failures",async()=>{
 vi.useFakeTimers();
 try{
  const {t,alice,organizationId}=await setup();
  const id=await t.mutation(internal.integrations.save,{token:alice,organizationId,externalId:"linear-crash",name:"Recovery",credentials:"invalid-encrypted-fixture",expiresAt:Date.now()+86400000});
  await t.mutation(api.integrations.disconnect,{token:alice,id});
  const job=await t.run(ctx=>ctx.db.query("integrationRevocations").withIndex("by_connection",q=>q.eq("connectionId",id)).unique());
  await t.mutation(internal.integrations.claimRevocation,{id:job!._id,lease:"interrupted"});
  await t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
  expect(await t.query(internal.integrations.revocation,{id:job!._id})).toMatchObject({status:"failed",credentials:"",attempts:3});
  expect((await t.run(ctx=>ctx.db.get(id)))!.error).toContain("revoke the OpenReview app in Linear settings");
 }finally{vi.useRealTimers();}
});
test("all tenant reads and mutations reject another workspace member", async () => {
  const { t, alice, bob, organizationId } = await setup();
  await expect(
    t.query(api.dashboard.overview, { token: bob, organizationId }),
  ).rejects.toThrow("Forbidden");
  await expect(
    t.query(api.repositories.list, { token: bob, organizationId }),
  ).rejects.toThrow("Forbidden");
  await expect(
    t.mutation(api.dashboard.rules, {
      token: bob,
      organizationId,
      title: "x",
      instructions: "x",
      category: "rules",
      severity: "high",
      globs: [],
      enabled: true,
    }),
  ).rejects.toThrow("Forbidden");
  await expect(
    t.query(api.dashboard.overview, { token: alice, organizationId }),
  ).resolves.toHaveProperty("repositories");
  await expect(
    t.query(api.dashboard.overview, {
      token: alice.slice(0, -4) + "xxxx",
      organizationId,
    }),
  ).rejects.toThrow();
});
test("installation cannot be moved between tenants and enabled repository queues indexing", async () => {
  const { t, alice, bob, organizationId } = await setup();
  const args = {
    token: alice,
    secret: "integration-service-secret",
    organizationId,
    installationId: 55,
    account: "alice",
    accountId: 1,
    repositories: [
      { id: 101, fullName: "alice/example", defaultBranch: "main" },
    ],
  };
  await t.mutation(api.repositories.connect, args);
  const second = await t.mutation(api.users.createOrganization, {
    token: bob,
    name: "Bob workspace",
  });
  await expect(
    t.mutation(api.repositories.connect, {
      ...args,
      token: bob,
      organizationId: second,
    }),
  ).rejects.toThrow("another workspace");
  const [repository] = await t.query(api.repositories.list, {
    token: alice,
    organizationId,
  });
  await t.mutation(api.repositories.configure, {
    token: alice,
    repositoryId: repository._id,
    enabled: true,
  });
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(jobs.some((j) => j.name.includes("jobs:index"))).toBe(true);
});
test("signed webhook is durable and duplicate delivery stores only one job", async () => {
  vi.useFakeTimers();
  try {
  const { t } = await setup();
  const body = JSON.stringify({ action: "opened" });
  const signature =
    "sha256=" +
    createHmac("sha256", "integration-webhook-secret")
      .update(body)
      .digest("hex");
  const options = {
    method: "POST",
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body,
  };
  expect((await t.fetch("/github/webhook", options)).status).toBe(202);
  expect((await t.fetch("/github/webhook", options)).status).toBe(202);
  const deliveries = await t.run((ctx) =>
    ctx.db.query("webhookDeliveries").collect(),
  );
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].status).toBe("queued");
  expect(
    (await t.fetch("/github/webhook", { ...options, body: body + " " })).status,
  ).toBe(401);
  } finally {vi.useRealTimers();}
});
test("GitHub Cloud re-review commands deduplicate native comment IDs and never enqueue a closed PR",async()=>{
 vi.useFakeTimers();
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:77,account:"alice",accountId:1,repositories:[{id:779,fullName:"alice/commands",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const scm=new Github("fixture"),installation=vi.spyOn(Github,"installation").mockResolvedValue(scm),permission=vi.spyOn(scm,"request").mockResolvedValue({permission:"write"});
 const change={number:1,title:"Units",body:"",draft:false,state:"open",html_url:"https://github.com/alice/commands/pull/1",user:{login:"alice"},head:{sha:"b".repeat(40),ref:"feature"},base:{sha:"a".repeat(40),ref:"main"},diff:[],comments:[],reviews:[],commits:[],checks:[]};
 const pull=vi.spyOn(scm,"pullRequest").mockResolvedValue(change);let sequence=0;
 vi.spyOn(scm,"changeMetadata").mockImplementation((...args)=>pull(...args));
 const deliver=async(commentId:number)=>{
  const deliveryId="github-command-"+(++sequence),body=JSON.stringify({action:"created",installation:{id:77},repository:{id:779},issue:{number:1,pull_request:{}},comment:{id:commentId,body:"@openreview review security",user:{login:"alice",type:"User"}}});
  expect((await t.fetch("/github/webhook",{method:"POST",headers:{"x-github-delivery":deliveryId,"x-github-event":"issue_comment","x-hub-signature-256":"sha256="+createHmac("sha256","integration-webhook-secret").update(body).digest("hex")},body})).status).toBe(202);
  const event=await t.run(ctx=>ctx.db.query("webhookDeliveries").withIndex("by_delivery",q=>q.eq("deliveryId",deliveryId)).unique());await t.action(internal.webhookJobs.process,{deliveryId:event!._id});
 };
 try{
  await deliver(11);await deliver(11);
  const reviews=await t.run(ctx=>ctx.db.query("reviews").collect());expect(reviews).toHaveLength(1);expect(reviews[0].category).toBe("security");expect(await t.run(ctx=>ctx.db.query("conversations").collect())).toHaveLength(1);
  pull.mockResolvedValue({...change,state:"closed"});await deliver(12);expect(await t.run(ctx=>ctx.db.query("reviews").collect())).toHaveLength(1);expect(await t.run(ctx=>ctx.db.query("conversations").collect())).toHaveLength(1);
 }finally{installation.mockRestore();permission.mockRestore();pull.mockRestore();vi.useRealTimers();}
});
test("rapid commits cancel stale review and duplicate head enqueues once", async () => {
  const { t, alice, organizationId } = await setup();
  await t.mutation(api.repositories.connect, {
    token: alice,
    secret: "integration-service-secret",
    organizationId,
    installationId: 55,
    account: "alice",
    accountId: 1,
    repositories: [
      { id: 101, fullName: "alice/example", defaultBranch: "main" },
    ],
  });
  const [repo] = await t.query(api.repositories.list, {
    token: alice,
    organizationId,
  });
  await t.mutation(api.repositories.configure, {
    token: alice,
    repositoryId: repo._id,
    enabled: true,
  });
  const first = await t.mutation(internal.reviews.enqueue, {
    repositoryId: repo._id,
    prNumber: 1,
    headSha: "a".repeat(40),
  });
  const duplicate = await t.mutation(internal.reviews.enqueue, {
    repositoryId: repo._id,
    prNumber: 1,
    headSha: "a".repeat(40),
  });
  expect(duplicate).toBe(first);
  const next = await t.mutation(internal.reviews.enqueue, {
    repositoryId: repo._id,
    prNumber: 1,
    headSha: "b".repeat(40),
  });
  expect(next).not.toBe(first);
  expect(
    (await t.query(internal.reviews.data, { reviewId: first! })).review.status,
  ).toBe("cancelled");
  expect(
    (await t.query(internal.reviews.data, { reviewId: next! })).review.status,
  ).toBe("queued");
});
test("member cannot administer workspace and invitations require matching GitHub identity", async () => {
  const { t, alice, bob, organizationId } = await setup();
  const id = await t.mutation(api.users.invite, {
    token: alice,
    organizationId,
    githubLogin: "bob",
    role: "member",
  });
  await expect(
    t.mutation(api.users.acceptInvitation, { token: alice, invitationId: id }),
  ).rejects.toThrow("invalid");
  await t.mutation(api.users.acceptInvitation, {
    token: bob,
    invitationId: id,
  });
  await expect(
    t.query(api.dashboard.overview, { token: bob, organizationId }),
  ).resolves.toHaveProperty("repositories");
  await expect(
    t.mutation(api.users.invite, {
      token: bob,
      organizationId,
      githubLogin: "charlie",
      role: "admin",
    }),
  ).rejects.toThrow("Forbidden");
});
test("security lifecycle audit records authorized changes atomically without credentials or rejected-success events",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const activity=()=>t.query(api.scopes.activity,{token:alice,organizationId});
 const old=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"admin"});
 const replacement=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"member"});
 await expect(t.mutation(api.users.acceptInvitation,{token:bob,invitationId:old})).rejects.toThrow();
 await t.mutation(api.users.acceptInvitation,{token:bob,invitationId:replacement});
 const pending=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"charlie",role:"viewer"});
 await t.mutation(api.users.revokeInvitation,{token:alice,invitationId:pending});
 const hash="c".repeat(64),keyId=await t.mutation(api.apiKeys.create,{token:alice,organizationId,name:"Private key label",hash,prefix:"or_fixture"});
 const beforeDenied=(await activity()).length;
 await expect(t.mutation(api.apiKeys.revoke,{token:bob,keyId})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.apiKeys.create,{token:bob,organizationId,name:"Denied",hash:"d".repeat(64),prefix:"or_denied"})).rejects.toThrow("Forbidden");
 expect((await activity()).length).toBe(beforeDenied);
 await t.mutation(api.apiKeys.revoke,{token:alice,keyId});
 await t.mutation(api.apiKeys.revoke,{token:alice,keyId});
 const members=(await t.query(api.dashboard.overview,{token:alice,organizationId})).members,member=members.find(m=>m.user?.login==="bob")!,owner=members.find(m=>m.user?.login==="alice")!;
 const beforeOwnerDenied=(await activity()).length;
 await expect(t.mutation(api.team.update,{token:alice,memberId:owner._id,role:"member",remove:true})).rejects.toThrow("last workspace owner");
 expect((await activity()).length).toBe(beforeOwnerDenied);
 await t.mutation(api.team.update,{token:alice,memberId:member._id,role:"viewer",remove:false});
 await t.mutation(api.team.update,{token:alice,memberId:member._id,role:"viewer",remove:false});
 await t.mutation(api.team.update,{token:alice,memberId:member._id,role:"viewer",remove:true});
 const events=await activity(),forTarget=(id:string,action:string)=>events.filter(e=>e.target===id&&e.action===action);
 expect(forTarget(old,"invitation.replaced")).toHaveLength(1);
 expect(forTarget(replacement,"invitation.accepted")).toHaveLength(1);
 expect(forTarget(pending,"invitation.revoked")).toHaveLength(1);
 expect(forTarget(keyId,"api_key.created")).toHaveLength(1);
 expect(forTarget(keyId,"api_key.revoked")).toHaveLength(1);
 expect(forTarget(keyId,"api_key.created")[0].actor).toBe("alice");
 expect(forTarget(replacement,"invitation.accepted")[0].actor).toBe("bob");
 expect(forTarget(member._id,"workspace.member_role_changed")).toHaveLength(1);
 expect(forTarget(member._id,"workspace.member_removed")).toHaveLength(1);
 expect(events.every(e=>e.organizationId===organizationId&&!!e.userId)).toBe(true);
 const recorded=JSON.stringify(events);expect(recorded).not.toContain(hash);expect(recorded).not.toContain("or_fixture");expect(recorded).not.toContain("Private key label");
 // E2: removal revokes the member's sessions, so the old token itself is rejected.
 await expect(t.query(api.scopes.activity,{token:bob,organizationId})).rejects.toThrow("Unauthorized");
});

test("audit pagination reaches activity beyond 100 events and authorizes every page before reading",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const seeded=await t.run(async ctx=>{
  const actor=await ctx.db.query("organizationMembers").withIndex("by_org",q=>q.eq("organizationId",organizationId)).first();
  const foreign=await ctx.db.insert("organizations",{name:"Other audit workspace",createdAt:Date.now()});
  const own:Id<"auditEvents">[]=[];
  for(let i=0;i<151;i++){
   own.push(await ctx.db.insert("auditEvents",{organizationId,userId:actor!.userId,action:"fixture.audit",target:String(i),createdAt:i}));
   await ctx.db.insert("auditEvents",{organizationId:foreign,action:"foreign.audit",target:"private",createdAt:i});
  }
  return {own,foreign,actor:actor!.userId};
 });
 const seen:Id<"auditEvents">[]=[],pages:number[]=[];
 let cursor:string|undefined;
 do{
  const result=await t.query(api.scopes.activityPage,{token:alice,organizationId,cursor});
  pages.push(result.page.length);seen.push(...result.page.map(e=>e._id));
  expect(result.page.every(e=>e.organizationId===organizationId&&e.actor==="alice"&&e.action==="fixture.audit")).toBe(true);
  await expect(t.query(api.scopes.activityPage,{token:bob,organizationId,cursor})).rejects.toThrow("Forbidden");
  await expect(t.query(api.scopes.activityPage,{token:alice,organizationId:seeded.foreign,cursor})).rejects.toThrow("Forbidden");
  cursor=result.isDone?undefined:result.continueCursor;
 }while(cursor);
 expect(pages).toEqual([30,30,30,30,30,1]);expect(seen).toEqual([...seeded.own].reverse());expect(new Set(seen).size).toBe(151);
 expect(await t.query(api.scopes.activityPage,{token:alice,organizationId})).toMatchObject({isDone:false});
 const member=await t.run(ctx=>ctx.db.query("organizationMembers").withIndex("by_org",q=>q.eq("organizationId",organizationId)).first());
 await t.run(ctx=>ctx.db.patch(member!._id,{role:"viewer"}));
 await expect(t.query(api.scopes.activityPage,{token:alice,organizationId})).rejects.toThrow("Forbidden");
});

test("API keys are hashed, revocable, membership-bound and the last owner cannot be removed", async () => {
  const { t, alice, bob, organizationId } = await setup();
  const hash = "a".repeat(64);
  const keyId = await t.mutation(api.apiKeys.create, {
    token: alice,
    organizationId,
    name: "test",
    hash,
    prefix: "or_test",
  });
  const key = await t.query(api.apiKeys.resolve, {
    secret: "integration-service-secret",
    hash,
  });
  expect(key.organizationId).toBe(organizationId);
  expect(
    (await t.query(api.apiKeys.list, { token: alice, organizationId }))[0],
  ).not.toHaveProperty("hash");
  await expect(
    t.query(api.apiKeys.list, { token: bob, organizationId }),
  ).rejects.toThrow("Forbidden");
  await t.mutation(api.apiKeys.revoke, { token: alice, keyId });
  await expect(
    t.query(api.apiKeys.resolve, {
      secret: "integration-service-secret",
      hash,
    }),
  ).rejects.toThrow("Invalid");
  const data = await t.query(api.dashboard.overview, {
    token: alice,
    organizationId,
  });
  await expect(
    t.mutation(api.team.update, {
      token: alice,
      memberId: data.members[0]._id,
      role: "member",
      remove: true,
    }),
  ).rejects.toThrow("last workspace owner");
});
test("existing workspace users see named invitations; replacement, revocation and acceptance stay workspace scoped",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const other=await t.mutation(api.users.createOrganization,{token:bob,name:"Bob workspace"});
 const foreign=await t.mutation(api.users.invite,{token:bob,organizationId:other,githubLogin:"bob",role:"member"});
 const old=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"BOB",role:"admin"});
 const current=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});
 expect(await t.run(ctx=>ctx.db.get(old))).toBeNull();
 expect(await t.run(ctx=>ctx.db.get(foreign))).not.toBeNull();
 const me=await t.query(api.users.me,{token:bob});
 expect(me.organizations.some(o=>o._id===other)).toBe(true);
 expect(me.invitations.find(i=>i._id===current)).toMatchObject({workspaceName:expect.any(String),role:"viewer",organizationId});
 expect((await t.query(api.users.me,{token:alice})).invitations).toEqual([]);
 await expect(t.query(api.users.invitations,{token:bob,organizationId})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.users.revokeInvitation,{token:bob,invitationId:current})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.users.acceptInvitation,{token:bob,invitationId:old})).rejects.toThrow("invalid");
 expect(await t.mutation(api.users.acceptInvitation,{token:bob,invitationId:current})).toBe(organizationId);
 expect((await t.query(api.users.me,{token:bob})).organizations.find(o=>o._id===organizationId)?.role).toBe("viewer");
 await expect(t.mutation(api.users.acceptInvitation,{token:bob,invitationId:current})).rejects.toThrow("invalid");
 const revoked=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"admin"});
 await t.mutation(api.users.revokeInvitation,{token:alice,invitationId:revoked});
 await expect(t.mutation(api.users.acceptInvitation,{token:bob,invitationId:revoked})).rejects.toThrow("invalid");
 expect(await t.query(api.users.invitations,{token:alice,organizationId})).toEqual([]);
});

test("invitation expiry and deleted workspaces fail closed; accepting cannot replace existing owner role",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const existing=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"alice",role:"viewer"});
 await t.mutation(api.users.acceptInvitation,{token:alice,invitationId:existing});
 expect((await t.query(api.users.me,{token:alice})).organizations.find(o=>o._id===organizationId)?.role).toBe("owner");
 const expires=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});
 const now=Date.now();await t.run(ctx=>ctx.db.patch(expires,{expiresAt:now}));
 const clock=vi.spyOn(Date,"now").mockReturnValue(now);
 try{
  expect((await t.query(api.users.me,{token:bob})).invitations).toEqual([]);
  await expect(t.mutation(api.users.acceptInvitation,{token:bob,invitationId:expires})).rejects.toThrow("expired");
 }finally{clock.mockRestore();}
 const missing=await t.mutation(api.users.createOrganization,{token:alice,name:"Removed workspace"});
 const dangling=await t.mutation(api.users.invite,{token:alice,organizationId:missing,githubLogin:"bob",role:"admin"});
 await t.run(ctx=>ctx.db.delete(missing));
 expect((await t.query(api.users.me,{token:bob})).invitations.some(i=>i._id===dangling)).toBe(false);
 await expect(t.mutation(api.users.acceptInvitation,{token:bob,invitationId:dangling})).rejects.toThrow("invalid");
});

test("index coalesces newer heads, retries failures, and closed PRs cancel pending review claims", async () => {
  const { t, alice, organizationId } = await setup();
  await t.mutation(api.repositories.connect, {
    token: alice,
    secret: "integration-service-secret",
    organizationId,
    installationId: 66,
    account: "alice",
    accountId: 1,
    repositories: [
      { id: 102, fullName: "alice/concurrency", defaultBranch: "main" },
    ],
  });
  const [repo] = await t.query(api.repositories.list, {
    token: alice,
    organizationId,
  });
  await t.run((ctx) => ctx.db.patch(repo._id, { enabled: true }));
  const jobId = await t.mutation(internal.repositories.indexing, {
    repositoryId: repo._id,
    sha: "a".repeat(40),
    total: 2,
  });
  expect(jobId).toBeTruthy();
  expect(
    await t.mutation(internal.repositories.indexing, {
      repositoryId: repo._id,
      sha: "b".repeat(40),
      total: 2,
    }),
  ).toBeNull();
  expect(
    (await t.query(api.repositories.list, { token: alice, organizationId }))[0]
      .pendingIndexSha,
  ).toBe("b".repeat(40));
  await t.mutation(internal.repositories.finishIndex, {
    repositoryId: repo._id,
    jobId: jobId!,
    sha: "a".repeat(40),
    error: "Temporary GitHub failure",
  });
  expect(
    await t.query(internal.repositories.indexJob, { jobId: jobId! }),
  ).toMatchObject({ status: "running", attempts: 2 });
  await t.mutation(internal.knowledge.save, {
    repositoryId: repo._id,
    sha: "old",
    entries: [
      {
        subsystem: "Removed module",
        description: "Removed source module",
        files: ["gone.ts"],
        dependencies: [],
        risks: [],
        conventions: [],
      },
      {
        subsystem: "Retained module",
        description: "Retained source module",
        files: ["gone.ts", "keep.ts"],
        dependencies: [],
        risks: [],
        conventions: [],
      },
    ],
  });
  const keptStorage=await t.run(ctx=>ctx.storage.store(new Blob(["export const kept = true;"])));
  await t.mutation(internal.repositories.indexedFile,{repositoryId:repo._id,jobId:jobId!,path:"keep.ts",sha:"a".repeat(40),storageId:keptStorage,chunks:[],symbols:[],relationships:[]});
  await t.mutation(internal.repositories.finishIndex, {
    repositoryId: repo._id,
    jobId: jobId!,
    sha: "a".repeat(40),
    processed: 1,
  });
  const knowledge = await t.query(api.dashboard.knowledge, {
    token: alice,
    repositoryId: repo._id,
  });
  expect(knowledge).toHaveLength(1);
  expect(knowledge[0].files).toEqual(["keep.ts"]);

  expect(
    (await t.query(api.repositories.list, { token: alice, organizationId }))[0],
  ).toMatchObject({ indexStatus: "ready", indexedSha: "a".repeat(40) });
  const id = await t.mutation(internal.reviews.enqueue, {
    repositoryId: repo._id,
    prNumber: 1,
    headSha: "b".repeat(40),
  });
  expect(
    await t.mutation(internal.reviews.stage, {
      reviewId: id!,
      status: "ingesting",
    }),
  ).toBe(true);
  expect(
    await t.mutation(internal.reviews.stage, {
      reviewId: id!,
      status: "ingesting",
    }),
  ).toBe(false);
  await t.mutation(internal.webhooks.lifecycle, {
    repositoryId: repo._id,
    action: "closed",
    prNumber: 1,
    state: "closed",
  });
  expect(
    (await t.query(internal.reviews.data, { reviewId: id! })).review.status,
  ).toBe("cancelled");
});
test("agent context enforces repository team access before metadata or source URL retrieval",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"member"});
 await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/private",defaultBranch:"main"},{id:102,fullName:"alice/public",defaultBranch:"main"}]});
 const repos=await t.query(api.repositories.list,{token:alice,organizationId}),repo=repos.find(r=>r.fullName==="alice/private")!,publicRepo=repos.find(r=>r.fullName==="alice/public")!;
 const teamId=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Private"});
 await t.mutation(api.scopes.assign,{token:alice,repositoryId:repo._id,teamId});
 await t.run(async ctx=>{
  const storageId=await ctx.storage.store(new Blob(["private source"],{type:"text/plain"}));
  await ctx.db.insert("repositoryFiles",{organizationId,repositoryId:repo._id,path:"private.ts",sha:"a".repeat(40),storageId,language:"typescript",updatedAt:Date.now()});
  for(const repositoryId of [undefined,repo._id,publicRepo._id])await ctx.db.insert("customRules",{organizationId,repositoryId,title:repositoryId??"workspace",instructions:"Review instructions",category:"correctness",severity:"high",globs:[],enabled:true,createdAt:Date.now()});
 });
 const args={repositoryId:repo._id,path:"private.ts"};
 await expect(t.query(api.agentContext.get,{...args,token:bob})).rejects.toThrow("Team access denied");
 const owner=await t.query(api.agentContext.get,{...args,token:alice});
 expect(owner.file).toMatchObject({path:"private.ts",sha:"a".repeat(40)});expect(owner.file?.url).toBeTruthy();
 expect(owner.rules.map(r=>r.repositoryId)).toEqual([undefined,repo._id]);
 const userId=await t.run(async ctx=>(await ctx.db.query("users").filter(q=>q.eq(q.field("login"),"bob")).unique())!._id);
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"viewer",remove:false});
 expect((await t.query(api.agentContext.get,{...args,token:bob})).file?.path).toBe("private.ts");
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"viewer",remove:true});
 await expect(t.query(api.agentContext.get,{...args,token:bob})).rejects.toThrow("Team access denied");
 expect((await t.query(api.agentContext.get,{token:bob,repositoryId:publicRepo._id})).repository._id).toBe(publicRepo._id);
});

test("rules pagination retains inherited defaults beyond 200 without leaking private repository rules",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});
 await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/public",defaultBranch:"main"},{id:102,fullName:"alice/private",defaultBranch:"main"}]});
 const repos=await t.query(api.repositories.list,{token:alice,organizationId}),publicRepo=repos.find(r=>r.githubId===101)!,privateRepo=repos.find(r=>r.githubId===102)!;
 const teamId=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Private rules"});
 await t.mutation(api.scopes.assign,{token:alice,repositoryId:privateRepo._id,teamId});
 const foreign=await t.mutation(api.users.createOrganization,{token:bob,name:"Foreign"});
 await t.run(async ctx=>{
  const rule={instructions:"Require authorization",category:"security",severity:"high",globs:[],enabled:true,createdAt:Date.now()};
  for(let i=0;i<205;i++)await ctx.db.insert("customRules",{...rule,organizationId,title:`Workspace ${i}`,enabled:i%2===0});
  await ctx.db.insert("customRules",{...rule,organizationId,repositoryId:publicRepo._id,title:"Public local"});
  await ctx.db.insert("customRules",{...rule,organizationId,repositoryId:privateRepo._id,title:"Private local"});
  await ctx.db.insert("customRules",{...rule,organizationId:foreign,title:"Foreign default"});
 });
 const seen: string[]=[];let cursor:string|undefined;let pages=0;
 do{
  const result=await t.query(api.dashboard.rulesPage,{token:bob,organizationId,repositoryId:publicRepo._id,cursor});
  expect(result.page.length).toBeLessThanOrEqual(30);seen.push(...result.page.map(r=>r.title));pages++;
  cursor=result.isDone?undefined:result.continueCursor;
 }while(cursor);
 expect(pages).toBe(7);expect(seen).toHaveLength(206);expect(new Set(seen).size).toBe(206);expect(seen).toContain("Workspace 0");expect(seen).toContain("Workspace 204");expect(seen).toContain("Public local");expect(seen).not.toContain("Private local");expect(seen).not.toContain("Foreign default");
 await expect(t.query(api.dashboard.rulesPage,{token:bob,organizationId,repositoryId:privateRepo._id})).rejects.toThrow("not accessible");
 await expect(t.query(api.dashboard.rulesPage,{token:alice,organizationId,teamId,repositoryId:publicRepo._id})).rejects.toThrow("not accessible");
 await expect(t.query(api.dashboard.rulesPage,{token:alice,organizationId:foreign})).rejects.toThrow("Forbidden");
 const all=await t.query(api.dashboard.rulesPage,{token:bob,organizationId});expect(all.page.map(r=>r.title)).not.toContain("Private local");
});

test("team isolation, inherited settings, bridge replay and revocation fail closed",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"member"});
 await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 const teamId=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Private"});
 await t.mutation(api.scopes.assign,{token:alice,repositoryId:repo._id,teamId});
 expect(await t.query(api.repositories.list,{token:bob,organizationId})).toEqual([]);
 expect((await t.query(api.scopes.list,{token:bob,organizationId})).repositories).toEqual([]);
 await expect(t.query(api.settings.repository,{token:bob,repositoryId:repo._id})).rejects.toThrow("Team access");
 const userId=await t.run(async ctx=>(await ctx.db.query("users").filter(q=>q.eq(q.field("login"),"bob")).unique())!._id);
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"viewer",remove:false});
 await expect(t.mutation(api.repositories.configure,{token:bob,repositoryId:repo._id,enabled:true})).rejects.toThrow("Team access");
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"member",remove:false});
 const {defaults}=await import("../src/review-settings");
 await t.mutation(api.scopes.save,{token:alice,organizationId,settings:{...defaults,minimumConfidence:.95},overrideKeys:["minimumConfidence"]});
 expect((await t.query(api.settings.repository,{token:alice,repositoryId:repo._id})).settings.minimumConfidence).toBe(.95);
 await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:false,settings:{...defaults,minimumConfidence:.9}});
 expect((await t.query(api.settings.repository,{token:alice,repositoryId:repo._id})).settings.minimumConfidence).toBe(.9);
 expect((await t.query(api.scopes.list,{token:alice,organizationId})).repositories[0].settingsInheritance).toMatchObject({mode:"overrides",effective:{minimumConfidence:.9}});
 await t.mutation(api.scopes.inherit,{token:alice,repositoryId:repo._id});
 expect((await t.query(api.settings.repository,{token:alice,repositoryId:repo._id})).settings.minimumConfidence).toBe(.95);
 expect((await t.query(api.scopes.list,{token:alice,organizationId})).repositories[0].settingsInheritance).toMatchObject({mode:"inherited",effective:{minimumConfidence:.95}});
 await t.mutation(api.scopes.save,{token:alice,organizationId,settings:{...defaults,summarySections:["risk"]},overrideKeys:["summarySections"]});
 expect((await t.query(api.settings.repository,{token:alice,repositoryId:repo._id})).settings.summarySections).toEqual(["risk"]);
 await t.mutation(api.scopes.save,{token:alice,organizationId,teamId,settings:{...defaults,summarySections:[]},overrideKeys:["summarySections"]});
 expect((await t.query(api.settings.repository,{token:alice,repositoryId:repo._id})).settings.summarySections).toEqual([]);
 expect((await t.query(api.scopes.list,{token:alice,organizationId})).repositories[0].settingsInheritance.effective.summarySections).toEqual([]);
 await t.mutation(api.scopes.save,{token:alice,organizationId,teamId,settings:{...defaults},overrideKeys:[]});
 expect((await t.query(api.settings.repository,{token:alice,repositoryId:repo._id})).settings.summarySections).toEqual(["risk"]);
 await expect(t.mutation(api.scopes.save,{token:alice,organizationId,settings:{...defaults,summarySections:["unknown"]},overrideKeys:["summarySections"]})).rejects.toThrow("Invalid settings");
 for(const minimumConfidence of [NaN,Infinity,-Infinity]){
  await expect(t.mutation(api.scopes.save,{token:alice,organizationId,settings:{...defaults,minimumConfidence},overrideKeys:["minimumConfidence"]})).rejects.toThrow("Invalid settings");
  await expect(t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:false,settings:{...defaults,minimumConfidence}})).rejects.toThrow("Invalid review settings");
 }

 await expect(t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:false,settings:{...defaults,summarySections:["risk","risk"]}})).rejects.toThrow("Invalid review settings");
 const {reviewId}=await t.run(async ctx=>{
  await ctx.db.patch(repo._id,{enabled:true});
  const reviewId=await ctx.db.insert("reviews",{repositoryId:repo._id,organizationId,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  return {reviewId};
 });
 const hash="a".repeat(64),code="b".repeat(12);
 await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash,code,name:"Test"});
 await t.mutation(api.bridge.approvePair,{token:bob,organizationId,code});
 const boundFindingId=await bridgeFinding(t,repo._id,reviewId);
 const requestId=await t.run(ctx=>ctx.db.insert("fixRequests",{userId,organizationId,repositoryId:repo._id,reviewId,findingIds:[boundFindingId],headSha:"a".repeat(40),agent:"codex",prompt:"Preserve unrelated changes.",status:"pending",expiresAt:Date.now()+300000,createdAt:Date.now(),updatedAt:Date.now()}));
 const claim={secret:"integration-service-secret",hash,requestId};
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"member",remove:true});
 await expect(t.mutation(internal.bridge.claim,{...claim,current:{headSha:"a".repeat(40),state:"open"}})).rejects.toThrow("Team access");
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"member",remove:false});
 await t.mutation(internal.bridge.claim,{...claim,current:{headSha:"a".repeat(40),state:"open"}});
 await expect(t.mutation(internal.bridge.claim,{...claim,current:{headSha:"a".repeat(40),state:"open"}})).rejects.toThrow("replayed");
 await expect(t.mutation(api.bridge.report,{...claim,hash:"c".repeat(64),status:"failed",error:"Wrong device"})).rejects.toThrow("unpaired");
 await t.mutation(api.bridge.report,{...claim,status:"launched"});
 const launched=await t.run(ctx=>ctx.db.get(requestId));
 await t.mutation(api.bridge.report,{...claim,status:"launched"});
 expect(await t.run(ctx=>ctx.db.get(requestId))).toEqual(launched);
 await t.mutation(api.bridge.report,{...claim,status:"failed",error:"codex exited with code 7"});
 expect(await t.query(api.bridge.status,{token:bob,requestId})).toMatchObject({status:"failed",error:"codex exited with code 7"});
 await expect(t.mutation(api.bridge.report,{...claim,status:"launched"})).rejects.toThrow("not claimed");
 await expect(t.mutation(api.bridge.report,{...claim,status:"finished"})).rejects.toThrow("not claimed");
 const successId=await t.run(ctx=>ctx.db.insert("fixRequests",{userId,organizationId,repositoryId:repo._id,reviewId,findingIds:[boundFindingId],headSha:"a".repeat(40),agent:"codex",prompt:"Preserve unrelated changes.",status:"pending",expiresAt:Date.now()+300000,createdAt:Date.now(),updatedAt:Date.now()}));
 const success={...claim,requestId:successId};
 await t.mutation(internal.bridge.claim,{...success,current:{headSha:"a".repeat(40),state:"open"}});
 await expect(t.mutation(api.bridge.report,{...success,status:"finished"})).rejects.toThrow("not claimed");
 await t.mutation(api.bridge.report,{...success,status:"launched"});
 await t.mutation(api.bridge.report,{...success,status:"finished"});
 expect(await t.query(api.bridge.status,{token:bob,requestId:successId})).toMatchObject({status:"finished"});
 const finished=await t.run(ctx=>ctx.db.get(successId));
 await t.mutation(api.bridge.report,{...success,status:"finished"});
 expect(await t.run(ctx=>ctx.db.get(successId))).toEqual(finished);
 await expect(t.mutation(api.bridge.report,{...success,status:"failed",error:"Late report"})).rejects.toThrow("not claimed");
 const personal=await t.query(api.bridge.personal,{token:bob});
 expect(personal.devices[0]).not.toHaveProperty("tokenHash");
 await t.mutation(api.bridge.revoke,{token:bob,deviceId:personal.devices[0]._id});
 await expect(t.mutation(api.bridge.pairStatus,{secret:"integration-service-secret",hash})).rejects.toThrow("expired");
});

test("agent defaults inherit per workspace, personal overrides reset, and administration stays isolated",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const other=await t.mutation(api.users.createOrganization,{token:bob,name:"Other"});
 expect((await t.query(api.bridge.personal,{token:alice,organizationId})).agent).toBe("codex");
 await t.mutation(api.bridge.saveWorkspaceAgent,{token:alice,organizationId,agent:"claude"});
 await t.mutation(api.bridge.saveWorkspaceAgent,{token:bob,organizationId:other,agent:"cursor"});
 expect((await t.query(api.bridge.personal,{token:alice,organizationId})).agent).toBe("claude");
 await expect(t.query(api.bridge.personal,{token:bob,organizationId})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.bridge.saveWorkspaceAgent,{token:bob,organizationId,agent:"codex"})).rejects.toThrow("Forbidden");
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});
 await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 expect(await t.query(api.bridge.personal,{token:bob,organizationId})).toMatchObject({agent:"claude",workspaceAgent:"claude",canManageWorkspace:false});
 await expect(t.mutation(api.bridge.saveWorkspaceAgent,{token:bob,organizationId,agent:"cursor"})).rejects.toThrow("Forbidden");
 const hash="e".repeat(64),code="f".repeat(12);
 await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash,code,name:"Other workspace bridge"});
 await expect(t.mutation(api.bridge.approvePair,{token:bob,organizationId,code})).rejects.toThrow("write access");
 await t.mutation(api.bridge.approvePair,{token:bob,organizationId:other,code});
 expect((await t.query(api.bridge.personal,{token:bob,organizationId})).devices).toEqual([]);
 expect((await t.query(api.bridge.personal,{token:bob,organizationId:other})).devices).toHaveLength(1);
 await t.mutation(api.bridge.savePersonal,{token:bob,agent:"codex"});
 for(const id of [organizationId,other])expect((await t.query(api.bridge.personal,{token:bob,organizationId:id})).agent).toBe("codex");
 await t.mutation(api.bridge.savePersonal,{token:bob});
 const inherited=await t.query(api.bridge.personal,{token:bob,organizationId});expect(inherited.agent).toBe("claude");expect(inherited.personalAgent).toBeUndefined();
 expect((await t.query(api.bridge.personal,{token:bob,organizationId:other})).agent).toBe("cursor");
 expect((await t.query(api.bridge.personal,{token:bob})).agent).toBe("codex");
 await t.mutation(api.bridge.saveWorkspaceAgent,{token:alice,organizationId,agent:"cursor"});
 expect((await t.query(api.bridge.personal,{token:bob,organizationId})).agent).toBe("cursor");
 expect((await t.query(api.scopes.activity,{token:alice,organizationId})).filter(e=>e.action==="agent.default_changed").map(e=>e.target)).toEqual(["cursor","claude"]);
});

test("completed indexing filters excluded knowledge changes while preserving source edits and removals",async()=>{
 vi.useFakeTimers();try{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:205,account:"alice",accountId:1,repositories:[{id:205,fullName:"alice/knowledge-index",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId}),sha="a".repeat(40);
 await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true,knowledgeStatus:"queued"});const storageId=await ctx.storage.store(new Blob(["export const cents=5;"]));await ctx.db.insert("repositoryFiles",{organizationId,repositoryId:repo._id,path:"src/price.ts",sha,storageId,language:"ts",updatedAt:Date.now()});});
 const finish=async(paths:string[],knowledgePaths:string[])=>{
 const jobId=await t.mutation(internal.repositories.indexing,{repositoryId:repo._id,sha,total:paths.length,knowledgePaths});
 // Mirrors jobs.indexBatch: sweep stored files missing from the revision, then complete.
 const stale=(await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).collect())).map(f=>f.path).filter(path=>!paths.includes(path));
 if(stale.length)expect(await t.mutation(internal.repositories.removeIndexedFiles,{repositoryId:repo._id,jobId:jobId!,paths:stale})).toBe(true);
 expect(await t.mutation(internal.repositories.finishIndex,{repositoryId:repo._id,jobId:jobId!,sha,processed:paths.length,knowledgePaths,removedPaths:knowledgePaths.filter(path=>!paths.includes(path))})).toBe(true);
 return t.run(ctx=>ctx.db.get(repo._id));
 };
 const baseline=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect());
 expect(await finish(["src/price.ts","assets/logo.bin"],["assets/logo.bin"])).toMatchObject({knowledgeStatus:"completed",knowledgePaths:[]});
 expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(baseline.length);
 expect(await finish(["src/price.ts","assets/logo.bin"],["src/price.ts","assets/logo.bin","src/price.ts"])).toMatchObject({knowledgeStatus:"queued",knowledgePaths:["src/price.ts"]});
 await t.mutation(internal.knowledge.save,{repositoryId:repo._id,sha,entries:[{subsystem:"Binary transition",description:"Previously indexed source changed to binary",files:["assets/logo.bin"],dependencies:[],risks:[],conventions:[]}]});
 expect(await finish(["src/price.ts","assets/logo.bin"],["assets/logo.bin"])).toMatchObject({knowledgeStatus:"queued",knowledgePaths:["assets/logo.bin"]});
 expect(await t.query(api.dashboard.knowledge,{token:alice,repositoryId:repo._id})).toHaveLength(0);
 expect(await finish(["assets/logo.bin"],["src/price.ts"])).toMatchObject({knowledgeStatus:"queued",knowledgePaths:["src/price.ts"]});
 expect(await t.run(ctx=>ctx.db.query("repositoryFiles").withIndex("by_repo",q=>q.eq("repositoryId",repo._id)).collect())).toHaveLength(0);
 }finally{vi.useRealTimers();}
});
test("knowledge generation only retains fetched sources and requires a recorded indexed revision",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/knowledge",defaultBranch:"main"}]});
 const repo=(await t.query(api.repositories.list,{token:alice,organizationId}))[0],revision="a".repeat(40);
 await t.run(async ctx=>{
  await ctx.db.patch(repo._id,{indexedSha:revision});
  const storageId=await ctx.storage.store(new Blob(["export const cents = 500;"]));
  for(const path of ["src/read.ts","unselected/hidden.ts","src/missing.ts"])await ctx.db.insert("repositoryFiles",{organizationId,repositoryId:repo._id,path,sha:"b".repeat(40),storageId,language:"typescript",updatedAt:Date.now()});
  const missing=await ctx.storage.store(new Blob(["removed"]));await ctx.storage.delete(missing);
  const file=await ctx.db.query("repositoryFiles").withIndex("by_path",q=>q.eq("repositoryId",repo._id).eq("path","src/missing.ts")).unique();await ctx.db.patch(file!._id,{storageId:missing});
 });
 const generate=vi.spyOn(HttpModel.prototype,"generate").mockImplementationOnce(async(request,schema)=>{
  expect((request.input as {sources:{path:string}[]}).sources.map(f=>f.path)).toEqual(["src/read.ts"]);
  const entry={subsystem:"Billing",description:"Keeps monetary amounts in cents.",files:["src/read.ts","src/read.ts","unselected/hidden.ts","src/missing.ts","invented.ts"],dependencies:[],risks:[],conventions:[]};
  return {value:schema.parse({entries:[entry,{...entry,subsystem:"Invented",files:["invented.ts"]}]}),usage:{task:"knowledge",provider:"fixture",model:"fixture",cached:false,inputTokens:10,outputTokens:10,estimatedCost:0,latencyMs:1}};
 });
 try {
  await t.action(internal.knowledgeJobs.generate,{repositoryId:repo._id,paths:["src/read.ts"]});
  const entries=await t.query(api.dashboard.knowledge,{token:alice,repositoryId:repo._id});
  expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({subsystem:"Billing",sha:revision,files:["src/read.ts"]});
  await t.run(ctx=>ctx.db.patch(repo._id,{indexedSha:undefined}));
  await t.action(internal.knowledgeJobs.generate,{repositoryId:repo._id,paths:["src/read.ts"],attempt:3});
  expect(generate).toHaveBeenCalledTimes(1);expect((await t.run(ctx=>ctx.db.get(repo._id)))?.knowledgeError).toContain("Index the repository");
 } finally {generate.mockRestore();}
});
test("knowledge search covers all subsystem records and source fields without widening repository access",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/knowledge",defaultBranch:"main"}]});
 const repo=(await t.query(api.repositories.list,{token:alice,organizationId}))[0];
 await t.mutation(internal.knowledge.save,{repositoryId:repo._id,sha:"a".repeat(40),entries:Array.from({length:105},(_,i)=>({subsystem:"Module "+i,description:"Description "+i,files:[i===104?"src/late-payment.ts":"src/module.ts"],dependencies:["billing"],risks:["integer units"],conventions:["validate input"]}))});
 const args={token:alice,repositoryId:repo._id};
 expect(await t.query(api.dashboard.knowledge,args)).toHaveLength(105);
 const pinned=(await t.query(api.dashboard.knowledge,{...args,search:"LATE-PAYMENT"}))[0];
 expect(pinned.sources).toEqual([{path:"src/late-payment.ts",url:"https://github.com/alice/knowledge/blob/"+"a".repeat(40)+"/src/late-payment.ts"}]);
 await t.run(async ctx=>{await ctx.db.patch(repo._id,{indexedSha:"b".repeat(40)});});
 expect((await t.query(api.dashboard.knowledge,{...args,search:"LATE-PAYMENT"}))[0].sources).toEqual(pinned.sources);
 expect((await t.query(api.dashboard.knowledge,{...args,search:" LATE-PAYMENT "})).map(e=>e.subsystem)).toEqual(["Module 104"]);
 for(const search of ["Description 104","Module 104","billing","integer units","validate input"])expect((await t.query(api.dashboard.knowledge,{...args,search})).length).toBeGreaterThan(0);
 expect(await t.query(api.dashboard.knowledge,{...args,search:"missing"})).toEqual([]);
 await expect(t.query(api.dashboard.knowledge,{...args,search:"x".repeat(201)})).rejects.toThrow("too long");
 await expect(t.query(api.dashboard.knowledge,{...args,token:bob,search:"billing"})).rejects.toThrow();
 const connectionId=await t.run(async ctx=>{const id=await ctx.db.insert("providerConnections",{organizationId,kind:"gitea",instance:"https://gitea.example/base",name:"Native source",credentials:"not-returned",webhookSecret:"not-returned",active:true,createdAt:Date.now()});await ctx.db.patch(repo._id,{connectionId:id});return id;});
 expect((await t.query(api.dashboard.knowledge,{...args,search:"LATE-PAYMENT"}))[0].sources).toEqual([{path:"src/late-payment.ts",url:"https://gitea.example/base/alice/knowledge/src/commit/"+"a".repeat(40)+"/src/late-payment.ts"}]);
 await t.run(async ctx=>{await ctx.db.patch(connectionId,{kind:"perforce"});});
 expect((await t.query(api.dashboard.knowledge,{...args,search:"LATE-PAYMENT"}))[0].sources[0].url).toBeUndefined();
 const foreign=await t.mutation(api.users.createOrganization,{token:alice,name:"Foreign source"});
 await t.run(async ctx=>{await ctx.db.patch(connectionId,{kind:"gitea",organizationId:foreign});});
 expect((await t.query(api.dashboard.knowledge,{...args,search:"LATE-PAYMENT"}))[0].sources[0].url).toBeUndefined();
});
test("selected teams scope analytics, PRs, findings and memory before pagination and cannot expand membership",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"member"});await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/payments",defaultBranch:"main"},{id:102,fullName:"alice/other",defaultBranch:"main"}]});
 const [one,two]=await t.query(api.repositories.list,{token:alice,organizationId});
 const teamId=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Payments"}),other=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Other"});
 await t.mutation(api.scopes.assign,{token:alice,repositoryId:one._id,teamId});await t.mutation(api.scopes.assign,{token:alice,repositoryId:two._id,teamId:other});
 const userId=await t.run(async ctx=>(await ctx.db.query("users").filter(q=>q.eq(q.field("login"),"bob")).unique())!._id);await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"viewer",remove:false});
 const now=Date.now();
 await t.run(async ctx=>{
  for(const repo of [one,two]){
   const reviewId=await ctx.db.insert("reviews",{organizationId,repositoryId:repo._id,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:now,updatedAt:now});
   await ctx.db.insert("pullRequests",{organizationId,repositoryId:repo._id,number:1,title:repo.fullName,author:"alice",url:"https://github.com/"+repo.fullName+"/pull/1",state:"open",headSha:"a".repeat(40),baseSha:"b".repeat(40),updatedAt:now});
   for(let i=0;i<(repo._id===one._id?1:35);i++)await ctx.db.insert("findings",{organizationId,repositoryId:repo._id,reviewId,prNumber:1,title:"Preserve integer cents",description:"Wrong units",severity:"high",confidence:1,category:"data",filePath:"total.ts",startLine:1,endLine:1,commitSha:"a".repeat(40),evidence:[],impact:"Undercharge",suggestedFix:"Preserve cents",agent:"data",symbol:"total",fingerprint:"cents-"+i,status:"open",createdAt:now,updatedAt:now});
   await ctx.db.insert("learnedPreferences",{organizationId,repositoryId:repo._id,instruction:"Preserve units",category:"data",source:"legacy",enabled:true,createdAt:now});
  }
 });
 const args={token:alice,organizationId,teamId};
 expect((await t.query(api.dashboard.overview,args)).repositories.map(r=>r._id)).toEqual([one._id]);
 expect((await t.query(api.pulls.list,{...args,paginationOpts:{numItems:30,cursor:null}})).page.map(p=>p.repositoryId)).toEqual([one._id]);
 expect((await t.query(api.findings.list,args)).page.map(f=>f.repositoryId)).toEqual([one._id]);
 expect((await t.query(api.settings.preferences,args)).map(p=>p.repositoryId)).toEqual([one._id]);
 expect(await t.query(api.analytics.report,{...args,since:now-1,until:now+1})).toMatchObject({totalReviews:1,totalPRs:1,findings:1});
 expect((await t.query(api.dashboard.overview,{...args,token:bob})).repositories.map(r=>r._id)).toEqual([one._id]);
 for(const team of [other,await t.mutation(api.scopes.createTeam,{token:alice,organizationId:await t.mutation(api.users.createOrganization,{token:alice,name:"Separate"}),name:"Foreign"})])await expect(t.query(api.dashboard.overview,{...args,token:bob,teamId:team})).rejects.toThrow("Team not accessible");
 await expect(t.query(api.settings.preferences,{...args,repositoryId:two._id})).rejects.toThrow("not accessible");
 await expect(t.query(api.analytics.report,{...args,repositoryId:two._id,since:now-1,until:now+1})).rejects.toThrow("not accessible");
 await expect(t.query(api.findings.list,{...args,repositoryId:two._id})).rejects.toThrow("selected scope");
 await expect(t.query(api.pulls.list,{...args,repositoryId:two._id,paginationOpts:{numItems:30,cursor:null}})).rejects.toThrow("selected scope");
 await t.mutation(api.scopes.member,{token:alice,teamId,userId,role:"viewer",remove:true});await expect(t.query(api.dashboard.overview,{...args,token:bob})).rejects.toThrow("Team not accessible");
});
test("provider comment IDs cannot alias another repository's conversation or finding", async () => {
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/one",defaultBranch:"main"},{id:102,fullName:"alice/two",defaultBranch:"main"}]});
 const [one,two]=await t.query(api.repositories.list,{token:alice,organizationId});
 const args={prNumber:1,commentId:7,author:"alice",question:"Why?",inline:true};
 const a=await t.mutation(internal.conversations.begin,{...args,repositoryId:one._id});
 const b=await t.mutation(internal.conversations.begin,{...args,repositoryId:two._id});
 expect(a!._id).not.toBe(b!._id);
 await t.run(async ctx=>{
  const reviewId=await ctx.db.insert("reviews",{repositoryId:one._id,organizationId,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  await ctx.db.insert("reviewComments",{organizationId,reviewId,githubId:7,fingerprint:"shared-id",createdAt:Date.now()});
 });
 expect(await t.query(internal.conversations.target,{repositoryId:two._id,prNumber:1,commentId:7})).toBeNull();
});

test("learned preference inspection preserves feedback and revision provenance, scopes visibility and rejects viewer writes",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const invitationId=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});await t.mutation(api.users.acceptInvitation,{token:bob,invitationId});
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:99,account:"alice",accountId:1,repositories:[{id:991,fullName:"alice/public-scope",defaultBranch:"main"},{id:992,fullName:"alice/private-scope",defaultBranch:"main"}]});
 const repos=await t.query(api.repositories.list,{token:alice,organizationId}),repo=repos.find(r=>r.fullName.endsWith("public-scope"))!,privateRepo=repos.find(r=>r.fullName.endsWith("private-scope"))!;
 const teamId=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Private"});await t.mutation(api.scopes.assign,{token:alice,repositoryId:privateRepo._id,teamId});
 await t.run(ctx=>ctx.db.insert("learnedPreferences",{organizationId,repositoryId:privateRepo._id,instruction:"Private pattern must never leak",category:"security",source:"legacy-private",enabled:true,createdAt:1}));
 const {reviewId,findingId}=await t.run(async ctx=>{
  await ctx.db.patch(repo._id,{enabled:true});const reviewId=await ctx.db.insert("reviews",{organizationId,repositoryId:repo._id,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:1,updatedAt:1});
  const findingId=await ctx.db.insert("findings",{organizationId,repositoryId:repo._id,reviewId,prNumber:1,title:"Preserve integer cents",description:"Converting cents here undercharges orders.",severity:"high",confidence:1,category:"data",filePath:"total.ts",startLine:1,endLine:1,commitSha:"a".repeat(40),evidence:[{filePath:"total.ts",startLine:1,quote:"return total / 100;"}],impact:"Orders are undercharged.",suggestedFix:"Return integer cents.",agent:"data",symbol:"total",fingerprint:"integer-cents",status:"open",createdAt:1,updatedAt:1});return {reviewId,findingId};
 });
 await expect(t.mutation(api.dashboard.feedback,{token:bob,findingId,value:"false_positive",comment:"Viewer mutation"})).rejects.toThrow("Viewers");
 expect((await t.run(ctx=>ctx.db.get(findingId)))?.status).toBe("open");
 expect((await t.query(api.dashboard.overview,{token:bob,organizationId})).writableRepositoryIds).toEqual([]);
 expect((await t.query(api.dashboard.overview,{token:alice,organizationId})).writableRepositoryIds).toContain(repo._id);
 const publicTeam=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Read only"});await t.mutation(api.scopes.assign,{token:alice,repositoryId:repo._id,teamId:publicTeam});
 const bobId=await t.run(async ctx=>{const user=(await ctx.db.query("users").filter(q=>q.eq(q.field("login"),"bob")).unique())!;const member=(await ctx.db.query("organizationMembers").withIndex("by_org_user",q=>q.eq("organizationId",organizationId).eq("userId",user._id)).unique())!;await ctx.db.patch(member._id,{role:"member"});return user._id;});
 await t.mutation(api.scopes.member,{token:alice,teamId:publicTeam,userId:bobId,role:"viewer",remove:false});
 await expect(t.mutation(api.dashboard.feedback,{token:bob,findingId,value:"false_positive",comment:"Team viewer mutation"})).rejects.toThrow("Team access");
 expect((await t.query(api.dashboard.overview,{token:bob,organizationId})).writableRepositoryIds).toEqual([]);
 await t.mutation(api.dashboard.feedback,{token:alice,findingId,value:"useful",comment:"Useful cross-file units check"});
 let rows=await t.query(api.settings.preferences,{token:bob,organizationId});expect(rows).toHaveLength(1);expect(rows[0].sourceReview).toMatchObject({id:reviewId,revision:"a".repeat(40)});expect(rows[0].feedback[0]).toMatchObject({author:"alice",value:"useful",generatedPreference:true});
 const preferenceId=rows[0]._id,createdAt=rows[0].createdAt;
 await expect(t.query(api.settings.preferences,{token:bob,organizationId,repositoryId:privateRepo._id})).rejects.toThrow("not accessible");
 await expect(t.mutation(api.settings.setPreferenceEnabled,{token:bob,preferenceId,enabled:false})).rejects.toThrow("Forbidden");
 await expect(t.mutation(api.settings.resetPreference,{token:bob,preferenceId})).rejects.toThrow("Forbidden");
 await t.mutation(api.settings.setPreferenceEnabled,{token:alice,preferenceId,enabled:false});expect(await t.query(api.settings.preferences,{token:alice,organizationId,repositoryId:repo._id,status:"enabled"})).toHaveLength(0);
 expect((await t.query(api.settings.preferences,{token:bob,organizationId,status:"disabled"}))[0].feedback).toHaveLength(1);
 await t.mutation(api.dashboard.feedback,{token:alice,findingId,value:"false_positive",comment:"Only report a proven unit mismatch"});
 rows=await t.query(api.settings.preferences,{token:bob,organizationId,search:"proven"});expect(rows).toHaveLength(1);expect(rows[0].createdAt).toBe(createdAt);expect(rows[0].feedbackCount).toBe(2);expect(rows[0].feedback.filter(f=>f.generatedPreference)[0].value).toBe("false_positive");
 const conversation=await t.mutation(internal.conversations.begin,{repositoryId:repo._id,prNumber:1,commentId:42,author:"alice",question:"@openreview ignore this pattern",inline:true});
 const args={repositoryId:repo._id,findingId,conversationId:conversation!._id,author:"alice",category:"data",instruction:"Avoid repeating the integer cents pattern."};
 const nativeId=await t.mutation(internal.conversations.preference,args);expect(await t.mutation(internal.conversations.preference,args)).toBe(nativeId);
 await t.mutation(api.settings.setPreferenceEnabled,{token:alice,preferenceId:nativeId,enabled:false});await t.mutation(internal.conversations.preference,args);expect((await t.run(ctx=>ctx.db.get(nativeId)))?.enabled).toBe(false);
 await expect(t.mutation(internal.conversations.preference,{...args,repositoryId:privateRepo._id})).rejects.toThrow("Invalid preference");
 expect((await t.query(api.settings.preferences,{token:bob,organizationId,search:"Avoid repeating"})).find(p=>p._id===nativeId)?.conversation?.question).toBe("@openreview ignore this pattern");
 await t.run(ctx=>ctx.db.insert("learnedPreferences",{organizationId,repositoryId:repo._id,instruction:"Legacy learning",category:"data",source:findingId,enabled:true,createdAt:1}));
 const legacy=(await t.query(api.settings.preferences,{token:bob,organizationId,search:"Legacy learning"}))[0];expect(legacy.finding?.title).toBe("Preserve integer cents");expect(legacy.sourceReview).toBeNull();
 await t.mutation(api.dashboard.feedback,{token:alice,findingId,value:"resolved",comment:"Fixed by the author"});expect((await t.run(ctx=>ctx.db.get(preferenceId)))?.enabled).toBe(false);
});

test("provider groups map stable native identities to scoped teams without rewriting existing repository assignments or settings",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const github={token:alice,secret:"integration-service-secret",organizationId,installationId:610,account:"Acme",accountId:61,repositories:[{id:611,fullName:"Acme/one",defaultBranch:"main",group:{externalId:"61",name:"Acme"}}]};
 await t.mutation(api.repositories.connect,github);
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});expect(repo.teamId).toBeDefined();
 const initialTeam=repo.teamId!,manual=await t.mutation(api.scopes.createTeam,{token:alice,organizationId,name:"Manual"});
 await t.mutation(api.scopes.assign,{token:alice,repositoryId:repo._id,teamId:manual});
 await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:false,settings:{...defaults,instructions:"Preserve this repository override"}});
 await t.mutation(api.repositories.connect,{...github,repositories:[...github.repositories,{id:612,fullName:"Acme/two",defaultBranch:"main",group:{externalId:"61",name:"Acme renamed"}}]});
 const repos=await t.query(api.repositories.list,{token:alice,organizationId});expect(repos.find(r=>r._id===repo._id)?.teamId).toBe(manual);expect(repos.find(r=>r.githubId===612)?.teamId).toBe(initialTeam);
 expect((await t.query(internal.repositories.data,{repositoryId:repo._id})).settings.instructions).toBe("Preserve this repository override");
 const connection={token:alice,secret:"integration-service-secret",organizationId,kind:"gitea",instance:"https://gitea.example",name:"Gitea",credentials:"encrypted-fixture",webhookSecret:"encrypted-hook"};
 const c1=await t.mutation(api.providerConnections.save,connection),c2=await t.mutation(api.providerConnections.save,{...connection,instance:"https://other.example"}),c3=await t.mutation(api.providerConnections.save,{...connection,instance:"https://gitea.example/another-instance"});
 const selection={token:alice,connectionId:c1,repositories:[{externalId:"1",fullName:"Acme/one",defaultBranch:"main",remoteUrl:"https://gitea.example/Acme/one.git",group:{externalId:"61",name:"Acme"}}]};
 await t.mutation(internal.providerConnections.select,selection);await t.mutation(internal.providerConnections.select,selection);
 await t.mutation(internal.providerConnections.select,{...selection,connectionId:c2});await t.mutation(internal.providerConnections.select,{...selection,connectionId:c3});
 const sources=await t.query(api.scopes.list,{token:alice,organizationId});expect(sources.teams.filter(t=>t.externalKey)).toHaveLength(4);
 const giteaRepo=sources.repositories.find(r=>r.connectionId===c1)!;expect(giteaRepo.teamId).not.toBe(initialTeam);expect(giteaRepo.teamId).not.toBe(sources.repositories.find(r=>r.connectionId===c2)?.teamId);expect(giteaRepo.teamId).not.toBe(sources.repositories.find(r=>r.connectionId===c3)?.teamId);
 await expect(t.mutation(internal.providerConnections.select,{...selection,token:bob})).rejects.toThrow("Forbidden");
 await expect(t.mutation(internal.providerConnections.select,{...selection,repositories:[{...selection.repositories[0],group:{externalId:"",name:"Bad"}}]})).rejects.toThrow("group identity");
 await t.run(ctx=>ctx.db.patch(c1,{suspended:true}));await expect(t.mutation(internal.providerConnections.select,selection)).rejects.toThrow("suspended");
 const invite=await t.mutation(api.users.invite,{token:alice,organizationId,githubLogin:"bob",role:"viewer"});await t.mutation(api.users.acceptInvitation,{token:bob,invitationId:invite});
 expect((await t.query(api.scopes.list,{token:bob,organizationId})).repositories).toEqual([]);
 const origin=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_group",namespaceId:"ns_group",credentials:"encrypted-fixture",jti:"group-receipt",expiresAt:Date.now()+240000});
 await t.mutation(internal.providerConnections.select,{token:alice,connectionId:origin,repositories:[{externalId:"repo_1",fullName:"namespace/one",defaultBranch:"main",remoteUrl:"https://origin.cursor.com/namespace/one.git"}]});
 expect((await t.query(api.scopes.list,{token:alice,organizationId})).teams.some(t=>t.externalKey===JSON.stringify(["origin","https://api.cursor.com","ns_group"]))).toBe(true);
 const p4=await t.mutation(api.providerConnections.save,{...connection,kind:"perforce",instance:"https://p4.example/server-a",name:"P4",webhookSecret:""});
 const p4Selection={token:alice,connectionId:p4,repositories:[{externalId:"native-project",fullName:"native-project",defaultBranch:"",group:{externalId:"native-project",name:"Native project"}}]};
 await t.mutation(internal.providerConnections.select,p4Selection);await t.mutation(internal.providerConnections.select,p4Selection);
 const p4Repos=(await t.query(api.repositories.list,{token:alice,organizationId})).filter(r=>r.connectionId===p4);expect(p4Repos).toHaveLength(1);
 expect(p4Repos[0]).toMatchObject({enabled:false,indexStatus:"unavailable",defaultBranch:""});expect(p4Repos[0].remoteUrl).toBeUndefined();expect(p4Repos[0].teamId).toBeDefined();
 await expect(t.mutation(api.repositories.configure,{token:alice,repositoryId:p4Repos[0]._id,enabled:true})).rejects.toThrow("native polling controls");
 await expect(t.mutation(api.repositories.reindex,{token:alice,repositoryId:p4Repos[0]._id})).rejects.toThrow("native polling controls");
 await t.mutation(api.repositories.configure,{token:alice,repositoryId:p4Repos[0]._id,enabled:false,settings:{...defaults,instructions:"Native project rules"}});
 expect((await t.query(internal.repositories.data,{repositoryId:p4Repos[0]._id})).settings.instructions).toBe("Native project rules");
 await expect(t.mutation(internal.providerConnections.select,{...p4Selection,repositories:[{...p4Selection.repositories[0],defaultBranch:"main",remoteUrl:"https://fake.example/project.git"}]})).rejects.toThrow("provider repository identity");
 await expect(t.mutation(internal.providerConnections.select,{...p4Selection,token:bob})).rejects.toThrow("Forbidden");
 expect((await t.query(api.repositories.list,{token:bob,organizationId})).some(r=>r.connectionId===p4)).toBe(false);
 await t.mutation(api.providerConnections.disconnect,{token:alice,id:p4});await expect(t.mutation(internal.providerConnections.select,p4Selection)).rejects.toThrow("disabled");
});

test("bridge dispatch checks the live provider revision and rechecks authorization before revealing fix context",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 const userId=await t.run(async ctx=>(await ctx.db.query("users").filter(q=>q.eq(q.field("login"),"alice")).unique())!._id);
 const head="a".repeat(40),hash="d".repeat(64),code="e".repeat(12);
 const reviewId=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return ctx.db.insert("reviews",{repositoryId:repo._id,organizationId,prNumber:1,headSha:head,revisionKey:"native-revision-one",status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});});
 await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash,code,name:"Live revision test"});
 await t.mutation(api.bridge.approvePair,{token:alice,organizationId,code});
 const boundFindingId=await bridgeFinding(t,repo._id,reviewId);
 const pending=()=>t.run(ctx=>ctx.db.insert("fixRequests",{userId,organizationId,repositoryId:repo._id,reviewId,findingIds:[boundFindingId],headSha:head,agent:"codex",prompt:"Authorized context",status:"pending",expiresAt:Date.now()+300000,createdAt:Date.now(),updatedAt:Date.now()}));
 let current={headSha:head,revisionKey:"native-revision-one",state:"open"};
 const installation=vi.spyOn(Github,"installation").mockResolvedValue(new Github("test-only-token"));
 const native=vi.spyOn(Github.prototype,"pullRequest").mockImplementation(async()=>({number:1,title:"Test",body:"",draft:false,state:current.state,html_url:"https://github.com/alice/example/pull/1",user:{login:"alice"},head:{sha:current.headSha,ref:"feature"},base:{sha:"b".repeat(40),ref:"main"},revisionKey:current.revisionKey,diff:[],comments:[],reviews:[],commits:[],checks:[]}));
 try{
  for(const changed of [{headSha:"c".repeat(40)},{revisionKey:"native-revision-two"},{state:"closed"}]){
   current={headSha:head,revisionKey:"native-revision-one",state:"open",...changed};const requestId=await pending();
   await expect(t.action(api.bridgeJobs.claim,{secret:"integration-service-secret",hash,requestId})).rejects.toThrow("Provider revision changed");
   expect(await t.run(ctx=>ctx.db.get(requestId))).toMatchObject({status:"failed",error:expect.stringContaining("no agent was launched")});
  }
  const unavailable=await pending();native.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(t.action(api.bridgeJobs.claim,{secret:"integration-service-secret",hash,requestId:unavailable})).rejects.toThrow("Provider unavailable");
  expect(await t.run(ctx=>ctx.db.get(unavailable))).toMatchObject({status:"failed",error:expect.stringContaining("no agent was launched")});
  current={headSha:head,revisionKey:"native-revision-one",state:"open"};
  const changedDuringFetch=await pending();native.mockImplementationOnce(async()=>{await t.run(ctx=>ctx.db.patch(repo._id,{enabled:false}));return {number:1,title:"Test",body:"",draft:false,state:"open",html_url:"https://github.com/alice/example/pull/1",user:{login:"alice"},head:{sha:head,ref:"feature"},base:{sha:"b".repeat(40),ref:"main"},revisionKey:current.revisionKey,diff:[],comments:[],reviews:[],commits:[],checks:[]};});
  await expect(t.action(api.bridgeJobs.claim,{secret:"integration-service-secret",hash,requestId:changedDuringFetch})).rejects.toThrow("Repository disabled");
  expect(await t.run(ctx=>ctx.db.get(changedDuringFetch))).toMatchObject({status:"pending"});
  await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
  const staleFinding=await pending();
  native.mockImplementationOnce(async()=>{
   await t.run(ctx=>ctx.db.patch(boundFindingId,{status:"resolved"}));
   return {number:1,title:"Test",body:"",draft:false,state:"open",html_url:"https://github.com/alice/example/pull/1",user:{login:"alice"},head:{sha:head,ref:"feature"},base:{sha:"b".repeat(40),ref:"main"},revisionKey:current.revisionKey,diff:[],comments:[],reviews:[],commits:[],checks:[]};
  });
  await expect(t.action(api.bridgeJobs.claim,{secret:"integration-service-secret",hash,requestId:staleFinding})).rejects.toThrow("Finding eligibility changed");
  expect(await t.run(ctx=>ctx.db.get(staleFinding))).toMatchObject({status:"failed",error:expect.stringContaining("no agent was launched")});
  await t.run(ctx=>ctx.db.patch(boundFindingId,{status:"open"}));
  const legacy=await pending();await t.run(ctx=>ctx.db.patch(legacy,{findingIds:undefined}));
  const beforeLegacy=native.mock.calls.length;
  await expect(t.action(api.bridgeJobs.claim,{secret:"integration-service-secret",hash,requestId:legacy})).rejects.toThrow("recreated");
  expect(native).toHaveBeenCalledTimes(beforeLegacy);
  expect(await t.run(ctx=>ctx.db.get(legacy))).toMatchObject({status:"failed",error:expect.stringContaining("no agent was launched")});
  const requestId=await pending(),args={secret:"integration-service-secret",hash,requestId};
  const results=await Promise.allSettled([t.action(api.bridgeJobs.claim,args),t.action(api.bridgeJobs.claim,args)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const result=results.find(r=>r.status==="fulfilled");expect(result?.status==="fulfilled"&&result.value).toMatchObject({headSha:head,prompt:"Authorized context"});
  const calls=native.mock.calls.length;await expect(t.action(api.bridgeJobs.claim,args)).rejects.toThrow("replayed");expect(native).toHaveBeenCalledTimes(calls);
 }finally{native.mockRestore();installation.mockRestore();}
});

test("review retry state tracks the actual durable job, deduplicates failures and clears after claim",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:771,account:"alice",accountId:1,repositories:[{id:991,fullName:"alice/retry",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 const reviewId=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return ctx.db.insert("reviews",{organizationId,repositoryId:repo._id,prNumber:1,headSha:"a".repeat(40),status:"summarizing",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});});
 await t.mutation(internal.reviews.finished,{reviewId,error:"Model summary failed with HTTP 429"});
 const queued=await t.run(ctx=>ctx.db.get(reviewId));
 expect(queued).toMatchObject({status:"queued",attempts:1,error:"Model summary failed with HTTP 429"});
 expect(queued!.finishedAt).toBeUndefined();expect(queued!.retryAt).toBeGreaterThan(Date.now());
 expect((await t.run(ctx=>ctx.db.system.get(queued!.retryScheduledId!)))?.state.kind).toBe("pending");
 expect(await t.query(api.reviews.detail,{token:alice,reviewId})).toMatchObject({retryPending:true});
 await t.mutation(internal.reviews.finished,{reviewId,error:"duplicate failure"});
 expect((await t.run(ctx=>ctx.db.get(reviewId)))!.retryScheduledId).toBe(queued!.retryScheduledId);
 await t.run(ctx=>ctx.db.patch(reviewId,{updatedAt:Date.now()-20*60000}));
 await t.mutation(internal.recovery.sweep,{});
 expect((await t.run(ctx=>ctx.db.get(reviewId)))!.retryScheduledId).toBe(queued!.retryScheduledId);
 expect(await t.mutation(internal.reviews.stage,{reviewId,status:"ingesting"})).toBe(true);
 const claimed=await t.run(ctx=>ctx.db.get(reviewId));expect(claimed).toMatchObject({status:"ingesting",attempts:2});expect(claimed!.retryScheduledId).toBeUndefined();expect(claimed!.error).toBeUndefined();
 expect((await t.run(ctx=>ctx.db.system.get(queued!.retryScheduledId!)))?.state.kind).toBe("canceled");
 expect((await t.query(api.reviews.detail,{token:alice,reviewId})).retryPending).toBe(false);
 await t.run(ctx=>ctx.db.patch(reviewId,{attempts:3}));await t.mutation(internal.reviews.finished,{reviewId,error:"retry exhausted"});
 const exhausted=await t.run(ctx=>ctx.db.get(reviewId));expect(exhausted!.status).toBe("failed");expect(exhausted!.finishedAt).toBeTypeOf("number");expect(exhausted!.retryScheduledId).toBeUndefined();
});

test("cancel and replacement revision stop pending retry jobs and record terminal times",async()=>{
 const {t,alice,organizationId}=await setup();await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:772,account:"alice",accountId:1,repositories:[{id:992,fullName:"alice/cancel-retry",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 for(const method of ["cancel","replace","stage"]){
  const reviewId=await t.run(ctx=>ctx.db.insert("reviews",{organizationId,repositoryId:repo._id,prNumber:2,headSha:"a".repeat(40),status:"summarizing",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()}));
  await t.mutation(internal.reviews.finished,{reviewId,error:"retryable"});const queued=await t.run(ctx=>ctx.db.get(reviewId));
  if(method==="cancel")await t.mutation(api.reviews.cancel,{token:alice,reviewId});
  else if(method==="replace")await t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:2,headSha:"b".repeat(40)});
  else await t.mutation(internal.reviews.stage,{reviewId,status:"cancelled",detail:"Closed native change"});
  const stopped=await t.run(ctx=>ctx.db.get(reviewId));expect(stopped!.status).toBe("cancelled");expect(stopped!.finishedAt).toBeTypeOf("number");expect(stopped!.retryScheduledId).toBeUndefined();expect((await t.run(ctx=>ctx.db.system.get(queued!.retryScheduledId!)))?.state.kind).toBe("canceled");
  await t.mutation(internal.reviews.finished,{reviewId,error:"late agent error"});expect((await t.run(ctx=>ctx.db.get(reviewId)))!.status).toBe("cancelled");
 }
});

test("Origin comments are read back before queueing and edited questions cannot launch conversation work",async()=>{
 const {t,alice,organizationId}=await setup(),oldKey=process.env.CREDENTIAL_ENCRYPTION_KEY;process.env.CREDENTIAL_ENCRYPTION_KEY="fixture-origin-credential-key-with-at-least-32-characters";
 const {privateKey}=generateKeyPairSync("ed25519"),credentials=encryptCredential(JSON.stringify({appId:"app_fixture",installationId:"inst_verified",privateKey:privateKey.export({format:"pem",type:"pkcs8"}).toString()}),organizationId+":origin");
 const connectionId=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_verified",namespaceId:"ns_verified",credentials,jti:"fresh-comment-receipt",expiresAt:Date.now()+240000});
 const repositoryId=await t.run(ctx=>ctx.db.insert("repositories",{organizationId,connectionId,externalId:"repo_verified",fullName:"acme/source",defaultBranch:"main",remoteUrl:"https://origin.cursor.com/acme/source.git",enabled:true,indexStatus:"ready",createdAt:Date.now()}));
 const permission=vi.spyOn(Origin.prototype,"canReply").mockResolvedValue(true),read=vi.spyOn(Origin.prototype,"followUp").mockRejectedValue(new Error("Origin question author or body changed"));
 const deliver=async(id:string)=>{
  const body=JSON.stringify({installationId:"inst_verified",appId:"app_fixture",deliveryId:id,event:{type:"pull_request.comment.created",payload:{pullRequest:{number:"1",repository:{id:"repo_verified"}},comment:{id:"comment_question",body:"@openreview explain",thread:{id:"thread_original"},author:{user:{id:"user_alice"}}}}}});
  const eventId=await t.mutation(internal.providerConnections.receive,{connectionId,externalId:id,eventType:"pull_request.comment.created",body});await t.action(internal.providerJobs.event,{id:eventId});return eventId;
 };
 try{
  const stale=await deliver("edited-question");expect(await t.run(ctx=>ctx.db.get(stale))).toMatchObject({status:"failed",error:"Origin question author or body changed"});
  expect((await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).filter(j=>j.name.includes("conversationJobs:reply"))).toHaveLength(0);expect(await t.run(ctx=>ctx.db.query("usageEvents").collect())).toHaveLength(0);
  read.mockResolvedValue({commentId:"comment_question",author:"user_alice",question:"@openreview explain",inline:true,parentCommentId:"comment_question"});
  const current=await deliver("verified-question");expect(await t.run(ctx=>ctx.db.get(current))).toMatchObject({status:"completed"});
  const jobs=await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect()),replies=jobs.filter(j=>j.name.includes("conversationJobs:reply"));expect(replies).toHaveLength(1);expect(replies[0].args[0]).toMatchObject({repositoryId,prNumber:1,commentId:"comment_question",parentCommentId:"comment_question",inline:true});
  const tree=vi.spyOn(Origin.prototype,"tree").mockResolvedValue([]);
  read.mockRejectedValue(new Error("Origin question author or body changed"));
  try{
   await expect(t.action(internal.conversationJobs.reply,{repositoryId,prNumber:1,commentId:"comment_question",author:"user_alice",question:"@openreview explain",inline:true,parentCommentId:"comment_question"})).rejects.toThrow("Origin question author or body changed");
   expect(tree).not.toHaveBeenCalled();expect(await t.run(ctx=>ctx.db.query("usageEvents").collect())).toHaveLength(0);
   expect((await t.run(ctx=>ctx.db.query("conversations").collect()))[0]).toMatchObject({status:"failed",error:"Origin question author or body changed"});
  }finally{tree.mockRestore();}
 }finally{permission.mockRestore();read.mockRestore();if(oldKey===undefined)delete process.env.CREDENTIAL_ENCRYPTION_KEY;else process.env.CREDENTIAL_ENCRYPTION_KEY=oldKey;}
});

test('Origin review and check lifecycle events recheck only authorized matching approval jobs and deduplicate deliveries',async()=>{
 const {t,alice,organizationId}=await setup();
 const connectionId=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:'integration-service-secret',organizationId,installationId:'inst_events',namespaceId:'ns_events',credentials:'unused-encrypted-fixture',jti:'event-receipt',expiresAt:Date.now()+240000});
 const sha='a'.repeat(40),otherSha='b'.repeat(40);
 const repo=await t.run(ctx=>ctx.db.insert('repositories',{organizationId,connectionId,externalId:'repo_events',fullName:'acme/source',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()}));
 const ids=await t.run(async ctx=>{const ids=[];for(const [number,head,status] of [[1,sha,'approved'],[2,sha,'waiting_checks'],[3,otherSha,'approved'],[4,sha,'invalidated']] as const){const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId:repo,prNumber:number,headSha:head,status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()});ids.push(await ctx.db.insert('approvalJobs',{organizationId,repositoryId:repo,reviewId,prNumber:number,headSha:head,policyKey:'fixture',status,reasons:[],createdAt:Date.now(),updatedAt:Date.now()}));}return ids;});
 const deliver=async(id:string,type:string,payload:Record<string,unknown>,installationId='inst_events')=>{const body=JSON.stringify({installationId,appId:'app_fixture',deliveryId:id,event:{type,payload}});const eventId=await t.mutation(internal.providerConnections.receive,{connectionId,externalId:id,eventType:type,body});await t.action(internal.providerJobs.event,{id:eventId});return eventId;};
 const scheduled=async()=> (await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('approvalJobs:process')).map(j=>j.args[0].id);
 const reviewPayload={pullRequest:{number:'1',repository:{id:'repo_events'}},review:{id:'rev_fixture'}};
 const reviewEvent=await deliver('review-event','pull_request.review.submitted',reviewPayload);expect(await t.run(ctx=>ctx.db.get(reviewEvent))).toMatchObject({status:'completed'});expect(await scheduled()).toEqual([ids[0]]);
 await deliver('review-event','pull_request.review.submitted',reviewPayload);expect(await scheduled()).toHaveLength(1);
 await deliver('dismissal-event','pull_request.review.dismissed',reviewPayload);expect(await scheduled()).toEqual([ids[0],ids[0]]);
 const checkPayload={repository:{id:'repo_events'},checkSuite:{id:'suite_fixture',repository:{id:'repo_events'},sha},checkRun:{id:'run_fixture',repository:{id:'repo_events'},sha,checkSuite:{id:'suite_fixture'}}};
 await deliver('check-event','repository.check_run.completed',checkPayload);expect((await scheduled()).slice(2).sort()).toEqual([ids[0],ids[1]].sort());
 const before=(await scheduled()).length;
 for(const [label,patch] of [['wrong-repo',{repository:{id:'repo_foreign'}}],['wrong-head',{sha:otherSha}],['wrong-suite',{checkSuite:{id:'suite_foreign'}}]] as const){const id=await deliver(label,'repository.check_run.updated',{...checkPayload,checkRun:{...checkPayload.checkRun,...patch}});expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({status:'failed',error:'Origin check event repository, suite or revision mismatch'});}
 const foreign=await deliver('foreign-installation','pull_request.review.submitted',reviewPayload,'inst_other');expect(await t.run(ctx=>ctx.db.get(foreign))).toMatchObject({status:'failed',error:'Origin event installation mismatch'});
 await deliver('foreign-repository','pull_request.review.submitted',{...reviewPayload,pullRequest:{number:'1',repository:{id:'repo_foreign'}}});
 await t.run(ctx=>ctx.db.patch(repo,{enabled:false}));await deliver('disabled-repository','repository.check_run.completed',checkPayload);
 expect(await scheduled()).toHaveLength(before);expect(await t.run(ctx=>ctx.db.query('usageEvents').collect())).toHaveLength(0);
});

test("failed provider delivery retry requires workspace admin, preserves signed payload and prevents duplicate retries",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const connectionId=await t.mutation(api.providerConnections.connectOrigin,{token:alice,secret:"integration-service-secret",organizationId,installationId:"inst_retry",namespaceId:"ns_retry",credentials:"encrypted",jti:"retry-receipt",expiresAt:Date.now()+240000});
 const id=await t.run(ctx=>ctx.db.insert("providerEvents",{connectionId,externalId:"original-delivery",body:"verified-original",eventType:"pull_request.created",status:"failed",attempts:3,createdAt:Date.now()}));
 await expect(t.mutation(api.providerConnections.retryEvent,{token:bob,id})).rejects.toThrow("Forbidden");
 await t.mutation(api.providerConnections.retryEvent,{token:alice,id});
 const event=await t.run(ctx=>ctx.db.get(id));expect(event).toMatchObject({status:"queued",attempts:0,body:"verified-original",externalId:"original-delivery"});
 await expect(t.mutation(api.providerConnections.retryEvent,{token:alice,id})).rejects.toThrow("Only failed");
 const list=await t.query(api.providerConnections.events,{token:alice,connectionId});expect(list[0]).not.toHaveProperty("body");
 await expect(t.query(api.providerConnections.events,{token:bob,connectionId})).rejects.toThrow("Forbidden");
 const reviewId=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert("repositories",{organizationId,connectionId,externalId:"r_native",fullName:"acme/source",defaultBranch:"main",enabled:true,indexStatus:"ready",createdAt:Date.now()});
  const resultStorageId=await ctx.storage.store(new Blob([JSON.stringify({metadata:{suppressions:[{title:"Rejected candidate",agent:"correctness",reason:"Quote does not match source"}],coverageLimits:["No runtime evidence"]},privateContent:"not exposed"})]));
  return ctx.db.insert("reviews",{organizationId,repositoryId,prNumber:1,headSha:"a".repeat(40),status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now(),resultStorageId});
 });
 expect(await t.action(api.jobs.diagnostics,{token:alice,reviewId})).toEqual({suppressions:[{title:"Rejected candidate",agent:"correctness",reason:"Quote does not match source"}],coverageLimits:["No runtime evidence"],skippedFiles:[],failedSpecialists:[],diagrams:[]});
 await expect(t.action(api.jobs.diagnostics,{token:bob,reviewId})).rejects.toThrow("Forbidden");
 await t.run(async ctx=>{
  const resultStorageId=await ctx.storage.store(new Blob([JSON.stringify({metadata:{suppressions:[{title:"Tests passed",agent:"testing",reason:"The defect is test-verified by the existing suite."}],coverageLimits:[]}})]));
  await ctx.db.patch(reviewId,{resultStorageId});
 });
 const withheld=await t.action(api.jobs.diagnostics,{token:alice,reviewId});
 expect(withheld?.suppressions[0].title).toContain("Explanation withheld");expect(withheld?.suppressions[0].reason).toContain("Explanation withheld");
 await t.run(async ctx=>{
  const resultStorageId=await ctx.storage.store(new Blob([JSON.stringify({metadata:{suppressions:[{title:"Candidate rejected",agent:"testing",reason:"Tests passed."}],coverageLimits:[]}})]));
  await ctx.db.patch(reviewId,{resultStorageId,runtimeEvidence:{headSha:"a".repeat(40),command:"node --test",executionStarted:true,exitCode:0,timedOut:false,output:"Recorded aggregate output",image:"node:24@sha256:"+"a".repeat(64),outputTruncated:false,network:"none",memoryMb:512,cpus:1}});
 });
 expect((await t.action(api.jobs.diagnostics,{token:alice,reviewId}))?.suppressions[0].reason).toBe("Tests passed.");
 await t.run(async ctx=>{const review=await ctx.db.get(reviewId);await ctx.db.patch(reviewId,{runtimeEvidence:{...review!.runtimeEvidence!,headSha:"b".repeat(40)}});});
 expect((await t.action(api.jobs.diagnostics,{token:alice,reviewId}))?.suppressions[0].reason).toContain("Explanation withheld");


 await t.run(async ctx=>{await ctx.db.patch(id,{status:"failed"});await ctx.db.patch(connectionId,{suspended:true});});
 await expect(t.mutation(api.providerConnections.retryEvent,{token:alice,id})).rejects.toThrow("suspended");
});

test("historical finding detail requires same-revision execution evidence without rewriting snapshots or lifecycle",async()=>{
 const {t,alice,bob,organizationId}=await setup();
 const headSha="a".repeat(40),now=Date.now();
 const {reviewId,findingId}=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert("repositories",{organizationId,fullName:"acme/evidence",defaultBranch:"main",enabled:true,indexStatus:"ready",createdAt:now});
  const reviewId=await ctx.db.insert("reviews",{organizationId,repositoryId,prNumber:1,headSha,status:"completed",mode:"standard",attempts:1,findingsRecorded:true,createdAt:now,updatedAt:now});
  const snapshot={title:"Failing existing tests",description:"Tests failed.",impact:"Source asserts integer cents.",severity:"high",confidence:1,category:"logic",filePath:"src/price.ts",startLine:1,endLine:1,commitSha:headSha,evidence:[{filePath:"tests/price.ts",startLine:1,quote:"assert.equal(price(),199)"}],suggestedFix:"Run tests after restoring integer cents.",agent:"correctness",symbol:"price",fingerprint:"historical-execution"};
  const findingId=await ctx.db.insert("findings",{...snapshot,organizationId,repositoryId,reviewId,prNumber:1,status:"resolved",createdAt:now,updatedAt:now});
  await ctx.db.insert("reviewFindings",{reviewId,findingId,snapshot});
  return {reviewId,findingId};
 });
 const detail=()=>t.query(api.reviews.detail,{token:alice,reviewId});
 let result=await detail();
 expect(result.findings[0]).toMatchObject({title:expect.stringContaining("Explanation withheld"),description:expect.stringContaining("Explanation withheld"),impact:"Source asserts integer cents.",currentStatus:"resolved",status:"open",canFix:false,suggestedFix:"Run tests after restoring integer cents."});
 expect(result.findings[0].evidence[0].quote).toBe("assert.equal(price(),199)");
 await expect(t.query(api.reviews.detail,{token:bob,reviewId})).rejects.toThrow("Forbidden");
 await t.run(ctx=>ctx.db.patch(reviewId,{runtimeEvidence:{headSha,command:"node --test",executionStarted:true,exitCode:1,timedOut:false,output:"Recorded failure",image:"node:24@sha256:"+"a".repeat(64),outputTruncated:false,network:"none",memoryMb:512,cpus:1}}));
 result=await detail();expect(result.findings[0]).toMatchObject({title:"Failing existing tests",description:"Tests failed.",currentStatus:"resolved",canFix:false});
 await t.run(async ctx=>{const r=await ctx.db.get(reviewId);await ctx.db.patch(reviewId,{runtimeEvidence:{...r!.runtimeEvidence!,headSha:"b".repeat(40)}});});
 expect((await detail()).findings[0].description).toContain("Explanation withheld");
 await t.run(async ctx=>{const r=await ctx.db.get(reviewId);await ctx.db.patch(reviewId,{runtimeEvidence:{...r!.runtimeEvidence!,headSha,exitCode:0}});});
 expect((await detail()).findings[0].description).toContain("Explanation withheld");
 const stored=await t.run(async ctx=>({finding:await ctx.db.get(findingId),snapshot:await ctx.db.query("reviewFindings").withIndex("by_review",q=>q.eq("reviewId",reviewId)).first()}));
 expect(stored.finding).toMatchObject({description:"Tests failed.",status:"resolved"});expect(stored.snapshot?.snapshot.description).toBe("Tests failed.");
});

test("Fix All binds eligible findings and rechecks status and confidence before bridge dispatch",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 const head="a".repeat(40),hash="f".repeat(64),code="d".repeat(12);
 const reviewId=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return ctx.db.insert("reviews",{repositoryId:repo._id,organizationId,prNumber:1,headSha:head,status:"completed",mode:"standard",attempts:1,createdAt:Date.now(),updatedAt:Date.now()});});
 const first=await bridgeFinding(t,repo._id,reviewId),second=await bridgeFinding(t,repo._id,reviewId,.9),excluded=await bridgeFinding(t,repo._id,reviewId,.1);
 await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash,code,name:"Finding eligibility"});
 await t.mutation(api.bridge.approvePair,{token:alice,organizationId,code});
 const create=()=>t.mutation(api.bridge.createFix,{token:alice,reviewId,agent:"codex"});
 let requestId=await create();
 const selected=await t.run(ctx=>ctx.db.get(requestId));
 expect(selected).toMatchObject({findingIds:[first,second]});
 expect(selected!.findingIds).not.toContain(excluded);
 for(const status of ["resolved","dismissed"]){
  await t.run(ctx=>ctx.db.patch(first,{status}));
  await expect(t.mutation(internal.bridge.claimData,{secret:"integration-service-secret",hash,requestId})).rejects.toThrow("Finding eligibility changed");
  await expect(t.mutation(internal.bridge.claim,{secret:"integration-service-secret",hash,requestId,current:{headSha:head,state:"open"}})).rejects.toThrow("Finding eligibility changed");
  expect(await t.run(ctx=>ctx.db.get(requestId))).toMatchObject({status:"pending"});
  await t.run(ctx=>ctx.db.patch(first,{status:"open"}));
 }
 await t.mutation(api.repositories.configure,{token:alice,repositoryId:repo._id,enabled:true,settings:{...defaults,minimumConfidence:.95}});
 await expect(t.mutation(internal.bridge.claimData,{secret:"integration-service-secret",hash,requestId})).rejects.toThrow("Finding eligibility changed");
 requestId=await create();
 expect((await t.run(ctx=>ctx.db.get(requestId)))!.findingIds).toEqual([first]);
 const claimed=await t.mutation(internal.bridge.claim,{secret:"integration-service-secret",hash,requestId,current:{headSha:head,state:"open"}});
 expect(claimed).toMatchObject({requestId,headSha:head});
 expect(await t.run(ctx=>ctx.db.get(first))).toMatchObject({status:"open"});
 await expect(t.mutation(internal.bridge.claim,{secret:"integration-service-secret",hash,requestId,current:{headSha:head,state:"open"}})).rejects.toThrow("replayed");
});

test("created and claimed Fix prompts distinguish exact-revision runtime evidence from test source",async()=>{
 const {t,alice,organizationId}=await setup();
 await t.mutation(api.repositories.connect,{token:alice,secret:"integration-service-secret",organizationId,installationId:55,account:"alice",accountId:1,repositories:[{id:101,fullName:"alice/example",defaultBranch:"main"}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId}),head="a".repeat(40),now=Date.now();
 const reviewId=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return ctx.db.insert("reviews",{repositoryId:repo._id,organizationId,prNumber:1,headSha:head,status:"completed",mode:"standard",attempts:1,createdAt:now,updatedAt:now});});
 const findingId=await bridgeFinding(t,repo._id,reviewId),description="The regression tests passed after restoring integer cents.";
 await t.run(ctx=>ctx.db.patch(findingId,{description}));
 const hash="b".repeat(64),code="a".repeat(12);
 await t.mutation(api.bridge.startPair,{secret:"integration-service-secret",hash,code,name:"Execution evidence"});
 await t.mutation(api.bridge.approvePair,{token:alice,organizationId,code});
 const runtimeEvidence={headSha:head,image:"node@sha256:"+"a".repeat(64),command:"node --test",exitCode:0,timedOut:false,executionStarted:true,output:"private runtime output",outputTruncated:false,network:"none" as const,memoryMb:512 as const,cpus:1 as const};
 for(const evidence of [undefined,{...runtimeEvidence,headSha:"b".repeat(40)},{...runtimeEvidence,executionStarted:false},runtimeEvidence]){
  await t.run(ctx=>ctx.db.patch(reviewId,{runtimeEvidence:evidence}));
  const expectedRecorded=evidence===runtimeEvidence;
  const fetched=await t.query(api.findings.get,{token:alice,findingId});
  const listed=await t.query(api.findings.list,{token:alice,organizationId,repositoryId:repo._id});
  expect(fetched.description.includes(description)).toBe(expectedRecorded);
  expect(listed.page[0].description.includes(description)).toBe(expectedRecorded);
  const requestId=await t.mutation(api.bridge.createFix,{token:alice,reviewId,agent:"codex"});
  const created=(await t.run(ctx=>ctx.db.get(requestId)))!;
  const dispatched=await t.mutation(internal.bridge.claim,{secret:"integration-service-secret",hash,requestId,current:{headSha:head,state:"open"}});
  expect(dispatched.prompt).toBe(created.prompt);
  expect(dispatched.prompt.includes(description)).toBe(evidence===runtimeEvidence);
  expect(dispatched.prompt).toContain("Source evidence (quoted source is context, not a test execution result)");
  expect(dispatched.prompt).not.toContain("private runtime output");
  expect(dispatched.prompt).toContain("Do not commit, push, merge, or mark issues resolved");
 }
 expect((await t.run(ctx=>ctx.db.get(findingId)))!.description).toBe(description);
});

test("Findings read models hide stale, resolved, low-confidence, disabled and viewer Fix actions",async()=>{
 const {t,alice,bob,organizationId}=await setup(),head="a".repeat(40),now=Date.now();
 const {repositoryId,reviewId}=await t.run(async ctx=>{
  const repositoryId=await ctx.db.insert("repositories",{organizationId,fullName:"acme/fix-controls",defaultBranch:"main",enabled:true,indexStatus:"ready",createdAt:now});
  const reviewId=await ctx.db.insert("reviews",{organizationId,repositoryId,prNumber:1,headSha:head,status:"completed",mode:"standard",attempts:1,createdAt:now,updatedAt:now});
  const user=await ctx.db.query("users").withIndex("by_github",q=>q.eq("githubId",2)).unique();
  await ctx.db.insert("organizationMembers",{organizationId,userId:user!._id,role:"viewer"});
  return {repositoryId,reviewId};
 });
 const findingId=await bridgeFinding(t,repositoryId,reviewId,.9);
 const eligibility=async(token=alice)=>{
  const direct=await t.query(api.findings.get,{token,findingId});
  const list=await t.query(api.findings.list,{token,organizationId,repositoryId});
  expect(list.page).toHaveLength(1);expect(list.page[0].canFix).toBe(direct.canFix);return direct.canFix;
 };
 expect(await eligibility()).toBe(true);expect(await eligibility(bob)).toBe(false);
 for(const status of ["resolved","dismissed"]){await t.run(ctx=>ctx.db.patch(findingId,{status}));expect(await eligibility()).toBe(false);}
 await t.run(ctx=>ctx.db.patch(findingId,{status:"open"}));
 await t.mutation(api.scopes.save,{token:alice,organizationId,settings:{...defaults,minimumConfidence:.95},overrideKeys:["minimumConfidence"]});
 expect(await eligibility()).toBe(false);
 await t.run(ctx=>ctx.db.patch(findingId,{confidence:1}));expect(await eligibility()).toBe(true);
 await t.run(ctx=>ctx.db.patch(repositoryId,{enabled:false}));expect(await eligibility()).toBe(false);
 await t.run(ctx=>ctx.db.patch(repositoryId,{enabled:true}));
 const newer=await t.run(ctx=>ctx.db.insert("reviews",{organizationId,repositoryId,prNumber:1,headSha:"b".repeat(40),status:"reviewing",mode:"standard",attempts:1,createdAt:now+1,updatedAt:now+1}));
 expect(await eligibility()).toBe(false);
 await t.run(ctx=>ctx.db.patch(newer,{status:"completed"}));expect(await eligibility()).toBe(false);
 expect(await t.run(ctx=>ctx.db.get(findingId))).toMatchObject({status:"open",commitSha:head,reviewId});
});
