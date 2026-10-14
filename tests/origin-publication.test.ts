import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {Origin} from '../src/origin';
import {findingComment} from '../src/github';
import {reviewLinks} from '../src/review-summary';
import type {Finding} from '../src/engine/types';
const sha='a'.repeat(40),base='b'.repeat(40),repo='acme/source',marker='review-one',summary='Verified review',app={app:{id:'app_fixture'}},human={user:{id:'user_alice'}};
const version={number:'4',headSha:sha,baseSha:base};
const finding:Finding={title:'Wrong cents',description:'Integer cents are required.',severity:'high',confidence:1,category:'correctness',filePath:'src/price.ts',startLine:3,endLine:3,evidence:[{filePath:'src/price.ts',startLine:3,quote:'return dollars;'}],impact:'Wrong charge',suggestedFix:'Return cents',symbol:'price',fingerprint:'f'.repeat(32),agent:'correctness',commitSha:sha};
const reviewBody='## OpenReview\n\n'+summary+reviewLinks(marker,1)+'\n\n<!-- openreview:'+marker+' -->';
const findingBody=findingComment(finding,'detailed')+'\n\n<!-- openreview-review:'+marker+' -->';
function fixture(t:TestContext){
 const key=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const client=new Origin({appId:'app_fixture',installationId:'inst_fixture',privateKey:key},'repo_fixture');
 const pr={number:'1',repository:{id:'repo_fixture'},title:'Change',body:'',state:'open',draft:false,author:human,head:{sha,ref:'feature'},base:{sha:base,ref:'main'},changedFiles:1,version:{...version}};
 type Actor={app?:{id:string};user?:{id:string};serviceAccount?:{id:string}};
 type Review={id:string;author:Actor;body:string;verdict:string;pullRequestVersion:typeof version;dismissal?:unknown};
 type Comment={id:string;author:Actor;body:string;thread:{id:string;version:typeof version;path:string;side?:'right'|'left'|'PULL_REQUEST_COMMENT_SIDE_UNSPECIFIED';startLine:number;endLine:number}};
 const reviews:Review[]=[],comments:Comment[]=[];
 const state={pr,reviews,comments,reviewPosts:0,replyPosts:0,reads:0,contextNumber:'1',contextRepo:'repo_fixture',returnedApp:'app_fixture',wrongAnchor:false,moveAfterWrite:false,replyThread:undefined as string|undefined,duplicateFinding:false,compactReply:false,missingReplyReadback:false};
 t.mock.method(globalThis,'fetch',async(input:string,options:RequestInit)=>{
  const url=new URL(input),path=url.pathname;assert.equal(options.redirect,'error');
  if(path.endsWith('/access_tokens')){assert.ok(JSON.parse(String(options.body)).scopes.includes('repository:pull_requests:reviews:read'));return Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()});}
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer oit_fixture');assert.ok(path.startsWith('/v1/origin/repos/_/repo_fixture/'));
  if(path.endsWith('/pulls/1')){state.reads++;return Response.json(pr);}
  const context={number:state.contextNumber,repository:{id:state.contextRepo}};
  if(path.endsWith('/reviews')){
   if(options.method==='POST'){
    state.reviewPosts++;const b=JSON.parse(String(options.body));assert.equal(b.versionNumber,'4');assert.equal(b.verdict,'comment');assert.equal(b.comments.length,1);
    const review={id:'review_native',author:{app:{id:state.returnedApp}},body:b.body,verdict:b.verdict,pullRequestVersion:{...version}};reviews.push(review);
    for(const item of b.comments){const c:Comment={id:'finding_native',author:app,body:item.body,thread:{id:'thread_finding',version:{...version},path:item.inline.path,side:item.inline.side,startLine:state.wrongAnchor?2:item.inline.startLine,endLine:item.inline.endLine}};comments.push(c);if(state.duplicateFinding)comments.push({...c,id:'finding_duplicate'});}
    if(state.moveAfterWrite){pr.head.sha='c'.repeat(40);pr.version.headSha=pr.head.sha;pr.version.number='5';}
    return Response.json(review);
   }
   return Response.json({reviews,pullRequest:context});
  }
  if(path.endsWith('/comments')){
   if(options.method==='POST'){
    state.replyPosts++;const b=JSON.parse(String(options.body));assert.equal(b.versionNumber,undefined);
    const original=comments.find(c=>c.thread.id===b.threadId)?.thread;
    const c:Comment={id:'reply_native',author:{app:{id:state.returnedApp}},body:b.body,thread:{...(original??{id:'thread_general',version:{...version},path:'',startLine:0,endLine:0}),...(state.replyThread?{id:state.replyThread}:{})}};if(!state.missingReplyReadback)comments.push(c);return Response.json(state.compactReply?{...c,thread:{id:c.thread.id}}:c);
   }
   return Response.json({comments,pullRequest:context});
  }
  throw new Error('Unexpected Origin endpoint '+path);
 });
 return {client,state,ownReview:(id='review_prior'):Review=>({id,author:app,body:reviewBody,verdict:'comment',pullRequestVersion:{...version}}),ownFinding:(id='finding_prior'):Comment=>({id,author:app,body:findingBody,thread:{id:'thread_finding',version:{...version},path:finding.filePath,side:'right',startLine:3,endLine:3}})};
}
test('Origin publication binds installed app, native version and exact finding anchor on creation and replay',async t=>{
 const {client,state,ownReview,ownFinding}=fixture(t);
 state.reviews.push({...ownReview('human_forgery'),author:human},{...ownReview('other_app'),author:{app:{id:'app_other'}}},{...ownReview('mixed_actor'),author:{...app,...human}});
 state.comments.push({...ownFinding('human_finding'),author:human});
 const first=await client.publish(repo,1,sha,summary,[finding],marker,'detailed','4');assert.equal(first.id,'review_native');assert.deepEqual(first.comments,[{id:'finding_native',fingerprint:finding.fingerprint}]);assert.equal(state.reviewPosts,1);
 assert.equal((await client.publish(repo,1,sha,summary,[finding],marker,'detailed','4')).reused,true);assert.equal(state.reviewPosts,1);
 state.comments.find(c=>c.id==='finding_native')!.thread.side='left';await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/anchor unavailable/);assert.equal(state.reviewPosts,1);
});
test('Origin rejects foreign discussion identities, stale or edited own publications and provider races',async t=>{
 const {client,state,ownReview}=fixture(t);
 state.contextRepo='repo_other';await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/repository or change identity/);state.contextRepo='repo_fixture';
 state.contextNumber='2';await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/repository or change identity/);state.contextNumber='1';
 state.pr.repository.id='repo_other';await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/identity mismatch/);state.pr.repository.id='repo_fixture';
 state.reviews.push({...ownReview(),pullRequestVersion:{...version,number:'3'}});await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/saved review/);state.reviews.length=0;
 state.reviews.push(ownReview());state.pr.version.baseSha='c'.repeat(40);await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/saved review/);state.pr.version.baseSha=base;state.reviews.length=0;
 state.reviews.push({...ownReview(),body:reviewBody.replace(summary,'Edited')});await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/saved review/);state.reviews.length=0;
 state.reviews.push({...ownReview(),dismissal:{dismissedAt:new Date().toISOString()}});await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/saved review/);state.reviews.length=0;
 await assert.rejects(client.publish(repo,1,sha,summary,[{...finding,commitSha:base}],marker,'detailed','4'),/Invalid.*publication/);assert.equal(state.reviewPosts,0);
 state.moveAfterWrite=true;await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/updated or closed/);assert.equal(state.reviewPosts,1);
 await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/updated or closed/);assert.equal(state.reviewPosts,1);
});
test('Origin verifies response publishers and unique native finding receipts',async t=>{
 const {client,state}=fixture(t);state.returnedApp='app_other';await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/another publication identity/);
 state.reviews.length=0;state.comments.length=0;state.returnedApp='app_fixture';state.duplicateFinding=true;
 await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/anchor unavailable/);
});
test('Origin follow-ups and retry markers stay with the actual authorized question thread',async t=>{
 const {client,state,ownFinding}=fixture(t),question={...ownFinding('question_native'),body:'@openreview why cents?',author:human};
 state.comments.push({...ownFinding('human_marker'),author:human},ownFinding(),question);
 assert.equal(await client.findingParent(repo,1,'thread_finding'),'finding_prior');
 assert.deepEqual(await client.followUp(repo,1,question.id,'user_alice',question.body),{commentId:question.id,author:'user_alice',question:question.body,inline:true,parentCommentId:'finding_prior'});
 await assert.rejects(client.followUp(repo,1,question.id,'user_bob',question.body),/author or body changed/);await assert.rejects(client.followUp(repo,1,question.id,'user_alice','edited'),/author or body changed/);
 state.comments.push({...ownFinding('wrong_thread'),body:'Answer\n\n<!-- openreview:answer-one -->',thread:{...ownFinding().thread,id:'thread_other'}});
 assert.equal((await client.reply(repo,1,'Answer','finding_prior','answer-one')).id,'reply_native');assert.equal(state.replyPosts,1);
 assert.equal((await client.reply(repo,1,'Answer','finding_prior','answer-one')).id,'reply_native');assert.equal(state.replyPosts,1);
 const saved=state.comments.find(c=>c.id==='reply_native')!,savedThread=saved.thread;
 saved.thread={...savedThread,version:{...savedThread.version,number:'99'}};
 await assert.rejects(client.reply(repo,1,'Answer','finding_prior','answer-one'),/saved reply thread version/);assert.equal(state.replyPosts,1);saved.thread=savedThread;
 await assert.rejects(client.reply(repo,1,'Answer','foreign_parent','answer-one'),/inside this change/);assert.equal(state.replyPosts,1);
 state.replyThread='thread_other';await assert.rejects(client.reply(repo,1,'Another answer','finding_prior','answer-two'),/another reply/);
});
test('Origin general discussion questions retain their thread and service-account markers cannot impersonate the app',async t=>{
 const {client,state,ownFinding}=fixture(t),general={...ownFinding('question_general'),body:'@openreview explain',author:human,thread:{id:'general_original',version:{...version},path:'',startLine:0,endLine:0}};
 state.comments.push(general,{...general,id:'service_marker',author:{serviceAccount:{id:'app_fixture'}},body:'Answer\n\n<!-- openreview:general-answer -->'});
 const q=await client.followUp(repo,1,general.id,'user_alice',general.body);assert.equal(q?.parentCommentId,general.id);assert.equal(q?.inline,true);
 await client.reply(repo,1,'Answer',general.id,'general-answer');assert.equal(state.replyPosts,1);assert.equal(state.comments.at(-1)?.thread.id,'general_original');
});

