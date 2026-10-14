import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {decryptCredential,encryptCredential} from '../src/credentials';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='notion-session-secret-at-least-32-characters',workspace='8f1e2d3c-4b5a-4697-8a9b-0c1d2e3f4a5b';
const pageId='1f2e3d4c-5b6a-4798-8796-a5b4c3d2e1f0',pageUrl='https://www.notion.so/acme/Checkout-1f2e3d4c5b6a47988796a5b4c3d2e1f0';
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'notion-service',CREDENTIAL_ENCRYPTION_KEY:'notion-encryption-secret-at-least-32-characters',NOTION_CLIENT_ID:'notion-client',NOTION_CLIENT_SECRET:'notion-secret',APP_URL:'https://review.example.com'});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

type State={tokens:Record<string,'ok'|'revoked'>;refresh:'ok'|'fail';revoke:'ok'|'fail'};
function notionApi(state:State){
 const calls:{path:string;auth:string|null;body?:Record<string,unknown>}[]=[];
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const u=new URL(String(input)),auth=new Headers(init?.headers).get('authorization'),body=init?.body?JSON.parse(String(init.body)):undefined;
  calls.push({path:u.pathname,auth,body});
  if(u.hostname!=='api.notion.com')throw new Error('Unexpected request '+u.href);
  if(u.pathname==='/v1/oauth/token'){
   if(body.grant_type==='refresh_token'&&state.refresh==='fail')return Response.json({error:'invalid_grant'},{status:400});
   const access=body.grant_type==='refresh_token'?'ntn_access_refreshed':'ntn_access_initial';state.tokens[access]='ok';
   return Response.json({access_token:access,token_type:'bearer',refresh_token:'ntn_refresh_'+access,bot_id:'bot',workspace_id:workspace,workspace_name:'Acme Notion'});
  }
  if(u.pathname==='/v1/oauth/revoke')return state.revoke==='ok'?Response.json({}):Response.json({},{status:503});
  const token=auth?.replace('Bearer ','')??'';
  if(state.tokens[token]!=='ok')return Response.json({object:'error',status:401,code:'unauthorized'},{status:401});
  if(u.pathname==='/v1/search')return Response.json({results:[{object:'page',id:pageId,url:pageUrl,properties:{Name:{type:'title',title:[{plain_text:'Checkout'}]}}}]});
  if(u.pathname===`/v1/pages/${pageId}`)return Response.json({object:'page',id:pageId,url:pageUrl,last_edited_time:'2026-10-02T09:00:00.000Z',properties:{Name:{type:'title',title:[{plain_text:'Checkout'}]}}});
  if(u.pathname===`/v1/blocks/${pageId}/children`)return Response.json({results:[{id:'b1',type:'paragraph',paragraph:{rich_text:[{plain_text:'Totals stay in integer cents.'}]}}],has_more:false,next_cursor:null});
  return Response.json({object:'error',status:404},{status:404});
 });
 return calls;
}
async function setup(){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'notion-service',githubId,login:name,avatar:''});return {id:id as Id<'users'>,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const alice=await login(91,'alice'),bob=await login(92,'bob');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'notion-service',organizationId:org,installationId:91,account:'acme',accountId:1,repositories:[{id:9101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 await t.run(async ctx=>{await ctx.db.patch(repo._id,{enabled:true});await ctx.db.insert('organizationMembers',{organizationId:org,userId:bob.id,role:'member'});});
 return {t,alice,bob,org,repo};
}
const connectArgs=(token:string,org:Id<'organizations'>,suffix='a')=>({token,secret:'notion-service',organizationId:org,code:'notion-code',redirectUri:'https://review.example.com/api/integrations/notion/callback',jti:'notion:'+suffix.repeat(43),expiresAt:Date.now()+300000});

test('Notion connect stores encrypted credentials once; admins scope repositories; PR-linked pages become cited requirements',async()=>{
 const {t,alice,bob,org,repo}=await setup();
 const state:State={tokens:{},refresh:'ok',revoke:'ok'},calls=notionApi(state);
 await expect(t.action(api.notionJobs.connect,{...connectArgs(alice.token,org),secret:'wrong'})).rejects.toThrow();
 await expect(t.action(api.notionJobs.connect,connectArgs(bob.token,org))).rejects.toThrow(/Forbidden/);
 await expect(t.action(api.notionJobs.connect,{...connectArgs(alice.token,org),redirectUri:'https://evil.example/cb'})).rejects.toThrow(/Invalid Notion OAuth callback/);
 const id=await t.action(api.notionJobs.connect,connectArgs(alice.token,org));
 await expect(t.action(api.notionJobs.connect,connectArgs(alice.token,org))).rejects.toThrow(/already consumed/);
 const stored=await t.run(ctx=>ctx.db.get(id));
 expect(stored).toMatchObject({kind:'notion',externalId:workspace,name:'Acme Notion',active:true,repositoryIds:[]});
 expect(stored!.credentials).not.toContain('ntn_access');
 expect(JSON.parse(decryptCredential(stored!.credentials,org+':notion'))).toMatchObject({accessToken:'ntn_access_initial',refreshToken:'ntn_refresh_ntn_access_initial'});
 // No repositories selected: nothing is fetched.
 expect((await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:pageUrl})).files).toEqual([]);
 expect(await t.action(api.notionJobs.discover,{token:alice.token,id})).toEqual({pages:[{id:pageId,url:pageUrl,title:'Checkout'}]});
 await expect(t.action(api.notionJobs.configure,{token:bob.token,id,repositoryIds:[repo._id]})).rejects.toThrow();
 await t.action(api.notionJobs.configure,{token:alice.token,id,repositoryIds:[repo._id]});
 const before=calls.length;
 const result=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:`Implements ${pageUrl} and https://evil.example/1f2e3d4c5b6a47988796a5b4c3d2e1f0`});
 expect(result.files).toEqual([{path:`requirements/notion/${id}/${pageId}.md`,content:`# Checkout\nSource: ${pageUrl}\nUpdated: 2026-10-02T09:00:00.000Z\n\nTotals stay in integer cents.`,sha:'2026-10-02T09:00:00.000Z',provenance:{repository:'Notion: Acme Notion',revision:'2026-10-02T09:00:00.000Z',sourceUrl:pageUrl}}]);
 expect(result.scopes).toEqual([{id,generation:2}]);
 expect(calls.slice(before).map(c=>c.path)).toEqual([`/v1/pages/${pageId}`,`/v1/blocks/${pageId}/children`]);
 const none=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'No links here'});
 expect(none.coverage).toContain('No Notion page links were found in the PR title, description or branch; no Notion requirements were fetched.');
});

