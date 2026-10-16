import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHmac} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='billing-session-secret-at-least-32-characters',whsec='whsec_billing_fixture';
const env={SESSION_SECRET:secret,SERVICE_SECRET:'billing-service',BILLING_ENABLED:'true',BILLING_TRIAL_REVIEWS:'2',BILLING_REVIEWS_PER_SEAT:'2',BILLING_GRACE_DAYS:'7',STRIPE_WEBHOOK_SECRET:whsec,STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_SEAT_PRICE_ID:'price_seat',APP_URL:'https://review.example.com'};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,env);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of [...Object.keys(env),'BILLING_TRIAL_DAYS'])if(!['SESSION_SECRET','SERVICE_SECRET'].includes(k))delete process.env[k];});

async function setup(){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'billing-service',githubId,login:name,avatar:''});return {id:id as Id<'users'>,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('120d').sign(new TextEncoder().encode(secret))};};
 const alice=await login(31,'alice'),bob=await login(32,'bob'),vera=await login(33,'vera');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'billing-service',organizationId:org,installationId:31,account:'acme',accountId:1,repositories:[{id:3101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 const members=await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});return {bob:await ctx.db.insert('organizationMembers',{organizationId:org,userId:bob.id,role:'member'}),vera:await ctx.db.insert('organizationMembers',{organizationId:org,userId:vera.id,role:'viewer'})};});
 return {t,alice,bob,vera,org,repo,members};
}
const enqueue=(t:Awaited<ReturnType<typeof setup>>['t'],repositoryId:Id<'repositories'>,pr:number)=>t.mutation(internal.reviews.enqueue,{repositoryId,prNumber:pr,headSha:String(pr).padStart(40,'a'),trigger:'automatic'});
const reviewOf=(t:Awaited<ReturnType<typeof setup>>['t'],id:Id<'reviews'>|null)=>t.run(ctx=>ctx.db.get(id!));
function signed(event:Record<string,unknown>,key=whsec){const body=JSON.stringify(event),ts=Math.floor(Date.now()/1000);return {body,headers:{'content-type':'application/json','stripe-signature':`t=${ts},v1=${createHmac('sha256',key).update(`${ts}.${body}`).digest('hex')}`}};}
const deliver=(t:Awaited<ReturnType<typeof setup>>['t'],event:Record<string,unknown>,key?:string)=>{const {body,headers}=signed(event,key);return t.fetch('/stripe/webhook',{method:'POST',headers,body});};
const subscription=(id:string,type:string,status:string,quantity:number,created:number,org?:string)=>({id,type,created,data:{object:{id:'sub_1',customer:'cus_1',status,metadata:org?{organizationId:org}:{},items:{data:[{id:'si_1',quantity,current_period_end:created+30*86400}]}}}});

test('trial quota is enforced at enqueue; blocked reviews are recorded with the billing reason and counted',async()=>{
 process.env.BILLING_TRIAL_DAYS='60';
 const {t,alice,org,repo}=await setup();
 const first=await enqueue(t,repo._id,1),second=await enqueue(t,repo._id,2),third=await enqueue(t,repo._id,3);
 expect((await reviewOf(t,first))?.status).toBe('queued');expect((await reviewOf(t,second))?.status).toBe('queued');
 expect(await reviewOf(t,third)).toMatchObject({status:'failed',error:'Billing: The trial includes 2 reviews per month. Subscribe in Settings → Billing for more.'});
 // Re-requesting an existing queued head does not count again.
 expect(await enqueue(t,repo._id,1)).toBe(first);
 const status=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(status).toMatchObject({enabled:true,plan:'trial',allowed:false,used:2,limit:2,blocked:1,activeSeats:2});
 // A new month resets the counter; an expired trial blocks regardless.
 vi.setSystemTime(Date.UTC(2026,10,1,0,0,1));
 expect((await reviewOf(t,await enqueue(t,repo._id,4)))?.status).toBe('queued');
 vi.setSystemTime(Date.UTC(2026,11,14));
 expect((await reviewOf(t,await enqueue(t,repo._id,5)))?.error).toMatch(/free trial has ended/);
});

test('the trial starts with the first review, so workspaces created before billing get the full trial',async()=>{
 const {t,alice,org,repo}=await setup();
 // A month after the workspace was created, nothing has been billed yet: the trial has not started.
 vi.setSystemTime(Date.UTC(2026,10,14,12));
 const before=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(before).toMatchObject({plan:'trial',allowed:true,trialStarted:false,trialDays:14,trialEndsAt:Date.now()+14*86400000});
 expect((await reviewOf(t,await enqueue(t,repo._id,1)))?.status).toBe('queued');
 const started=await t.query(api.billing.status,{token:alice.token,organizationId:org});
 expect(started).toMatchObject({trialStarted:true,trialEndsAt:Date.UTC(2026,10,28,12),used:1});
 vi.setSystemTime(Date.UTC(2026,10,28,12));
 expect((await reviewOf(t,await enqueue(t,repo._id,2)))?.error).toMatch(/free trial has ended/);
});

