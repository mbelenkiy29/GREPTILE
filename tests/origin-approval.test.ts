import test from 'node:test';
import assert from 'node:assert/strict';
import {Origin} from '../src/origin';
import {z} from 'zod';
const head='a'.repeat(40),base='b'.repeat(40),marker='<!-- openreview:approval:operation_one -->',body='OpenReview approved this exact native version after all configured approval gates passed. No merge was performed.\n\n'+marker;
const actor={app:{id:'app_fixture'}},reference={id:'pr_fixture',number:'1',repository:{id:'repo_fixture'}},version={number:'3',headSha:head,baseSha:base};
const pr={number:'1',repository:{id:'repo_fixture'},title:'Change',state:'open',draft:false,author:{user:{id:'user_alice'}},head:{sha:head,ref:'feature'},base:{sha:base,ref:'main'},version,changedFiles:0};
const review={id:'rev_fixture',author:actor,body,verdict:'approve',submittedAt:new Date().toISOString(),pullRequestVersion:version};
function client(){return new Origin({appId:'app_fixture',installationId:'i_fixture',privateKey:'fixture signing key not used in native-response tests'},'repo_fixture');}
test('Origin approval snapshot pins opaque native version and checks, human objections and unknown merge blockers fail closed',async t=>{
 const scm=client();let state:Record<string,unknown>={pullRequest:reference,verdict:'blocked',blockers:[{pullRequest:reference,kind:'required_approvals',message:'One approval required'}],evaluatedPullRequests:[reference],headSha:head,baseRef:'main',baseSha:base,evaluatedAt:new Date().toISOString()},reviews:Record<string,unknown>[]=[review],changes=0,changed=false;
 t.mock.method(scm,'request',async(endpoint:string,schema:z.ZodType)=>{
  assert.ok(endpoint.startsWith('/repos/_/repo_fixture/'));
  if(endpoint.includes('/mergeability')){assert.ok(endpoint.endsWith('expectedHeadSha='+head));return schema.parse(state);}
  if(endpoint.includes('/reviews?'))return schema.parse({pullRequest:reference,reviews});
  if(endpoint.endsWith('/pulls/1')){changes++;return schema.parse(changed&&changes>2?{...pr,version:{...version,number:'4'}}:pr);}
  if(endpoint.includes('/check-runs'))return schema.parse({checkRuns:[]});
  return schema.parse({pullRequest:reference,files:[],comments:[],commits:[]});
 });
 const result=await scm.approvalSnapshot('acme/source',1);assert.equal(result.reviews[0].id,'rev_fixture');assert.equal(result.reviews[0].state,'APPROVED');assert.equal(result.checks.at(-1)?.conclusion,'success');assert.equal(result.pr.revisionKey,'3');
 for(const kind of ['required_checks','codeowner_approval','ruleset_error','new_unknown_kind',undefined]){state={...state,blockers:[{pullRequest:reference,kind,message:'Blocked'}]};assert.equal((await scm.approvalSnapshot('acme/source',1)).checks.at(-1)?.conclusion,'failure');}
 state={...state,verdict:'future_value',blockers:[]};assert.equal((await scm.approvalSnapshot('acme/source',1)).checks.at(-1)?.conclusion,'failure');
 state={...state,verdict:'mergeable',blockers:[]};assert.equal((await scm.approvalSnapshot('acme/source',1)).checks.at(-1)?.conclusion,'success');
 reviews=[{...review,id:'rev_human',author:{user:{id:'user_alice'}},verdict:'request_changes'}];assert.equal((await scm.approvalSnapshot('acme/source',1)).humanChangeRequested,true);
 reviews=[{...reviews[0],dismissal:{message:'Superseded'}}];assert.equal((await scm.approvalSnapshot('acme/source',1)).humanChangeRequested,false);
 reviews=[{...review,pullRequestVersion:{...version,number:'2'}}];assert.equal((await scm.approvalSnapshot('acme/source',1)).reviews[0].state,'COMMENTED');
 state={...state,evaluatedPullRequests:[{...reference,id:'pr_ancestor',number:'2'},reference]};assert.equal((await scm.approvalSnapshot('acme/source',1)).checks.at(-1)?.conclusion,'failure');
 state={...state,evaluatedPullRequests:[reference],pullRequest:{...reference,repository:{id:'repo_foreign'}}};await assert.rejects(scm.approvalSnapshot('acme/source',1),/identity mismatch/);
 state={...state,pullRequest:reference};reviews=[{...review,author:{user:{id:'user_alice'},app:{id:'app_fixture'}}}];await assert.rejects(scm.approvalSnapshot('acme/source',1),/ambiguous/);
 reviews=[review];changed=true;changes=0;await assert.rejects(scm.approvalSnapshot('acme/source',1),/revision changed/);
});
test('Origin approval creation and replay retain exact version, author, body and opaque operation identity',async t=>{
 const scm=client();let mode='ok',saved:Record<string,unknown>[]=[];let writes=0;
 t.mock.method(scm,'request',async(endpoint:string,schema:z.ZodType,input?:Record<string,unknown>)=>{
  if(endpoint.endsWith('/pulls/1'))return schema.parse(mode==='stale'?{...pr,version:{...version,number:'4'}}:mode==='own'?{...pr,author:actor}:mode==='draft'?{...pr,draft:true}:pr);
  if(endpoint.includes('/reviews?'))return schema.parse({pullRequest:reference,reviews:saved});
  assert.equal(endpoint,'/repos/_/repo_fixture/pulls/1/reviews');assert.deepEqual(input,{verdict:'approve',versionNumber:'3',body});writes++;
  const result={...review,...(mode==='wrong-author'?{author:{app:{id:'app_foreign'}}}:{})};saved=[result];return schema.parse(result);
 });
 assert.deepEqual(await scm.approve('acme/source',1,head,marker,'app_fixture','3'),{id:'rev_fixture',reused:false});
 assert.deepEqual(await scm.approve('acme/source',1,head,marker,'app_fixture','3'),{id:'rev_fixture',reused:true});assert.equal(writes,1);
 saved=[{...review,dismissal:{message:'Invalidated'}}];await assert.rejects(scm.approve('acme/source',1,head,marker,'app_fixture','3'),/saved approval/);
 saved=[review,review];await assert.rejects(scm.approve('acme/source',1,head,marker,'app_fixture','3'),/Multiple/);
 saved=[];for(mode of ['stale','own','draft'])await assert.rejects(scm.approve('acme/source',1,head,marker,'app_fixture','3'));
 mode='wrong-author';await assert.rejects(scm.approve('acme/source',1,head,marker,'app_fixture','3'),/another approval/);
 await assert.rejects(scm.approve('acme/source',1,head,marker,'app_fixture'));await assert.rejects(scm.approve('acme/source',1,head,marker,'app_foreign','3'));
});
test('Origin native dismissal is an ownership-bound PUT and verifies the persisted result without dismissing unrelated reviews',async t=>{
 const scm=client();let saved:Record<string,unknown>={...review},writes=0,mode='ok';
 t.mock.method(scm,'request',async(endpoint:string,schema:z.ZodType,input?:Record<string,unknown>,method?:string)=>{
  if(endpoint.includes('/reviews?'))return schema.parse({pullRequest:reference,reviews:[saved]});
  assert.equal(endpoint,'/repos/_/repo_fixture/pulls/1/reviews/rev_fixture/dismissals');assert.equal(method,'PUT');assert.ok(String(input?.message).includes('invalidated'));writes++;
  saved={...saved,dismissal:{message:'Invalidated'}};return schema.parse(mode==='wrong-result'?{...saved,id:'rev_other'}:saved);
 });
 await scm.dismissApproval('acme/source',1,'rev_fixture');await scm.dismissApproval('acme/source',1,'rev_fixture');assert.equal(writes,1);
 for(const change of [{author:{app:{id:'app_foreign'}}},{body:'unrelated'},{verdict:'comment'},{submittedAt:undefined}]){saved={...review,...change};await assert.rejects(scm.dismissApproval('acme/source',1,'rev_fixture'),/unrelated/);}
 assert.equal(writes,1);saved={...review};mode='wrong-result';await assert.rejects(scm.dismissApproval('acme/source',1,'rev_fixture'),/identity/);await assert.rejects(scm.dismissApproval('acme/source',1,42));
});

