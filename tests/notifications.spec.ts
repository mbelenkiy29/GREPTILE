import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,createHmac} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {encryptCredential} from '../src/credentials';
import {HttpModel} from '../src/engine/model';
import type {Id} from '../convex/_generated/dataModel';
import type {ToolCall,ToolRequest,ToolTurn} from '../src/engine/types';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters',signing='slack-signing-secret-fixture',head='f'.repeat(40);
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'integration-service-secret',LLM_API_KEY:'fixture',CREDENTIAL_ENCRYPTION_KEY:'credential-encryption-key-at-least-32-chars',SLACK_SIGNING_SECRET:signing,APP_URL:'https://review.example.com'});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of ['RESEND_API_KEY','EMAIL_FROM','SLACK_CLIENT_ID','SLACK_CLIENT_SECRET'])delete process.env[k];});

type Sent={url:string;body:Record<string,unknown>};
function fakeNetwork(){
 const sent:Sent[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input),raw=String(init?.body??'');
  const body=url.includes('oauth.v2.access')?Object.fromEntries(new URLSearchParams(raw)):raw?JSON.parse(raw):{};
  sent.push({url,body});
  if(url==='https://slack.com/api/oauth.v2.access')return Response.json({ok:true,access_token:'xoxb-secret-bot-token',bot_user_id:'U0BOT1234',team:{id:'T0ACME123',name:'Acme Slack'},scope:'app_mentions:read,chat:write,commands'});
  if(url.startsWith('https://slack.com/api/'))return Response.json({ok:true,ts:'1700000000.000100'});
  if(url==='https://api.resend.com/emails')return Response.json({id:'email_'+sent.length});
  return new Response('unexpected '+url,{status:500});
 });
 return sent;
}
async function setup(){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId,login:name,avatar:''});return {id:id as Id<'users'>,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const alice=await login(81,'alice'),bob=await login(82,'bob'),carol=await login(83,'carol'),dave=await login(84,'dave');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'integration-service-secret',organizationId:org,installationId:81,account:'acme',accountId:1,repositories:[{id:8101,fullName:'acme/shop',defaultBranch:'main'},{id:8102,fullName:'acme/billing',defaultBranch:'main'}]});
 const repos=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 const [shop,billing]=['acme/shop','acme/billing'].map(n=>repos.find(r=>r.fullName===n)!);
 const ids=await t.run(async ctx=>{
  const teamId=await ctx.db.insert('teams',{organizationId:org,name:'Billing',createdAt:0});
  await ctx.db.patch(billing._id,{teamId});
  for(const u of [bob,carol,dave])await ctx.db.insert('organizationMembers',{organizationId:org,userId:u.id,role:'member'});
  for(const r of [shop,billing]){await ctx.db.patch(r._id,{enabled:true,indexStatus:'ready',indexedSha:head});
   const content='export function total(cents: number, qty: number) {\n  return cents * qty;\n}\n';
   await ctx.db.insert('repositoryFiles',{organizationId:org,repositoryId:r._id,path:'src/cart.ts',sha:'blob',storageId:await ctx.storage.store(new Blob([content])),language:'typescript',updatedAt:0});
   await ctx.db.insert('codeChunks',{organizationId:org,repositoryId:r._id,filePath:'src/cart.ts',startLine:1,content});}
  await ctx.db.insert('pullRequests',{organizationId:org,repositoryId:shop._id,number:7,title:'Totals in cents',author:'bob',url:'https://github.com/acme/shop/pull/7',headSha:head,baseSha:'b'.repeat(40),state:'open',updatedAt:0} as never);
  const reviewId=await ctx.db.insert('reviews',{organizationId:org,repositoryId:shop._id,prNumber:7,headSha:head,status:'running',mode:'standard',attempts:1,createdAt:0,updatedAt:0});
  const snapshot={title:'Totals become dollars',description:'d',impact:'i',severity:'high',confidence:0.9,category:'correctness',filePath:'src/cart.ts',startLine:2,endLine:2,commitSha:head,evidence:[{filePath:'src/cart.ts',startLine:2,quote:'  return cents * qty;'}],suggestedFix:'f',agent:'correctness',symbol:'total',fingerprint:'fp01'};
  const findingId=await ctx.db.insert('findings',{...snapshot,organizationId:org,repositoryId:shop._id,reviewId,prNumber:7,status:'open',createdAt:0,updatedAt:0});
  await ctx.db.insert('reviewFindings',{reviewId,findingId,snapshot});
  return {reviewId,teamId};
 });
 return {t,alice,bob,carol,dave,org,shop,billing,...ids};
}
async function installSlack(t:Awaited<ReturnType<typeof setup>>['t'],org:Id<'organizations'>,installedBy:Id<'users'>){
 return t.run(ctx=>ctx.db.insert('slackInstallations',{organizationId:org,teamId:'T0ACME123',teamName:'Acme Slack',botUserId:'U0BOT1234',credentials:encryptCredential('xoxb-secret-bot-token',`${org}:slack`),installedBy,active:true,createdAt:0,updatedAt:0}));
}
async function verify(t:Awaited<ReturnType<typeof setup>>['t'],org:Id<'organizations'>,user:Id<'users'>,email:string,levels:{reviewCompleted:string;highSeverity:string}){
 await t.run(ctx=>ctx.db.insert('notificationPreferences',{organizationId:org,userId:user,email,emailVerifiedAt:1,...levels,updatedAt:0}));
}
const slackPosts=(sent:Sent[])=>sent.filter(s=>s.url==='https://slack.com/api/chat.postMessage');
const emails=(sent:Sent[])=>sent.filter(s=>s.url==='https://api.resend.com/emails');

