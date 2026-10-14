import test from 'node:test';
import assert from 'node:assert/strict';
import {forgePersonalCredential,verifyForgePersonalAccess,revalidateForgePersonalAccess} from '../src/bitbucket-forge';

test('Forge personal access verifies active native principal and selected repository, expires with the native token and rechecks access',async t=>{
 const workspace='11111111-1111-4111-8111-111111111111',repository='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333',foreign='44444444-4444-4444-8444-444444444444';
 const installation='ari:cloud:ecosystem::installation/55555555-5555-4555-8555-555555555555';
 const userToken='opaque-native-user-token';
 const invocation={installationId:installation,workspaceId:workspace,principal:'native-account',invocationId:'signed-fixture',invocationIssuedAt:Date.now(),invocationExpiresAt:Date.now()+60000};
 let mode='ok',calls=0,userCalls=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,options?:RequestInit)=>{
  calls++;const url=new URL(String(input));assert.equal(url.origin,'https://api.bitbucket.org');assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+userToken);
  if(mode==='denied')return new Response('',{status:403});
  if(url.pathname==='/2.0/user'){
   userCalls++;return Response.json({uuid:mode==='changed'&&userCalls>1?foreign:user,type:mode==='bot'?'app_user':'user',account_id:mode==='principal'?'other-account':'native-account',...(mode==='missing-status'?{}:{account_status:mode==='inactive'?'inactive':'active'})});
  }
  assert.equal(decodeURIComponent(url.pathname),'/2.0/repositories/{'+workspace+'}/{'+repository+'}');
  return Response.json({uuid:mode==='repository'?foreign:repository,scm:mode==='scm'?'hg':'git',full_name:mode==='name'?'acme/other':'acme/repo',workspace:{uuid:mode==='workspace'?foreign:workspace}});
 });
 const linked=await verifyForgePersonalAccess(invocation,userToken,'{'+repository+'}','acme/repo');
 assert.equal(linked.externalId,user);assert.equal(linked.username,'{'+user+'}');assert.equal(linked.credential.expiresAt-linked.credential.receivedAt,60*60000);assert.equal(calls,3);
 const saved=JSON.stringify(linked.credential);
 assert.deepEqual(await revalidateForgePersonalAccess(saved,installation,workspace,repository,'acme/repo'),{externalId:user,username:'{'+user+'}'});
 for(const bad of ['principal','bot','missing-status','inactive','repository','workspace','name','scm','changed','denied']){mode=bad;userCalls=0;await assert.rejects(verifyForgePersonalAccess(invocation,userToken,repository,'acme/repo'));}
 mode='ok';userCalls=0;
 for(const invalid of [{principal:undefined},{invocationExpiresAt:Date.now()-1},{invocationIssuedAt:Date.now()+60000}]){const before:number=calls;await assert.rejects(verifyForgePersonalAccess({...invocation,...invalid},userToken,repository,'acme/repo'));assert.equal(calls,before);}
 for(const change of [{expiresAt:linked.credential.receivedAt+7200000},{expiresAt:Date.now()-1},{receivedAt:Date.now()+60000},{installationId:'forged'},{nativeUserId:'forged'},{accountId:''},{extra:'forged'}])assert.throws(()=>forgePersonalCredential(JSON.stringify({...linked.credential,...change})));
 let before:number=calls;await assert.rejects(revalidateForgePersonalAccess(saved,installation,foreign,repository,'acme/repo'));assert.equal(calls,before);
 before=calls;await assert.rejects(revalidateForgePersonalAccess(saved,installation.replace('55555555','66666666'),workspace,repository,'acme/repo'));assert.equal(calls,before);
 await assert.rejects(revalidateForgePersonalAccess(JSON.stringify({...linked.credential,nativeUserId:foreign}),installation,workspace,repository,'acme/repo'),/account replaced/);
});