test('switching Stripe modes resets every workspace to its trial without losing the trial date',async()=>{
 const {t,alice,org,repo}=await setup();
 const created=Math.floor(Date.now()/1000);
 await deliver(t,{id:'evt_checkout_test',type:'checkout.session.completed',created,data:{object:{mode:'subscription',client_reference_id:org,customer:'cus_1',subscription:'sub_1'}}});
 await deliver(t,subscription('evt_sub_test','customer.subscription.created','trialing',1,created+1,org));
 const before=(await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0];
 expect(before).toMatchObject({customerId:'cus_1',status:'trialing'});
 await expect(t.mutation(internal.billing.resetStripeLinks,{confirm:'yes' as 'reset-stripe-links'})).rejects.toThrow();
 expect(await t.mutation(internal.billing.resetStripeLinks,{confirm:'reset-stripe-links'})).toBe(1);
 const after=(await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0];
 expect(after).toMatchObject({status:'trial',trialEndsAt:before.trialEndsAt});
 for(const key of ['customerId','subscriptionId','subscriptionItemId','currentPeriodEnd','pastDueSince','lastEventCreated'])expect(after).not.toHaveProperty(key);
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({plan:'trial',hasCustomer:false,billedSeats:null});
 // Reviews follow the trial again, and a new checkout can link a customer from the new mode.
 expect((await reviewOf(t,await enqueue(t,repo._id,1)))?.status).toBe('queued');
 await deliver(t,{id:'evt_checkout_live',type:'checkout.session.completed',created:created+5,data:{object:{mode:'subscription',client_reference_id:org,customer:'cus_live',subscription:'sub_live'}}});
 expect((await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0]).toMatchObject({customerId:'cus_live',subscriptionId:'sub_live'});
});

test('without BILLING_ENABLED nothing is enforced and the webhook endpoint does not exist',async()=>{
 delete process.env.BILLING_ENABLED;
 const {t,alice,org,repo}=await setup();
 for(let pr=1;pr<=4;pr++)expect((await reviewOf(t,await enqueue(t,repo._id,pr)))?.status).toBe('queued');
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toEqual({enabled:false});
 expect((await deliver(t,subscription('evt_off','customer.subscription.updated','active',1,1))).status).toBe(404);
 expect(await t.run(ctx=>ctx.db.query('billingAccounts').collect())).toEqual([]);
});

test('signed Stripe webhooks link the workspace, apply once, and ignore replays and out-of-order events',async()=>{
 const {t,alice,org,repo}=await setup();
 const created=Math.floor(Date.now()/1000);
 const bad=signed({id:'evt_x',type:'invoice.paid',created,data:{object:{customer:'cus_1'}}});
 expect((await t.fetch('/stripe/webhook',{method:'POST',headers:bad.headers,body:bad.body+' '})).status).toBe(401);
 expect((await deliver(t,{id:'evt_x',type:'invoice.paid',created,data:{object:{customer:'cus_1'}}},'whsec_wrong')).status).toBe(401);
 const checkout={id:'evt_checkout',type:'checkout.session.completed',created,data:{object:{mode:'subscription',client_reference_id:org,customer:'cus_1',subscription:'sub_1'}}};
 expect((await deliver(t,checkout)).status).toBe(200);
 expect((await deliver(t,checkout)).status).toBe(200);
 const outcomes=async()=>(await t.run(ctx=>ctx.db.query('stripeEvents').collect())).map(e=>[e.eventId,e.outcome]);
 expect(await outcomes()).toEqual([['evt_checkout','linked']]);
 await deliver(t,subscription('evt_sub_new','customer.subscription.updated','active',3,created+20,org));
 await deliver(t,subscription('evt_sub_old','customer.subscription.created','incomplete',1,created+10,org));
 await deliver(t,subscription('evt_sub_new','customer.subscription.updated','active',3,created+20,org));
 expect(await outcomes()).toEqual([['evt_checkout','linked'],['evt_sub_new','active'],['evt_sub_old','stale']]);
 expect(await t.run(ctx=>ctx.db.query('billingAccounts').collect())).toEqual([expect.objectContaining({organizationId:org,customerId:'cus_1',subscriptionId:'sub_1',subscriptionItemId:'si_1',status:'active',seats:3})]);
 // Starter plan: unlimited under a fair-use limit of 3 seats × 2 reviews.
 for(let pr=1;pr<=6;pr++)expect((await reviewOf(t,await enqueue(t,repo._id,pr)))?.status).toBe('queued');
 expect((await reviewOf(t,await enqueue(t,repo._id,7)))?.error).toMatch(/fair-use limit of 6 reviews this month \(2 per seat\)/);
 expect(await t.query(api.billing.status,{token:alice.token,organizationId:org})).toMatchObject({plan:'starter',limit:6,used:6});
 // A subscription for another workspace cannot hijack this customer.
 await deliver(t,subscription('evt_spoof','customer.subscription.updated','active',99,created+30,'k57abc0000000000000000organizations'));
 expect((await t.run(ctx=>ctx.db.query('billingAccounts').collect()))[0].seats).toBe(3);
 // Payment failure: reviews continue through the grace period, then pause; payment restores them.
 vi.setSystemTime(Date.UTC(2026,10,2));
 // Current API versions put the invoice's subscription under parent.subscription_details.
 await deliver(t,{id:'evt_failed',type:'invoice.payment_failed',created:Math.floor(Date.now()/1000),data:{object:{customer:'cus_1',parent:{subscription_details:{subscription:'sub_1'}}}}});
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:org})).status).toBe('past_due');
 vi.setSystemTime(Date.UTC(2026,10,8));
 expect((await reviewOf(t,await enqueue(t,repo._id,8)))?.status).toBe('queued');
 vi.setSystemTime(Date.UTC(2026,10,9,1));
 expect((await reviewOf(t,await enqueue(t,repo._id,9)))?.error).toMatch(/past due and the grace period has ended/);
 await deliver(t,{id:'evt_paid',type:'invoice.paid',created:Math.floor(Date.now()/1000),data:{object:{customer:'cus_1',subscription:'sub_1'}}});
 expect((await reviewOf(t,await enqueue(t,repo._id,10)))?.status).toBe('queued');
 // Cancellation falls back to the (expired) trial.
 await deliver(t,subscription('evt_cancel','customer.subscription.deleted','canceled',3,Math.floor(Date.now()/1000),org));
 expect((await reviewOf(t,await enqueue(t,repo._id,11)))?.error).toMatch(/free trial has ended/);
});