test('a completed review fans out to matching Slack channels and opted-in verified members, exactly once',async()=>{
 const {t,alice,bob,carol,dave,org,shop,billing,reviewId}=await setup();
 process.env.RESEND_API_KEY='re_fixture';process.env.EMAIL_FROM='OpenReview <noreply@example.com>';
 await installSlack(t,org,alice.id);
 await t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[shop._id],events:['review.completed','finding.high'],qa:false});
 await t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0ALL00001',repositoryIds:[],events:['finding.high'],qa:false});
 await t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0BILL0001',repositoryIds:[billing._id],events:['review.completed'],qa:false});
 await verify(t,org,alice.id,'alice@example.com',{reviewCompleted:'all',highSeverity:'off'});
 await verify(t,org,bob.id,'bob@example.com',{reviewCompleted:'off',highSeverity:'mine'});
 await verify(t,org,dave.id,'dave@example.com',{reviewCompleted:'mine',highSeverity:'off'});
 await t.run(ctx=>ctx.db.insert('notificationPreferences',{organizationId:org,userId:carol.id,email:'carol@example.com',reviewCompleted:'all',highSeverity:'all',updatedAt:0}));
 const sent=fakeNetwork();
 // Completion schedules the fan-out (the workspace has notifications configured).
 await t.mutation(internal.reviews.finished,{reviewId});
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).some(j=>j.name.includes('notificationJobs:reviewCompleted'))).toBe(true);
 const outcome=await t.action(internal.notificationJobs.reviewCompleted,{reviewId});
 expect(Object.values(outcome).every(s=>s==='sent')).toBe(true);
 expect(slackPosts(sent).map(s=>[s.body.channel,String(s.body.text).split('\n')[0]])).toEqual([
  ['C0SHOP0001','*OpenReview finished reviewing acme/shop#7: 1 finding*'],
  ['C0SHOP0001','*1 high-severity finding in acme/shop#7*'],
  ['C0ALL00001','*1 high-severity finding in acme/shop#7*'],
 ]);
 expect(String(slackPosts(sent)[0].body.text)).toContain('<https://review.example.com/dashboard/pulls/'+reviewId+'|View the review>');
 // alice: all completions; bob: high severity on his own PR; dave: not his PR; carol: unverified.
 expect(emails(sent).map(e=>[(e.body.to as string[])[0],e.body.subject])).toEqual([['alice@example.com','OpenReview finished reviewing acme/shop#7: 1 finding'],['bob@example.com','1 high-severity finding in acme/shop#7']]);
 // Retries never notify twice.
 const again=await t.action(internal.notificationJobs.reviewCompleted,{reviewId});
 expect(Object.keys(again)).toHaveLength(5);expect(Object.values(again).every(s=>s==='duplicate')).toBe(true);
 expect(slackPosts(sent)).toHaveLength(3);expect(emails(sent)).toHaveLength(2);
});

