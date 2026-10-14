import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';
import {Github} from '../src/github';import {Gitea} from '../src/gitea';import {Gitlab} from '../src/gitlab';import {BitbucketDC} from '../src/bitbucket-dc';import {BitbucketCloud} from '../src/bitbucket-cloud';import {Origin} from '../src/origin';
import {numberedPage,validateChangePage} from '../src/change-metadata';
const head='a'.repeat(40),base='b'.repeat(40),minimal={number:1,title:'Large PR with omitted diff',html_url:'https://example.com/pr/1',state:'open',draft:false,user:{login:'alice'},head:{sha:head,ref:'feature'},base:{sha:base,ref:'main'}};
test('GitHub, Gitea and GitLab catalog pages read minimal metadata without diff or discussion requests',async t=>{
 const calls:string[]=[];t.mock.method(globalThis,'fetch',async(input:string)=>{const u=new URL(input);calls.push(u.href);if(u.pathname.endsWith('/pulls')||u.pathname.endsWith('/merge_requests')){const page=Number(u.searchParams.get('page'));return Response.json(page===1?Array.from({length:30},(_,i)=>({number:i+1,iid:i+1})):[]);}if(u.pathname.endsWith('/merge_requests/1'))return Response.json({iid:1,title:minimal.title,description:null,draft:false,state:'opened',web_url:minimal.html_url,author:{username:'alice'},source_branch:'feature',target_branch:'main',diff_refs:{base_sha:base,head_sha:head,start_sha:base}});return Response.json(minimal);});
 for(const client of [new Github('fixture','https://github.example/api'),new Gitea('https://gitea.example','fixture'),new Gitlab('https://gitlab.example','fixture','123')]){
  assert.deepEqual(await client.openChanges('acme/repo',null),{numbers:Array.from({length:30},(_,i)=>i+1),next:'2'});assert.deepEqual(await client.openChanges('acme/repo','2'),{numbers:[],next:null});const pr=await client.changeMetadata('acme/repo',1);assert.equal(pr.head.sha,head);assert.equal(pr.title,minimal.title);
  await assert.rejects(client.openChanges('acme/repo','https://foreign.example'),/cursor/);
 }
 assert.equal(calls.length,9);assert.ok(calls.every(c=>!/(diff|comments|reviews|commits|files)/.test(new URL(c).pathname)));
 assert.throws(()=>numberedPage('01'));assert.throws(()=>validateChangePage({numbers:[1,1],next:null},null));assert.throws(()=>validateChangePage({numbers:[1],next:'repeat'},'repeat'));
});
test('Bitbucket catalog pagination preserves repository scope and rejects changed filters, cursors and native repository identity',async t=>{
 const workspace='11111111-1111-4111-8111-111111111111',repoId='22222222-2222-4222-8222-222222222222';let mode='ok';const calls:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:string)=>{const u=new URL(input);calls.push(u.pathname);
  if(u.hostname==='dc.example'){
   if(u.pathname.endsWith('/repos/repo'))return Response.json({id:71});
   if(u.pathname.endsWith('/pull-requests'))return Response.json({start:0,values:[{id:1}],isLastPage:false,nextPageStart:mode==='cursor'?0:30});
   return Response.json({id:1,title:minimal.title,state:'OPEN',author:{user:{name:'alice',active:true}},fromRef:{displayId:'feature',latestCommit:head,repository:{id:999}},toRef:{displayId:'main',latestCommit:base,repository:{id:mode==='identity'?72:71}}});
  }
  const r={uuid:'{'+repoId+'}',full_name:'acme/repo',workspace:{uuid:'{'+workspace+'}'}};
  if(!u.pathname.includes('/pullrequests'))return Response.json(r);
  if(u.pathname.endsWith('/pullrequests')){const next=new URL(u);next.searchParams.set('page','2');if(mode==='scope')next.hostname='foreign.example';if(mode==='filter')next.searchParams.set('state','DECLINED');return Response.json({values:[{id:1}],next:next.href});}
  return Response.json({id:1,title:minimal.title,state:'OPEN',author:{uuid:'{'+workspace+'}'},source:{branch:{name:'feature'},commit:{hash:head},repository:r},destination:{branch:{name:'main'},commit:{hash:base},repository:{...r,uuid:'{'+(mode==='identity'?workspace:repoId)+'}'}}});
 });
 const dc=new BitbucketDC('https://dc.example','fixture-token','71'),cloud=new BitbucketCloud('fixture-token',workspace,repoId);
 for(const client of [dc,cloud]){const pr=await client.changeMetadata('acme/repo',1);assert.equal(pr.revisionKey,base);assert.equal(pr.base.sha,base);assert.deepEqual(await client.openChanges('acme/repo',null),{numbers:[1],next:client===dc?'30':'2'});mode='identity';await assert.rejects(client.changeMetadata('acme/repo',1),/identity/);mode='ok';}
 mode='cursor';await assert.rejects(dc.openChanges('acme/repo',null),/advance/);for(const m of ['scope','filter']){mode=m;await assert.rejects(cloud.openChanges('acme/repo',null),/scope/);}
 assert.ok(calls.every(c=>!/(diff|comments|activities|merge-base|commits)/.test(c)));
});
test('Origin catalog retains opaque pagination and native version without requiring change files',async t=>{
 const client=new Origin({appId:'app_fixture',installationId:'i_fixture',privateKey:'not-used-by-this-contract'},'r_fixture');let mode='ok';const paths:string[]=[];
 t.mock.method(client,'request',async(endpoint:string,validator:z.ZodTypeAny)=>{paths.push(endpoint);if(endpoint.includes('/pulls?'))return validator.parse({pullRequests:[{number:'1'}],nextPageToken:mode==='repeat'?'opaque-next':endpoint.includes('pageToken=')?'':'opaque-next'});return validator.parse({number:'1',repository:{id:mode==='identity'?'r_other':'r_fixture'},title:minimal.title,state:'open',author:{user:{id:'user_alice'}},head:minimal.head,base:minimal.base,version:{number:'7',headSha:head,baseSha:base}});});
 assert.deepEqual(await client.openChanges('ns/repo',null),{numbers:[1],next:'opaque-next'});assert.deepEqual(await client.openChanges('ns/repo','opaque-next'),{numbers:[1],next:null});const pr=await client.changeMetadata('ns/repo',1);assert.equal(pr.revisionKey,'7');assert.equal(pr.user.login,'user_alice');
 mode='repeat';await assert.rejects(client.openChanges('ns/repo','opaque-next'),/repeated/);mode='identity';await assert.rejects(client.changeMetadata('ns/repo',1),/identity mismatch/);assert.ok(paths.every(p=>!/(files|comments|reviews|commits)/.test(p)));
});
