import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='identity-session-secret-at-least-32-characters',svc='identity-service';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,14,12));Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:svc,APP_URL:'https://review.example.com'});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();delete process.env.RESEND_API_KEY;delete process.env.EMAIL_FROM;});

const session=()=>{const sid=randomBytes(32).toString('base64url');return {sid,hash:createHash('sha256').update(sid).digest('hex')};};
const jwt=(userId:string,sid?:string,issuedAt=Math.floor(Date.now()/1000))=>new SignJWT(sid?{sid}:{}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setIssuedAt(issuedAt).setExpirationTime('7d').sign(new TextEncoder().encode(secret));
type T=ReturnType<typeof convexTest>;
async function signIn(t:T,profile:{provider:'github'|'gitlab'|'google';providerUserId:string;login:string;email?:string;emailVerified:boolean},linkToken?:string){
 const s=session();const userId=await t.mutation(api.identity.signIn,{secret:svc,avatar:'',...profile,sessionHash:s.hash,userAgent:'Vitest',...(linkToken?{linkToken}:{})});
 return {userId,token:await jwt(userId,s.sid),sid:s.sid};
}
const valid=(t:T,token:string)=>t.query(api.identity.sessionValid,{token});

test('migration backfills GitHub identities for legacy users idempotently; legacy and new GitHub logins resolve to the same user',async()=>{
 const t=convexTest(schema,modules);
 const legacy=await t.run(async ctx=>[await ctx.db.insert('users',{githubId:101,login:'old-alice',avatar:'',createdAt:1}),await ctx.db.insert('users',{githubId:102,login:'old-bob',avatar:'',createdAt:2}),await ctx.db.insert('users',{login:'email-only',avatar:'',createdAt:3})]);
 expect(await t.mutation(internal.identity.backfillIdentities,{})).toEqual({created:2,done:true});
 expect(await t.mutation(internal.identity.backfillIdentities,{})).toEqual({created:0,done:true});
 expect((await t.run(ctx=>ctx.db.query('identities').collect())).map(i=>[i.userId,i.provider,i.providerUserId])).toEqual([[legacy[0],'github','101'],[legacy[1],'github','102']]);
 // The new sign-in path and the legacy login mutation both find the migrated user.
 const viaSignIn=await signIn(t,{provider:'github',providerUserId:'101',login:'alice',emailVerified:false});
 expect(viaSignIn.userId).toBe(legacy[0]);
 expect(await t.mutation(api.users.login,{secret:svc,githubId:102,login:'bob',avatar:''})).toBe(legacy[1]);
 // A GitHub user created after the deploy (no backfill needed) gets an identity on first login.
 const fresh=await t.mutation(api.users.login,{secret:svc,githubId:103,login:'carol',avatar:''});
 expect((await t.run(ctx=>ctx.db.get(fresh)))?.githubId).toBe(103);
 expect((await t.run(ctx=>ctx.db.query('identities').collect())).filter(i=>i.userId===fresh)).toHaveLength(1);
 expect((await t.run(ctx=>ctx.db.get(legacy[0])))?.login).toBe('alice');
});

test('accounts link only through a verified email on both sides — an unverified address never takes over',async()=>{
 const t=convexTest(schema,modules);
 const victim=await signIn(t,{provider:'google',providerUserId:'g-victim',login:'victim',email:'victim@example.com',emailVerified:true});
 // Attacker controls a self-managed GitLab account claiming the victim's address (unverified).
 const attacker=await signIn(t,{provider:'gitlab',providerUserId:'gl-attacker',login:'victim',email:'victim@example.com',emailVerified:false});
 expect(attacker.userId).not.toBe(victim.userId);
 // Google with an unverified email does not link either.
 expect((await signIn(t,{provider:'google',providerUserId:'g-other',login:'x',email:'VICTIM@example.com',emailVerified:false})).userId).not.toBe(victim.userId);
 // The real owner's confirmed gitlab.com account (verified) joins the same user.
 expect((await signIn(t,{provider:'gitlab',providerUserId:'gl-victim',login:'victim',email:'Victim@Example.com',emailVerified:true})).userId).toBe(victim.userId);
 // The attacker's unverified identity does not become a link target for later verified sign-ins.
 const third=await signIn(t,{provider:'gitlab',providerUserId:'gl-new',login:'n',email:'attacker-target@example.com',emailVerified:true});
 expect(third.userId).not.toBe(attacker.userId);
 // GitHub never links by email (no verified email is requested).
 expect((await signIn(t,{provider:'github',providerUserId:'555',login:'victim',email:'victim@example.com',emailVerified:false})).userId).not.toBe(victim.userId);
 // Explicit linking while signed in attaches a new provider; an account owned by someone else cannot be linked.
 const linked=await signIn(t,{provider:'github',providerUserId:'777',login:'victim-gh',emailVerified:false},victim.token);
 expect(linked.userId).toBe(victim.userId);
 await expect(signIn(t,{provider:'gitlab',providerUserId:'gl-attacker',login:'x',emailVerified:false},victim.token)).rejects.toThrow(/already linked to another/);
 expect((await t.query(api.identity.sessions,{token:victim.token})).identities.map(i=>i.provider).sort()).toEqual(['github','gitlab','google']);
});

test('server-side sessions: individual revocation, sign out everywhere, expiry, and legacy tokens',async()=>{
 const t=convexTest(schema,modules);
 const laptop=await signIn(t,{provider:'google',providerUserId:'g-1',login:'dev',email:'dev@example.com',emailVerified:true});
 const phone=await signIn(t,{provider:'google',providerUserId:'g-1',login:'dev',email:'dev@example.com',emailVerified:true});
 const legacyToken=await jwt(laptop.userId);
 const listed=await t.query(api.identity.sessions,{token:laptop.token});
 expect(listed.sessions.map(s=>s.current)).toEqual([true,false]);
 await t.mutation(api.identity.revokeSession,{token:laptop.token,sessionId:listed.sessions[1]._id});
 expect([await valid(t,laptop.token),await valid(t,phone.token),await valid(t,legacyToken)]).toEqual([true,false,true]);
 await expect(t.query(api.users.me,{token:phone.token})).rejects.toThrow();
 // A forged session ID is rejected.
 expect(await valid(t,await jwt(laptop.userId,randomBytes(32).toString('base64url')))).toBe(false);
 // Sign out: only this browser.
 const tablet=await signIn(t,{provider:'google',providerUserId:'g-1',login:'dev',email:'dev@example.com',emailVerified:true});
 await t.mutation(api.identity.signOut,{token:laptop.token});
 expect([await valid(t,laptop.token),await valid(t,tablet.token)]).toEqual([false,true]);
 // Sign out everywhere: every session and every older session-less token.
 vi.advanceTimersByTime(2000);
 await t.mutation(api.identity.signOutEverywhere,{token:tablet.token});
 expect([await valid(t,tablet.token),await valid(t,legacyToken)]).toEqual([false,false]);
 // Signing in again in the same second still works.
 const again=await signIn(t,{provider:'google',providerUserId:'g-1',login:'dev',email:'dev@example.com',emailVerified:true});
 expect(await valid(t,again.token)).toBe(true);
 vi.advanceTimersByTime(8*86400000);
 expect(await valid(t,again.token)).toBe(false);
});

test('removing a member revokes their sessions, API keys and bridges for that workspace',async()=>{
 const t=convexTest(schema,modules);
 const owner=await signIn(t,{provider:'github',providerUserId:'1',login:'owner',emailVerified:false});
 const member=await signIn(t,{provider:'github',providerUserId:'2',login:'member',emailVerified:false});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const other=await t.mutation(api.users.createOrganization,{token:member.token,name:'Own'});
 const ids=await t.run(async ctx=>({
  membership:await ctx.db.insert('organizationMembers',{organizationId:org,userId:member.userId,role:'member'}),
  key:await ctx.db.insert('apiKeys',{organizationId:org,userId:member.userId,hash:'a'.repeat(64),name:'k',prefix:'or_k',createdAt:0,revoked:false}),
  ownKey:await ctx.db.insert('apiKeys',{organizationId:other,userId:member.userId,hash:'b'.repeat(64),name:'own',prefix:'or_o',createdAt:0,revoked:false}),
  bridge:await ctx.db.insert('bridgeDevices',{tokenHash:'c'.repeat(64),code:'X',userId:member.userId,organizationId:org,name:'laptop',expiresAt:Date.now()+86400000,revoked:false,createdAt:0}),
 }));
 vi.advanceTimersByTime(1000);
 await t.mutation(api.team.update,{token:owner.token,memberId:ids.membership,role:'member',remove:true});
 expect(await valid(t,member.token)).toBe(false);
 const rows=await t.run(async ctx=>({key:await ctx.db.get(ids.key),ownKey:await ctx.db.get(ids.ownKey),bridge:await ctx.db.get(ids.bridge)}));
 expect([rows.key?.revoked,rows.ownKey?.revoked,rows.bridge?.revoked]).toEqual([true,false,true]);
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).some(e=>e.action==='workspace.member_removed')).toBe(true);
 expect(await valid(t,owner.token)).toBe(true);
});

