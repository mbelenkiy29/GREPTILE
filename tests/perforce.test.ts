import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {P4CodeReview,P4Error,p4Credential,type P4Comment} from '../src/perforce';
import type {Finding} from '../src/engine/types';
import {changedLines} from '../src/engine/diff';

test('P4 native snapshots use archived changelists, project views and digests; paging and source identity fail closed',async()=>{
 const original=globalThis.fetch,originalHosts=process.env.SCM_ALLOWED_HOSTS;process.env.SCM_ALLOWED_HOSTS='p4.example';
 const source='return priceCents * quantity;\n',path='//depot/main/price.ts',digest=createHash('md5').update(source).digest('hex');
 let limited=false,outside=false,changed=false,noArchive=false,badLink=false,badPath=false,badDigest=false,stalled=false,errorEnvelope=false,readReviews=0,metadataMismatch=false,emptyReviewCursor=false,wrongReviewCursor=false;
 const value={id:12,author:'alice',description:'Preserve integer cents',updated:1,pending:true,state:'needsReview',projects:{payments:['main']},versions:[{change:13,archiveChange:14,pending:true,time:1}]};
 const calls:string[]=[];
 let wrongSession=false;
 let duplicateBranch=false,invalidView=false,reinclude=false,secondBranch=false,scopeChanged=false,projectReads=0;
 let diffCut=false,diffChunk=false,diffPaging=false,diffHeader=false,diffTruncated=false,diffWrongSource=false,diffOverlap=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push(url.href);assert.equal(url.origin,'https://p4.example');assert.equal(init?.redirect,'error');assert.equal((init?.headers as Record<string,string>).authorization,'Basic '+Buffer.from('review-bot:fixture-ticket').toString('base64'));
  if(url.pathname==='/api/v9/session')return Response.json({isValid:true,user:{User:wrongSession?'another-user':'review-bot'}});
  if(url.pathname==='/api/v9/projects')return Response.json({projects:[{id:'payments',name:'Payments',branches:[{id:'main',name:'Main',paths:[invalidView?'not-a-depot-view':'//depot/main/...','-//depot/main/private/...']},...(duplicateBranch?[{id:'main',name:'Duplicate',paths:['//depot/other/...']}]:[])]}]});
  if(url.pathname==='/api/v9/projects/payments'){projectReads++;return Response.json({project:{id:'payments',name:'Payments',branches:[{id:'main',name:'Main',paths:scopeChanged&&projectReads>1?['//depot/main/*']:['//depot/main/...','-//depot/main/private/...',...(reinclude?['//depot/main/private/secret.ts']:[])]},...(secondBranch?[{id:'secondary',name:'Secondary',paths:['//depot/main/private/...']}]:[])]}});}
  if(url.pathname==='/api/v11/reviews'){
   if(emptyReviewCursor)return Response.json({error:null,data:{reviews:[],lastSeen:12,totalCount:1}});
   if(wrongReviewCursor)return Response.json({error:null,data:{reviews:[value,{...value,id:11}],lastSeen:12,totalCount:2}});
   if(url.searchParams.get('after')==='12')return Response.json({error:null,data:{reviews:[],lastSeen:null,totalCount:0}});
   const values=stalled?Array.from({length:100},(_,i)=>({...value,id:100+i})): [value];return Response.json({error:null,data:{reviews:values,lastSeen:stalled?100:12,totalCount:null}});
  }
  if(url.pathname==='/api/v11/reviews/12'){readReviews++;return Response.json({error:errorEnvelope?403:null,data:{reviews:[{...value,versions:[{...value.versions[0],archiveChange:noArchive?undefined:changed&&readReviews>1?15:14}]}]}});}
  if(url.pathname==='/api/v11/reviews/12/files')return Response.json({error:null,data:{limited,files:[{depotFile:outside?'//depot/main/private/secret.ts':path,action:'edit',type:'text',rev:'3',fileSize:String(Buffer.byteLength(source)),digest}]}});
  if(url.pathname.endsWith('/diff')){
   assert.equal(url.searchParams.get('from'),'#3');assert.equal(url.searchParams.get('to'),'@=14');assert.equal(url.searchParams.get('max_diffs'),'-1');assert.equal(url.searchParams.has('ignoreWs'),false);
   const patch=diffTruncated?'@@ -1,2 +1,2 @@\n-old\n+return priceCents * quantity;\n':diffWrongSource?'@@ -1 +1 @@\n-old\n+wrong source\n':'@@ -1 +1 @@\n-old\n+return priceCents * quantity;\n';
   const diffs=diffOverlap?[patch,patch]:[patch];
   return Response.json({error:null,data:{isCut:diffCut?1000:false,isSame:false,header:`--- a/${path}#3\n+++ b/${path}@=${diffHeader?15:14}\n`,diffs,paging:{diffs:diffs.length,offset:diffPaging?1:null},...(diffChunk?{isContentChunk:1000}:{})}});
  }
  if(url.pathname.startsWith('/api/v11/files/')){
   assert.equal(Buffer.from(url.pathname.split('/').at(-1)!,'base64url').toString(),path);assert.equal(url.searchParams.get('fileRevision'),'@=14');
   return Response.json({error:null,data:{fileName:path,fileRevision:metadataMismatch?'#3':'@=14',contentLink:badLink?'https://attacker.example/view/depot/main/price.ts':badPath?'https://p4.example/view/depot/main/other.ts':'https://p4.example/view/depot/main/price.ts?v=%2399'}});
  }
  if(url.pathname==='/view/depot/main/price.ts'){assert.equal(url.searchParams.get('v'),'@=14');return new Response(badDigest?'different source':source);}
  throw new Error('Unexpected P4 path '+url.pathname);
 };
 try{
  assert.throws(()=>new P4CodeReview('https://unknown.example','review-bot','fixture-ticket'),/authorize/);
  assert.throws(()=>new P4CodeReview('https://p4.example','bot:forged','fixture-ticket'),/username/);
  assert.equal(p4Credential.safeParse({username:'review-bot',ticket:'fixture-ticket',password:'unexpected'}).success,false);
  assert.equal(p4Credential.safeParse({username:'review-bot',ticket:'x'.repeat(10001)}).success,false);
  const p4=new P4CodeReview('https://p4.example','review-bot','fixture-ticket');assert.equal((await p4.projects())[0].id,'payments');
  assert.equal(await p4.authenticatedIdentity(),'review-bot');wrongSession=true;await assert.rejects(p4.authenticatedIdentity(),/authenticated user/);wrongSession=false;
  duplicateBranch=true;await assert.rejects(p4.projects(),/Duplicate P4 branch identity/);duplicateBranch=false;
  invalidView=true;await assert.rejects(p4.projects());invalidView=false;
  const page=await p4.reviewPage('payments');assert.equal(page.reviews[0].id,12);assert.equal(page.cursor,12);assert.equal((await p4.reviewPage('payments',page.cursor!)).cursor,null);
  const snapshot=await p4.snapshot('payments',12);assert.equal(snapshot.change,14);assert.match(snapshot.revision,/^p4:12:1:14:[0-9a-f]{64}$/);assert.equal(snapshot.coverage.length,1);
  assert.equal((await p4.content(snapshot,path)).content,source);
  const diff=await p4.diff(snapshot,path,3);assert.equal(diff.path,path);assert.equal(diff.status,'modified');assert.deepEqual([...changedLines(diff.patch)],[1]);
  diffCut=true;await assert.rejects(p4.diff(snapshot,path,3),/truncated/);diffCut=false;
  diffChunk=true;await assert.rejects(p4.diff(snapshot,path,3),/truncated/);diffChunk=false;
  diffPaging=true;await assert.rejects(p4.diff(snapshot,path,3),/paginated/);diffPaging=false;
  diffHeader=true;await assert.rejects(p4.diff(snapshot,path,3),/revision header/);diffHeader=false;
  diffTruncated=true;await assert.rejects(p4.diff(snapshot,path,3),/coverage incomplete/);diffTruncated=false;
  diffWrongSource=true;await assert.rejects(p4.diff(snapshot,path,3),/archived source/);diffWrongSource=false;
  diffOverlap=true;await assert.rejects(p4.diff(snapshot,path,3),/overlapping/);diffOverlap=false;
  await assert.rejects(p4.diff(snapshot,path,0),/base revision/);
  const attempts=calls.length;await assert.rejects(p4.content(snapshot,'//other/main/secret.ts'),/pinned digest/);assert.equal(calls.length,attempts);
  badLink=true;await assert.rejects(p4.content(snapshot,path),/trusted file origin/);badLink=false;
  badPath=true;await assert.rejects(p4.content(snapshot,path),/trusted file origin/);badPath=false;
  metadataMismatch=true;await assert.rejects(p4.content(snapshot,path),/metadata revision mismatch/);metadataMismatch=false;
  badDigest=true;await assert.rejects(p4.content(snapshot,path),/digest changed/);badDigest=false;
  limited=true;await assert.rejects(p4.snapshot('payments',12),/truncated/);limited=false;
  outside=true;await assert.rejects(p4.snapshot('payments',12),/outside selected/);outside=false;
  outside=true;reinclude=true;assert.equal((await p4.snapshot('payments',12)).files.length,1);reinclude=false;
  secondBranch=true;value.projects.payments=['main','secondary'];assert.equal((await p4.snapshot('payments',12)).files.length,1);secondBranch=false;value.projects.payments=['main'];outside=false;
  projectReads=0;scopeChanged=true;await assert.rejects(p4.snapshot('payments',12),/branch scope changed/);scopeChanged=false;
  value.projects.payments=['unknown'];await assert.rejects(p4.snapshot('payments',12),/branch identity/);value.projects.payments=['main'];
  noArchive=true;await assert.rejects(p4.snapshot('payments',12),/archived changelist/);noArchive=false;
  readReviews=0;changed=true;await assert.rejects(p4.snapshot('payments',12),/revision.*changed/);changed=false;
  stalled=true;await assert.rejects(p4.reviewPage('payments',100),/stalled/);stalled=false;
  emptyReviewCursor=true;await assert.rejects(p4.reviewPage('payments'),/pagination/);emptyReviewCursor=false;
  wrongReviewCursor=true;await assert.rejects(p4.reviewPage('payments'),/pagination/);wrongReviewCursor=false;
  errorEnvelope=true;await assert.rejects(p4.snapshot('payments',12));errorEnvelope=false;
  assert.equal(new P4Error(401,'/reviews?private=secret').message,'P4 Code Review 401 at /reviews');
 }finally{globalThis.fetch=original;if(originalHosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=originalHosts;}
});

