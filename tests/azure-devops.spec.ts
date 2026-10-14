import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {encryptCredential} from '../src/credentials';
import {AzureDevOps} from '../src/azure-devops';
import {defaults} from '../src/review-settings';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='azure-session-secret-at-least-32-characters',hookSecret='azure-hook-secret-at-least-32-characters-long';
const repoGuid='3411ebc1-d5aa-464f-9615-0b527bc66719',head='a'.repeat(40),target='b'.repeat(40);
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'azure-service',CREDENTIAL_ENCRYPTION_KEY:'azure-encryption-key-at-least-32-characters'});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

async function setup(){
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:'azure-service',githubId:61,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Fabrikam'});
 const connectionId=await t.mutation(api.providerConnections.save,{token,secret:'azure-service',organizationId,kind:'azure-devops',instance:'https://dev.azure.com/fabrikam',name:'Azure DevOps',credentials:encryptCredential('pat-fixture-value',organizationId+':azure-devops'),webhookSecret:encryptCredential(hookSecret,organizationId+':azure-devops:webhook')});
 const repositoryId=await t.run(async ctx=>{
  const repo=await ctx.db.insert('repositories',{organizationId,connectionId,externalId:repoGuid,fullName:'Retail/shop',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()});
  await ctx.db.insert('repositorySettings',{repositoryId:repo,organizationId,inherit:false,settings:{...defaults,automatic:true}});return repo;
 });
 const metadata=vi.spyOn(AzureDevOps.prototype,'changeMetadata').mockResolvedValue({number:7,title:'Totals',html_url:'https://dev.azure.com/fabrikam/Retail/_git/shop/pullrequest/7',draft:false,state:'open',user:{login:'alice@fabrikam.com'},head:{sha:head,ref:'feature'},base:{sha:target,ref:'main'},revisionKey:target+':'+head});
 return {t,token,organizationId,connectionId,repositoryId,metadata};
}
const delivery=(connectionId:string,body:unknown,signature=hookSecret)=>({secret:'azure-service',connectionId:connectionId as never,signature,externalId:(body as {id:string}).id,body:JSON.stringify(body)});
const prEvent=(id:string,eventType='git.pullrequest.created',repo=repoGuid)=>({id,eventType,resource:{pullRequestId:7,status:'active',repository:{id:repo}}});

test('service hooks need the shared secret, deliver once, and route pull requests to reviews',async()=>{
 const {t,connectionId,repositoryId,metadata}=await setup();
 await expect(t.action(api.providerJobs.webhook,delivery(connectionId,prEvent('evt-1'),'wrong-secret'))).rejects.toThrow(/signature/);
 await t.action(api.providerJobs.webhook,delivery(connectionId,prEvent('evt-1')));
 await t.action(api.providerJobs.webhook,delivery(connectionId,prEvent('evt-1')));
 const events=await t.run(ctx=>ctx.db.query('providerEvents').collect());
 expect(events).toHaveLength(1);
 await t.action(internal.providerJobs.event,{id:events[0]._id});
 const reviews=await t.run(ctx=>ctx.db.query('reviews').collect());
 expect(reviews.map(r=>[r.repositoryId,r.prNumber,r.headSha,r.revisionKey])).toEqual([[repositoryId,7,head,target+':'+head]]);
 expect(metadata).toHaveBeenCalledWith('Retail/shop',7);
 // An update with the same head does not re-review; one for an unknown repository is ignored.
 await t.action(api.providerJobs.webhook,delivery(connectionId,prEvent('evt-2','git.pullrequest.updated')));
 await t.action(api.providerJobs.webhook,delivery(connectionId,prEvent('evt-3','git.pullrequest.created','00000000-0000-4000-8000-000000000000')));
 for(const e of (await t.run(ctx=>ctx.db.query('providerEvents').collect())).filter(e=>e.externalId!=='evt-1'))await t.action(internal.providerJobs.event,{id:e._id});
 expect(await t.run(ctx=>ctx.db.query('reviews').collect())).toHaveLength(1);
 expect(metadata).toHaveBeenCalledTimes(2);
});

test('pushes to the default branch re-index; other branches and disconnected connections do not',async()=>{
 const {t,token,connectionId}=await setup();
 const push=(id:string,ref:string)=>({id,eventType:'git.push',resource:{refUpdates:[{name:ref,newObjectId:head}],repository:{id:repoGuid}}});
 await t.action(api.providerJobs.webhook,delivery(connectionId,push('push-1','refs/heads/feature')));
 await t.action(api.providerJobs.webhook,delivery(connectionId,push('push-2','refs/heads/main')));
 for(const e of await t.run(ctx=>ctx.db.query('providerEvents').collect()))await t.action(internal.providerJobs.event,{id:e._id});
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).filter(j=>j.name.includes('jobs:index'))).toHaveLength(1);
 await t.mutation(api.providerConnections.disconnect,{token,id:connectionId});
 await expect(t.action(api.providerJobs.webhook,delivery(connectionId,push('push-3','refs/heads/main')))).rejects.toThrow();
});
