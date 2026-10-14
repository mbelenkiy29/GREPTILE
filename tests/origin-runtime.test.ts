import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Origin} from '../src/origin';
import {originApi} from '../src/origin-auth';
import {runtimeRevisionSchema} from '../src/runtime-revision';
const credentials={appId:'app_fixture',installationId:'i_fixture',privateKey:generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString()},repo='acme/source',id='repo_fixture',sha='a'.repeat(40),bytes=new Uint8Array(gzipSync('archive fixture'));

test('Origin archives pin immutable repository and full SHA-1/SHA-256 commits before and after streaming',async t=>{
 let calls=0,identities=0,commits=0,requested=sha;
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  calls++;assert.ok(options.signal);const path=new URL(input).pathname;
  if(path.endsWith('/access_tokens'))return Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()});
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer oit_fixture');
  if(path.endsWith('/'+id)){identities++;assert.equal(options.redirect,'error');return Response.json({id});}
  if(path.includes('/git/commits/')){commits++;assert.equal(path.split('/').at(-1),requested);return Response.json({sha:requested});}
  assert.equal(input,originApi+'/repos/_/'+id+'/tarball/'+requested);assert.equal(options.redirect,'manual');return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
 });
 const client=new Origin(credentials,id);
 for(const invalid of ['main','HEAD','a'.repeat(39),'a'.repeat(63),sha+'?ref=main'])await assert.rejects(client.archive(repo,invalid),/exact Git commit/);
 await assert.rejects(new Origin(credentials).archive(repo,sha),/repository identity/);assert.equal(calls,0);
 assert.deepEqual(await client.archive(repo,sha),bytes);requested='b'.repeat(64);assert.deepEqual(await client.archive(repo,requested),bytes);assert.equal(identities,4);assert.equal(commits,4);
 assert.equal(runtimeRevisionSchema.parse(requested),requested);for(const invalid of ['main','b'.repeat(63),'B'.repeat(64),requested+'?x=1'])assert.equal(runtimeRevisionSchema.safeParse(invalid).success,false);
});

test('Origin cached archives follow one approved HTTPS signed redirect without forwarding App credentials',async t=>{
 const prior=process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS;process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS='cdn.fixture';
 let location='https://cdn.fixture/archive/'+sha+'.tar.gz?signature=opaque',downloads=0,redirectCancelled=0,mode='ok';
 t.mock.method(globalThis,'fetch',async(input:string|URL,options:RequestInit)=>{
  const url=String(input);assert.ok(options.signal);
  if(url.startsWith('https://cdn.fixture/')){downloads++;assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('authorization'),null);if(mode==='redirect-again')throw new TypeError('redirect rejected');return new Response(bytes);}
  if(url.endsWith('/access_tokens'))return Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()});
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer oit_fixture');
  if(url.endsWith('/'+id))return Response.json({id});if(url.includes('/git/commits/'))return Response.json({sha});
  assert.equal(options.redirect,'manual');return new Response(new ReadableStream({cancel(){redirectCancelled++;}}),{status:302,headers:location?{location}:{}});
 });
 try{
  const client=new Origin(credentials,id);assert.deepEqual(await client.archive(repo,sha),bytes);assert.equal(downloads,1);
  for(const invalid of ['https://foreign.fixture/archive','http://cdn.fixture/archive','https://user:password@cdn.fixture/archive','https://cdn.fixture:444/archive','https://cdn.fixture/archive#secret','//cdn.fixture/archive','']){location=invalid;await assert.rejects(client.archive(repo,sha));}
  assert.equal(downloads,1);assert.equal(redirectCancelled,8);
  location='https://cdn.fixture/archive?signature=opaque';mode='redirect-again';await assert.rejects(client.archive(repo,sha),/redirect rejected/);assert.equal(downloads,2);
  delete process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS;mode='ok';await assert.rejects(client.archive(repo,sha),/operator approval/);assert.equal(downloads,2);
 }finally{if(prior===undefined)delete process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS;else process.env.ORIGIN_ARCHIVE_ALLOWED_HOSTS=prior;}
});

test('Origin archive failures cancel streams and cannot produce source bytes on size, format or identity mismatch',async t=>{
 let mode='ok',reads=0,cancelled=false;
 t.mock.method(globalThis,'fetch',async(input:string)=>{
  if(input.endsWith('/access_tokens'))return Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()});
  if(input.endsWith('/'+id)){reads++;return Response.json({id:mode==='wrong-repository'||mode==='changed-repository'&&reads>1?'repo_other':id});}
  if(input.includes('/git/commits/'))return Response.json({sha:mode==='wrong-commit'||mode==='changed-commit'&&reads>1?'b'.repeat(40):sha});
  if(mode==='denied')return Response.json({},{status:403});if(mode==='empty-repo')return Response.json({},{status:409});if(mode==='missing')return new Response(null);
  if(mode==='overflow')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20000001));},cancel(){cancelled=true;}}));
  if(mode==='wrong-format')return new Response('login page');
  const lengths:Record<string,string>={'large-header':'20000001','invalid-header':'-1','fraction-header':'1.5','overflow-header':'9007199254740993','size-mismatch':'1'};
  return new Response(bytes,{headers:lengths[mode]?{'content-length':lengths[mode]}:{}});
 });
 const client=new Origin(credentials,id);
 for(const next of ['denied','empty-repo','missing','overflow','wrong-format','large-header','invalid-header','fraction-header','overflow-header','size-mismatch','wrong-repository','changed-repository','wrong-commit','changed-commit']){mode=next;reads=0;await assert.rejects(client.archive(repo,sha));}
 assert.equal(cancelled,true);
});
