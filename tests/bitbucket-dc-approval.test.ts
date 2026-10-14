import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {BitbucketDC} from '../src/bitbucket-dc';

const head='b'.repeat(40),target='c'.repeat(40),repo='ACME/payments';
const bot={id:7,name:'openreview',slug:'openreview',active:true,type:'SERVICE'};
const alice={id:9,name:'alice',slug:'alice',active:true,type:'NORMAL'};
const participant=(status='UNAPPROVED',account=alice)=>({user:account,role:'REVIEWER',status,approved:status==='APPROVED',lastReviewedCommit:head});
const nativePr=()=>({id:1,title:'Cents',draft:false,locked:false,version:4,state:'OPEN',author:{user:alice},fromRef:{displayId:'feature',latestCommit:head,repository:{id:72}},toRef:{displayId:'main',latestCommit:target,repository:{id:71}},reviewers:[participant()],participants:[]});
const page=(values:unknown[])=>({start:0,values,isLastPage:true});
function fixture(t:TestContext){
 let pr:Record<string,unknown>=nativePr(),accounts:unknown[]=[bot],statuses:unknown[]=[{key:'ci/unit',state:'SUCCESSFUL'}],activities:unknown[]=[],merge:Record<string,unknown>={conflicted:false,outcome:'CLEAN',vetoes:[]},header:string|undefined=bot.name;
 let activityReads=0,activityMutation:((value:unknown[])=>unknown[])|undefined;
 let mutate:((value:Record<string,unknown>)=>Record<string,unknown>)|undefined,reads=0,cursor=0;
 const writes:string[]=[];
 t.mock.method(globalThis,'fetch',async(raw:string,options:RequestInit={})=>{
  if(options.method!=='GET')writes.push(String(options.method));
  const url=new URL(raw),p=url.pathname;
  let value:unknown;
  if(p.endsWith('/repos/payments'))value={id:71};
  else if(p.endsWith('/users'))value={...page(accounts),start:cursor};
  else if(p.endsWith('/pull-requests/1')){reads++;value=mutate&&reads%2===0?mutate(pr):pr;}
  else if(p.endsWith('/merge'))value=merge;
  else if(p.endsWith('/activities')){activityReads++;value=page(activityMutation&&activityReads%2===0?activityMutation(activities):activities);}
  else if(p.includes('/build-status/latest/commits/'))value=page(statuses);
  else throw new Error('Unexpected native path '+p);
  return Response.json(value,{headers:header?{'X-AUSERNAME':header}:{}});
 });
 return {client:new BitbucketDC('https://bitbucket.example','fixture-token','71',bot.name),writes,setPr(value:Record<string,unknown>){pr=value;reads=0;},setAccounts(value:unknown[]){accounts=value;},setStatuses(value:unknown[]){statuses=value;},setActivities(value:unknown[]){activities=value;activityReads=0;},setActivityMutation(value:typeof activityMutation){activityMutation=value;activityReads=0;},setMerge(value:Record<string,unknown>){merge=value;},setHeader(value:string|undefined){header=value;},setMutation(value:typeof mutate){mutate=value;reads=0;},setCursor(value:number){cursor=value;}};
}

test('Data Center approval evidence authenticates native publisher and binds read-only gates to revision',async t=>{
 const f=fixture(t),result=await f.client.approvalEvidence(repo,1);
 assert.equal(f.client.supportsApproval,true);
 assert.deepEqual(result.required,[{name:'OpenReview / Bitbucket Data Center native merge conditions'}]);
 assert.deepEqual(result.checks.map(c=>c.conclusion),['success','success']);
 assert.equal(result.pr.fromRef.latestCommit,head);
 assert.equal(result.pr.toRef.latestCommit,target);
 assert.equal(result.bot.id,7);
 assert.equal(result.publisherApprovalActivity,undefined);
 for(const merge of [{conflicted:true,outcome:'CONFLICTED',vetoes:[]},{conflicted:false,outcome:'UNKNOWN',vetoes:[]},{conflicted:false,outcome:'CLEAN',vetoes:[{summaryMessage:'Required approval',detailedMessage:'Needs another reviewer'}]}]){
  f.setMerge(merge);assert.equal((await f.client.approvalEvidence(repo,1)).checks.at(-1)?.conclusion,'failure');
 }
 f.setMerge({conflicted:false,outcome:'CLEAN',vetoes:[]});
 for(const patch of [{draft:true},{locked:true},{state:'MERGED'},{author:{user:bot}},{reviewers:[participant('NEEDS_WORK')]}]){
  f.setPr({...nativePr(),...patch});assert.equal((await f.client.approvalEvidence(repo,1)).checks.at(-1)?.conclusion,'failure');
 }
 assert.deepEqual(f.writes,[]);
});

