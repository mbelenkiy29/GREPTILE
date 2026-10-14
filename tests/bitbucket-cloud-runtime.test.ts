import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {BitbucketCloud} from '../src/bitbucket-cloud';
const workspace='11111111-1111-4111-8111-111111111111',repositoryId='22222222-2222-4222-8222-222222222222',sha='a'.repeat(40),repo='acme/source';
const nativeRepo={uuid:'{'+repositoryId+'}',full_name:repo,workspace:{uuid:'{'+workspace+'}'}};
const source=(path:string,size:number,attributes:string[]=[])=>({path,type:'commit_file',size,attributes,commit:{hash:sha}});
function parseTar(bytes:Uint8Array){const tar=gunzipSync(bytes),result:Record<string,{mode:number;bytes:Buffer}>={};for(let offset=0;tar[offset];){const name=tar.subarray(offset,offset+100).toString().split('\0')[0],size=parseInt(tar.subarray(offset+124,offset+136).toString(),8);result[name]={mode:parseInt(tar.subarray(offset+100,offset+108).toString(),8),bytes:tar.subarray(offset+512,offset+512+size)};offset+=512+Math.ceil(size/512)*512;}return result;}
test('Bitbucket runtime archives exact unfiltered binary bytes, empty files and executable modes with a single wrapper',async t=>{
 const bytes=Buffer.from([0,255,128,1]);let repoReads=0,commitReads=0;
 t.mock.method(globalThis,'fetch',async(input:string|URL,init:RequestInit)=>{
  const url=new URL(input);assert.equal(url.hostname,'api.bitbucket.org');assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-system-token');
  if(url.pathname.endsWith('}')){repoReads++;return Response.json(nativeRepo);} // encoded UUID path checked below instead
  if(!url.pathname.includes('/src/')&&!url.pathname.includes('/commit/')){repoReads++;return Response.json(nativeRepo);}
  if(url.pathname.includes('/commit/')){commitReads++;assert.ok(url.pathname.endsWith(sha));return Response.json({hash:sha});}
  if(url.pathname.endsWith('/src/'+sha+'/'))return Response.json({values:[source('image.bin',4,['binary']),source('run.sh',3,['executable']),source('empty',0)],size:3});
  const path=url.pathname.split('/src/'+sha+'/')[1],data=path==='image.bin'?bytes:path==='empty'?Buffer.alloc(0):Buffer.from('run');
  if(url.searchParams.get('format')==='meta')return Response.json(source(path,data.length,path==='image.bin'?['binary']:path==='run.sh'?['executable']:[]));return new Response(data);
 });
 const tar=parseTar(await new BitbucketCloud('fixture-system-token',workspace,repositoryId).archive(repo,sha));assert.deepEqual(Object.keys(tar),['source/image.bin','source/run.sh','source/empty']);assert.deepEqual(tar['source/image.bin'].bytes,bytes);assert.equal(tar['source/run.sh'].mode,0o755);assert.equal(tar['source/image.bin'].mode,0o644);assert.equal(tar['source/empty'].bytes.length,0);assert.equal(commitReads,2);assert.equal(repoReads,3);
});
test('Bitbucket runtime fails on metadata, unsupported semantics, size limits, missing access and changed native identities',async t=>{
 let mode='ok',reads=0;const scm=new BitbucketCloud('fixture-system-token',workspace,repositoryId);
 t.mock.method(globalThis,'fetch',async(input:string|URL)=>{
  const url=new URL(input);
  if(!url.pathname.includes('/src/')&&!url.pathname.includes('/commit/')){reads++;return Response.json(mode==='identity'&&reads>2?{...nativeRepo,full_name:'acme/foreign'}:nativeRepo);}
  if(url.pathname.includes('/commit/'))return Response.json({hash:mode==='revision'?'b'.repeat(40):sha});
  if(url.pathname.endsWith('/src/'+sha+'/'))return Response.json({values:[source('file',3)],size:1});
  if(url.searchParams.get('format')==='meta')return Response.json({...source(mode==='path'?'other':'file',mode==='large'?20000001:3,mode==='link'?['link']:mode==='subrepo'?['subrepository']:mode==='unknown'?['future']:[]),...(mode==='missing-attributes'?{attributes:undefined}:{}),...(mode==='metadata-revision'?{commit:{hash:'b'.repeat(40)}}:{})});
  if(mode==='denied')return Response.json({},{status:403});if(mode==='lfs')return new Response(null,{status:301,headers:{location:'https://media.example/file'}});return new Response(mode==='short'?'ab':mode==='overflow'?'abcd':'abc');
 });
 for(mode of ['identity','revision','path','large','link','subrepo','unknown','missing-attributes','metadata-revision','denied','lfs','short','overflow']){reads=0;await assert.rejects(scm.archive(repo,sha));}
 await assert.rejects(scm.archive(repo,'main'));await assert.rejects(scm.archive(repo,sha.slice(0,7)));
});