test('P4 publication resumes partial writes and binds publisher, native version, depot file and complete diff',async()=>{
 const original=globalThis.fetch,hosts=process.env.SCM_ALLOWED_HOSTS;process.env.SCM_ALLOWED_HOSTS='p4.example';
 const path='//depot/main/price.ts',source='return priceCents * quantity;\n',digest=createHash('md5').update(source).digest('hex');
 const review={id:12,author:'alice',description:'Integer cents',updated:1,pending:true,state:'needsReview',projects:{payments:['main']},versions:[{change:13,archiveChange:14,pending:true,time:1}]};
 let comments:P4Comment[]=[],posts=0,failAfterWrite=false,wrongAuthor=false,wrongContext=false,stalled=false,wrongScope=false,emptyCursor=false,advancingEmpty=false,unboundedEmpty=false,filteredTail=false,wrongSide=false;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));assert.equal(u.origin,'https://p4.example');assert.equal(init?.redirect,'error');
  assert.equal((init?.headers as Record<string,string>).authorization,'Basic '+Buffer.from('review-bot:fixture-ticket').toString('base64'));
  if(u.pathname==='/api/v9/projects/payments')return Response.json({project:{id:'payments',name:'Payments',branches:[{id:'main',name:'Main',paths:['//depot/main/...']}]}});
  if(u.pathname==='/api/v11/reviews/12')return Response.json({error:null,data:{reviews:[review]}});
  if(u.pathname==='/api/v11/reviews/12/files')return Response.json({error:null,data:{limited:false,files:[{depotFile:path,action:'edit',type:'text',rev:3,fileSize:Buffer.byteLength(source),digest}]}});
  if(u.pathname==='/api/v9/comments'||u.pathname==='/api/v11/comments/reviews/12'){
   if(init?.method==='POST'){
    assert.equal(u.pathname,'/api/v11/comments/reviews/12');assert.equal((init.headers as Record<string,string>)['content-type'],'application/json');posts++;
    const payload=JSON.parse(String(init.body));assert.equal(payload.context.version,1);assert.equal(payload.taskState,'comment');const form=new URLSearchParams({body:payload.body,'context[version]':String(payload.context.version),...(payload.context.file?{'context[file]':payload.context.file,'context[rightLine]':String(payload.context.rightLine)}:{})});if(payload.context.file){assert.equal(payload.context.type,'text');assert.equal(payload.context.leftLine,null);payload.context.content.forEach((line:string,i:number)=>form.set(`context[content][${i}]`,line));}
    const c:P4Comment={id:100+posts,body:form.get('body')!,user:wrongAuthor?'human':'review-bot',topic:'reviews/12',flags:[],context:{...(payload.context.comment?{comment:payload.context.comment}:{}),version:wrongContext?2:1,...(form.has('context[file]')?{file:form.get('context[file]')!,rightLine:Number(form.get('context[rightLine]')),content:Array.from(form.entries()).filter(([k])=>k.startsWith('context[content][')).map(([,v])=>v)}:{rightLine:null}),...(wrongSide?{leftLine:2}:{})}};
    if(form.has('context[file]'))assert.deepEqual(c.context.content,[source.trimEnd()]);comments.push(c);if(failAfterWrite){failAfterWrite=false;return new Response('Response lost after storing comment',{status:503});}return Response.json({error:null,data:{comments:[c]}});
   }
   assert.equal(u.searchParams.get('topic'),'reviews/12');assert.equal(u.searchParams.get('context[version]'),'1');assert.equal(u.searchParams.get('ignoreArchived'),'false');
   const requestedAfter=Number(u.searchParams.get('after')??0);
   if(emptyCursor)return Response.json({topic:'reviews/12',comments:[],lastSeen:999});
   if(unboundedEmpty)return Response.json({comments:[],lastSeen:requestedAfter+1});
   if(advancingEmpty)return Response.json({comments:[],lastSeen:requestedAfter===0?4:null});
   const after=Number(u.searchParams.get('after')??0),page=comments.filter(c=>c.context.version===1&&(stalled||c.id>after)).sort((a,b)=>a.id-b.id).slice(0,1);
   return Response.json({comments:page.map(c=>wrongScope?{...c,context:{...c.context,file:'//other/private.ts'}}:c),lastSeen:page.length?(filteredTail?page.at(-1)!.id+10:page.at(-1)!.id):null});
  }
  if(u.pathname.endsWith('/diff'))return Response.json({error:null,data:{isCut:false,isSame:false,header:`--- a/${path}#3\n+++ b/${path}@=14\n`,diffs:['@@ -1 +1 @@\n-old\n+return priceCents * quantity;\n'],paging:{diffs:1,offset:null}}});
  if(u.pathname.startsWith('/api/v11/files/'))return Response.json({error:null,data:{filename:path,fileRevision:'@=14',contentLink:'https://p4.example/view/depot/main/price.ts'}});
  if(u.pathname==='/view/depot/main/price.ts')return new Response(source);
  throw new Error('Unexpected P4 endpoint '+u.pathname);
 };
 try{
  const p4=new P4CodeReview('https://p4.example','review-bot','fixture-ticket'),snapshot=await p4.snapshot('payments',12),run='run-one';
  const f:Finding={title:'Preserve cents',description:'The billing caller expects integer cents.',severity:'high',confidence:1,category:'data',filePath:path,startLine:1,endLine:1,commitSha:snapshot.revision,evidence:[{filePath:path,startLine:1,quote:source.trim()}],impact:'Wrong payment amount.',suggestedFix:'Return integer cents.',fingerprint:'a'.repeat(32),symbol:'total',agent:'verification'};
  const marker=`<!-- openreview:${run}:${snapshot.revision}`;
  comments=[{id:1,body:marker+' -->',user:'human',topic:'reviews/12',flags:[],context:{version:1}},{id:2,body:marker+':finding:'+f.fingerprint+' -->',user:'human',topic:'reviews/12',flags:[],context:{version:1,file:path,rightLine:1}}];
  assert.equal((await p4.comments(snapshot)).length,2); // Native short pages must continue.
  await assert.rejects(p4.publish(snapshot,'Summary',[f],{[path]:3},run,'standard',async()=>{throw new Error('Authorization revoked');}),/Authorization revoked/);assert.equal(posts,0);
  failAfterWrite=true;await assert.rejects(p4.publish(snapshot,'Verified summary',[f],{[path]:3},run),/503/);assert.equal(posts,1);
  let authorizationChecks=0;
  const completed=await p4.publish(snapshot,'Verified summary',[f],{[path]:3},run,'standard',async()=>{authorizationChecks++;});assert.equal(posts,2);assert.equal(completed.comments[0].id,101);assert.equal(completed.id,102);assert.ok(authorizationChecks>=2);
  const replay=await p4.publish(snapshot,'Ignored replay body',[f],{[path]:3},run);assert.equal(replay.reused,true);assert.equal(replay.id,102);assert.equal(posts,2);
  comments.find(c=>c.id===102)!.flags=['closed'];await assert.rejects(p4.publish(snapshot,'Summary',[f],{[path]:3},run),/archived/);assert.equal(posts,2);comments.find(c=>c.id===102)!.flags=[];
  await assert.rejects(p4.publish(snapshot,'Summary',[{...f,startLine:2}],{[path]:3},'bad-line'),/pinned diff/);
  await assert.rejects(p4.publish(snapshot,'Summary',[f],{},'missing-base'),/pinned diff/);assert.equal(posts,2);
  await assert.rejects(p4.publish(snapshot,'Summary',[f,f],{[path]:3},run),/Invalid/);
  review.versions[0].archiveChange=15;await assert.rejects(p4.publish(snapshot,'Summary',[f],{[path]:3},run),/changed or closed/);review.versions[0].archiveChange=14;
  review.state='approved';await assert.rejects(p4.publish(snapshot,'Summary',[f],{[path]:3},run),/closed/);review.state='needsReview';assert.equal(posts,2);
  stalled=true;await assert.rejects(p4.comments(snapshot),/pagination/);stalled=false;
  wrongScope=true;await assert.rejects(p4.comments(snapshot),/scope mismatch/);wrongScope=false;
  advancingEmpty=true;assert.deepEqual(await p4.comments(snapshot),[]);advancingEmpty=false;
  emptyCursor=true;await assert.rejects(p4.comments(snapshot),/complete coverage/);emptyCursor=false;
  unboundedEmpty=true;await assert.rejects(p4.comments(snapshot),/coverage limit/);unboundedEmpty=false;
  const savedComments=comments;comments=[comments[0]];filteredTail=true;assert.equal((await p4.comments(snapshot)).length,1);filteredTail=false;comments=savedComments;
  wrongAuthor=true;await assert.rejects(p4.publish(snapshot,'Summary',[],{},'wrong-author'),/publication identity/);wrongAuthor=false;
  wrongSide=true;await assert.rejects(p4.publish(snapshot,'Summary',[f],{[path]:3},'wrong-side'),/publication identity/);wrongSide=false;
  wrongContext=true;await assert.rejects(p4.publish(snapshot,'Summary',[],{},'wrong-version'),/publication identity/);wrongContext=false;
  const question:P4Comment={id:1000,body:'@openreview Why are integer cents required?',user:'alice',topic:'reviews/12',flags:[],context:{version:1,comment:101}};comments.push(question);
  const answer='The caller expects integer cents. No runtime execution evidence was supplied.',beforeReplies=posts;
  await assert.rejects(p4.reply(snapshot,question,answer,'question-1000',async()=>{throw new Error('Authority revoked');}),/Authority revoked/);assert.equal(posts,beforeReplies);
  const reply=await p4.reply(snapshot,question,answer,'question-1000');assert.equal(reply.reused,false);assert.equal(posts,beforeReplies+1);
  assert.equal((await p4.reply(snapshot,question,answer,'question-1000')).reused,true);assert.equal(posts,beforeReplies+1);
  await assert.rejects(p4.reply(snapshot,question,answer+' Changed.','question-1000'),/saved answer/);
  const savedReply=comments.find(c=>c.id===reply.id)!;savedReply.flags=['closed'];await assert.rejects(p4.reply(snapshot,question,answer,'question-1000'),/retry identity/);savedReply.flags=[];
  await assert.rejects(p4.reply(snapshot,{...question,body:'Forged question'},answer,'forged-question'),/question changed/);
  question.flags=['closed'];await assert.rejects(p4.reply(snapshot,question,answer,'closed-question'),/archived/);question.flags=[];
  await assert.rejects(p4.reply(snapshot,{...question,user:'review-bot'},answer,'bot-question'),/Invalid/);
  review.versions[0].archiveChange=15;await assert.rejects(p4.reply(snapshot,question,answer,'stale-question'),/shelf changed/);review.versions[0].archiveChange=14;
  review.state='approved';await assert.rejects(p4.reply(snapshot,question,answer,'closed-shelf'),/closed/);review.state='needsReview';
  wrongAuthor=true;await assert.rejects(p4.reply(snapshot,question,answer,'wrong-reply-publisher'),/reply identity/);wrongAuthor=false;
  wrongContext=true;await assert.rejects(p4.reply(snapshot,question,answer,'wrong-reply-version'),/reply identity/);wrongContext=false;

 }finally{globalThis.fetch=original;if(hosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=hosts;}
});

