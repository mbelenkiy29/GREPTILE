import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {defaults} from '../src/review-settings';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='pr-replies-session-secret-at-least-32-chars';
const env={SESSION_SECRET:secret,SERVICE_SECRET:'pr-replies-service',BILLING_ENABLED:'true',BILLING_TRIAL_REVIEWS:'1',BILLING_REVIEWS_PER_SEAT:'2',BILLING_GRACE_DAYS:'7',BILLING_TRIAL_DAYS:'60',APP_URL:'https://review.example.com'};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,16,12));Object.assign(process.env,env);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of Object.keys(env))if(!['SESSION_SECRET','SERVICE_SECRET'].includes(k))delete process.env[k];});

async function setup(){
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:'pr-replies-service',githubId:41,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1d').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token,secret:'pr-replies-service',organizationId,installationId:41,account:'acme',accountId:1,repositories:[{id:4101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 return {t,token,organizationId,repo};
}
const scheduled=(t:Awaited<ReturnType<typeof setup>>['t'])=>t.run(async ctx=>(await ctx.db.system.query('_scheduled_functions').collect()).map(s=>({name:s.name,args:s.args[0] as Record<string,unknown>})));

test('a review the plan blocks schedules one pull request notice for GitHub activity, never for dashboard requests',async()=>{
 const {t,repo}=await setup();
 const enqueue=(pr:number,trigger:'automatic'|'mention'|'manual')=>t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:pr,headSha:String(pr).padStart(40,'a'),trigger});
 await enqueue(1,'automatic');
 const blocked=await enqueue(2,'automatic');
 expect(await t.run(ctx=>ctx.db.get(blocked!))).toMatchObject({status:'failed'});
 await enqueue(3,'manual');
 await enqueue(4,'mention');
 const notices=(await scheduled(t)).filter(s=>/billingNotice/.test(s.name));
 expect(notices.map(n=>n.args.prNumber).sort()).toEqual([2,4]);
 expect(notices.every(n=>n.args.repositoryId===repo._id)).toBe(true);
});

test('an @openreview review request remembers its comment so the published review can confirm it',async()=>{
 delete process.env.BILLING_ENABLED;
 const {t,repo}=await setup();
 const reviewId=await t.mutation(internal.conversations.requestReview,{repositoryId:repo._id,prNumber:7,commentId:991,author:'alice',question:'@openreview review',headSha:'b'.repeat(40),triggerComment:{id:991,inline:true}});
 expect(await t.run(ctx=>ctx.db.get(reviewId as Id<'reviews'>))).toMatchObject({trigger:'mention',triggerComment:{id:991,inline:true},status:'queued'});
 const plain=await t.mutation(internal.reviews.enqueue,{repositoryId:repo._id,prNumber:8,headSha:'c'.repeat(40),trigger:'automatic'});
 expect((await t.run(ctx=>ctx.db.get(plain!)))?.triggerComment).toBeUndefined();
});

test('summary placement and the check run minimum score are validated wherever settings are saved',async()=>{
 const {t,token,organizationId,repo}=await setup();
 for(const bad of [{summaryPlacement:'sidebar'},{checkMinimumScore:6},{checkMinimumScore:2.5},{checkMinimumScore:-1}]){
  await expect(t.mutation(api.scopes.save,{token,organizationId,settings:{...defaults,...bad},overrideKeys:Object.keys(bad)})).rejects.toThrow('Invalid settings');
  await expect(t.mutation(api.repositories.configure,{token,repositoryId:repo._id,enabled:true,settings:{...defaults,...bad}})).rejects.toThrow('Invalid review settings');
 }
 await t.mutation(api.repositories.configure,{token,repositoryId:repo._id,enabled:true,settings:{...defaults,summaryPlacement:'comment',checkMinimumScore:4}});
 await t.mutation(api.scopes.save,{token,organizationId,settings:{...defaults,summaryPlacement:'comment',checkMinimumScore:3},overrideKeys:['summaryPlacement','checkMinimumScore']});
 expect(defaults).toMatchObject({summaryPlacement:'description',checkMinimumScore:0});
});
