import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,exportPKCS8,SignJWT} from 'jose';
import {z} from 'zod';
import {originApi,verifyOriginUserReceipt,originUserAccess} from '../src/origin-auth';

test('Origin personal confirmation validates signed identity, receipt type, installation, namespace, state and lifetime',async t=>{
 const pair=await generateKeyPair('EdDSA',{extractable:true}),jwk={...await exportJWK(pair.publicKey),kid:'origin-personal-key'};
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{assert.equal(input,originApi+'/keys');assert.equal(options.redirect,'error');return Response.json({keys:[jwk]});});
 const now=Math.floor(Date.now()/1000),claims={sub:'user_alice',installation_id:'i_fixture',namespace_id:'ns_fixture',state:'bound-state',jti:'receipt-one',iat:now,exp:now+299};
 const sign=(changes:Record<string,unknown>={},typ='origin-user-confirmation-receipt+jwt',aud='app_fixture',iss=originApi)=>new SignJWT({...claims,...changes}).setProtectedHeader({alg:'EdDSA',kid:jwk.kid,typ}).setIssuer(iss).setAudience(aud).sign(pair.privateKey);
 const check=(receipt:string,state='bound-state',installation='i_fixture',namespace='ns_fixture')=>verifyOriginUserReceipt(receipt,'app_fixture',state,installation,namespace);
 const receipt=await sign();assert.equal((await check(receipt)).sub,'user_alice');
 for(const changes of [{sub:'app_forged'},{state:'foreign'},{installation_id:'i_other'},{namespace_id:'ns_other'},{jti:''},{exp:now+301},{iat:now-500,exp:now+10},{exp:now-1},{iat:now+100,exp:now+99}])await assert.rejects(check(await sign(changes)));
 for(const invalidReceipt of [await sign({},'origin-installation-receipt+jwt'),await sign({},undefined,'app_other'),await sign({},undefined,undefined,'https://foreign.example'),receipt.slice(0,-8)+'forgery'])await assert.rejects(check(invalidReceipt));
 await assert.rejects(check(receipt,''));await assert.rejects(check(receipt,'bound-state','i_other'));await assert.rejects(check(receipt,'bound-state','i_fixture','ns_other'));
});

test('Origin delegated access is freshly minted for only the confirmed user and primary repository, with read-only scope',async t=>{
 const pair=await generateKeyPair('EdDSA',{extractable:true}),credentials={appId:'app_fixture',privateKey:await exportPKCS8(pair.privateKey),installationId:'i_fixture'},personal={userId:'user_alice',installationId:'i_fixture',namespaceId:'ns_fixture'};
 let mode='ok',mints=0,reads=0;let expectedRepo='repo_fixture',expectedUser='user_alice';
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  assert.equal(options.redirect,'error');
  if(input.endsWith('/user_access_tokens')){
   mints++;assert.equal(input,originApi+'/app/installations/i_fixture/user_access_tokens');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(String(options.body)),{userId:expectedUser,scopes:['repository:metadata:read','repository:contents:read','repository:pull_requests:read'],repositoryIds:[expectedRepo]});
   if(mode==='revoked'||mode==='missing-scope')return Response.json({},{status:mode==='revoked'?401:403});
   return Response.json({token:'opaque-personal-token',expiresAt:new Date(Date.now()+(mode==='too-long'?360000:mode==='expired'?-1000:240000)).toISOString()});
  }
  reads++;assert.equal(input,originApi+'/repos/_/'+expectedRepo);assert.equal(new Headers(options.headers).get('authorization'),'Bearer opaque-personal-token');
  return Response.json({id:mode==='wrong-repo'?'repo_other':expectedRepo,owner:{id:mode==='wrong-namespace'?'ns_other':'ns_fixture'}},{status:mode==='denied'?403:200});
 });
 for(let i=0;i<2;i++)assert.deepEqual(await originUserAccess(credentials,personal,'repo_fixture'),{externalId:'user_alice',username:'user_alice'});assert.equal(mints,2);
 for(const next of ['revoked','missing-scope','too-long','expired','denied','wrong-repo','wrong-namespace']){mode=next;await assert.rejects(originUserAccess(credentials,personal,'repo_fixture'));}
 const before=mints;await assert.rejects(originUserAccess(credentials,{...personal,installationId:'i_other'},'repo_fixture'));await assert.rejects(originUserAccess(credentials,personal,'branch/main'));assert.equal(mints,before);assert.equal(reads,5);
 mode='ok';expectedRepo='r_01m421v82efh88nejzh0yvxm07';expectedUser='user_tkWiNrWtwGn2FzKlyV5iqodPBN';assert.equal((await originUserAccess(credentials,{...personal,userId:expectedUser},expectedRepo)).externalId,expectedUser);
});

test('Origin ingestion retains a human immutable author ID and excludes app, service and mixed identities',async t=>{
 const {Origin}=await import('../src/origin'),pair=await generateKeyPair('EdDSA',{extractable:true}),client=new Origin({appId:'app_fixture',installationId:'i_fixture',privateKey:await exportPKCS8(pair.privateKey)},'repo_fixture'),sha='a'.repeat(40),base='b'.repeat(40);
 let author:Record<string,unknown>={user:{id:'user_alice'}};
 t.mock.method(Origin.prototype,'request',async(endpoint:string,validator:z.ZodType)=>{
  if(endpoint.endsWith('/pulls/1'))return validator.parse({number:'1',repository:{id:'repo_fixture'},title:'Change',state:'open',author,head:{sha,ref:'feature'},base:{sha:base,ref:'main'},version:{number:'1',headSha:sha,baseSha:base}});
  return validator.parse({pullRequest:{number:'1',repository:{id:'repo_fixture'}}});
 });
 assert.equal((await client.pullRequest('acme/source',1)).authorExternalId,'user_alice');
 for(const invalid of [{app:{id:'app_fixture'}},{serviceAccount:{id:'service_bot'}},{user:{id:'user_alice'},app:{id:'app_fixture'}}]){author=invalid;assert.equal((await client.pullRequest('acme/source',1)).authorExternalId,undefined);}
});


test('Origin native PR DTO binds omitted repository to authenticated immutable repository and rejects contradictory identities',async t=>{
 const {Origin}=await import('../src/origin'),pair=await generateKeyPair('EdDSA',{extractable:true}),client=new Origin({appId:'app_fixture',installationId:'i_fixture',privateKey:await exportPKCS8(pair.privateKey)},'repo_fixture'),sha='a'.repeat(40),base='b'.repeat(40);
 let returnedRepository='repo_fixture';const explicit:{repository?:string}={};
 t.mock.method(Origin.prototype,'request',async(endpoint:string,validator:z.ZodType)=>{
  if(endpoint==='/repos/_/repo_fixture')return validator.parse({id:returnedRepository});
  if(endpoint.endsWith('/pulls/1'))return validator.parse({number:'1',...(explicit.repository?{repository:{id:explicit.repository}}:{}),title:'Native change',state:'open',author:{user:{id:'user_alice'}},head:{sha,ref:'feature'},base:{sha:base,ref:'main'},version:{number:'1',headSha:sha,baseSha:base}});
  return validator.parse({pullRequest:{number:'1',repository:{id:'repo_fixture'}}});
 });
 assert.equal((await client.pullRequest('acme/source',1)).revisionKey,'1');
 returnedRepository='repo_foreign';await assert.rejects(client.pullRequest('acme/source',1),/identity mismatch/);
 explicit.repository='repo_foreign';await assert.rejects(client.pullRequest('acme/source',1),/identity mismatch/);
});