test('nothing is scheduled or sent for workspaces without notifications; unconfigured email is skipped, not failed',async()=>{
 const {t,alice,org,reviewId}=await setup();
 const sent=fakeNetwork();
 await t.mutation(internal.reviews.finished,{reviewId});
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).some(j=>j.name.includes('notificationJobs'))).toBe(false);
 await verify(t,org,alice.id,'alice@example.com',{reviewCompleted:'all',highSeverity:'all'});
 const outcome=await t.action(internal.notificationJobs.reviewCompleted,{reviewId});
 expect(Object.values(outcome)).toEqual(['skipped','skipped']);
 expect(sent).toHaveLength(0);
 expect((await t.run(ctx=>ctx.db.query('notificationDeliveries').collect())).map(d=>[d.status,d.error])).toEqual([['skipped','Email delivery is not configured'],['skipped','Email delivery is not configured']]);
});

test('channel links are admin-only and audited; members manage only their own email, verified by a one-time link',async()=>{
 const {t,alice,bob,org,shop}=await setup();
 await expect(t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[],events:[],qa:false})).rejects.toThrow(/Install the Slack app first/);
 await installSlack(t,org,alice.id);
 await expect(t.mutation(api.notifications.saveChannel,{token:bob.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[shop._id],events:['finding.high'],qa:true})).rejects.toThrow(/Forbidden/);
 await expect(t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'#general',repositoryIds:[],events:[],qa:false})).rejects.toThrow();
 await expect(t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[],events:[],qa:true})).rejects.toThrow(/Q&A needs 1 to 5/);
 await expect(t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[],events:['everything'],qa:false})).rejects.toThrow(/Unknown notification event/);
 const channel=await t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[shop._id],events:['finding.high'],qa:true});
 expect((await t.query(api.notifications.settings,{token:bob.token,organizationId:org})).channels).toEqual([]);
 expect((await t.query(api.notifications.settings,{token:alice.token,organizationId:org})).channels).toEqual([{_id:channel,channelId:'C0SHOP0001',repositoryIds:[shop._id],events:['finding.high'],qa:true}]);
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).filter(e=>e.target===channel).map(e=>e.action)).toEqual(['notification_channel.saved']);
 // Email verification: only the hash is stored; the link works once and expires.
 process.env.RESEND_API_KEY='re_fixture';process.env.EMAIL_FROM='OpenReview <noreply@example.com>';
 const sent=fakeNetwork();
 await t.mutation(api.notifications.setEmail,{token:bob.token,organizationId:org,email:'Bob@Example.com'});
 const pref=(await t.run(ctx=>ctx.db.query('notificationPreferences').collect()))[0];
 expect(await t.action(internal.notificationJobs.sendVerification,{preferenceId:pref._id})).toBe('sent');
 const link=/https:\/\/review\.example\.com\/api\/notifications\/verify\?token=([A-Za-z0-9_-]+)/.exec(String(emails(sent)[0].body.text))!;
 expect((emails(sent)[0].body.to as string[])[0]).toBe('bob@example.com');
 const stored=await t.run(ctx=>ctx.db.get(pref._id));
 expect(JSON.stringify(stored)).not.toContain(link[1]);
 const hash=createHash('sha256').update(link[1]).digest('hex');
 expect(await t.mutation(api.notifications.verifyEmail,{tokenHash:hash})).toBe(true);
 expect(await t.mutation(api.notifications.verifyEmail,{tokenHash:hash})).toBe(false);
 expect((await t.query(api.notifications.settings,{token:bob.token,organizationId:org})).preferences).toMatchObject({email:'bob@example.com',verified:true});
 await t.mutation(api.notifications.setEmail,{token:bob.token,organizationId:org,email:'bob2@example.com'});
 expect((await t.query(api.notifications.settings,{token:bob.token,organizationId:org})).preferences.verified).toBe(false);
});

