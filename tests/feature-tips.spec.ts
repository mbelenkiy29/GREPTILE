import {test,expect,vi,afterEach} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {defaults} from '../src/review-settings';
const modules=import.meta.glob('../convex/**/*.ts');
afterEach(()=>{vi.useRealTimers();delete process.env.BILLING_ENABLED;});
async function setup(){
 process.env.SERVICE_SECRET='tips-service';process.env.SESSION_SECRET='tips-session-secret-at-least-32-characters';
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'tips-service',githubId:61,login:'tips',avatar:''});
 const token=await new SignJWT({}).setSubject(userId).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Tips'});
 await t.mutation(api.repositories.connect,{token,secret:'tips-service',organizationId,installationId:61,account:'tips',accountId:1,repositories:[{id:610,fullName:'tips/repo',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 const review=()=>t.run(ctx=>ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:1,headSha:'a'.repeat(40),status:'publishing',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()}));
 const choose=(reviewId:Awaited<ReturnType<typeof review>>,signals:Partial<{references:string;rules:number;strictness:number;engine:string;agenticAvailable:boolean}>={})=>t.mutation(internal.featureTips.choose,{reviewId,references:'Refactor totals',rules:0,strictness:0,engine:'pipeline',agenticAvailable:true,...signals});
 return {t,token,repo,organizationId,review,choose};
}
const day=86_400_000;

test('one tip per review, reused on retry, with a per-repository cooldown and no monthly repeats',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
 const s=await setup();
 const first=await s.review();
 expect(await s.choose(first)).toEqual({key:'rules'});
 expect(await s.choose(first,{rules:5})).toEqual({key:'rules'}); // a publish retry shows the same tip
 // Within three days no other review gets a tip.
 vi.setSystemTime(new Date('2026-10-03T09:00:00Z'));
 expect(await s.choose(await s.review())).toBeNull();
 // After the cooldown the next eligible tip is chosen, never the one shown within 30 days.
 vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));
 expect(await s.choose(await s.review())).toEqual({key:'agentic'});
 vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
 expect(await s.choose(await s.review())).toBeNull(); // only rules and agentic are eligible; both shown this month
 vi.setSystemTime(new Date(Date.parse('2026-10-01T09:00:00Z')+31*day));
 expect(await s.choose(await s.review())).toEqual({key:'rules'});
 expect(await s.t.run(ctx=>ctx.db.query('featureTips').collect())).toHaveLength(3);
});

test('tips use stored signals: dismissed findings suggest strictness, connected trackers suppress the ticket tip',async()=>{
 const s=await setup();
 await s.t.run(async ctx=>{
  const reviewId=await ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.repo._id,prNumber:9,headSha:'b'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  for(let i=0;i<12;i++)await ctx.db.insert('findings',{organizationId:s.organizationId,repositoryId:s.repo._id,reviewId,prNumber:9,title:'Finding '+i,description:'d',severity:'medium',confidence:.9,category:'correctness',filePath:'a.ts',startLine:1,endLine:1,commitSha:'b'.repeat(40),evidence:[],impact:'i',suggestedFix:'f',agent:'correctness',symbol:'s',fingerprint:'fp'+i,status:'open',lastFeedback:i<7?'false_positive':'useful',createdAt:Date.now(),updatedAt:Date.now()});
  await ctx.db.insert('integrationConnections',{organizationId:s.organizationId,kind:'linear',externalId:'lin',name:'Linear',credentials:'x',expiresAt:Date.now()+day,active:true,generation:1,teamIds:[],projectIds:[],repositoryIds:[],createdAt:Date.now()});
 });
 expect(await s.choose(await s.review(),{references:'Fixes https://linear.app/acme/issue/ENG-1 and ENG-2',rules:3,engine:'agentic'})).toEqual({key:'strictness'});
 const other=await setup();
 expect(await other.choose(await other.review(),{references:'Fixes https://acme.atlassian.net/browse/SHOP-7',rules:3})).toEqual({key:'ticket',ticket:'jira'});
});

test('effective settings include Feature tips by default only on the hosted cloud; saved section lists are respected',async()=>{
 const s=await setup();
 expect((await s.t.query(api.settings.repository,{token:s.token,repositoryId:s.repo._id})).settings.summarySections).not.toContain('tips');
 process.env.BILLING_ENABLED='true';
 expect((await s.t.query(api.settings.repository,{token:s.token,repositoryId:s.repo._id})).settings.summarySections).toContain('tips');
 // An explicitly saved repository list (without tips) wins over the deployment default.
 await s.t.mutation(api.repositories.configure,{token:s.token,repositoryId:s.repo._id,enabled:true,settings:{...defaults}});
 const saved=await s.t.run(ctx=>ctx.db.query('repositorySettings').withIndex('by_repo',q=>q.eq('repositoryId',s.repo._id)).unique());
 expect(saved?.inherit).toBe(false);
 expect((await s.t.query(api.settings.repository,{token:s.token,repositoryId:s.repo._id})).settings.summarySections).not.toContain('tips');
});
