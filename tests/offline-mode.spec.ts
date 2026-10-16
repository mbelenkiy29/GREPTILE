import {test,expect,vi,afterEach} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
import {atlassianScopes} from '../src/atlassian';
import {encryptCredential} from '../src/credentials';
const modules=import.meta.glob('../convex/**/*.ts');
afterEach(()=>{vi.unstubAllGlobals();delete process.env.OPENREVIEW_OFFLINE;});

test('offline mode: review-time requirements lookups make no requests, leave connections healthy and say why',async()=>{
 process.env.CREDENTIAL_ENCRYPTION_KEY='offline-requirements-key-at-least-32-characters';
 const t=convexTest(schema,modules),site={id:'11111111-1111-4111-8111-111111111111',name:'Offline fixture',url:'https://fixture.atlassian.net',scopes:atlassianScopes};
 const {connected,bare}=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Offline',createdAt:Date.now()}),repo=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/repo',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()}),expiry=Date.now()-1000;
  const other=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/other',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()});
  // Expired tokens: an online lookup would refresh them first.
  for(const kind of ['linear','atlassian'] as const)await ctx.db.insert('integrationConnections',{organizationId,kind,externalId:kind==='linear'?'native-org':'native-sites',name:kind,credentials:encryptCredential(JSON.stringify({accessToken:'fixture-access-token',refreshToken:'fixture-refresh-token',expiresAt:expiry}),organizationId+':'+kind),expiresAt:expiry,active:true,generation:1,teamIds:kind==='linear'?['native-team']:[],projectIds:[],repositoryIds:[repo],...(kind==='atlassian'?{sites:[site],jiraProjectIds:[site.id+':10'],confluenceSpaceIds:[]}:{}),createdAt:Date.now()});
  return {connected:repo,bare:other};
 });
 const requests:string[]=[];
 vi.stubGlobal('fetch',async(input:string|URL)=>{requests.push(String(input));return Response.json({});});
 process.env.OPENREVIEW_OFFLINE='true';
 expect(await t.action(internal.integrationJobs.requirements,{repositoryId:connected,references:'PAY-1 https://fixture.atlassian.net/wiki/spaces/SPEC/pages/40/Money'})).toEqual({files:[],scopes:[],coverage:['Offline mode (OPENREVIEW_OFFLINE=true): linked tickets and documents were not fetched.']});
 expect(await t.action(internal.integrationJobs.requirements,{repositoryId:bare,references:'PAY-1'})).toEqual({files:[],scopes:[],coverage:[]});
 expect(requests).toEqual([]);
 const connections=await t.run(ctx=>ctx.db.query('integrationConnections').collect());
 expect(connections.map(c=>[c.active,c.error??null,c.generation])).toEqual([[true,null,1],[true,null,1]]);
});