test('seats follow membership: viewers are free and changes resync the subscription quantity',async()=>{
 const {t,alice,bob,org,members}=await setup();
 const calls:{url:string;body:string;key:string|null}[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push({url,body:String(init?.body),key:new Headers(init?.headers).get('idempotency-key')});
  if(url.endsWith('/v1/customers'))return Response.json({id:'cus_1'});
  if(url.endsWith('/v1/checkout/sessions'))return Response.json({id:'cs_1',url:'https://checkout.stripe.com/c/pay/cs_1'});
  if(url.endsWith('/v1/billing_portal/sessions'))return Response.json({url:'https://billing.stripe.com/p/session_1'});
  if(url.includes('/v1/subscriptions/'))return Response.json({id:'sub_1'});
  return new Response('unexpected',{status:500});});
 await expect(t.action(api.billingJobs.checkout,{token:bob.token,organizationId:org})).rejects.toThrow(/Forbidden/);
 expect(await t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org})).toBe('https://checkout.stripe.com/c/pay/cs_1');
 const session=new URLSearchParams(calls[1].body);
 // The untouched 14-day trial carries into the subscription, so the card is not charged until it ends.
 expect(Object.fromEntries(session)).toMatchObject({mode:'subscription',customer:'cus_1',client_reference_id:org,integration_identifier:expect.stringMatching(/^openreview-starter-seats-[a-z]{8}$/),'line_items[0][price]':'price_seat','line_items[0][quantity]':'2','subscription_data[metadata][organizationId]':org,'subscription_data[trial_end]':String(Math.floor((Date.now()+14*86400000)/1000)),success_url:'https://review.example.com/dashboard/settings/billing?checkout=success',cancel_url:'https://review.example.com/dashboard/settings/billing?checkout=cancelled'});
 expect(session.has('payment_method_types')).toBe(false);
 // From guided setup, Checkout returns to the plan step.
 await t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org,returnTo:'onboarding'});
 expect(Object.fromEntries(new URLSearchParams(calls.at(-1)!.body))).toMatchObject({success_url:'https://review.example.com/dashboard/onboarding/plan?checkout=success',cancel_url:'https://review.example.com/dashboard/onboarding/plan?checkout=cancelled'});
 expect(calls[0].key).toBe(`customer:${org}`);
 expect(await t.action(api.billingJobs.portal,{token:alice.token,organizationId:org})).toBe('https://billing.stripe.com/p/session_1');
 await deliver(t,subscription('evt_sub','customer.subscription.created','active',2,Math.floor(Date.now()/1000),org));
 // Promoting the viewer adds a billed seat; the sync job updates Stripe once.
 await t.mutation(api.team.update,{token:alice.token,memberId:members.vera,role:'member',remove:false});
 const jobs=(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('billingJobs:syncSeats'));
 expect(jobs).toHaveLength(1);
 expect(await t.action(internal.billingJobs.syncSeats,{organizationId:org})).toBe('updated');
 const update=calls.at(-1)!;
 expect(update.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
 expect(Object.fromEntries(new URLSearchParams(update.body))).toEqual({'items[0][id]':'si_1','items[0][quantity]':'3',proration_behavior:'create_prorations'});
 expect((await t.query(api.billing.status,{token:alice.token,organizationId:org})).activeSeats).toBe(3);
 await expect(t.action(api.billingJobs.checkout,{token:alice.token,organizationId:org})).rejects.toThrow(/already has a subscription/);
 // Live keys are refused unless explicitly allowed.
 process.env.STRIPE_SECRET_KEY='sk_live_x';
 await expect(t.action(api.billingJobs.portal,{token:alice.token,organizationId:org})).rejects.toThrow(/test-mode key/);
});
