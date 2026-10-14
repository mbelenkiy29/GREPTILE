import test from 'node:test';
import assert from 'node:assert/strict';
import {Gitea} from '../src/gitea';
import {approvalBlockers,approvalDefaults,type ApprovalState} from '../src/approval';
const sha='a'.repeat(40),base='b'.repeat(40);
test('Gitea approval uses effective native checks, latest status contexts and human review states',async t=>{
 const client=new Gitea('https://gitea.example','fixture-token');
 const pr={number:1,title:'Change',body:'',draft:false,state:'open',html_url:'https://gitea.example/o/r/pulls/1',user:{login:'alice'},head:{sha,ref:'feature'},base:{sha:base,ref:'release/main'},changed_files:1,diff:[{path:'price.ts',status:'modified',patch:''}],reviews:[],comments:[],commits:[],checks:[]} as Awaited<ReturnType<Gitea['pullRequest']>>;
 t.mock.method(client,'pullRequest',async()=>pr);
 let protectedBranch=true,known=true,patterns=['ci/*'],status='success',statusSha=sha,changed=false,duplicate=false;
 const reviews=[{id:4,body:'Objection',commit_id:base,state:'REQUEST_CHANGES',dismissed:false,stale:true,user:{login:'bob',type:'User'}},{id:5,body:'Comment',commit_id:sha,state:'COMMENT',dismissed:false,stale:false,user:{login:'bob',type:'User'}},{id:6,body:'Old approval',commit_id:base,state:'APPROVED',dismissed:false,stale:true,user:{login:'openreview',type:'User'}}];
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  assert.equal(options.redirect,'error');assert.equal((options.headers as Record<string,string>).authorization,'token fixture-token');const path=new URL(input).pathname;
  if(path.endsWith('/user'))return Response.json({login:'openreview'});
  if(path.endsWith('/branches/release%2Fmain'))return Response.json({protected:protectedBranch,...(known?{enable_status_check:true,status_check_contexts:patterns}:{})});
  if(path.endsWith('/reviews'))return Response.json(reviews);
  if(path.endsWith('/status'))return Response.json({sha:statusSha,total_count:duplicate?2:1,statuses:[{context:'ci/unit',status},...(duplicate?[{context:'ci/unit',status:'failure'}]:[])]});
  if(path.endsWith('/pulls/1'))return Response.json({...pr,head:{sha:changed?base:sha}});
  throw new Error('Unexpected endpoint '+path);
 });
 let result=await client.approvalSnapshot('o/r',1);assert.equal(client.supportsApproval,true);assert.equal(result.humanChangeRequested,true);assert.equal(result.reviews[2].state,'DISMISSED');assert.deepEqual(result.nativeRequiredChecks,[{name:'ci/*'}]);assert.equal(result.checks.find(c=>c.name==='ci/*')?.conclusion,'success');
 reviews[1].dismissed=true;assert.equal((await client.approvalSnapshot('o/r',1)).humanChangeRequested,true);
 reviews[0].dismissed=true;result=await client.approvalSnapshot('o/r',1);assert.equal(result.humanChangeRequested,false);
 const state:ApprovalState={supported:true,open:true,draft:false,head:sha,reviewedHead:sha,latest:true,completed:true,coverageLimits:[],unresolved:0,assessment:{risk:'low',confidence:1,reason:'Verified exact source and complete evidence'},author:'alice',changedPaths:[],humanChangeRequested:false,requiredChecksKnown:true,checks:result.checks,nativeRequiredChecks:result.nativeRequiredChecks,runtimeRequired:false,runtimePassed:false};
 assert.deepEqual(approvalBlockers({...approvalDefaults,enabled:true},state),[]);
 status='pending';result=await client.approvalSnapshot('o/r',1);assert.ok(approvalBlockers({...approvalDefaults,enabled:true},{...state,checks:result.checks}).includes('Required checks have not passed'));
 patterns=['missing/*'];result=await client.approvalSnapshot('o/r',1);assert.equal(result.checks.find(c=>c.name==='missing/*')?.conclusion,'failure');
 patterns=['ci/[a-z]*'];await assert.rejects(client.approvalSnapshot('o/r',1),/Unsupported.*pattern/);patterns=['ci/*'];
 known=false;await assert.rejects(client.approvalSnapshot('o/r',1),/required checks unavailable/);protectedBranch=false;assert.deepEqual((await client.approvalSnapshot('o/r',1)).nativeRequiredChecks,[]);protectedBranch=true;known=true;
 statusSha=base;await assert.rejects(client.approvalSnapshot('o/r',1),/another revision/);statusSha=sha;
 duplicate=true;await assert.rejects(client.approvalSnapshot('o/r',1),/duplicate contexts/);duplicate=false;
 changed=true;await assert.rejects(client.approvalSnapshot('o/r',1),/revision changed/);
});
test('Gitea approval publishes native APPROVED, replays only own active markers and confirms scoped dismissal',async t=>{
 const client=new Gitea('https://gitea.example','fixture-token'),marker='<!-- openreview:approval:fixture-one -->';let head=sha,own=false,draft=false,posts=0,dismissals=0,publisher='openreview';
 const reviews=[{id:1,body:marker,commit_id:sha,state:'APPROVED',dismissed:false,stale:false,user:{login:'alice',type:'User'}}];
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  const path=new URL(input).pathname;
  if(path.endsWith('/user'))return Response.json({login:publisher});
  if(path.endsWith('/pulls/1'))return Response.json({state:'open',draft,head:{sha:head},user:{login:own?'openreview':'alice'}});
  if(path.endsWith('/dismissals')){dismissals++;assert.equal(JSON.parse(String(options.body)).priors,false);reviews[1].dismissed=true;return new Response(null,{status:204});}
  if(/\/reviews\/\d+$/.test(path))return Response.json(reviews.find(r=>r.id===Number(path.split('/').at(-1))));
  if(path.endsWith('/reviews')){
   if(options.method==='POST'){posts++;const b=JSON.parse(String(options.body));assert.equal(b.event,'APPROVED');assert.equal(b.commit_id,sha);reviews.push({id:2,body:b.body,commit_id:sha,state:'APPROVED',dismissed:false,stale:false,user:{login:'openreview',type:'User'}});return Response.json(reviews[1]);}
   return Response.json(reviews);
  }
  throw new Error('Unexpected endpoint '+path);
 });
 await assert.rejects(client.approve('o/r',1,'main',marker,'openreview'),/identity or revision/);
 assert.equal((await client.approve('o/r',1,sha,marker,'openreview')).id,2);assert.equal(posts,1);
 assert.equal((await client.approve('o/r',1,sha,marker,'openreview')).reused,true);assert.equal(posts,1);
 await assert.rejects(client.dismissApproval('o/r',1,1),/unrelated/);
 await client.dismissApproval('o/r',1,2);await client.dismissApproval('o/r',1,2);assert.equal(dismissals,1);
 head=base;await assert.rejects(client.approve('o/r',1,sha,marker,'openreview'),/revision changed/);head=sha;
 draft=true;await assert.rejects(client.approve('o/r',1,sha,marker,'openreview'),/revision changed/);draft=false;
 own=true;await assert.rejects(client.approve('o/r',1,sha,marker,'openreview'),/own pull request/);own=false;
 publisher='other';await assert.rejects(client.approve('o/r',1,sha,marker,'openreview'),/publisher changed/);
});
test('Gitea runtime uses its native archive endpoint and bounded token-authenticated downloads',async t=>{
 let mode='ok',calls=0,cancelled=false;
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  calls++;assert.equal(new URL(input).pathname,'/api/v1/repos/o/r/archive/'+sha+'.tar.gz');assert.equal(options.redirect,'error');assert.equal((options.headers as Record<string,string>).authorization,'token fixture-token');
  if(mode==='redirect')throw new TypeError('redirect rejected');
  if(mode==='header')return new Response(new Uint8Array([0x1f,0x8b]),{headers:{'content-length':'20000001'}});
  if(mode==='stream')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20000001));},cancel(){cancelled=true;}}));
  if(mode==='missing')return new Response(null);
  if(mode==='denied')return new Response(null,{status:403});
  return new Response(new Uint8Array(mode==='bad'?[0,1]:[0x1f,0x8b,8,0]));
 });
 const client=new Gitea('https://gitea.example','fixture-token');
 await assert.rejects(client.archive('o/r','main'),/exact Git commit/);await assert.rejects(client.archive('../r',sha),/identity/);assert.equal(calls,0);
 assert.equal((await client.archive('o/r',sha)).length,4);
 for(const [next,pattern] of [['redirect',/redirect rejected/],['header',/too large/],['stream',/exceeds 20 MB/],['missing',/missing/],['denied',/unavailable/],['bad',/not gzip/]] as const){mode=next;await assert.rejects(client.archive('o/r',sha),pattern);}assert.equal(cancelled,true);
});
test('Gitea PR ingestion reads the native status field and latest combined contexts',async t=>{
 let status='pending';const called:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:string)=>{
  const path=new URL(input).pathname;called.push(path);
  if(path.endsWith('/pulls/1'))return Response.json({number:1,title:'Change',body:'',draft:false,state:'open',html_url:'https://gitea.example/o/r/pulls/1',user:{login:'alice'},head:{sha,ref:'feature'},base:{sha:base,ref:'main'},changed_files:0});
  if(path.endsWith('.diff'))return new Response('');
  if(path.endsWith('/status'))return Response.json({sha,total_count:1,statuses:[{context:'ci/unit',status}]});
  return Response.json([]);
 });
 const client=new Gitea('https://gitea.example','fixture-token');
 assert.deepEqual((await client.pullRequest('o/r',1)).checks,[{name:'ci/unit',status:'in_progress',conclusion:'pending'}]);
 status='success';assert.deepEqual((await client.pullRequest('o/r',1)).checks,[{name:'ci/unit',status:'completed',conclusion:'success'}]);
 assert.ok(!called.some(path=>path.includes('/statuses/')));
});