test('P4 approval inspection is read-only, revision-bound and redacts native private blocker metadata',async()=>{
 const original=globalThis.fetch,hosts=process.env.SCM_ALLOWED_HOSTS;process.env.SCM_ALLOWED_HOSTS='p4.example';
 const native={id:12,author:'alice',description:'Inspect approval',updated:1,pending:true,state:'needsReview',projects:{payments:['main']},versions:[{change:13,archiveChange:14,pending:true,time:1}]};
 let transitions:unknown={approved:'Approve','approved:commit':'Approve and Commit'},blocked:unknown=[],changeDuringRead=false,deny=false;
 globalThis.fetch=async(input,init)=>{
  assert.notEqual(init?.method,'POST');const u=new URL(String(input));
  if(u.pathname.startsWith('/api/v9/projects/'))return Response.json({project:{id:'payments',name:'Payments',branches:[{id:'main',name:'Main',paths:['//depot/main/...']}]}});
  if(u.pathname==='/api/v11/reviews/12')return Response.json({error:null,data:{reviews:[native]}});
  if(u.pathname==='/api/v11/reviews/12/files')return Response.json({error:null,data:{limited:false,files:[]}});
  if(u.pathname==='/api/v11/reviews/12/transitions'){
   if(deny)return new Response('',{status:403});if(changeDuringRead)native.updated++;
   return Response.json({error:null,data:{transitions,blocked}});
  }
  throw new Error('Unexpected approval inspection request');
 };
 try{
  const client=new P4CodeReview('https://p4.example','bot','fixture-ticket');
  const result=await client.approvalInspection('payments',12);
  assert.equal(result.nativeApprovalAvailable,true);assert.equal(result.version,1);assert.equal(result.coverage.length,1);assert.ok(result.inspectedAt>0);
  blocked={approved:{votes:{privateProjects:3,projects:{secret:{name:'private-name'}}},moderators:{users:['private-human']},tests:['secret-test'],unknown:{secret:'private-metadata'}}};
  const restricted=await client.approvalInspection('payments',12);assert.equal(restricted.nativeApprovalAvailable,false);assert.equal(restricted.nativeBlockers.length,4);assert.doesNotMatch(JSON.stringify(restricted),/private-name|private-human|secret-test|private-metadata/);
  blocked={approved:{}};assert.match((await client.approvalInspection('payments',12)).nativeBlockers[0],/interpreted/);
  blocked={unexpected:{}};assert.equal((await client.approvalInspection('payments',12)).nativeApprovalAvailable,false);
  blocked=[];transitions={'approved:commit':'Approve and Commit'};assert.equal((await client.approvalInspection('payments',12)).nativeApprovalAvailable,false);
  transitions={approved:42};await assert.rejects(client.approvalInspection('payments',12));transitions={approved:'Approve'};
  blocked=[{approved:'malformed'}];await assert.rejects(client.approvalInspection('payments',12));blocked=[];
  changeDuringRead=true;await assert.rejects(client.approvalInspection('payments',12),/changed during approval inspection/);changeDuringRead=false;
  deny=true;await assert.rejects(client.approvalInspection('payments',12),/403/);deny=false;
  await assert.rejects(client.approvalInspection('other-project',12),/project identity changed/);
 }finally{globalThis.fetch=original;if(hosts===undefined)delete process.env.SCM_ALLOWED_HOSTS;else process.env.SCM_ALLOWED_HOSTS=hosts;}
});
