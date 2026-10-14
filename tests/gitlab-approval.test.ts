import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Gitlab} from '../src/gitlab';
const sha='a'.repeat(40),base='b'.repeat(40),key=base+':'+base,marker='<!-- openreview:approval:fixture-one -->';
const bot={id:3,username:'openreview-bot'},human={id:2,username:'alice'};
function fixture(t:TestContext){
 const client=new Gitlab('https://gitlab.example','fixture-token','1');
 const state={head:sha,base,projectId:1,draft:false,author:'alice',merge:'mergeable',pipeline:false,external:false,externalStatus:'passed',discussions:false,resolved:true,pipelineStatus:'pending',checkStatus:'success',duplicate:false,checkSha:sha,approvalPosts:0,notePosts:0,withdrawals:0,eligible:true,mode:'ok',active:[] as {user:typeof bot;approved_at?:string}[],notes:[] as {id:number;body:string;author:typeof bot;system:boolean;noteable_iid:number;noteable_type:string}[]};
 const pr={number:1,title:'Label',body:'',draft:false,state:'open',html_url:'https://gitlab.example/o/r/-/merge_requests/1',user:{login:'alice'},head:{sha,ref:'feature'},base:{sha:base,ref:'main'},revisionKey:key,diff:[],comments:[],reviews:[],commits:[],checks:[]};
 t.mock.method(client,'pullRequest',async()=>pr);
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  assert.equal(options.redirect,'manual');assert.equal((options.headers as Record<string,string>)['PRIVATE-TOKEN'],'fixture-token');const path=new URL(input).pathname,b=options.body?JSON.parse(String(options.body)):undefined;
  if(path==='/api/v4/user')return Response.json(bot);
  if(path==='/api/v4/projects/1')return Response.json({id:1,only_allow_merge_if_pipeline_succeeds:state.pipeline,only_allow_merge_if_all_discussions_are_resolved:state.discussions,only_allow_merge_if_all_status_checks_passed:state.external});
  if(path==='/api/v4/projects/1/merge_requests/1')return Response.json({iid:1,project_id:state.projectId,title:'Label',description:'',draft:state.draft,state:'opened',web_url:pr.html_url,author:{username:state.author},source_branch:'feature',target_branch:'main',diff_refs:{head_sha:state.head,base_sha:state.base,start_sha:state.base},detailed_merge_status:state.merge,has_conflicts:false,blocking_discussions_resolved:state.resolved,head_pipeline:{sha:state.head,status:state.pipelineStatus}});
  if(path.endsWith('/statuses')){assert.equal(new URL(input).searchParams.get('all'),'false');assert.equal(new URL(input).searchParams.get('ref'),'feature');return Response.json([{id:4,name:'regression',sha:state.checkSha,ref:'feature',status:state.checkStatus},...(state.duplicate?[{id:5,name:'regression',sha:state.checkSha,ref:'feature',status:'failed'}]:[])]);}
  if(path.endsWith('/status_checks'))return Response.json([{id:9,name:'Security service',status:state.externalStatus}]);
  if(path.endsWith('/approvals'))return Response.json({approved_by:state.active,user_can_approve:state.eligible});
  if(path.endsWith('/approve')){state.approvalPosts++;assert.equal(b.sha,sha);state.active=[{user:bot,...(state.mode==='missing-time'?{}:{approved_at:'2026-10-03T12:00:00.123Z'})}];if(state.mode==='race')state.base='c'.repeat(40);return Response.json({approved_by:state.active});}
  if(path.endsWith('/unapprove')){state.withdrawals++;if(state.mode!=='withdraw-fails')state.active=[];return new Response(null,{status:204});}
  if(/\/notes\/\d+$/.test(path))return Response.json(state.notes.find(n=>n.id===Number(path.split('/').at(-1))));
  if(path.endsWith('/notes')){if(options.method==='POST'){state.notePosts++;const n={id:10+state.notePosts,body:b.body,author:bot,system:false,noteable_iid:1,noteable_type:'MergeRequest'};state.notes.push(n);if(state.mode==='note-lost')throw new Error('Lost note response');return Response.json(n);}return Response.json(state.notes);}
  throw new Error('Unexpected endpoint '+path);
 });
 return {client,state,pr};
}
test('GitLab approval snapshot verifies native requirements, status identities and revision keys',async t=>{
 const {client,state}=fixture(t);let v=await client.approvalSnapshot('o/r',1);assert.equal(v.pr.revisionKey,key);assert.equal(v.botLogin,bot.username);assert.deepEqual(v.nativeRequiredChecks,[{name:'OpenReview / GitLab merge conditions'}]);
 state.pipeline=true;state.discussions=true;state.resolved=false;v=await client.approvalSnapshot('o/r',1);assert.equal(v.checks.find(c=>c.name==='OpenReview / GitLab required pipeline')?.conclusion,'failure');assert.equal(v.checks.find(c=>c.name==='OpenReview / GitLab resolved discussions')?.conclusion,'failure');
 state.pipelineStatus='success';state.resolved=true;v=await client.approvalSnapshot('o/r',1);assert.ok(v.checks.every(c=>c.conclusion==='success'));
 state.external=true;state.merge='not_approved';v=await client.approvalSnapshot('o/r',1);assert.ok(v.checks.every(c=>c.conclusion==='success'));state.externalStatus='failed';assert.equal((await client.approvalSnapshot('o/r',1)).checks.find(c=>c.name==='OpenReview / GitLab external check #9')?.conclusion,'failure');state.external=false;
 state.merge='requested_changes';v=await client.approvalSnapshot('o/r',1);assert.equal(v.humanChangeRequested,true);assert.equal(v.checks.find(c=>c.name==='OpenReview / GitLab merge conditions')?.conclusion,'failure');
 state.merge='approvals_syncing';assert.equal((await client.approvalSnapshot('o/r',1)).checks.find(c=>c.name==='OpenReview / GitLab merge conditions')?.conclusion,'failure');
 state.duplicate=true;await assert.rejects(client.approvalSnapshot('o/r',1),/duplicate contexts/);state.duplicate=false;
 state.checkSha=base;await assert.rejects(client.approvalSnapshot('o/r',1),/revision mismatch/);state.checkSha=sha;
 state.projectId=2;await assert.rejects(client.approvalSnapshot('o/r',1),/project or change mismatch/);state.projectId=1;
 state.base='c'.repeat(40);await assert.rejects(client.approvalSnapshot('o/r',1),/revision changed/);
});
test('GitLab publishes SHA-bound approval, replays its own receipt and withdraws only that native timestamp',async t=>{
 const {client,state}=fixture(t);
 state.notes.push({id:1,body:marker,author:human,system:false,noteable_iid:1,noteable_type:'MergeRequest'});
 const v=await client.approve('o/r',1,sha,marker,bot.username,key);assert.equal(v.id,11);assert.equal(v.reused,false);assert.equal(state.approvalPosts,1);
 assert.deepEqual(await client.approve('o/r',1,sha,marker,bot.username,key),{id:11,reused:true});assert.equal(state.approvalPosts,1);assert.equal((await client.approvalSnapshot('o/r',1)).reviews[0].state,'APPROVED');
 await assert.rejects(client.dismissApproval('o/r',1,1),/unrelated/);assert.equal(state.withdrawals,0);
 state.active[0].approved_at='2026-10-03T13:00:00.123Z';await client.dismissApproval('o/r',1,11);assert.equal(state.withdrawals,0);assert.equal((await client.approvalSnapshot('o/r',1)).reviews[0].state,'DISMISSED');
 state.active[0].approved_at='2026-10-03T12:00:00.123Z';state.mode='withdraw-fails';await assert.rejects(client.dismissApproval('o/r',1,11),/withdrawal was not confirmed/);assert.equal(state.active.length,1);state.mode='ok';await client.dismissApproval('o/r',1,11);await client.dismissApproval('o/r',1,11);assert.equal(state.withdrawals,2);assert.equal(state.active.length,0);
});
test('GitLab rejects missing receipts, changed receipt identity and unsupported native approval metadata',async t=>{
 const {client,state}=fixture(t);
 await assert.rejects(client.approve('o/r',1,sha,marker,bot.username),/native revision/);
 state.active=[{user:bot,approved_at:'2026-10-03T12:00:00.123Z'}];await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/without this receipt/);assert.equal(state.approvalPosts,0);state.active=[];
 state.eligible=false;await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/not eligible/);state.eligible=true;
 state.draft=true;await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/revision changed/);state.draft=false;state.author=bot.username;await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/own merge request/);state.author='alice';
 await client.approve('o/r',1,sha,marker,bot.username,key);state.notes[0].body=state.notes[0].body.replace(sha,'d'.repeat(40));await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/receipt or native approval changed/);
 state.active[0].approved_at=undefined;await assert.rejects(client.approvalSnapshot('o/r',1),/timestamp unavailable/);
});
test('GitLab publication races and lost receipt responses fail visibly and withdraw their known approval',async t=>{
 const {client,state}=fixture(t);state.mode='race';await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/revision changed during/);assert.equal(state.active.length,0);assert.equal(state.withdrawals,1);
 state.mode='note-lost';state.base=base;await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/Lost note response/);assert.equal(state.active.length,0);assert.equal(state.withdrawals,2);
 await assert.rejects(client.approve('o/r',1,sha,marker,bot.username,key),/receipt or native approval changed/);assert.equal(state.approvalPosts,2);
});
