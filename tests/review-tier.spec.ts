import {afterEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHmac} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {defaults} from '../src/review-settings';
import {Github} from '../src/github';
const modules=import.meta.glob('../convex/**/*.ts');
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function setup(settings:Partial<typeof defaults>={}){
 process.env.SESSION_SECRET='tier-session-secret-at-least-32-characters';process.env.SERVICE_SECRET='tier-service';process.env.GITHUB_WEBHOOK_SECRET='tier-webhook';
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'tier-service',githubId:95,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Tiers'});
 await t.mutation(api.repositories.connect,{token,secret:'tier-service',organizationId,installationId:95,account:'alice',accountId:1,repositories:[{id:9595,fullName:'alice/tiers',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 await t.mutation(api.repositories.configure,{token,repositoryId:repo._id,enabled:true,settings:{...defaults,...settings}});
 const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
 vi.spyOn(scm,'changeMetadata').mockImplementation(async(_r,number)=>({number,title:'Change',body:'',draft:false,state:'open',html_url:'https://github.com/alice/tiers/pull/'+number,user:{login:'alice'},head:{sha:'c'.repeat(40),ref:'feature'},base:{sha:'a'.repeat(40),ref:'main'}}) as never);
 let n=0;
 const deliver=async(event:string,body:Record<string,unknown>)=>{
  const deliveryId='tier-'+(++n),text=JSON.stringify({installation:{id:95},repository:{id:9595,full_name:'alice/tiers',default_branch:'main'},...body});
  expect((await t.fetch('/github/webhook',{method:'POST',headers:{'x-github-delivery':deliveryId,'x-github-event':event,'x-hub-signature-256':'sha256='+createHmac('sha256','tier-webhook').update(text).digest('hex')},body:text})).status).toBe(202);
  const delivery=await t.run(ctx=>ctx.db.query('webhookDeliveries').withIndex('by_delivery',q=>q.eq('deliveryId',deliveryId)).unique());
  await t.action(internal.webhookJobs.process,{deliveryId:delivery!._id});
 };
 const pr=(labels:string[],extra:Record<string,unknown>={})=>({number:7,draft:false,state:'open',head:{sha:'c'.repeat(40),ref:'feature'},base:{ref:'main'},user:{login:'alice'},labels:labels.map(name=>({name})),...extra});
 return {t,repo,deliver,pr,reviews:()=>t.run(ctx=>ctx.db.query('reviews').collect())};
}

test('an openreview:<tier> label requests that tier and starts a review even with automatic reviews off',async()=>{
 vi.useFakeTimers();
 const s=await setup({automatic:false});
 await s.deliver('pull_request',{action:'opened',pull_request:s.pr([])});
 expect(await s.reviews()).toHaveLength(0);
 await s.deliver('pull_request',{action:'labeled',label:{name:'openreview:deep'},pull_request:s.pr(['openreview:deep'])});
 const [review]=await s.reviews();
 expect(review).toMatchObject({prNumber:7,trigger:'label',requestedMode:'deep',requestedModeSource:'label'});
});

test('automatic reviews of a labelled PR carry the label tier; unlabelled PRs request nothing',async()=>{
 vi.useFakeTimers();
 const s=await setup();
 await s.deliver('pull_request',{action:'opened',pull_request:s.pr(['bug','openreview:fast'])});
 expect((await s.reviews())[0]).toMatchObject({trigger:'automatic',requestedMode:'fast',requestedModeSource:'label'});
 const plain=await setup();
 await plain.deliver('pull_request',{action:'opened',pull_request:plain.pr([])});
 expect((await plain.reviews())[0].requestedMode).toBeUndefined();
});

test('"@openreview review deep" from a writer enqueues a deep request and says so',async()=>{
 vi.useFakeTimers();
 const s=await setup();
 const reviewId=await s.t.mutation(internal.conversations.requestReview,{repositoryId:s.repo._id,prNumber:7,commentId:41,author:'alice',question:'@openreview review deep',headSha:'c'.repeat(40)});
 expect(await s.t.run(ctx=>ctx.db.get(reviewId!))).toMatchObject({trigger:'mention',requestedMode:'deep',requestedModeSource:'comment'});
 const conversation=await s.t.run(ctx=>ctx.db.query('conversations').first());
 expect(conversation?.answer).toBe('Requested a new deep review of the current revision.');
 const security=await s.t.mutation(internal.conversations.requestReview,{repositoryId:s.repo._id,prNumber:7,commentId:42,author:'alice',question:'@openreview review security',headSha:'c'.repeat(40)});
 expect(await s.t.run(ctx=>ctx.db.get(security!))).toMatchObject({category:'security'});
 expect((await s.t.run(ctx=>ctx.db.get(security!)))?.requestedMode).toBeUndefined();
});
