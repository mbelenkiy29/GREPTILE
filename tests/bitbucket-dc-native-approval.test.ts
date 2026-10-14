import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {BitbucketDC} from '../src/bitbucket-dc';
const head='b'.repeat(40),target='c'.repeat(40),repo='ACME/payments',marker='<!-- openreview:approval:fixture1 -->';
const bot={id:7,name:'openreview',slug:'openreview',active:true,type:'SERVICE'},alice={id:9,name:'alice',slug:'alice',active:true,type:'NORMAL'};
const member=(status='UNAPPROVED')=>({user:bot,role:'PARTICIPANT',status,approved:status==='APPROVED',lastReviewedCommit:head});
function fixture(t:TestContext){
 const pr={id:1,title:'Cents',draft:false,locked:false,version:4,state:'OPEN',author:{user:alice},fromRef:{displayId:'feature',latestCommit:head,repository:{id:72}},toRef:{displayId:'main',latestCommit:target,repository:{id:71}},reviewers:[] as ReturnType<typeof member>[],participants:[] as ReturnType<typeof member>[]};
 let sequence=20,receiptFailure=false,withdrawalFailure=false,afterApproval:(()=>void)|undefined,resultMutation:((value:ReturnType<typeof member>)=>unknown)|undefined;
 const activities:{id:number;createdDate:number;action:string;user:typeof bot}[]=[],notes:{id:number;text:string;author:typeof bot;version:number;pending:boolean;reply:boolean;state:string}[]=[];
 const writes:{method:string;path:string;body:Record<string,unknown>}[]=[];
 const page=(values:unknown[])=>({start:0,values,isLastPage:true});
 t.mock.method(globalThis,'fetch',async(raw:string,options:RequestInit={})=>{
  const u=new URL(raw),p=u.pathname,headers={'X-AUSERNAME':bot.name};
  const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
  if(options.method!=='GET'){
   const body=JSON.parse(String(options.body));writes.push({method:options.method!,path:p,body});
   if(options.method==='PUT'&&p.endsWith('/participants/openreview')){
    if(withdrawalFailure&&body.status==='UNAPPROVED')return json({},503);
    if(Number(u.searchParams.get('version'))!==pr.version||body.lastReviewedCommit!==pr.fromRef.latestCommit)return json({},409);
    const value=member(body.status);pr.participants=[value];pr.version++;
    activities.push({id:++sequence,createdDate:sequence,action:body.status==='APPROVED'?'APPROVED':'UNAPPROVED',user:bot});
    if(body.status==='APPROVED')afterApproval?.();
    return json(resultMutation?resultMutation(value):value);
   }
   if(options.method==='POST'&&p.endsWith('/comments')){
    if(receiptFailure)return json({},503);
    const note={id:notes.length+1,text:body.text,author:bot,version:0,pending:false,reply:false,state:'OPEN'};notes.push(note);return json(note);
   }
   throw new Error('Unexpected native write '+p);
  }
  if(p.endsWith('/repos/payments'))return json({id:71});
  if(p.endsWith('/users'))return json(page([bot]));
  if(p.endsWith('/pull-requests/1'))return json(pr);
  if(p.endsWith('/merge'))return json({conflicted:false,outcome:'CLEAN',vetoes:[]});
  if(p.endsWith('/activities'))return json(page([...activities,...notes.map(n=>({id:100+n.id,createdDate:100+n.id,action:'COMMENTED',user:n.author,comment:n}))]));
  const note=/\/comments\/(\d+)$/.exec(p);if(note)return json(notes.find(n=>n.id===Number(note[1])));
  if(p.endsWith('/merge-base'))return json({id:'a'.repeat(40)});
  if(p.includes('/build-status/latest/commits/'))return json(page([{key:'ci/unit',state:'SUCCESSFUL'}]));
  if(p.endsWith('/changes')||p.endsWith('/commits'))return json(page([]));
  throw new Error('Unexpected native read '+p);
 });
 return {client:new BitbucketDC('https://bitbucket.example','fixture-token','71',bot.name),pr,activities,notes,writes,setReceiptFailure(value:boolean){receiptFailure=value;},setWithdrawalFailure(value:boolean){withdrawalFailure=value;},setAfterApproval(value:typeof afterApproval){afterApproval=value;},setResultMutation(value:typeof resultMutation){resultMutation=value;},addDecision(action='APPROVED'){activities.push({id:++sequence,createdDate:sequence,action,user:bot});}};
}
test('Data Center publishes receipt-owned approval, replays once and confirms native withdrawal',async t=>{
 const f=fixture(t),result=await f.client.approve(repo,1,head,marker,bot.name,target);
 assert.equal(result.reused,false);assert.equal(result.id,1);
 assert.deepEqual(f.writes.map(w=>w.method),['PUT','POST']);
 assert.deepEqual(f.writes[0].body,{status:'APPROVED',lastReviewedCommit:head});
 const snapshot=await f.client.approvalSnapshot(repo,1);
 assert.equal(snapshot.reviews[0].state,'APPROVED');assert.equal(snapshot.botLogin,bot.name);
 assert.equal((await f.client.approve(repo,1,head,marker,bot.name,target)).reused,true);assert.equal(f.writes.length,2);
 await f.client.dismissApproval(repo,1,result.id);
 assert.equal(f.pr.participants[0].status,'UNAPPROVED');
 assert.equal((await f.client.approvalSnapshot(repo,1)).reviews[0].state,'DISMISSED');
 await f.client.dismissApproval(repo,1,result.id);assert.equal(f.writes.length,3);
 assert.ok(f.writes.every(w=>!w.path.endsWith('/merge')));
});
test('Data Center refuses stale or foreign receipt ownership and preserves newer native approvals',async t=>{
 const f=fixture(t);await f.client.approve(repo,1,head,marker,bot.name,target);
 f.addDecision();await f.client.dismissApproval(repo,1,1);assert.equal(f.pr.participants[0].status,'APPROVED');assert.equal(f.writes.length,2);
 assert.equal((await f.client.approvalSnapshot(repo,1)).reviews[0].state,'DISMISSED');
 await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target),/no longer active/);
 f.notes[0].author={...alice,type:'NORMAL'};await assert.rejects(f.client.dismissApproval(repo,1,1),/unrelated/);
 assert.equal(f.writes.length,2);
});
test('Data Center withdraws known approvals after receipt failures and source or destination races',async t=>{
 for(const kind of ['receipt','source','destination'])await t.test(kind,async t=>{
  const f=fixture(t);
  if(kind==='receipt')f.setReceiptFailure(true);
  else f.setAfterApproval(()=>{if(kind==='source')f.pr.fromRef.latestCommit='d'.repeat(40);else f.pr.toRef.latestCommit='d'.repeat(40);});
  await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target));
  assert.equal(f.pr.participants[0].status,'UNAPPROVED');
  assert.equal(f.writes.at(-1)?.body.status,'UNAPPROVED');
  assert.equal(f.writes.at(-1)?.body.lastReviewedCommit,f.pr.fromRef.latestCommit);
 });
});
test('Data Center rejects invalid metadata, self approval, preexisting approvals and unproven write responses',async t=>{
 const f=fixture(t);
 await assert.rejects(f.client.approve(repo,1,head,marker,'foreign',target),/publisher changed/);
 await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,undefined));
 f.pr.author.user=bot;await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target),/author/);f.pr.author.user=alice;
 f.pr.draft=true;await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target),/revision/);f.pr.draft=false;
 f.pr.participants=[member('APPROVED')];await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target),/already approved/);f.pr.participants=[];
 assert.equal(f.writes.length,0);
 f.setResultMutation(value=>({...value,user:alice}));await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target),/inspect before retrying/);
 assert.equal(f.notes.length,0);assert.equal(f.writes.length,1);
});

test('Data Center rejects ambiguous new decisions and exposes failed withdrawal',async t=>{
 const f=fixture(t);f.setAfterApproval(()=>f.addDecision());
 await assert.rejects(f.client.approve(repo,1,head,marker,bot.name,target),/activity unavailable/);
 assert.equal(f.notes.length,0);assert.equal(f.writes.length,1);
});
test('Data Center withdrawal errors stay visible and closed changes cannot produce active receipts',async t=>{
 const f=fixture(t);await f.client.approve(repo,1,head,marker,bot.name,target);
 f.setWithdrawalFailure(true);await assert.rejects(f.client.dismissApproval(repo,1,1),/503/);assert.equal(f.pr.participants[0].status,'APPROVED');
 f.pr.state='DECLINED';assert.equal((await f.client.approvalSnapshot(repo,1)).reviews[0].state,'DISMISSED');
 const count=f.writes.length;await f.client.dismissApproval(repo,1,1);assert.equal(f.writes.length,count);
});