const signed=(body:string)=>{const ts=String(Math.floor(Date.now()/1000));return {'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',signing).update(`v0:${ts}:${body}`).digest('hex')};};
const event=(over:Record<string,unknown>={},eventOver:Record<string,unknown>={})=>JSON.stringify({type:'event_callback',team_id:'T0ACME123',event_id:'Ev01',event:{type:'app_mention',text:'<@U0BOT1234> where is the total computed?',channel:'C0SHOP0001',ts:'1700000000.000100',...eventOver},...over});
test('Slack events: signatures are required; mentions route to Q&A only in linked channels, once per event',async()=>{
 const {t,alice,org,shop}=await setup();
 const post=(path:string,body:string,headers:Record<string,string>=signed(body))=>t.fetch(path,{method:'POST',headers:{'content-type':'application/json',...headers},body});
 expect((await post('/slack/events',event(),{})).status).toBe(401);
 expect((await post('/slack/events',event(),{...signed(event()),'x-slack-signature':'v0='+'0'.repeat(64)})).status).toBe(401);
 const challenge=JSON.stringify({type:'url_verification',challenge:'abc123'});
 expect(await (await post('/slack/events',challenge)).json()).toEqual({challenge:'abc123'});
 // Not installed: acknowledged, nothing queued.
 expect((await post('/slack/events',event({event_id:'Ev00'}))).status).toBe(200);
 const scheduled=async(name:string)=>(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes(name));
 expect(await scheduled('notificationJobs')).toHaveLength(0);
 const installationId=await installSlack(t,org,alice.id);
 // Unlinked channel: a hint reply, no model work.
 await post('/slack/events',event({event_id:'Ev02'}));
 expect((await scheduled('slackReply'))[0].args[0]).toMatchObject({installationId,channelId:'C0SHOP0001',threadTs:'1700000000.000100'});
 expect(await scheduled('slackAnswer')).toHaveLength(0);
 await t.mutation(api.notifications.saveChannel,{token:alice.token,organizationId:org,channelId:'C0SHOP0001',repositoryIds:[shop._id],events:[],qa:true});
 await post('/slack/events',event());
 await post('/slack/events',event());
 await post('/slack/events',event({event_id:'Ev03'},{bot_id:'B1'}));
 const answers=await scheduled('slackAnswer');
 expect(answers).toHaveLength(1);
 expect(answers[0].args[0]).toEqual({installationId,channelId:'C0SHOP0001',threadTs:'1700000000.000100',question:'where is the total computed?',repositoryIds:[shop._id]});
 // Slash command: ephemeral status for the channel.
 const form=new URLSearchParams({team_id:'T0ACME123',channel_id:'C0SHOP0001',command:'/openreview',text:'status'}).toString();
 const status=await (await t.fetch('/slack/commands',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...signed(form)},body:form})).json();
 expect(status.response_type).toBe('ephemeral');
 expect(status.text).toContain('• acme/shop: index ready @ fffffff');
 expect((await t.fetch('/slack/commands',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form})).status).toBe(401);
});

