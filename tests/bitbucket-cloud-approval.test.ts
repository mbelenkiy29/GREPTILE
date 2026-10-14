import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {BitbucketCloud} from "../src/bitbucket-cloud";
const workspace="11111111-1111-4111-8111-111111111111",repository="22222222-2222-4222-8222-222222222222",bot="33333333-3333-4333-8333-333333333333",human="44444444-4444-4444-8444-444444444444";
const head="a".repeat(40),base="b".repeat(40),repo="acme/repo",marker="<!-- openreview:approval:fixture-one -->",time="2026-10-03T12:00:00.123Z";
type Participant={user:{uuid:string;type:string};role:string;approved:boolean;state:string|null;participated_on:string|null};
type Note={id:number;content:{raw:string};user:{uuid:string;type:string};deleted:boolean;parent?:{id:number}};
function fixture(t:TestContext){
 const client=new BitbucketCloud("fixture-system-token",workspace,repository,bot),native={uuid:repository,full_name:repo,workspace:{uuid:workspace}};
 const state={head,base,draft:false,queued:false,author:human,mode:"ok",approvalPosts:0,withdrawals:0,notePosts:0,participants:[] as Participant[],notes:[] as Note[],checkState:"PASSED",checkRequired:true,missingCheck:false,duplicate:false,checkSha:head,reads:0};
 const check=(type:string)=>({type,status:"PASSED",required:true,blocking:false});
 t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{
  const url=new URL(String(input)),path=decodeURIComponent(url.pathname),prefix="/2.0/repositories/{"+workspace+"}/{"+repository+"}";
  assert.equal(url.origin,"https://api.bitbucket.org");assert.equal(options?.redirect,"error");assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-system-token");assert.ok(path===prefix||path.startsWith(prefix+"/"));
  if(path===prefix)return Response.json(native);
  const endpoint=path.slice(prefix.length);
  if(endpoint==="/pullrequests/1"){
   state.reads++;const rows=state.mode==="duplicate-participant"?[...state.participants,...state.participants]:state.participants;
   return Response.json({id:1,title:"Label",description:null,state:"OPEN",...(state.mode==="missing-draft"?{}:{draft:state.draft}),...(state.mode==="missing-queue"?{}:{queued:state.queued}),author:{uuid:state.author,type:"user"},source:{branch:{name:"feature"},commit:{hash:state.head},repository:native},destination:{branch:{name:"main"},commit:{hash:state.base},repository:native},...(state.mode==="missing-participants"?{}:{participants:rows})});
  }
  if(endpoint.startsWith("/merge-base/"))return Response.json({hash:base});
  if(endpoint.startsWith("/diffstat/"))return Response.json({values:[]});
  if(endpoint.startsWith("/diff/"))return new Response("");
  if(endpoint==="/pullrequests/1/commits")return Response.json({values:[{hash:head}]});
  if(endpoint==="/pullrequests/1/statuses")return Response.json({values:[{key:"regression",state:"SUCCESSFUL",commit:{hash:state.checkSha}}]});
  if(endpoint==="/pullrequests/1/mergeability/checks"){
   const values=[check("pullrequest_state_check"),check("current_user_permission_check"),...(!state.missingCheck?[check("git_mergeability_check")]:[]),{...check("standard_merge_check"),status:state.checkState,required:state.checkRequired,check:{kind:"resolved_tasks"}},...(state.duplicate?[check("git_mergeability_check")]:[])];return Response.json({values,size:values.length});
  }
  if(endpoint==="/pullrequests/1/approve"){
   if(options?.method==="DELETE"){state.withdrawals++;if(state.mode!=="withdraw-fails")state.participants=state.participants.filter(p=>p.user.uuid!==bot);return new Response(null,{status:204});}
   assert.equal(options?.method,"POST");state.approvalPosts++;const p:Participant={user:{uuid:bot,type:state.mode==="wrong-publisher"?"user":"app_user"},role:"PARTICIPANT",approved:true,state:"approved",participated_on:state.mode==="missing-time"?null:time};state.participants.push(p);if(state.mode==="race")state.base="c".repeat(40);return Response.json(p);
  }
  if(endpoint==="/pullrequests/1/comments"){
   if(options?.method==="POST"){state.notePosts++;const b=JSON.parse(String(options.body)),n:Note={id:10+state.notePosts,content:b.content,user:{uuid:bot,type:"app_user"},deleted:false};state.notes.push(n);if(state.mode==="note-lost")throw new Error("Lost receipt response");return Response.json(n);}
   return Response.json({values:state.notes});
  }
  if(/^\/pullrequests\/1\/comments\/\d+$/.test(endpoint))return Response.json(state.notes.find(n=>n.id===Number(endpoint.split("/").at(-1))));
  throw new Error("Unexpected endpoint "+endpoint);
 });
 return {client,state};
}
const objection:Participant={user:{uuid:human,type:"user"},role:"REVIEWER",approved:false,state:"changes_requested",participated_on:time};
test("Bitbucket native approval verifies checks, publisher, reviewer objections and exact revision",async t=>{
 const {client,state}=fixture(t);let s=await client.approvalSnapshot(repo,1);assert.equal(s.botLogin,"{"+bot+"}");assert.equal(s.nativeRequiredChecks.length,4);assert.ok(s.checks.every(c=>c.conclusion==="success"));
 state.participants=[objection];s=await client.approvalSnapshot(repo,1);assert.equal(s.humanChangeRequested,true);assert.equal(s.pr.reviews[0].state,"CHANGES_REQUESTED");assert.equal(s.pr.reviews[0].commit_id,"");await assert.rejects(client.approve(repo,1,head,marker,s.botLogin,base),/human objection/);state.participants=[];
 for(const status of ["PENDING","FAILED","UNKNOWN","SKIPPED"]){state.checkState=status;assert.equal((await client.approvalSnapshot(repo,1)).checks.at(-1)?.conclusion,"failure");await assert.rejects(client.approve(repo,1,head,marker,s.botLogin,base),/checks have not passed/);}state.checkState="PASSED";
 state.checkRequired=false;state.checkState="FAILED";assert.equal((await client.approvalSnapshot(repo,1)).nativeRequiredChecks.length,3);state.checkRequired=true;state.checkState="PASSED";
 state.checkSha=base;await assert.rejects(client.approvalSnapshot(repo,1),/status revision/);state.checkSha=head;
 state.missingCheck=true;await assert.rejects(client.approvalSnapshot(repo,1),/conditions unavailable/);state.missingCheck=false;
 state.duplicate=true;await assert.rejects(client.approvalSnapshot(repo,1),/Duplicate/);state.duplicate=false;
 for(const mode of ["missing-draft","missing-queue","missing-participants"]){state.mode=mode;await assert.rejects(client.approvalSnapshot(repo,1),/coverage unavailable/);}state.mode="ok";
 state.participants=[objection];state.mode="duplicate-participant";await assert.rejects(client.pullRequest(repo,1),/Duplicate/);state.mode="ok";state.participants=[];
 assert.equal(state.approvalPosts,0);
});
test("Bitbucket approval replay and withdrawal own only their native timestamp and authenticated receipt",async t=>{
 const {client,state}=fixture(t),login="{"+bot+"}";
 state.notes.push({id:1,content:{raw:marker},user:{uuid:human,type:"user"},deleted:false});
 assert.deepEqual(await client.approve(repo,1,head,marker,login,base),{id:11,reused:false});assert.equal(state.approvalPosts,1);
 assert.deepEqual(await client.approve(repo,1,head,marker,login,base),{id:11,reused:true});assert.equal(state.approvalPosts,1);assert.equal((await client.approvalSnapshot(repo,1)).reviews[0].state,"APPROVED");
 await assert.rejects(client.dismissApproval(repo,1,1),/unrelated/);assert.equal(state.withdrawals,0);
 state.participants[0].participated_on="2026-10-03T13:00:00.123Z";await client.dismissApproval(repo,1,11);assert.equal(state.withdrawals,0);assert.equal((await client.approvalSnapshot(repo,1)).reviews[0].state,"DISMISSED");
 state.participants[0].participated_on=time;state.mode="withdraw-fails";await assert.rejects(client.dismissApproval(repo,1,11),/not confirmed/);state.mode="ok";state.base="c".repeat(40);await client.dismissApproval(repo,1,11);await client.dismissApproval(repo,1,11);assert.equal(state.withdrawals,2);assert.equal(state.participants.length,0);
});
test("Bitbucket approval rejects mismatched native identity and rolls back revision/lost-receipt races",async t=>{
 const {client,state}=fixture(t),login="{"+bot+"}";
 await assert.rejects(client.approve(repo,1,head,marker,login));await assert.rejects(client.approve(repo,1,head,marker,"other",base),/publisher changed/);
 state.draft=true;await assert.rejects(client.approve(repo,1,head,marker,login,base),/revision changed/);state.draft=false;state.queued=true;await assert.rejects(client.approve(repo,1,head,marker,login,base),/revision changed/);state.queued=false;
 state.author=bot;await assert.rejects(client.approve(repo,1,head,marker,login,base),/revision changed/);state.author=human;
 state.participants=[{user:{uuid:bot,type:"app_user"},role:"PARTICIPANT",state:"approved",approved:true,participated_on:time}];await assert.rejects(client.approve(repo,1,head,marker,login,base),/without this receipt/);state.participants=[];
 state.mode="race";await assert.rejects(client.approve(repo,1,head,marker,login,base),/revision changed/);assert.equal(state.withdrawals,1);assert.equal(state.participants.length,0);
 state.mode="note-lost";state.base=base;await assert.rejects(client.approve(repo,1,head,marker,login,base),/Lost receipt/);assert.equal(state.withdrawals,2);assert.equal(state.participants.length,0);
 await assert.rejects(client.approve(repo,1,head,marker,login,base),/receipt or native timestamp changed/);assert.equal(state.approvalPosts,2);
});

test("Bitbucket unknown approval metadata cannot create a trusted receipt or silently retry",async t=>{
 for(const mode of ["missing-time","wrong-publisher"])await t.test(mode,async child=>{const {client,state}=fixture(child);state.mode=mode;await assert.rejects(client.approve(repo,1,head,marker,"{"+bot+"}",base),/timestamp|identity/);assert.equal(state.approvalPosts,1);assert.equal(state.notePosts,0);assert.equal(state.withdrawals,0);});
});
