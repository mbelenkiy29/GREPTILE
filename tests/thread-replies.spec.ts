import {beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHmac} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {defaults} from '../src/review-settings';
import {Github} from '../src/github';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='thread-replies-session-secret-at-least-32-characters';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='thread-replies-service';process.env.GITHUB_WEBHOOK_SECRET='thread-replies-webhook';});

async function setup(settings:Partial<typeof defaults>={}){
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'thread-replies-service',githubId:93,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Threads'});
 await t.mutation(api.repositories.connect,{token,secret:'thread-replies-service',organizationId,installationId:93,account:'alice',accountId:1,repositories:[{id:9393,fullName:'alice/threads',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 await t.mutation(api.repositories.configure,{token,repositoryId:repo._id,enabled:true,settings:{...defaults,...settings}});
 // OpenReview posted inline finding comments 500–519 on PR 7; comment 999 is a human-started thread.
 await t.run(async ctx=>{
  const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:7,headSha:'c'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  for(let i=0;i<20;i++)await ctx.db.insert('reviewComments',{organizationId,reviewId,githubId:500+i,fingerprint:'fp-'+i,createdAt:Date.now()});
  // Another pull request's OpenReview thread with an id that must not match PR 7.
  const other=await ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:8,headSha:'d'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  await ctx.db.insert('reviewComments',{organizationId,reviewId:other,githubId:800,fingerprint:'fp-other',createdAt:Date.now()});
 });
 const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
 const permissions:Record<string,string>={alice:'write',reader:'read'};
 const request=vi.spyOn(scm,'request').mockImplementation(async(path:string)=>{const login=decodeURIComponent(path.split('/collaborators/')[1]?.split('/')[0]??'');return {permission:permissions[login]??'none'} as never;});
 let sequence=0;
 const reply=async(comment:{id:number;body:string;in_reply_to_id?:number;login?:string;type?:string},action='created',event='pull_request_review_comment')=>{
  const deliveryId='thread-'+(++sequence);
  const body=JSON.stringify({action,installation:{id:93},repository:{id:9393,full_name:'alice/threads',default_branch:'main'},pull_request:{number:7,draft:false,state:'open',head:{sha:'c'.repeat(40),ref:'feature'},base:{ref:'main'},user:{login:'alice'}},comment:{id:comment.id,body:comment.body,in_reply_to_id:comment.in_reply_to_id,user:{login:comment.login??'alice',type:comment.type??'User'}}});
  expect((await t.fetch('/github/webhook',{method:'POST',headers:{'x-github-delivery':deliveryId,'x-github-event':event,'x-hub-signature-256':'sha256='+createHmac('sha256','thread-replies-webhook').update(body).digest('hex')},body})).status).toBe(202);
  const delivery=await t.run(ctx=>ctx.db.query('webhookDeliveries').withIndex('by_delivery',q=>q.eq('deliveryId',deliveryId)).unique());
  await t.action(internal.webhookJobs.process,{deliveryId:delivery!._id});
  expect((await t.run(ctx=>ctx.db.get(delivery!._id)))?.status).toBe('completed');
 };
 const replies=async()=>(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('conversationJobs')).map(j=>j.args[0] as {commentId:number;parentCommentId?:number;inline:boolean;question:string});
 return {t,repo,token,reply,replies,request};
}

test('replies without a mention are answered only in OpenReview threads, never for bots, acknowledgements, readers or other threads',async()=>{
 vi.useFakeTimers();
 try{
  const s=await setup();
  await s.reply({id:1,body:'Why is this a problem when the caller checks for null first?',in_reply_to_id:500});
  expect(await s.replies()).toEqual([expect.objectContaining({commentId:1,parentCommentId:500,inline:true})]);
  const calls=s.request.mock.calls.length;
  // A human-started thread and another pull request's OpenReview thread: no answer and no provider call.
  await s.reply({id:2,body:'Should we rename this helper?',in_reply_to_id:999});
  await s.reply({id:3,body:'Is this the same issue as before?',in_reply_to_id:800});
  expect(s.request.mock.calls.length).toBe(calls);
  // Bots (including OpenReview itself), [bot] logins, acknowledgements, read-only users, top-level comments and edits.
  await s.reply({id:4,body:'Answer from the bot itself, which must not loop.',in_reply_to_id:500,login:'openreview[bot]',type:'Bot'});
  await s.reply({id:5,body:'Automated dependency note for this line.',in_reply_to_id:500,login:'renovate[bot]',type:'User'});
  await s.reply({id:6,body:'Thanks, fixed! 👍',in_reply_to_id:500});
  await s.reply({id:7,body:'> quoted text\nok',in_reply_to_id:500});
  await s.reply({id:8,body:'Why does this matter for read-only users?',in_reply_to_id:500,login:'reader'});
  await s.reply({id:9,body:'A new top-level review comment without a thread.'});
  await s.reply({id:1,body:'Edited: why is this a problem?',in_reply_to_id:500},'edited');
  expect((await s.replies()).map(r=>r.commentId)).toEqual([1]);
  // Mentions keep working everywhere, including human-started threads.
  await s.reply({id:10,body:'@openreview what calls this helper?',in_reply_to_id:999});
  expect((await s.replies()).map(r=>r.commentId)).toEqual([1,10]);
 }finally{vi.restoreAllMocks();vi.useRealTimers();}
});

test('the repository setting turns unmentioned replies off while mentions still work',async()=>{
 vi.useFakeTimers();
 try{
  const s=await setup({threadReplies:false});
  await s.reply({id:1,body:'Why is this a problem here?',in_reply_to_id:500});
  expect(s.request).not.toHaveBeenCalled();
  await s.reply({id:2,body:'@openreview why is this a problem here?',in_reply_to_id:500});
  expect((await s.replies()).map(r=>r.commentId)).toEqual([2]);
  expect(defaults.threadReplies).toBe(true);
 }finally{vi.restoreAllMocks();vi.useRealTimers();}
});

test('unmentioned replies are limited per thread and per pull request each hour',async()=>{
 vi.useFakeTimers();
 vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
 try{
  const s=await setup();
  // Three answers per thread: the fourth reply in thread 500 is not answered.
  for(let i=0;i<4;i++)await s.reply({id:100+i,body:'Follow-up question number '+i+'?',in_reply_to_id:500});
  expect((await s.replies()).map(r=>r.commentId)).toEqual([100,101,102]);
  // Ten per pull request: threads 501–507 add seven more and the eighth new thread is refused.
  for(let i=0;i<8;i++)await s.reply({id:200+i,body:'Question about thread '+i+'?',in_reply_to_id:501+i});
  expect((await s.replies()).length).toBe(10);
  expect((await s.replies()).map(r=>r.commentId)).not.toContain(207);
  // A redelivered comment that was already answered is not answered twice.
  await s.t.run(ctx=>ctx.db.insert('conversations',{organizationId:s.repo.organizationId,repositoryId:s.repo._id,prNumber:7,githubCommentId:300,author:'alice',question:'q',inline:true,status:'completed',createdAt:Date.now(),updatedAt:Date.now(),attempts:1}));
  vi.setSystemTime(new Date('2026-10-14T11:30:00Z'));
  await s.reply({id:300,body:'Why is this a problem here?',in_reply_to_id:510});
  expect((await s.replies()).map(r=>r.commentId)).not.toContain(300);
  // A new hour opens the window again.
  await s.reply({id:301,body:'And what about the retry path?',in_reply_to_id:500});
  expect((await s.replies()).map(r=>r.commentId)).toContain(301);
 }finally{vi.restoreAllMocks();vi.useRealTimers();}
});
