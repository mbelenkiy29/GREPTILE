import {test,expect,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import type {Id} from '../convex/_generated/dataModel';
import {api,internal} from '../convex/_generated/api';
import {atlassianScopes} from '../src/atlassian';
import {decryptCredential,encryptCredential} from '../src/credentials';
import {citesFetchedRequirements} from '../src/engine/review';
const modules=import.meta.glob('../convex/**/*.ts');

test('shared requirements action bounds the combined native Linear and Jira documents',async()=>{
 process.env.CREDENTIAL_ENCRYPTION_KEY='combined-requirements-key-at-least-32-characters';
 const t=convexTest(schema,modules),site={id:'11111111-1111-4111-8111-111111111111',name:'Native fixture',url:'https://fixture.atlassian.net',scopes:atlassianScopes};
 const repositoryId=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Mixed requirements',createdAt:Date.now()}),repo=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/repo',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()}),expiry=Date.now()+3600000;
  for(const kind of ['linear','atlassian'] as const)await ctx.db.insert('integrationConnections',{organizationId,kind,externalId:kind==='linear'?'native-org':'native-sites',name:kind,credentials:encryptCredential(JSON.stringify({accessToken:'fixture-access-token',refreshToken:'fixture-refresh-token',expiresAt:expiry}),organizationId+':'+kind),expiresAt:expiry,active:true,generation:1,teamIds:kind==='linear'?['native-team']:[],projectIds:[],repositoryIds:[repo],...(kind==='atlassian'?{sites:[site],jiraProjectIds:[site.id+':10'],confluenceSpaceIds:[]}:{}),createdAt:Date.now()});
  return repo;
 });
 let linearBody=false,jiraBody=false;
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const u=new URL(String(input));
  if(u.hostname==='api.linear.app'){
   const full=JSON.parse(String(init?.body)).query.includes('description');if(full)linearBody=true;
   return Response.json({data:{organization:{id:'native-org'},issue:{id:'native-issue',identifier:'PAY-1',team:{id:'native-team'},project:null,...(full?{title:'Linear requirement',description:'é'.repeat(30000),updatedAt:'2026-10-03T00:00:00.000Z',url:'https://linear.app/fixture/issue/PAY-1/requirement'}:{})}}});
  }
  if(u.pathname==='/oauth/token/accessible-resources')return Response.json([site]);
  if(u.pathname.includes('/issue/PAY-1')||u.pathname.endsWith('/issue/30')){const full=u.searchParams.get('fields')?.includes('description');if(full)jiraBody=true;return Response.json({id:'30',key:'PAY-1',fields:{project:{id:'10'},...(full?{summary:'Jira requirement',description:{type:'doc',version:1,content:[{type:'text',text:'a'.repeat(60000)}]},updated:'2026-10-03T00:00:00.000Z'}:{})}});}
  throw new Error('Unexpected native request');
 });
 try{
  const result=await t.action(internal.integrationJobs.requirements,{repositoryId,references:'PAY-1'});
  expect(linearBody&&jiraBody).toBe(true);expect(result.scopes).toHaveLength(2);expect(result.files).toHaveLength(1);expect(result.files[0].path).toContain('/linear/');expect(result.files.reduce((n,f)=>n+Buffer.byteLength(f.content,'utf8'),0)).toBeLessThanOrEqual(100000);expect(result.coverage.join()).toContain('Combined Linear and Atlassian');
  expect(citesFetchedRequirements(site.url+'/browse/PAY-1',result.files.map(f=>f.provenance!.sourceUrl!))).toBe(false);
 }finally{vi.unstubAllGlobals();}
});