test('magic links and email invitations are single use, expire, and never store raw tokens',async()=>{
 const t=convexTest(schema,modules);
 process.env.RESEND_API_KEY='re_fixture';process.env.EMAIL_FROM='OpenReview <noreply@example.com>';
 const mails:{to:string;text:string}[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_u:string|URL|Request,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));mails.push({to:b.to[0],text:b.text});return Response.json({id:'m'+mails.length});});
 const linkToken=(text:string,path:string)=>new RegExp(`${path.replace(/[/?]/g,'\\$&')}\\?token=([A-Za-z0-9_-]+)`).exec(text)![1];
 await expect(t.action(api.identityJobs.requestMagicLink,{secret:'wrong',email:'new@example.com'})).rejects.toThrow();
 await t.action(api.identityJobs.requestMagicLink,{secret:svc,email:'New@Example.com',next:'/invite?token=abc'});
 const raw=linkToken(mails[0].text,'/api/auth/email/verify');
 expect(mails[0].text).toContain('&next=%2Finvite%3Ftoken%3Dabc');
 expect(JSON.stringify(await t.run(ctx=>ctx.db.query('loginTokens').collect()))).not.toContain(raw);
 const s1=session(),hash=createHash('sha256').update(raw).digest('hex');
 const userId=await t.mutation(api.identity.consumeLoginToken,{secret:svc,tokenHash:hash,sessionHash:s1.hash});
 expect(userId).toBeTruthy();
 expect(await t.mutation(api.identity.consumeLoginToken,{secret:svc,tokenHash:hash,sessionHash:session().hash})).toBeNull();
 expect(await valid(t,await jwt(userId!,s1.sid))).toBe(true);
 // The email identity is verified, so a later verified Google sign-in for that address joins it.
 expect((await signIn(t,{provider:'google',providerUserId:'g-new',login:'new',email:'new@example.com',emailVerified:true})).userId).toBe(userId);
 // Expired links fail.
 await t.action(api.identityJobs.requestMagicLink,{secret:svc,email:'late@example.com'});
 vi.advanceTimersByTime(16*60000);
 expect(await t.mutation(api.identity.consumeLoginToken,{secret:svc,tokenHash:createHash('sha256').update(linkToken(mails[1].text,'/api/auth/email/verify')).digest('hex'),sessionHash:session().hash})).toBeNull();
 // Email invitations: admin-only, single use, expiring, revocable.
 const owner=await signIn(t,{provider:'github',providerUserId:'1',login:'owner',emailVerified:false});
 const org=await t.mutation(api.users.createOrganization,{token:owner.token,name:'Acme'});
 const outsider=await signIn(t,{provider:'github',providerUserId:'9',login:'outsider',emailVerified:false});
 await expect(t.action(api.identityJobs.inviteByEmail,{token:outsider.token,organizationId:org,email:'x@example.com',role:'member'})).rejects.toThrow();
 expect(await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'Invitee@Example.com',role:'viewer'})).toBe('sent');
 const invite=linkToken(mails.at(-1)!.text,'/invite'),inviteHash=createHash('sha256').update(invite).digest('hex');
 expect(mails.at(-1)!.to).toBe('invitee@example.com');
 expect(await t.query(api.identity.invitationPreview,{tokenHash:inviteHash})).toMatchObject({workspace:'Acme',role:'viewer'});
 const invitee=await signIn(t,{provider:'gitlab',providerUserId:'gl-invitee',login:'invitee',emailVerified:false});
 expect(await t.mutation(api.identity.acceptEmailInvitation,{token:invitee.token,tokenHash:inviteHash})).toBe(org);
 expect((await t.query(api.users.me,{token:invitee.token})).organizations.map(o=>[o._id,o.role])).toEqual([[org,'viewer']]);
 await expect(t.mutation(api.identity.acceptEmailInvitation,{token:outsider.token,tokenHash:inviteHash})).rejects.toThrow(/invalid or expired/);
 expect(await t.query(api.identity.invitationPreview,{tokenHash:inviteHash})).toBeNull();
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'second@example.com',role:'member'});
 const second=createHash('sha256').update(linkToken(mails.at(-1)!.text,'/invite')).digest('hex');
 const [pending]=await t.query(api.identity.emailInvitations,{token:owner.token,organizationId:org});
 await t.mutation(api.identity.revokeEmailInvitation,{token:owner.token,invitationId:pending._id as Id<'emailInvitations'>});
 await expect(t.mutation(api.identity.acceptEmailInvitation,{token:outsider.token,tokenHash:second})).rejects.toThrow(/invalid or expired/);
 await t.action(api.identityJobs.inviteByEmail,{token:owner.token,organizationId:org,email:'third@example.com',role:'member'});
 const third=createHash('sha256').update(linkToken(mails.at(-1)!.text,'/invite')).digest('hex');
 vi.advanceTimersByTime(8*86400000);
 const fresh=await signIn(t,{provider:'github',providerUserId:'10',login:'late',emailVerified:false});
 await expect(t.mutation(api.identity.acceptEmailInvitation,{token:fresh.token,tokenHash:third})).rejects.toThrow(/invalid or expired/);
 expect(JSON.stringify(await t.run(ctx=>ctx.db.query('emailInvitations').collect()))).not.toContain(invite);
});
