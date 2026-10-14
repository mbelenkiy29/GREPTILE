import {beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {Github} from '../src/github';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';});

async function setup(){
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId:95,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Reactions'});
 await t.mutation(api.repositories.connect,{token,secret:'integration-service-secret',organizationId,installationId:95,account:'alice',accountId:1,repositories:[{id:9595,fullName:'alice/reactions',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const ids=await t.run(async ctx=>{
  const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:3,headSha:'h'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  const finding=(fingerprint:string,title:string)=>ctx.db.insert('findings',{organizationId,repositoryId:repo._id,reviewId,prNumber:3,title,description:'A concrete defect description.',severity:'high',confidence:0.95,category:'correctness',filePath:'a.ts',startLine:1,endLine:1,commitSha:'h'.repeat(40),evidence:[{filePath:'a.ts',startLine:1,quote:'x'}],impact:'impact',suggestedFix:'fix it',symbol:'s',fingerprint,agent:'correctness',status:'open',createdAt:Date.now(),updatedAt:Date.now()});
  const first=await finding('fp1','Totals become dollars'),second=await finding('fp2','Rounding drops cents');
  await ctx.db.insert('reviewComments',{organizationId,reviewId,githubId:10,fingerprint:'fp1',createdAt:0});
  await ctx.db.insert('reviewComments',{organizationId,reviewId,githubId:11,fingerprint:'fp2',createdAt:0});
  await ctx.db.insert('reviewComments',{organizationId,reviewId,githubId:12,createdAt:0});
  await ctx.db.insert('pullRequests',{organizationId,repositoryId:repo._id,number:3,title:'Totals',author:'bob',url:'https://github.com/alice/reactions/pull/3',headSha:'h'.repeat(40),baseSha:'b'.repeat(40),state:'open',updatedAt:Date.now()} as never);
  return {first,second};
 });
 return {t,token,organizationId,repo,...ids};
}

test('reactions mirror the provider state, dedupe, and become feedback once per user',async()=>{
 const {t,repo,first,second}=await setup();
 const targets=await t.query(internal.reactions.targets,{repositoryId:repo._id,prNumber:3});
 expect(targets.map(x=>x.commentId).sort()).toEqual(['10','11']);
 const now=Date.now(),observed=[{commentId:'10',user:'carol',reaction:'+1' as const,createdAt:now},{commentId:'10',user:'dave',reaction:'-1' as const,createdAt:now},{commentId:'11',user:'dave',reaction:'-1' as const,createdAt:now},{commentId:'11',user:'erin',reaction:'+1' as const,createdAt:now},{commentId:'11',user:'erin',reaction:'-1' as const,createdAt:now}];
 expect(await t.mutation(internal.reactions.apply,{repositoryId:repo._id,prNumber:3,provider:'github',targets,observed})).toEqual({added:5,removed:0});
 expect(await t.mutation(internal.reactions.apply,{repositoryId:repo._id,prNumber:3,provider:'github',targets,observed})).toEqual({added:0,removed:0});
 const feedback=await t.run(ctx=>ctx.db.query('findingFeedback').collect());
 expect(feedback.map(f=>[f.findingId===first?'first':'second',f.githubLogin,f.value]).sort()).toEqual([['first','carol','useful'],['first','dave','not_useful'],['second','dave','not_useful']]);
 expect((await t.run(ctx=>ctx.db.get(second)))?.lastFeedback).toBe('not_useful');
 const preference=await t.run(ctx=>ctx.db.query('learnedPreferences').withIndex('by_source',q=>q.eq('repositoryId',repo._id).eq('source',second)).first());
 expect(preference?.instruction).toMatch(/Avoid repeating this not_useful finding pattern: Rounding drops cents/);
 // A removed reaction disappears from the mirror; recorded feedback history stays.
 expect(await t.mutation(internal.reactions.apply,{repositoryId:repo._id,prNumber:3,provider:'github',targets,observed:observed.filter(o=>o.user!=='dave')})).toEqual({added:0,removed:2});
 expect(await t.run(ctx=>ctx.db.query('commentReactions').collect())).toHaveLength(3);
 expect(await t.run(ctx=>ctx.db.query('findingFeedback').collect())).toHaveLength(3);
 expect((await t.run(ctx=>ctx.db.query('pullRequests').collect()))[0].reactionsSyncedAt).toBeGreaterThan(0);
});

test('sync polls GitHub for OpenReview finding comments only; sweep selects open PRs not synced in the last hour',async()=>{
 vi.useFakeTimers();
 try{
  const {t,repo}=await setup();
  expect(await t.query(internal.reactions.due,{limit:25})).toEqual([{repositoryId:repo._id,prNumber:3}]);
  const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
  const polled=vi.spyOn(scm,'reactions').mockResolvedValue([{commentId:'10',user:'carol',reaction:'+1',createdAt:Date.now()}]);
  expect(await t.action(internal.reactionJobs.sync,{repositoryId:repo._id,prNumber:3})).toEqual({added:1,removed:0});
  expect(polled.mock.calls[0][1].sort()).toEqual([10,11]);
  expect(await t.query(internal.reactions.due,{limit:25})).toEqual([]);
  await t.run(async ctx=>{const pr=(await ctx.db.query('pullRequests').collect())[0];await ctx.db.patch(pr._id,{reactionsSyncedAt:Date.now()-2*3600000});});
  expect(await t.query(internal.reactions.due,{limit:25})).toHaveLength(1);
  await t.run(async ctx=>{const pr=(await ctx.db.query('pullRequests').collect())[0];await ctx.db.patch(pr._id,{state:'closed'});});
  expect(await t.query(internal.reactions.due,{limit:25})).toEqual([]);
 }finally{vi.restoreAllMocks();vi.useRealTimers();}
});

test('GitLab emoji awards and revocations update reactions for finding notes only',async()=>{
 const {t,repo}=await setup();
 expect(await t.mutation(internal.reactions.emoji,{repositoryId:repo._id,prNumber:3,noteId:'11',user:'frank',reaction:'-1',award:true})).toBe(true);
 expect(await t.mutation(internal.reactions.emoji,{repositoryId:repo._id,prNumber:3,noteId:'11',user:'frank',reaction:'-1',award:true})).toBe(true);
 expect(await t.run(ctx=>ctx.db.query('commentReactions').collect())).toHaveLength(1);
 expect((await t.run(ctx=>ctx.db.query('findingFeedback').collect())).map(f=>f.value)).toEqual(['not_useful']);
 await t.mutation(internal.reactions.emoji,{repositoryId:repo._id,prNumber:3,noteId:'11',user:'frank',reaction:'-1',award:false});
 expect(await t.run(ctx=>ctx.db.query('commentReactions').collect())).toHaveLength(0);
 expect(await t.mutation(internal.reactions.emoji,{repositoryId:repo._id,prNumber:3,noteId:'12',user:'frank',reaction:'+1',award:true})).toBe(false);
});

test('analytics aggregates reaction counts for visible repositories in the period',async()=>{
 const {t,token,organizationId,repo}=await setup();
 const targets=await t.query(internal.reactions.targets,{repositoryId:repo._id,prNumber:3});
 await t.mutation(internal.reactions.apply,{repositoryId:repo._id,prNumber:3,provider:'github',targets,observed:[{commentId:'10',user:'a',reaction:'+1',createdAt:Date.now()},{commentId:'10',user:'b',reaction:'+1',createdAt:Date.now()},{commentId:'11',user:'c',reaction:'-1',createdAt:Date.now()},{commentId:'11',user:'d',reaction:'-1',createdAt:Date.now()-40*86400000}]});
 const report=await t.query(api.analytics.report,{token,organizationId,since:Date.now()-7*86400000,until:Date.now()+1000});
 expect(report.reactions).toEqual({up:2,down:1});
});