test('a 401 refreshes the token once and retries; a revoked grant without refresh surfaces a reconnect prompt',async()=>{
 const {t,alice,org,repo}=await setup();
 const state:State={tokens:{},refresh:'ok',revoke:'ok'},calls=notionApi(state);
 const id=await t.action(api.notionJobs.connect,connectArgs(alice.token,org));
 await t.action(api.notionJobs.configure,{token:alice.token,id,repositoryIds:[repo._id]});
 state.tokens.ntn_access_initial='revoked';
 const recovered=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:pageUrl});
 expect(recovered.files).toHaveLength(1);
 expect(calls.filter(c=>c.path==='/v1/oauth/token').map(c=>c.body?.grant_type)).toEqual(['authorization_code','refresh_token']);
 const rotated=await t.run(ctx=>ctx.db.get(id));
 expect(JSON.parse(decryptCredential(rotated!.credentials,org+':notion'))).toMatchObject({accessToken:'ntn_access_refreshed',refreshToken:'ntn_refresh_ntn_access_refreshed'});
 expect(rotated!.error).toBeUndefined();
 // Refresh rejected: the page is skipped with coverage, and the connection shows an error.
 state.tokens.ntn_access_refreshed='revoked';state.refresh='fail';
 const failed=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:pageUrl});
 expect(failed.files).toEqual([]);
 expect(failed.coverage.some(c=>c.startsWith(`Notion page ${pageId} was unavailable`))).toBe(true);
 expect((await t.run(ctx=>ctx.db.get(id)))!.error).toMatch(/Token refresh failed/);
 // A grant without a refresh token asks for a reconnect instead of refreshing.
 await t.run(ctx=>ctx.db.patch(id,{credentials:encryptCredential(JSON.stringify({accessToken:'ntn_access_dead',refreshToken:null,expiresAt:Date.now()+86400000}),org+':notion'),error:undefined}));
 const tokenCalls=calls.filter(c=>c.path==='/v1/oauth/token').length;
 expect((await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:pageUrl})).files).toEqual([]);
 expect(calls.filter(c=>c.path==='/v1/oauth/token')).toHaveLength(tokenCalls);
 expect((await t.run(ctx=>ctx.db.get(id)))!.error).toBe('Notion rejected the stored token. Reconnect Notion to restore requirements access.');
});

test('disconnect removes access immediately and revokes the token at Notion, retrying failures before asking for manual removal',async()=>{
 const {t,alice,org,repo}=await setup();
 const state:State={tokens:{},refresh:'ok',revoke:'ok'},calls=notionApi(state);
 const id=await t.action(api.notionJobs.connect,connectArgs(alice.token,org));
 await t.action(api.notionJobs.configure,{token:alice.token,id,repositoryIds:[repo._id]});
 await t.mutation(api.integrations.disconnect,{token:alice.token,id});
 expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({active:false,credentials:'',repositoryIds:[]});
 expect((await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:pageUrl})).files).toEqual([]);
 const [revocation]=await t.run(ctx=>ctx.db.query('integrationRevocations').collect());
 await t.action(internal.notionJobs.revoke,{id:revocation._id});
 expect(calls.filter(c=>c.path==='/v1/oauth/revoke').map(c=>[c.body?.token,c.auth])).toEqual([['ntn_access_initial','Basic '+Buffer.from('notion-client:notion-secret').toString('base64')]]);
 expect(await t.run(ctx=>ctx.db.get(revocation._id))).toMatchObject({status:'completed',credentials:''});
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).some(e=>e.action==='integration.disconnected'&&e.target===id)).toBe(true);
 // A revocation that keeps failing ends with manual instructions.
 const again=await t.action(api.notionJobs.connect,connectArgs(alice.token,org,'b'));
 state.revoke='fail';
 await t.mutation(api.integrations.disconnect,{token:alice.token,id:again});
 // Reconnecting the same Notion workspace reuses the connection record; take its newest revocation.
 expect(again).toBe(id);
 const second=(await t.run(ctx=>ctx.db.query('integrationRevocations').collect())).filter(r=>r.connectionId===again).at(-1)!;
 expect(second.status).toBe('queued');
 for(let i=0;i<3;i++){await t.action(internal.notionJobs.revoke,{id:second._id});await t.run(ctx=>ctx.db.patch(second._id,{leaseExpiresAt:undefined}));}
 expect(await t.run(ctx=>ctx.db.get(second._id))).toMatchObject({status:'failed',credentials:''});
 expect((await t.run(ctx=>ctx.db.get(again)))!.error).toBe('Local access removed. Notion revocation failed; remove the OpenReview connection in Notion under Settings → Connections.');
});