test('Origin native unspecified sides allow only unanchored discussions without weakening finding receipts',async t=>{
 const {client,state,ownFinding,ownReview}=fixture(t),general={...ownFinding('native_general'),body:'@openreview explain',author:human,thread:{id:'native_general_thread',version:{...version},path:'',side:'PULL_REQUEST_COMMENT_SIDE_UNSPECIFIED' as const,startLine:0,endLine:0}};
 state.comments.push(general);
 const question=await client.followUp(repo,1,general.id,'user_alice',general.body);assert.equal(question?.parentCommentId,general.id);
 await client.reply(repo,1,'Answer',general.id,'native-general-answer');assert.equal(state.replyPosts,1);
 // Native round trips may omit or explicitly spell the same no-side value.
 state.comments.at(-1)!.thread.side=undefined;
 await client.reply(repo,1,'Answer',general.id,'native-general-answer');assert.equal(state.replyPosts,1);
 general.thread.path='src/price.ts';await assert.rejects(client.followUp(repo,1,general.id,'user_alice',general.body),/unanchored discussion/);general.thread.path='';
 general.thread.startLine=1;await assert.rejects(client.followUp(repo,1,general.id,'user_alice',general.body),/unanchored discussion/);general.thread.startLine=0;
 state.reviews.push(ownReview());
 state.comments.push({...ownFinding(),thread:{...ownFinding().thread,side:'PULL_REQUEST_COMMENT_SIDE_UNSPECIFIED'}});
 await assert.rejects(client.publish(repo,1,sha,summary,[finding],marker,'detailed','4'),/unanchored discussion/);assert.equal(state.reviewPosts,0);
 state.comments.pop();general.thread.side='unexpected' as typeof general.thread.side;
 await assert.rejects(client.followUp(repo,1,general.id,'user_alice',general.body),/Invalid enum value/);assert.equal(state.replyPosts,1);
});