test('Personal remote consumes only a signed native user invocation and encrypts the verified token in the exact OpenReview user scope',async t=>{
 const {generateKeyPairSync,createHash}=await import('node:crypto'),{SignJWT}=await import('jose'),{ConvexHttpClient}=await import('convex/browser'),{decryptCredential}=await import('../src/credentials'),{POST}=await import('../app/api/bitbucket/forge/identity/route');
 const workspace='11111111-1111-4111-8111-111111111111',repository='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333',app='ari:cloud:ecosystem::app/44444444-4444-4444-8444-444444444444',installation='ari:cloud:ecosystem::installation/55555555-5555-4555-8555-555555555555',environment=app.replace('::app/','::environment/')+'/66666666-6666-4666-8666-666666666666',code='a'.repeat(64),hash=createHash('sha256').update(code).digest('hex');
 const before=Object.fromEntries(['BITBUCKET_FORGE_APP_ID','BITBUCKET_FORGE_ENVIRONMENT_ID','NEXT_PUBLIC_CONVEX_URL','SERVICE_SECRET','CREDENTIAL_ENCRYPTION_KEY'].map(k=>[k,process.env[k]]));
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const sign=(principal:string|undefined='account')=>new SignJWT({app:{id:app,environment:{id:environment},installation:{id:installation,contexts:[{name:'bitbucket',apiBaseUrl:'https://api.bitbucket.org',workspaceId:workspace}]}},...(principal?{principal}:{})}).setProtectedHeader({alg:'RS256',kid:'personal-fixture'}).setIssuer('forge/invocation-token').setAudience(app).setIssuedAt().setNotBefore('0s').setExpirationTime('1m').setJti('personal-fit').sign(privateKey);
 let grantValid=true,grantWorkspace=workspace,mutations=0,apiCalls=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,options?:RequestInit)=>{
  const url=new URL(String(input));assert.equal(options?.redirect,'error');if(url.hostname==='forge.cdn.prod.atlassian-dev.net')return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'personal-fixture',alg:'RS256'}]});
  apiCalls++;assert.equal(new Headers(options?.headers).get('authorization'),'Bearer opaque-user-token');if(url.pathname==='/2.0/user')return Response.json({uuid:user,type:'user',account_id:'account',account_status:'active'});assert.equal(decodeURIComponent(url.pathname),'/2.0/repositories/{'+workspace+'}/{'+repository+'}');return Response.json({uuid:repository,scm:'git',full_name:'acme/repo',workspace:{uuid:workspace}});
 });
 t.mock.method(ConvexHttpClient.prototype,'query',async(_fn:unknown,args:{tokenHash:string;secret:string})=>{assert.equal(args.tokenHash,hash);assert.equal(args.secret,'service');if(!grantValid)throw new Error('Consumed');return {organizationId:'org',userId:'openreview-user',connectionId:'connection',digest:'binding',installationId:installation,workspaceId:grantWorkspace,externalId:repository,fullName:'acme/repo'};});
 t.mock.method(ConvexHttpClient.prototype,'mutation',async(_fn:unknown,args:{tokenHash:string;credentials:string;externalId:string;username:string;expiresAt:number;digest:string;invocationId:string})=>{assert.equal(args.tokenHash,hash);assert.equal(args.externalId,user);assert.equal(args.username,'{'+user+'}');assert.equal(args.digest,'binding');assert.equal(args.invocationId,'personal-fit');const saved=JSON.parse(decryptCredential(args.credentials,'org:provider-personal:connection:openreview-user'));assert.equal(saved.userToken,'opaque-user-token');assert.equal(saved.expiresAt,args.expiresAt);mutations++;return {expiresAt:args.expiresAt};});
 try{
  delete process.env.BITBUCKET_FORGE_APP_ID;assert.equal((await POST(new Request('https://openreview.example/api/bitbucket/forge/identity',{method:'POST'}))).status,503);
  Object.assign(process.env,{BITBUCKET_FORGE_APP_ID:app,BITBUCKET_FORGE_ENVIRONMENT_ID:environment,NEXT_PUBLIC_CONVEX_URL:'https://fixture.convex.cloud',SERVICE_SECRET:'service',CREDENTIAL_ENCRYPTION_KEY:'personal-encryption-fixture-at-least-32-characters'});
  const request=(authorization:string,body:unknown={code})=>new Request('https://openreview.example/api/bitbucket/forge/identity',{method:'POST',headers:{authorization,'x-forge-oauth-user':'opaque-user-token'},body:JSON.stringify(body)});
  const authorization='Bearer '+await sign();const response=await POST(request(authorization));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const result=await response.json();assert.deepEqual(Object.keys(result).sort(),['expiresAt','status']);assert.equal(result.status,'linked');assert.equal(mutations,1);
  assert.equal((await POST(request('Bearer forged'))).status,401);assert.equal((await POST(request('Bearer '+await sign('')))).status,403);
  assert.equal((await POST(request(authorization,{code,userId:'forged'}))).status,400);assert.equal((await POST(request(authorization,{code:'a'.repeat(2000)}))).status,400);
  grantWorkspace=repository;let count=apiCalls;assert.equal((await POST(request(authorization))).status,403);assert.equal(apiCalls,count);grantWorkspace=workspace;
  grantValid=false;count=apiCalls;assert.equal((await POST(request(authorization))).status,403);assert.equal(apiCalls,count);assert.equal(mutations,1);
 }finally{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