test('Origin configured approval checks exclude foreign comparison bases and reject foreign native check identities',async t=>{
 const scm=client();let checks:Record<string,unknown>[]=[{id:'run_otherbase',repository:{id:'repo_fixture'},sha:head,baseSha:'c'.repeat(40),name:'regression',status:'completed',conclusion:'success'},{id:'run_current',repository:{id:'repo_fixture'},sha:head,baseSha:base,name:'regression',status:'in_progress'},{id:'run_agnostic',repository:{id:'repo_fixture'},sha:head,name:'lint',status:'completed',conclusion:'success'}];
 t.mock.method(scm,'request',async(endpoint:string,schema:z.ZodType)=>{
  if(endpoint.endsWith('/pulls/1'))return schema.parse(pr);
  if(endpoint.includes('/mergeability'))return schema.parse({pullRequest:reference,verdict:'mergeable',blockers:[],evaluatedPullRequests:[reference],headSha:head,baseRef:'main',baseSha:base,evaluatedAt:new Date().toISOString()});
  if(endpoint.includes('/check-runs'))return schema.parse({checkRuns:checks});
  return schema.parse({pullRequest:reference,reviews:[],files:[],comments:[],commits:[]});
 });
 const result=await scm.approvalSnapshot('acme/source',1);expectCheck(result.checks.filter(c=>c.name==='regression'),[{name:'regression',status:'in_progress',conclusion:null}]);assert.equal(result.checks.find(c=>c.name==='lint')?.conclusion,'success');
 for(const patch of [{repository:{id:'repo_foreign'}},{sha:'c'.repeat(40)}]){checks=[{...checks[0],...patch}];await assert.rejects(scm.approvalSnapshot('acme/source',1),/check repository or revision mismatch/);}
 function expectCheck(actual:unknown,expected:unknown){assert.deepEqual(actual,expected);}
});