test('Origin collaborator fallback is limited to App 404 and preserves native denials',async t=>{
 const key=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString(),credentials={appId:'app_fixture',installationId:'inst_fixture',privateKey:key};
 let status=404,permission='admin',nativeUser='user_alice',fallbackCalls=0;
 t.mock.method(globalThis,'fetch',async(input:string)=>String(input).endsWith('/access_tokens')?Response.json({token:'oit_fixture',expiresAt:new Date(Date.now()+240000).toISOString()}):Response.json({user:{id:nativeUser},permission},{status}));
 const client=new Origin(credentials,'repo_fixture',async(repository,author)=>{assert.equal(repository,repo);assert.equal(author,'user_alice');fallbackCalls++;return true;});
 assert.equal(await client.canReply(repo,'user_alice'),true);assert.equal(fallbackCalls,1);
 for(const code of [401,403,500]){status=code;await assert.rejects(client.canReply(repo,'user_alice'),new RegExp('Origin '+code));assert.equal(fallbackCalls,1);}
 status=200;for(const role of ['read','custom']){permission=role;assert.equal(await client.canReply(repo,'user_alice'),false);}
 permission='admin';nativeUser='user_other';assert.equal(await client.canReply(repo,'user_alice'),false);assert.equal(fallbackCalls,1);
 nativeUser='user_alice';permission='unknown';await assert.rejects(client.canReply(repo,'user_alice'));assert.equal(fallbackCalls,1);
 assert.equal(await client.canReply(repo,'app_fixture'),false);
 status=404;await assert.rejects(new Origin(credentials,'repo_fixture').canReply(repo,'user_alice'),/Origin 404/);
 assert.equal(await new Origin(credentials,'repo_fixture',async()=>false).canReply(repo,'user_alice'),false);
});

test('Origin compact native reply responses require full scoped readback before success',async t=>{
 const {client,state,ownFinding}=fixture(t);state.comments.push(ownFinding());state.compactReply=true;
 assert.equal((await client.reply(repo,1,'Answer','finding_prior','compact')).id,'reply_native');assert.equal(state.replyPosts,1);
 await client.reply(repo,1,'Answer','finding_prior','compact');assert.equal(state.replyPosts,1);
 state.missingReplyReadback=true;
 await assert.rejects(client.reply(repo,1,'Missing','finding_prior','missing'),/readback.*unavailable/);assert.equal(state.replyPosts,2);
});
