import {test,expect,vi,afterEach} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import {encryptCredential,decryptCredential} from '../src/credentials';
import {Gitlab} from '../src/gitlab';
const modules=import.meta.glob('../convex/**/*.ts');
afterEach(()=>vi.restoreAllMocks());
async function setup(){
 process.env.SESSION_SECRET='provider-refresh-session-secret-long-enough';process.env.SERVICE_SECRET='provider-refresh-service';process.env.CREDENTIAL_ENCRYPTION_KEY='provider-refresh-encryption-key-long-enough';
 const t=convexTest(schema,modules),user=await t.mutation(api.users.login,{secret:process.env.SERVICE_SECRET,githubId:81001,login:'refresh-admin',avatar:''});
 const token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Credential recovery'});
 const credentials=encryptCredential('expired-bot-token',organizationId+':gitlab'),webhookSecret=encryptCredential('preserve-webhook-secret',organizationId+':gitlab:webhook');
 const connectionId=await t.mutation(api.providerConnections.save,{token,secret:process.env.SERVICE_SECRET,organizationId,kind:'gitlab',instance:'https://gitlab.com',name:'Recovery',credentials,webhookSecret});
 const repo=await t.run(ctx=>ctx.db.insert('repositories',{organizationId,connectionId,externalId:'42',fullName:'group/repo',defaultBranch:'main',enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40),createdAt:Date.now()}));
 return {t,token,user,organizationId,connectionId,repo,credentials,webhookSecret};
}
test('replacement verifies native selected identity, encrypts credentials and retains repository/webhook with an audit',async()=>{
 const s=await setup(),discover=vi.spyOn(Gitlab.prototype,'repositories').mockResolvedValue([{externalId:'42',fullName:'group/repo',defaultBranch:'main',remoteUrl:'https://gitlab.com/group/repo.git'}]);
 await s.t.action(api.providerJobs.replaceGitCredentials,{token:s.token,connectionId:s.connectionId,credential:'replacement-bot-token'});
 const c=await s.t.run(ctx=>ctx.db.get(s.connectionId));expect(c?.credentials).not.toBe('replacement-bot-token');expect(decryptCredential(c!.credentials,s.organizationId+':gitlab')).toBe('replacement-bot-token');expect(c?.webhookSecret).toBe(s.webhookSecret);
 expect(await s.t.run(ctx=>ctx.db.get(s.repo))).toMatchObject({enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40)});
 expect(discover).toHaveBeenCalledTimes(1);expect(await s.t.run(ctx=>ctx.db.query('auditEvents').collect())).toEqual(expect.arrayContaining([expect.objectContaining({action:'provider.credentials_replaced',target:s.connectionId})]));
 expect(await s.t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(0);
});
test('missing access, changed credentials, repository changes and lost admin rights fail before saving',async()=>{
 const s=await setup(),native=vi.spyOn(Gitlab.prototype,'repositories').mockResolvedValue([{externalId:'different',fullName:'group/repo',defaultBranch:'main',remoteUrl:'https://gitlab.com/group/repo.git'}]);
 const args={token:s.token,connectionId:s.connectionId,credential:'replacement-bot-token'};
 await expect(s.t.action(api.providerJobs.replaceGitCredentials,args)).rejects.toThrow('every selected repository');
 expect((await s.t.run(ctx=>ctx.db.get(s.connectionId)))?.credentials).toBe(s.credentials);
 const verified=[{externalId:'42',fullName:'group/repo',defaultBranch:'main',remoteUrl:'https://gitlab.com/group/repo.git'}];
 native.mockImplementation(async()=>{await s.t.run(ctx=>ctx.db.patch(s.connectionId,{credentials:'concurrent-rotation'}));return verified;});
 await expect(s.t.action(api.providerJobs.replaceGitCredentials,args)).rejects.toThrow('changed during');
 await s.t.run(ctx=>ctx.db.patch(s.connectionId,{credentials:s.credentials}));
 native.mockImplementation(async()=>{await s.t.run(ctx=>ctx.db.patch(s.repo,{fullName:'group/renamed'}));return verified;});
 await expect(s.t.action(api.providerJobs.replaceGitCredentials,args)).rejects.toThrow('repositories changed');
 await s.t.run(ctx=>ctx.db.patch(s.repo,{fullName:'group/repo'}));
 native.mockImplementation(async()=>{await s.t.run(async ctx=>{const m=await ctx.db.query('organizationMembers').withIndex('by_org',q=>q.eq('organizationId',s.organizationId)).first();await ctx.db.patch(m!._id,{role:'viewer'});});return verified;});
 await expect(s.t.action(api.providerJobs.replaceGitCredentials,args)).rejects.toThrow('Forbidden');
 expect((await s.t.run(ctx=>ctx.db.get(s.connectionId)))?.credentials).toBe(s.credentials);
});
