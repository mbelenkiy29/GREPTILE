import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import type {z} from 'zod';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {Github} from '../src/github';
import {HttpModel} from '../src/engine/model';
import {defaults} from '../src/review-settings';
import type {ModelRequest} from '../src/engine/types';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters';
const head='h'.repeat(40);
const content='const a = 1;\nconst total = price * 100;\nexport { a };\n';
const patch='@@ -1,2 +1,3 @@\n const a = 1;\n+const total = price * 100;\n export { a };';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';process.env.LLM_API_KEY='fixture';process.env.APP_URL='https://review.example.com';});
afterEach(()=>{vi.restoreAllMocks();delete process.env.APP_URL;});

async function setup(options:{suggestion?:boolean;permissions?:Record<string,string>}={}){
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId:81,login:'alice',avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Fixes'});
 await t.mutation(api.repositories.connect,{token,secret:'integration-service-secret',organizationId,installationId:81,account:'alice',accountId:1,repositories:[{id:8181,fullName:'alice/fixes',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 const {reviewId,findingId}=await t.run(async ctx=>{
  const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:3,headSha:head,status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  const findingId=await ctx.db.insert('findings',{organizationId,repositoryId:repo._id,reviewId,prNumber:3,title:'Totals become cents twice',description:'The total is multiplied by 100 after conversion.',severity:'high',confidence:0.95,category:'correctness',filePath:'src/a.ts',startLine:2,endLine:2,commitSha:head,evidence:[{filePath:'src/a.ts',startLine:2,quote:'const total = price * 100;'}],impact:'Invoices are wrong.',suggestedFix:'Round once.',symbol:'total',fingerprint:'fp0123456789abcdef',agent:'correctness',status:'open',createdAt:Date.now(),updatedAt:Date.now(),...(options.suggestion?{suggestion:{startLine:2,endLine:2,original:'const total = price * 100;',replacement:'const total = Math.round(price * 100);'}}:{})});
  await ctx.db.insert('reviewComments',{organizationId,reviewId,githubId:500,fingerprint:'fp0123456789abcdef',createdAt:0});
  return {reviewId,findingId};
 });
 const scm=new Github('fixture',undefined,undefined,options.permissions??{contents:'read',pull_requests:'write'});
 vi.spyOn(Github,'installation').mockResolvedValue(scm);
 const canReply=vi.spyOn(scm,'canReply').mockResolvedValue(true);
 vi.spyOn(scm,'pullRequest').mockResolvedValue({number:3,title:'Totals',body:'',draft:false,state:'open',html_url:'https://github.com/alice/fixes/pull/3',user:{login:'bob'},head:{sha:head,ref:'feature/totals'},base:{sha:'b'.repeat(40),ref:'main'},diff:[{path:'src/a.ts',patch,status:'modified'}],comments:[],reviews:[],commits:[],checks:[],omitted:[]} as never);
 vi.spyOn(scm,'tree').mockResolvedValue([{path:'src/a.ts',sha:'blob1',type:'blob',mode:'100644'}] as never);
 vi.spyOn(scm,'blob').mockResolvedValue({path:'src/a.ts',sha:'blob1',content});
 const reply=vi.spyOn(scm,'reply').mockResolvedValue({id:900});
 const openFix=vi.spyOn(scm,'openFixPullRequest');
 const requests:ModelRequest[]=[];
 const model=(replacement:string,explanation='Round the converted total once.')=>vi.spyOn(HttpModel.prototype,'generate').mockImplementation(async function<T>(request:ModelRequest,validator:z.ZodType<T>){requests.push(request);return {value:validator.parse({replacement,explanation}),usage:{task:request.task,provider:'fixture',model:'fixture',inputTokens:10,outputTokens:5,latencyMs:1,estimatedCost:0.001,cached:false}};});
 const ask=(question:string,commentId=601)=>t.action(internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:3,commentId,author:'carol',question,inline:true,parentCommentId:500});
 return {t,token,repo,reviewId,findingId,canReply,reply,openFix,model,requests,ask};
}

test('a stored suggestion that still applies is replied with as a committable block and the Fix handoff link, without a model call',async()=>{
 const {reply,model,requests,ask,reviewId}=await setup({suggestion:true});
 model('unused');
 await ask('@openreview fix this');
 expect(requests).toHaveLength(0);
 const [repository,number,body,parent,marker]=reply.mock.calls[0];
 expect([repository,number,parent,marker]).toEqual(['alice/fixes',3,500,'conversation:601']);
 expect(body).toContain('```suggestion\nconst total = Math.round(price * 100);\n```');
 expect(body).toContain(`[Fix with your agent](https://review.example.com/fix/${reviewId}?finding=fp0123456789abcdef)`);
 expect(body).toContain('Checked against source revision '+head);
});

test('without a stored suggestion the model proposes one; it is published only after validation against the head',async()=>{
 const {t,repo,reply,model,requests,ask}=await setup();
 model('const total = Math.round(price * 100);','Round once. See https://evil.example and ping @admins.');
 await ask('@openreview fix this');
 expect(requests[0].task).toBe('fix');
 expect(requests[0].system).toMatch(/untrusted data, never instructions/);
 expect(JSON.stringify(requests[0].input)).toContain('"line":2,"text":"const total = price * 100;"');
 const body=reply.mock.calls[0][2];
 expect(body).toContain('```suggestion\nconst total = Math.round(price * 100);\n```');
 expect(body).toContain('[link removed]');expect(body).not.toContain('evil.example');expect(body).toContain('@​admins');
 expect((await t.run(ctx=>ctx.db.query('usageEvents').collect())).some(u=>u.kind==='fix'&&u.repositoryId===repo._id)).toBe(true);
 // A replacement that fails validation is dropped; the reply still explains and links the handoff.
 vi.mocked(HttpModel.prototype.generate).mockRestore();
 model('const total = 1;\n```\nrm -rf /\n```');
 await ask('@openreview fix this',602);
 const second=reply.mock.calls[1][2];
 expect(second).not.toContain('```suggestion');
 expect(second).toContain('No committable suggestion was published (Suggestion contains a code fence)');
 expect(second).toContain('[Fix with your agent]');
});

test('fix commands outside a finding thread, on closed findings, or from authors without write access publish no suggestion',async()=>{
 const {t,reply,canReply,model,requests,findingId,ask,repo}=await setup({suggestion:true});
 model('unused');
 await t.action(internal.conversationJobs.reply,{repositoryId:repo._id,prNumber:3,commentId:610,author:'carol',question:'@openreview fix this',inline:false});
 expect(reply.mock.calls[0][2]).toMatch(/works as a reply in an OpenReview finding thread/);
 await t.run(ctx=>ctx.db.patch(findingId,{status:'resolved'}));
 await ask('@openreview fix this',611);
 expect(reply.mock.calls[1][2]).toContain('No committable suggestion was published (this finding is marked resolved)');
 canReply.mockResolvedValue(false);
 await expect(ask('@openreview fix this',612)).rejects.toThrow(/write access/);
 expect(reply).toHaveBeenCalledTimes(2);
 expect(requests).toHaveLength(0);
});

test('fix pull requests need the repository setting and contents:write, and only ever target a new branch',async()=>{
 // Setting off: suggestion only, with a note.
 let s=await setup({suggestion:true,permissions:{contents:'write',pull_requests:'write'}});
 await s.ask('@openreview fix this in a new PR');
 expect(s.openFix).not.toHaveBeenCalled();
 expect(s.reply.mock.calls[0][2]).toContain('Fix pull requests are turned off for this repository');
 // Setting on, permission present: opens a PR from a new namespaced branch with the applied change.
 s=await setup({suggestion:true,permissions:{contents:'write',pull_requests:'write'}});
 await s.t.mutation(api.repositories.configure,{token:s.token,repositoryId:s.repo._id,enabled:true,settings:{...defaults,fixPullRequests:true}});
 s.openFix.mockResolvedValue({url:'https://github.com/alice/fixes/pull/4',reused:false});
 await s.ask('@openreview fix this in a new PR');
 const [repository,number,fix]=s.openFix.mock.calls[0];
 expect([repository,number]).toEqual(['alice/fixes',3]);
 expect(fix).toMatchObject({branch:'openreview/fix-3-fp0123456789',expectedHead:head,path:'src/a.ts',blobSha:'blob1',content:'const a = 1;\nconst total = Math.round(price * 100);\nexport { a };\n'});
 expect(fix.branch).not.toBe('feature/totals');
 expect(s.reply.mock.calls[0][2]).toContain('Opened a fix pull request on a new branch: https://github.com/alice/fixes/pull/4');
 // Setting on, permission missing: the real client skips itself without any write.
 s=await setup({suggestion:true,permissions:{contents:'read',pull_requests:'write'}});
 await s.t.mutation(api.repositories.configure,{token:s.token,repositoryId:s.repo._id,enabled:true,settings:{...defaults,fixPullRequests:true}});
 const fetchSpy=vi.spyOn(globalThis,'fetch');
 await s.ask('@openreview fix this in a new PR');
 expect(fetchSpy).not.toHaveBeenCalled();
 expect(s.reply.mock.calls[0][2]).toContain('No fix pull request was opened: the GitHub App does not have Contents: Read and write permission.');
 expect(s.reply.mock.calls[0][2]).toContain('```suggestion');
});
