import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import {encryptCredential} from '../src/credentials';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='gitlab-network-session-secret-at-least-32-chars',hookSecret='gitlab-network-hook-secret-at-least-32-chars';
beforeEach(()=>{Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'gitlab-network-service',CREDENTIAL_ENCRYPTION_KEY:'gitlab-network-encryption-key-at-least-32',SCM_ALLOWED_HOSTS:'gitlab.example.com,gitlab-api.internal,other-api.internal',SCM_ALLOWED_PROXIES:'proxy.internal:3128'});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const jwt=(id:string)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));

test('GitLab network settings: stored only for GitLab, shown to admins, changed only after every repository is reachable, audited',async()=>{
 const t=convexTest(schema,modules);
 const owner=await jwt(await t.mutation(api.users.login,{secret:'gitlab-network-service',githubId:71,login:'owner',avatar:''}));
 const memberId=await t.mutation(api.users.login,{secret:'gitlab-network-service',githubId:72,login:'member',avatar:''}),member=await jwt(memberId);
 const organizationId=await t.mutation(api.users.createOrganization,{token:owner,name:'Network'});
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId,userId:memberId as never,role:'member'}));
 const base={token:owner,secret:'gitlab-network-service',organizationId,name:'GitLab',credentials:encryptCredential('bot-token-fixture',organizationId+':gitlab'),webhookSecret:encryptCredential(hookSecret,organizationId+':gitlab')};
 await expect(t.mutation(api.providerConnections.save,{...base,kind:'gitea',instance:'https://git.example',apiUrl:'https://gitlab-api.internal'})).rejects.toThrow(/available for GitLab/);
 const connectionId=await t.mutation(api.providerConnections.save,{...base,kind:'gitlab',instance:'https://gitlab.example.com',apiUrl:'https://gitlab-api.internal',proxyUrl:''});
 await t.run(ctx=>ctx.db.insert('repositories',{organizationId,connectionId,externalId:'42',fullName:'group/repo',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()}));
 const listed=(await t.query(api.providerConnections.list,{token:owner,organizationId}))[0];
 expect([listed.instance,listed.apiUrl,listed.proxyUrl,listed.caCertificates]).toEqual(['https://gitlab.example.com','https://gitlab-api.internal',undefined,0]);

 // Verification uses the new API URL; a host that cannot list the selected repository is refused and nothing changes.
 const hosts:string[]=[];
 vi.stubGlobal('fetch',async(input:string|URL)=>{const url=new URL(String(input));hosts.push(url.host);
  if(url.pathname==='/api/v4/projects')return Response.json(url.host==='other-api.internal'?[{id:42,path_with_namespace:'group/repo',default_branch:'main',http_url_to_repo:'https://gitlab.example.com/group/repo.git'}]:[]);
  return new Response(null,{status:404});});
 await expect(t.action(api.providerJobs.updateNetwork,{token:owner,connectionId,apiUrl:'https://gitlab-api.internal'})).rejects.toThrow(/cannot read every selected repository/);
 await expect(t.action(api.providerJobs.updateNetwork,{token:owner,connectionId,apiUrl:'https://not-allowed.example'})).rejects.toThrow(/SCM_ALLOWED_HOSTS/);
 await expect(t.action(api.providerJobs.updateNetwork,{token:member,connectionId,apiUrl:'https://other-api.internal'})).rejects.toThrow();
 expect((await t.run(ctx=>ctx.db.get(connectionId)))?.apiUrl).toBe('https://gitlab-api.internal');
 await t.action(api.providerJobs.updateNetwork,{token:owner,connectionId,apiUrl:'https://other-api.internal'});
 expect(hosts).toEqual(['gitlab-api.internal','other-api.internal']);
 const saved=await t.run(ctx=>ctx.db.get(connectionId));
 expect([saved?.apiUrl,saved?.caBundle,saved?.proxyUrl]).toEqual(['https://other-api.internal',undefined,undefined]);
 const audits=(await t.run(ctx=>ctx.db.query('auditEvents').collect())).map(a=>a.action);
 expect(audits).toContain('provider.network_updated');
});