test('Slack answers use the chat engine on linked repositories and update the placeholder with cited lines',async()=>{
 const {t,alice,org,shop,billing,teamId}=await setup();
 const installationId=await installSlack(t,org,alice.id);
 const sent=fakeNetwork();
 let turn=0;
 vi.spyOn(HttpModel.prototype,'runTools').mockImplementation(async(r:ToolRequest):Promise<ToolTurn>=>{void r;turn++;const calls:ToolCall[]=turn===1?[{id:'r',name:'read_file',input:{repository:'acme/shop',path:'src/cart.ts'}}]:turn===2?[{id:'a',name:'answer',input:{answer:'total() multiplies cents <b>by</b> quantity [1].',citations:[{repository:'acme/shop',filePath:'src/cart.ts',startLine:2,quote:'  return cents * qty;'}]}}]:[];return {content:'',toolCalls:calls,stopReason:calls.length?'tool_use':'end_turn',usage:{task:'chat',provider:'fixture',model:'fixture',inputTokens:10,outputTokens:5,latencyMs:1,estimatedCost:0.001,cached:false},message:{role:'assistant',content:'',toolCalls:calls}};});
 expect(await t.action(internal.notificationJobs.slackAnswer,{installationId,channelId:'C0SHOP0001',threadTs:'1.2',question:'How is the total computed?',repositoryIds:[shop._id]})).toBe('answered');
 expect(sent.map(s=>s.url.replace('https://slack.com/api/',''))).toEqual(['chat.postMessage','chat.update']);
 expect(sent[0].body).toMatchObject({channel:'C0SHOP0001',thread_ts:'1.2',text:'Investigating acme/shop…'});
 expect(sent[1].body.text).toBe(`total() multiplies cents &lt;b&gt;by&lt;/b&gt; quantity [1].\n\n[1] <https://github.com/acme/shop/blob/${head}/src/cart.ts#L2|acme/shop:src/cart.ts:2>`);
 expect(new Headers((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer xoxb-secret-bot-token');
 expect((await t.run(ctx=>ctx.db.query('usageEvents').collect())).some(u=>u.kind==='slack')).toBe(true);
 // A team-restricted repository the installer cannot read is never searched.
 await t.run(async ctx=>{const m=(await ctx.db.query('organizationMembers').collect()).find(x=>x.userId===alice.id)!;await ctx.db.patch(m._id,{role:'member'});});
 void teamId;
 expect(await t.action(internal.notificationJobs.slackAnswer,{installationId,channelId:'C0SHOP0001',threadTs:'1.3',question:'Billing?',repositoryIds:[billing._id]})).toBe('no repositories');
});

test('Slack install exchanges the code once, stores the bot token encrypted, and keeps workspaces apart',async()=>{
 const {t,alice,bob,org}=await setup();
 process.env.SLACK_CLIENT_ID='123.456';process.env.SLACK_CLIENT_SECRET='slack-client-secret';
 const sent=fakeNetwork();
 const args={token:alice.token,secret:'integration-service-secret',organizationId:org,code:'c0de',redirectUri:'https://review.example.com/api/slack/callback',jti:'slack:'+'s'.repeat(43),expiresAt:Date.now()+300000};
 await expect(t.action(api.notificationJobs.installSlack,{...args,secret:'wrong'})).rejects.toThrow();
 await expect(t.action(api.notificationJobs.installSlack,{...args,token:bob.token})).rejects.toThrow(/Forbidden/);
 const id=await t.action(api.notificationJobs.installSlack,args);
 expect(sent.at(-1)!.body).toMatchObject({client_id:'123.456',client_secret:'slack-client-secret',code:'c0de'});
 const stored=await t.run(ctx=>ctx.db.get(id));
 expect(stored).toMatchObject({teamId:'T0ACME123',teamName:'Acme Slack',botUserId:'U0BOT1234',active:true});
 expect(stored!.credentials).not.toContain('xoxb');
 await expect(t.action(api.notificationJobs.installSlack,args)).rejects.toThrow(/already used/);
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).some(e=>e.action==='slack.installed'&&e.target===id)).toBe(true);
 // The same Slack workspace cannot be attached to a second OpenReview workspace.
 const other=await t.mutation(api.users.createOrganization,{token:bob.token,name:'Other'});
 await expect(t.action(api.notificationJobs.installSlack,{...args,token:bob.token,organizationId:other,jti:'slack:'+'t'.repeat(43)})).rejects.toThrow(/another OpenReview workspace/);
 await t.mutation(api.notifications.disconnectSlack,{token:alice.token,organizationId:org});
 expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({active:false,credentials:''});
});
