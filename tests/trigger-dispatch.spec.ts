import {beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHmac} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {defaults} from '../src/review-settings';
import {Github} from '../src/github';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';process.env.GITHUB_WEBHOOK_SECRET='integration-webhook-secret';});

test('GitHub pull_request webhooks honour trigger labels, mention-only mode and excluded authors end to end',async()=>{
 vi.useFakeTimers();
 try{
  const t=convexTest(schema,modules);
  const userId=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId:91,login:'alice',avatar:''});
  const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Triggers'});
  await t.mutation(api.repositories.connect,{token,secret:'integration-service-secret',organizationId,installationId:91,account:'alice',accountId:1,repositories:[{id:9191,fullName:'alice/triggers',defaultBranch:'main'}]});
  const [repo]=await t.query(api.repositories.list,{token,organizationId});
  await t.mutation(api.repositories.configure,{token,repositoryId:repo._id,enabled:true,settings:{...defaults,automatic:false,triggerLabels:['needs-review'],excludedAuthors:['dependabot[bot]']}});
  let sequence=0,head='';
  const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
  vi.spyOn(scm,'changeMetadata').mockImplementation(async(_repo,number)=>({number,title:'Change',body:'',draft:false,state:'open',html_url:'https://github.com/alice/triggers/pull/7',user:{login:'alice'},head:{sha:head,ref:'feature'},base:{sha:'a'.repeat(40),ref:'main'}}) as never);
  const deliver=async(action:string,extra:Record<string,unknown>={})=>{
   head=String(sequence+1).padStart(40,'c');
   const deliveryId='trigger-'+(++sequence),body=JSON.stringify({action,installation:{id:91},repository:{id:9191,full_name:'alice/triggers',default_branch:'main'},pull_request:{number:7,draft:false,state:'open',head:{sha:String(sequence).padStart(40,'c'),ref:'feature'},base:{ref:'main'},user:{login:'alice'},labels:[],...extra},...(action==='labeled'?{label:{name:'needs-review'}}:{})});
   expect((await t.fetch('/github/webhook',{method:'POST',headers:{'x-github-delivery':deliveryId,'x-github-event':'pull_request','x-hub-signature-256':'sha256='+createHmac('sha256','integration-webhook-secret').update(body).digest('hex')},body})).status).toBe(202);
   const event=await t.run(ctx=>ctx.db.query('webhookDeliveries').withIndex('by_delivery',q=>q.eq('deliveryId',deliveryId)).unique());
   await t.action(internal.webhookJobs.process,{deliveryId:event!._id});
   return t.run(ctx=>ctx.db.query('reviews').collect());
  };
  expect(await deliver('opened')).toHaveLength(0);
  const labelled=await deliver('labeled');
  expect(labelled).toHaveLength(1);expect(labelled[0]).toMatchObject({prNumber:7,trigger:'label'});
  expect(await deliver('synchronize',{labels:[{name:'needs-review'}]})).toHaveLength(2);
  expect(await deliver('labeled',{user:{login:'dependabot[bot]'}})).toHaveLength(2);
  expect(await deliver('synchronize')).toHaveLength(2);
 }finally{vi.restoreAllMocks();vi.useRealTimers();}
});