test('Data Center approval evidence rejects missing identity, coverage and revision races',async t=>{
 const f=fixture(t);
 for(const header of [undefined,'anonymous','another-bot']){f.setHeader(header);await assert.rejects(f.client.approvalEvidence(repo,1),/authenticated header|configured bot/);}
 f.setHeader(bot.name);
 for(const accounts of [[],[bot,bot],[{...bot,active:false}],[{...bot,id:Number.MAX_SAFE_INTEGER+1}]]){f.setAccounts(accounts);await assert.rejects(f.client.approvalEvidence(repo,1));}
 f.setAccounts([bot]);f.setCursor(100);await assert.rejects(f.client.approvalEvidence(repo,1),/cursor mismatch/);f.setCursor(0);
 for(const field of ['draft','locked','version','participants','reviewers']){const pr:Record<string,unknown>=nativePr();delete pr[field];f.setPr(pr);await assert.rejects(f.client.approvalEvidence(repo,1));}
 f.setPr(nativePr());
 for(const statuses of [[{key:'ci',state:'SUCCESSFUL'},{key:'ci',state:'FAILED'}],Array.from({length:100},(_,i)=>({key:'ci/'+i,state:'SUCCESSFUL'})),[{key:'ci',state:'SKIPPED'}],[{key:'OpenReview / Bitbucket Data Center native merge conditions',state:'SUCCESSFUL'}]]){
  f.setStatuses(statuses);await assert.rejects(f.client.approvalEvidence(repo,1));
 }
 f.setStatuses([{key:'ci',state:'INPROGRESS'}]);assert.equal((await f.client.approvalEvidence(repo,1)).checks[0].status,'in_progress');
 for(const change of [(pr:Record<string,unknown>)=>({...pr,version:5}),(pr:Record<string,unknown>)=>({...pr,toRef:{...nativePr().toRef,latestCommit:'d'.repeat(40)}}),(pr:Record<string,unknown>)=>({...pr,reviewers:[participant('NEEDS_WORK')]})]){
  f.setMutation(change);await assert.rejects(f.client.approvalEvidence(repo,1),/changed during approval/);
 }
 assert.deepEqual(f.writes,[]);
});

test('Data Center native activity IDs distinguish publisher approval from later account decisions',async t=>{
 const f=fixture(t);
 f.setPr({...nativePr(),participants:[participant('APPROVED',bot)]});
 const approved={id:20,createdDate:100,action:'APPROVED',user:bot};
 f.setActivities([approved]);assert.equal((await f.client.approvalEvidence(repo,1)).publisherApprovalActivity?.id,20);
 for(const action of ['UNAPPROVED','REVIEWED','REVIEW_FINISHED','REVIEW_DISCARDED']){
  f.setActivities([{...approved,id:21,createdDate:101,action},approved]);
  assert.equal((await f.client.approvalEvidence(repo,1)).publisherApprovalActivity,undefined);
 }
 f.setActivities([approved,{...approved,id:22,createdDate:102,action:'COMMENTED'}]);
 assert.equal((await f.client.approvalEvidence(repo,1)).publisherApprovalActivity?.id,20);
 for(const activities of [[approved,approved],[approved,{...approved,id:21,createdDate:99}],[{...approved,user:{...bot,name:'renamed'}}],[{...approved,action:'UNKNOWN'}]]){
  f.setActivities(activities);await assert.rejects(f.client.approvalEvidence(repo,1));
 }
 f.setActivities([approved]);f.setActivityMutation(value=>[...value,{...approved,id:23,createdDate:103}]);
 await assert.rejects(f.client.approvalEvidence(repo,1),/decision activities changed/);f.setActivityMutation(undefined);
 f.setActivities([approved]);f.setPr({...nativePr(),participants:[{...participant('APPROVED',bot),lastReviewedCommit:target}]});
 assert.equal((await f.client.approvalEvidence(repo,1)).publisherApprovalActivity,undefined);
 assert.deepEqual(f.writes,[]);
});