test('Atlassian OAuth persistence, native scope selection, context provenance, refresh and immediate disconnect guard tenant/cache boundaries',async()=>{
 process.env.SERVICE_SECRET='atlassian-service';process.env.SESSION_SECRET='atlassian-session-secret-at-least-32-characters';process.env.CREDENTIAL_ENCRYPTION_KEY='atlassian-encryption-secret-at-least-32-characters';process.env.ATLASSIAN_CLIENT_ID='fixture-client';process.env.ATLASSIAN_CLIENT_SECRET='fixture-secret';process.env.APP_URL='http://localhost:3000';
 const t=convexTest(schema,modules);
 const identity=async(githubId:number)=>{const id=await t.mutation(api.users.login,{secret:'atlassian-service',githubId,login:'user-'+githubId,avatar:''});return{id,token:await new SignJWT({}).setSubject(id).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET))};};
 const alice=await identity(1),bob=await identity(2),viewer=await identity(3),organizationId=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Atlassian'});
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId,userId:viewer.id,role:'viewer'}));
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'atlassian-service',organizationId,installationId:79,account:'user-1',accountId:1,repositories:[{id:790,fullName:'user-1/repo',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice.token,organizationId});
 const site={id:'11111111-1111-4111-8111-111111111111',name:'Product',url:'https://product.atlassian.net',scopes:atlassianScopes};
 let tokenCalls=0,outside=false,unauthorized=false,disconnectDuringRead=false;
 const contentReads:string[]=[];
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const u=new URL(String(input));expect(init?.redirect).toBe('error');
  if(u.hostname==='auth.atlassian.com'){tokenCalls++;const body=JSON.parse(String(init?.body));expect(body.client_secret).toBe('fixture-secret');return Response.json({access_token:'fixture-access-'+tokenCalls,refresh_token:'fixture-refresh-'+tokenCalls,expires_in:3600,scope:atlassianScopes.join(' ')});}
  if(unauthorized)return new Response('',{status:401});
  if(u.pathname==='/oauth/token/accessible-resources')return Response.json([site]);
  if(u.pathname.endsWith('/project/search'))return Response.json({startAt:0,isLast:true,values:[{id:'10',key:'PAY',name:'Payments'}]});
  if(u.pathname.endsWith('/spaces'))return Response.json({results:[{id:'20',key:'SPEC',name:'Specs'}],_links:{}});
  if(u.pathname.includes('/issue/')){
   const full=u.searchParams.get('fields')?.includes('description');if(full){contentReads.push('issue');if(disconnectDuringRead)await t.mutation(api.integrations.disconnect,{token:alice.token,id});}
   return Response.json({id:'30',key:'PAY-1',fields:{project:{id:outside?'99':'10'},...(full?{summary:'Integer cents',description:{type:'doc',version:1,content:[{type:'text',text:'Preserve cents'}]},updated:'2026-10-02T00:00:00.000Z'}:{})}});
  }
  if(u.pathname.endsWith('/pages/40')){const full=u.searchParams.has('body-format');if(full)contentReads.push('page');return Response.json({id:'40',spaceId:'20',status:'current',...(full?{title:'Money spec',version:{number:4},body:{atlas_doc_format:{representation:'atlas_doc_format',value:JSON.stringify({type:'doc',version:1,content:[]})}}}:{})});}
  throw new Error('Unexpected fetch '+u.pathname);
 });
 let id:Id<'integrationConnections'>;
 try{
  const grant={token:alice.token,secret:'atlassian-service',organizationId,code:'fixture-code',redirectUri:'http://localhost:3000/api/integrations/atlassian/callback',jti:'atlassian:'+'x'.repeat(43),expiresAt:Date.now()+240000};
  await expect(t.action(api.atlassianJobs.connect,{...grant,token:bob.token})).rejects.toThrow('Forbidden');expect(tokenCalls).toBe(0);
  id=await t.action(api.atlassianJobs.connect,grant);await expect(t.action(api.atlassianJobs.connect,grant)).rejects.toThrow('consumed');expect(tokenCalls).toBe(1);
  const data=await t.query(internal.integrations.data,{id});expect(data.credentials).not.toContain('fixture-access');expect(JSON.parse(decryptCredential(data.credentials,organizationId+':atlassian')).accessToken).toBe('fixture-access-1');
  expect(await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'PAY-1'})).toEqual({files:[],scopes:[],coverage:[]});
  await expect(t.action(api.atlassianJobs.discover,{token:viewer.token,id})).rejects.toThrow('Forbidden');
  const available=await t.action(api.atlassianJobs.discover,{token:alice.token,id});expect(available.projects[0].id).toBe(site.id+':10');expect(available.spaces[0].id).toBe(site.id+':20');
  const selected={token:alice.token,id,jiraProjectIds:[site.id+':10'],confluenceSpaceIds:[site.id+':20'],repositoryIds:[repo._id]};
  await expect(t.action(api.atlassianJobs.configure,{...selected,jiraProjectIds:[site.id+':99']})).rejects.toThrow('currently authorized');
  await t.action(api.atlassianJobs.configure,selected);
  const context=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'PAY-1 https://product.atlassian.net/wiki/spaces/SPEC/pages/40/Money'});
  expect(context.files).toHaveLength(2);expect(context.coverage).toEqual([]);expect(context.files.map(f=>f.provenance?.sourceUrl)).toEqual([site.url+'/browse/PAY-1',site.url+'/wiki/pages/viewpage.action?pageId=40']);expect(context.files.map(f=>f.sha)).toEqual(['2026-10-02T00:00:00.000Z','4']);
  expect(citesFetchedRequirements(site.url+'/browse/PAY-999',context.files.map(f=>f.provenance!.sourceUrl!))).toBe(false);
  expect(citesFetchedRequirements('http://PRODUCT.ATLASSIAN.NET/browse/PAY-1',context.files.map(f=>f.provenance!.sourceUrl!))).toBe(false);
  expect(citesFetchedRequirements('https://PRODUCT.ATLASSIAN.NET/browse/PAY-1',context.files.map(f=>f.provenance!.sourceUrl!))).toBe(true);
  await t.query(internal.integrations.validate,{repositoryId:repo._id,scopes:context.scopes});
  outside=true;contentReads.length=0;const denied=await t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'PAY-1'});expect(denied.files).toEqual([]);expect(denied.coverage.join(' ')).toContain('outside selected resources');expect(contentReads).toEqual([]);outside=false;
  await t.run(ctx=>ctx.db.patch(id,{expiresAt:1,credentials:data.credentials})); // Token timestamp is inside encrypted credentials.
  const credentials=JSON.parse(decryptCredential(data.credentials,organizationId+':atlassian'));credentials.expiresAt=1;
  const {encryptCredential}=await import('../src/credentials');await t.run(ctx=>ctx.db.patch(id,{credentials:encryptCredential(JSON.stringify(credentials),organizationId+':atlassian')}));
  await t.action(api.atlassianJobs.discover,{token:alice.token,id});expect(tokenCalls).toBe(2);
  const refreshed=await t.query(internal.integrations.data,{id});expect(JSON.parse(decryptCredential(refreshed.credentials,organizationId+':atlassian')).refreshToken).toBe('fixture-refresh-2');
  unauthorized=true;await expect(t.action(api.atlassianJobs.discover,{token:alice.token,id})).rejects.toThrow('401');expect(tokenCalls).toBe(3);unauthorized=false;
  await t.action(api.atlassianJobs.configure,selected);await expect(t.query(internal.integrations.validate,{repositoryId:repo._id,scopes:context.scopes})).rejects.toThrow('scope changed');
  disconnectDuringRead=true;await expect(t.action(internal.integrationJobs.requirements,{repositoryId:repo._id,references:'PAY-1'})).rejects.toThrow('scope changed');
  const removed=await t.run(ctx=>ctx.db.get(id));expect(removed?.credentials).toBe('');expect(removed?.sites).toEqual([]);expect(removed?.active).toBe(false);expect(removed?.error).toContain('Connected Apps');
  await expect(t.action(api.atlassianJobs.discover,{token:alice.token,id})).rejects.toThrow('disconnected');expect(await t.query(internal.integrations.forRepository,{repositoryId:repo._id})).toEqual([]);
  expect(await t.run(ctx=>ctx.db.query('integrationRevocations').collect())).toEqual([]);
 }finally{vi.unstubAllGlobals();}
});
