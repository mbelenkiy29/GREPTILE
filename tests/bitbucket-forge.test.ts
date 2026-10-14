import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {SignJWT} from "jose";
import {verifyBitbucketForge,forgeRepositories,verifyForgeConnectionAccess} from "../src/bitbucket-forge";
import {POST} from "../app/api/bitbucket/forge/catalog/route";
import {POST as connect} from "../app/api/bitbucket/forge/connect/route";
import {POST as uninstall} from "../app/api/bitbucket/forge/uninstall/route";
import {POST as events} from "../app/api/bitbucket/forge/events/route";
import {POST as refresh} from "../app/api/bitbucket/forge/refresh/route";
import {ConvexHttpClient} from "convex/browser";
import {createHash} from "node:crypto";
import {decryptCredential,encryptCredential} from "../src/credentials";

test("Forge catalog authenticates the installed app/environment and confines discovery to its signed workspace",async t=>{
 const appUuid="11111111-1111-4111-8111-111111111111",tenant="22222222-2222-4222-8222-222222222222",repoId="33333333-3333-4333-8333-333333333333";
 const app="ari:cloud:ecosystem::app/"+appUuid,environment="ari:cloud:ecosystem::environment/"+appUuid+"/44444444-4444-4444-8444-444444444444";
 const installation="ari:cloud:ecosystem::installation/55555555-5555-4555-8555-555555555555";
 const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
 const payload={app:{id:app,environment:{id:environment},installation:{id:installation,contexts:[{name:"bitbucket",apiBaseUrl:"https://api.bitbucket.org",workspaceId:tenant}]}},context:{workspaceId:"{"+tenant+"}"}};
 const sign=async(value:Record<string,unknown>=payload,expiry="1m")=>new SignJWT(value).setProtectedHeader({alg:"RS256",kid:"fixture"}).setIssuer("forge/invocation-token").setAudience(app).setIssuedAt().setNotBefore("0s").setExpirationTime(expiry).setJti("invocation-fixture").sign(privateKey);
 const row={uuid:"{"+repoId+"}",full_name:"acme/repo",slug:"repo",scm:"git",workspace:{uuid:"{"+tenant+"}",slug:"acme",name:"Acme"},mainbranch:{name:"main"}};
 let page:unknown={values:[row]},calls=0;
 t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{
  const url=new URL(String(input));assert.equal(options?.redirect,"error");
  if(url.hostname==="forge.cdn.prod.atlassian-dev.net")return Response.json({keys:[{...publicKey.export({format:"jwk"}),kid:"fixture",alg:"RS256"}]});
  calls++;assert.equal(url.origin,"https://api.bitbucket.org");assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-system-token");
  assert.equal(decodeURIComponent(url.pathname),"/2.0/repositories/{"+tenant+"}");return Response.json(page);
 });
 const token=await sign();
 assert.deepEqual(await verifyBitbucketForge("Bearer "+token,app,environment),{installationId:installation,workspaceId:tenant,invocationId:"invocation-fixture",invocationExpiresAt:JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()).exp*1000,invocationIssuedAt:JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()).iat*1000});
 await assert.rejects(verifyBitbucketForge("Bearer "+token,app,environment.replace(/4/g,"6")));
 await assert.rejects(verifyBitbucketForge("Bearer "+await sign({...payload,context:{workspaceId:repoId}}),app,environment));
 await assert.rejects(verifyBitbucketForge("Bearer "+await sign({...payload,icLabel:"other-cloud"}),app,environment));
 await assert.rejects(verifyBitbucketForge("Bearer "+await sign({...payload,app:{...payload.app,installationId:"ari:cloud:ecosystem::installation/"+repoId}}),app,environment),/installation context mismatch/);
 assert.equal((await verifyBitbucketForge("Bearer "+await sign({...payload,principal:"account-fixture"}),app,environment)).principal,"account-fixture");
 await assert.rejects(verifyBitbucketForge("Bearer "+await sign(payload,"-1s"),app,environment));
 await assert.rejects(verifyBitbucketForge("Bearer "+token.slice(0,-8)+"AAAAAAAA",app,environment));
 const found=await forgeRepositories(tenant,"fixture-system-token");assert.equal(found[0].externalId,row.uuid);assert.equal(found[0].group.externalId,tenant);assert.equal(found[0].remoteUrl,"https://bitbucket.org/acme/repo.git");
 page={values:[{...row,mainbranch:null}]};assert.equal((await forgeRepositories(tenant,"fixture-system-token"))[0].defaultBranch,null);
 page={values:[{...row,workspace:{...row.workspace,uuid:repoId}}]};await assert.rejects(forgeRepositories(tenant,"fixture-system-token"),/workspace mismatch/);
 page={values:[row,row]};await assert.rejects(forgeRepositories(tenant,"fixture-system-token"),/identity/);
 page={values:[{...row,slug:"../repo"}]};await assert.rejects(forgeRepositories(tenant,"fixture-system-token"));
 for(const next of ["https://evil.example/token","https://api.bitbucket.org/2.0/repositories/other?pagelen=100"]){page={values:[row],next};const before=calls;await assert.rejects(forgeRepositories(tenant,"fixture-system-token"),/Invalid/);assert.equal(calls,before+1);}
 const first="https://api.bitbucket.org/2.0/repositories/"+encodeURIComponent("{"+tenant+"}")+"?pagelen=100";
 page={values:[row],next:first};await assert.rejects(forgeRepositories(tenant,"fixture-system-token"),/repeated/);
 const previousApp=process.env.BITBUCKET_FORGE_APP_ID,previousEnvironment=process.env.BITBUCKET_FORGE_ENVIRONMENT_ID;
 const envBefore={NEXT_PUBLIC_CONVEX_URL:process.env.NEXT_PUBLIC_CONVEX_URL,SERVICE_SECRET:process.env.SERVICE_SECRET,CREDENTIAL_ENCRYPTION_KEY:process.env.CREDENTIAL_ENCRYPTION_KEY};
 try{
  delete process.env.BITBUCKET_FORGE_APP_ID;assert.equal((await POST(new Request("https://openreview.example/api/bitbucket/forge/catalog",{method:"POST"}))).status,503);
  process.env.BITBUCKET_FORGE_APP_ID=app;process.env.BITBUCKET_FORGE_ENVIRONMENT_ID=environment;
  assert.equal((await POST(new Request("https://openreview.example/api/bitbucket/forge/catalog",{method:"POST"}))).status,401);
  page={values:[row]};
  const response=await POST(new Request("https://openreview.example/api/bitbucket/forge/catalog",{method:"POST",headers:{authorization:"Bearer "+token,"x-forge-oauth-system":"fixture-system-token"},body:JSON.stringify({workspaceId:repoId})}));
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");assert.equal((await response.json()).workspaceId,tenant);
  process.env.NEXT_PUBLIC_CONVEX_URL="https://fixture.convex.cloud";process.env.SERVICE_SECRET="service-fixture";process.env.CREDENTIAL_ENCRYPTION_KEY="credential-fixture-".repeat(4);
  const code="a".repeat(64),hash=createHash("sha256").update(code).digest("hex"),publisher="66666666-6666-4666-8666-666666666666";
  let mutations=0,grantValid=true,nativeOwner=true;
  t.mock.method(ConvexHttpClient.prototype,"query",async(_fn:unknown,args:{tokenHash:string;secret:string})=>{assert.equal(args.tokenHash,hash);assert.equal(args.secret,"service-fixture");if(!grantValid)throw new Error("Expired grant");return {organizationId:"org-fixture",expiresAt:Date.now()+60000};});
  t.mock.method(ConvexHttpClient.prototype,"mutation",async(_fn:unknown,args:{credentials:string;workspaceId:string;installationId:string;invocationExpiresAt:number})=>{
   assert.equal(args.workspaceId,tenant);assert.equal(args.installationId,installation);assert.ok(args.invocationExpiresAt>Date.now());
   const credential=JSON.parse(decryptCredential(args.credentials,"org-fixture:bitbucket-cloud"));assert.equal(credential.systemToken,"fixture-system-token");assert.equal(credential.publisherId,publisher);assert.ok(credential.expiresAt>credential.receivedAt);assert.ok(credential.expiresAt<=Date.now()+3600000);assert.equal(credential.userToken,undefined);
   mutations++;return "connection-fixture";
  });
  t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{
   const url=new URL(String(input));assert.equal(url.origin,"https://api.bitbucket.org");assert.equal(options?.redirect,"error");
   const system=new Headers(options?.headers).get("authorization")==="Bearer fixture-system-token";
   if(url.pathname==="/2.0/user")return Response.json({uuid:system?publisher:repoId,type:system?"app_user":"user",account_id:system?"app-account":"account-fixture",account_status:"active"});
   assert.equal(decodeURIComponent(url.pathname),"/2.0/workspaces/{"+tenant+"}/permissions");
   return Response.json({values:[{permission:nativeOwner?"owner":"member",user:{uuid:repoId},workspace:{uuid:tenant}}]});
  });
  const invocation=await sign({...payload,principal:"account-fixture"});
  const request=(body:unknown={code},authorization="Bearer "+invocation)=>new Request("https://openreview.example/api/bitbucket/forge/connect",{method:"POST",headers:{authorization,"x-forge-oauth-system":"fixture-system-token","x-forge-oauth-user":"fixture-user-token"},body:JSON.stringify(body)});
  const connected=await connect(request());assert.equal(connected.status,200);assert.equal(connected.headers.get("cache-control"),"no-store");assert.deepEqual(Object.keys(await connected.json()).sort(),["connectionId","message","status"]);assert.equal(mutations,1);
  assert.equal((await connect(request({code,workspaceId:repoId}))).status,400);
  assert.equal((await connect(request({code:"x".repeat(2000)}))).status,400);
  assert.equal((await connect(request({code},"Bearer forged"))).status,401);
  grantValid=false;assert.equal((await connect(request())).status,403);grantValid=true;nativeOwner=false;assert.equal((await connect(request())).status,403);assert.equal(mutations,1);
  let available=true,nativePublisher=publisher,previousIssuedAt=0,refreshes=0;
  t.mock.method(ConvexHttpClient.prototype,"query",async(_fn:unknown,args:{secret:string;installationId:string;workspaceId:string})=>{
   assert.equal(args.secret,"service-fixture");assert.equal(args.installationId,installation);assert.equal(args.workspaceId,tenant);if(!available)throw new Error("Disconnected");
   return {id:"connection-fixture",organizationId:"org-fixture",credentials:encryptCredential(JSON.stringify({publisherId:publisher,invocationIssuedAt:previousIssuedAt}),"org-fixture:bitbucket-cloud")};
  });
  t.mock.method(ConvexHttpClient.prototype,"mutation",async(_fn:unknown,args:{previousCredentials:string;credentials:string;installationId:string;workspaceId:string})=>{
   assert.equal(args.installationId,installation);assert.equal(args.workspaceId,tenant);
   assert.equal(JSON.parse(decryptCredential(args.previousCredentials,"org-fixture:bitbucket-cloud")).publisherId,publisher);
   const current=JSON.parse(decryptCredential(args.credentials,"org-fixture:bitbucket-cloud"));assert.equal(current.publisherId,publisher);assert.equal(current.systemToken,"fixture-system-token");assert.equal(current.expiresAt-current.receivedAt,90*60000);assert.equal(current.userToken,undefined);refreshes++;
   return {id:"connection-fixture"};
  });
  t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{assert.equal(String(input),"https://api.bitbucket.org/2.0/user");assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-system-token");return Response.json({uuid:nativePublisher,type:"app_user",account_id:"app-fixture",account_status:"active"});});
  const scheduled={...payload,app:{...payload.app,module:{type:"core:endpoint",key:"openreview-token-refresh"}}};
  const renewRequest=(authorization:string)=>new Request("https://openreview.example/api/bitbucket/forge/refresh",{method:"POST",headers:{authorization,"x-forge-oauth-system":"fixture-system-token"}});
  const refreshed=await refresh(renewRequest("Bearer "+await sign(scheduled)));assert.equal(refreshed.status,200);assert.deepEqual(await refreshed.json(),{status:"refreshed"});assert.equal(refreshes,1);
  for(const invalid of [payload,{...scheduled,principal:"account-fixture"},{...scheduled,app:{...scheduled.app,module:{type:"xen:macro",key:"openreview-token-refresh"}}},{...scheduled,app:{...scheduled.app,module:{type:"core:endpoint",key:"other-endpoint"}}}])assert.equal((await refresh(renewRequest("Bearer "+await sign(invalid)))).status,403);
  assert.equal((await refresh(renewRequest("Bearer forged"))).status,401);
  available=false;assert.equal((await refresh(renewRequest("Bearer "+await sign(scheduled)))).status,403);available=true;
  nativePublisher=repoId;assert.equal((await refresh(renewRequest("Bearer "+await sign(scheduled)))).status,403);nativePublisher=publisher;
  previousIssuedAt=Date.now()+60000;assert.equal((await refresh(renewRequest("Bearer "+await sign(scheduled)))).status,403);assert.equal(refreshes,1);

  let deliveries=0;
  t.mock.method(ConvexHttpClient.prototype,"mutation",async(_fn:unknown,args:{body:string;workspaceId:string;installationId:string;secret:string})=>{
   assert.equal(args.workspaceId,tenant);assert.equal(args.installationId,installation);assert.equal(args.secret,"service-fixture");
   const received=JSON.parse(args.body);assert.equal(received.repository.uuid,repoId);assert.equal(received.comment.injected,undefined);deliveries++;return "event-fixture";
  });
  const product={...payload,app:{...payload.app,module:{type:"core:endpoint",key:"openreview-events"}}};
  const nativeEvent={eventType:"avi:bitbucket:created:pullrequest-comment",timestamp:"2026-03-23T06:03:12.361017Z",actor:{type:"user",uuid:repoId,accountId:"account-fixture"},repository:{uuid:"{"+repoId+"}"},workspace:{uuid:"{"+tenant+"}"},pullrequest:{id:1,state:"OPEN",source:{branch:"feature",commit:{hash:"a".repeat(40)}},destination:{branch:"main",commit:{hash:"b".repeat(40)}}},comment:{id:10,injected:"@openreview stolen body"}};
  const eventRequest=(authorization:string,value:unknown=nativeEvent)=>new Request("https://openreview.example/api/bitbucket/forge/events",{method:"POST",headers:{authorization},body:JSON.stringify(value)});
  const accepted=await events(eventRequest("Bearer "+await sign(product)));assert.equal(accepted.status,202);assert.deepEqual(await accepted.json(),{status:"accepted"});assert.equal(deliveries,1);
  assert.equal((await events(eventRequest("Bearer forged"))).status,401);
  for(const invalid of [payload,{...product,principal:"account-fixture"},{...product,app:{...product.app,module:{type:"core:endpoint",key:"openreview-token-refresh"}}}])assert.equal((await events(eventRequest("Bearer "+await sign(invalid)))).status,403);
  const productToken="Bearer "+await sign(product);
  assert.equal((await events(eventRequest(productToken,{...nativeEvent,workspace:{uuid:repoId}}))).status,403);
  assert.equal((await events(eventRequest(productToken,{...nativeEvent,comment:undefined}))).status,400);
  assert.equal((await events(eventRequest(productToken,{...nativeEvent,padding:"x".repeat(400001)}))).status,400);assert.equal(deliveries,1);

  let removals=0;
  t.mock.method(ConvexHttpClient.prototype,"mutation",async(_fn:unknown,args:{workspaceId:string;installationId:string;body?:unknown})=>{assert.equal(args.workspaceId,tenant);assert.equal(args.installationId,installation);assert.equal(args.body,undefined);removals++;return {status:"disconnected"};});
  const removal={...payload,app:{...payload.app,module:{type:"core:endpoint",key:"openreview-uninstall"}}};
  const removalRequest=(authorization:string)=>new Request("https://openreview.example/api/bitbucket/forge/uninstall",{method:"POST",headers:{authorization},body:JSON.stringify({workspaceId:repoId,installationId:"forged-body"})});
  const removed=await uninstall(removalRequest("Bearer "+await sign(removal)));assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{status:"disconnected"});assert.equal(removals,1);
  assert.equal((await uninstall(removalRequest("Bearer forged"))).status,401);
  for(const invalid of [payload,product,{...removal,principal:"account-fixture"}])assert.equal((await uninstall(removalRequest("Bearer "+await sign(invalid)))).status,403);assert.equal(removals,1);
 }finally{if(previousApp===undefined)delete process.env.BITBUCKET_FORGE_APP_ID;else process.env.BITBUCKET_FORGE_APP_ID=previousApp;if(previousEnvironment===undefined)delete process.env.BITBUCKET_FORGE_ENVIRONMENT_ID;else process.env.BITBUCKET_FORGE_ENVIRONMENT_ID=previousEnvironment;for(const [key,value] of Object.entries(envBefore)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test("Forge connection proof binds the native active user, workspace owner and app publisher without accepting forged scope",async t=>{
 const tenant="22222222-2222-4222-8222-222222222222",nativeUser="33333333-3333-4333-8333-333333333333",publisher="44444444-4444-4444-8444-444444444444";
 const identity={installationId:"ari:cloud:ecosystem::installation/55555555-5555-4555-8555-555555555555",workspaceId:tenant,invocationId:"invocation-fixture",invocationExpiresAt:Date.now()+60000,invocationIssuedAt:Date.now(),principal:"account-fixture"};
 let mode="ok",permissionCalls=0;
 t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{
  const url=new URL(String(input));assert.equal(url.origin,"https://api.bitbucket.org");assert.equal(options?.redirect,"error");
  const token=new Headers(options?.headers).get("authorization");
  if(url.pathname==="/2.0/user"){
   const system=token==="Bearer fixture-system-token";
   assert.ok(system||token==="Bearer fixture-user-token");
   return Response.json({uuid:system?publisher:nativeUser,type:system?(mode==="human-system"?"user":"app_user"):"user",account_id:system?"app-fixture":mode==="principal"?"another-account":"account-fixture",...(mode==="missing-status"?{}:{account_status:mode==="inactive"&&!system?"inactive":"active"})});
  }
  permissionCalls++;assert.equal(token,"Bearer fixture-user-token");assert.equal(decodeURIComponent(url.pathname),"/2.0/workspaces/{"+tenant+"}/permissions");assert.equal(url.searchParams.get("q"),'user.uuid="{'+nativeUser+'}"');
  const row={permission:mode==="member"?"member":"owner",user:{uuid:mode==="foreign-user"?publisher:nativeUser},workspace:{uuid:mode==="foreign-workspace"?publisher:tenant}};
  return Response.json({values:mode==="empty"?[]:mode==="duplicate"?[row,row]:[row],...(mode==="escape"?{next:"https://evil.example/permissions"}:mode==="replay"?{next:url.href}:mode==="filter"?{next:url.origin+url.pathname+"?q=all&pagelen=100"}:mode==="incomplete"?{size:2}:{} )});
 });
 assert.deepEqual(await verifyForgeConnectionAccess(identity,"fixture-user-token","fixture-system-token"),{...identity,nativeUserId:nativeUser,publisherId:publisher});
 for(const bad of ["principal","inactive","missing-status","human-system","member","foreign-user","foreign-workspace","empty","duplicate","incomplete","escape","replay","filter"]){mode=bad;const before=permissionCalls;await assert.rejects(verifyForgeConnectionAccess(identity,"fixture-user-token","fixture-system-token"));if(["escape","replay","filter"].includes(bad))assert.equal(permissionCalls,before+1);}
 mode="ok";await assert.rejects(verifyForgeConnectionAccess({...identity,principal:undefined},"fixture-user-token","fixture-system-token"),/user invocation required/);
 await assert.rejects(verifyForgeConnectionAccess(identity,"bad-token","fixture-system-token"),/OAuth token required/);
});
