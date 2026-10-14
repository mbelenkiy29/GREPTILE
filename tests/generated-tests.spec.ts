import {afterEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {Github} from '../src/github';
import {findingComment} from '../src/review-summary';
import type {Finding} from '../src/engine/types';
const modules=import.meta.glob('../convex/**/*.ts');
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const image='node@sha256:'+'a'.repeat(64),head='b'.repeat(40),credential='orw_'+'c'.repeat(64),hash=createHash('sha256').update(credential).digest('hex');
const finding=(fingerprint:string,startLine:number):Finding=>({title:'Totals become dollars '+fingerprint,description:'total() divides cents by 100 before callers store cents.',severity:'high',confidence:.9,category:'correctness',filePath:'src/total.js',startLine,endLine:startLine,evidence:[{filePath:'src/total.js',startLine,quote:'return cents / 100;'}],impact:'Orders are undercharged.',suggestedFix:'Return cents unchanged.',symbol:'total',fingerprint,agent:'correctness',commitSha:head});
async function setup(policy:{generatedTests?:boolean;testCommand?:string}={generatedTests:true,testCommand:'node --test {test}'},online=true){
 process.env.SERVICE_SECRET='tests-service';process.env.SESSION_SECRET='tests-session-secret-at-least-32-characters';
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'tests-service',githubId:81,login:'owner',avatar:''});
 const token=await new SignJWT({}).setSubject(userId).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Generated tests'});
 await t.mutation(api.repositories.connect,{token,secret:'tests-service',organizationId,installationId:81,account:'owner',accountId:1,repositories:[{id:810,fullName:'owner/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 // An already indexed repository, so the resumed review goes straight to publication.
 await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40)}));
 await t.mutation(api.runtime.save,{token,organizationId,policy:{enabled:false,image,command:'',timeout:60,requiredForApproval:false,...policy}});
 const workerId=await t.mutation(api.runtime.worker,{token,organizationId,name:'isolated',hash});
 if(online)await t.run(ctx=>ctx.db.patch(workerId,{lastSeen:Date.now()}));
 // A saved review result (what the fresh review path stores before publication).
 const findings=[finding('f1',2),finding('f2',5)];
 const reviewId=await t.run(ctx=>ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:3,headSha:head,status:'summarizing',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()}));
 const storageId=await t.run(ctx=>ctx.storage.store(new Blob([JSON.stringify({summary:'Saved summary.',findings,metadata:{carriedForward:[],resolvedFingerprints:[]}})])));
 await t.mutation(internal.reviews.save,{reviewId,storageId,summary:'Saved summary.',reviewScore:{value:2,reason:'The verified currency defect must be fixed before merging.'},findings,resolved:[],usage:[]});
 // Provider fakes: every write path is spied so the no-commit guarantee can be checked.
 const gh=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(gh);
 vi.spyOn(Github.prototype,'archive').mockResolvedValue(new Uint8Array([31,139,8,0]));
 vi.spyOn(Github.prototype,'pullRequest').mockResolvedValue({number:3,title:'Totals',body:'',draft:false,state:'open',html_url:'https://github.com/owner/shop/pull/3',user:{login:'author'},head:{sha:head,ref:'feature'},base:{sha:'a'.repeat(40),ref:'main'},diff:[],comments:[],reviews:[],commits:[],checks:[]} as never);
 const publish=vi.spyOn(Github.prototype,'publish').mockResolvedValue({id:900,reused:false,comments:[]});
 vi.spyOn(Github.prototype,'startCheckRun').mockResolvedValue(null);
 const writes=[vi.spyOn(Github.prototype,'openFixPullRequest'),vi.spyOn(Github.prototype,'reply')];
 const fetchCalls:string[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{fetchCalls.push(String(input));throw new Error('unexpected network call');});
 return {t,token,organizationId,repo,reviewId,publish,writes,fetchCalls};
}
const drafts=[{fingerprint:'f1',path:'src/total.repro.test.js',content:"import test from 'node:test';\ntest('f1', () => { throw new Error('dollars'); });"},{fingerprint:'f2',path:'src/total2.repro.test.js',content:"import test from 'node:test';\ntest('f2', () => {});"}];
const run=(command:string,exitCode:number,output:string)=>({headSha:head,image,command,exitCode,timedOut:false,executionStarted:true,output,outputTruncated:false,network:'none' as const,memoryMb:512 as const,cpus:1 as const});

test('generated tests run as a sandbox job and their recorded outcomes attach to the right findings without any commit',async()=>{
 vi.useFakeTimers();
 const s=await setup();
 expect(await s.t.mutation(internal.runtime.requestTests,{reviewId:s.reviewId,tests:drafts})).toBe(true);
 expect(await s.t.mutation(internal.runtime.requestTests,{reviewId:s.reviewId,tests:drafts})).toBe(false);
 expect((await s.t.run(ctx=>ctx.db.get(s.reviewId)))?.status).toBe('waiting_runtime');
 await s.t.finishInProgressScheduledFunctions();
 await vi.runOnlyPendingTimersAsync();await s.t.finishInProgressScheduledFunctions();
 const lease='0e3c6c63-0c38-4a6e-9a0e-6f0c4f1f7a11';
 const claimed=await s.t.mutation(internal.runtime.claim,{hash,lease});
 expect(claimed).toMatchObject({kind:'tests',image,command:'node --test {test}',timeout:60,tests:[{fingerprint:'f1',path:'src/total.repro.test.js',command:"node --test 'src/total.repro.test.js'"},{fingerprint:'f2',command:"node --test 'src/total2.repro.test.js'"}]});
 // Evidence must match each test's own approved command.
 await expect(s.t.action(internal.runtimeJobs.report,{id:claimed!.id,hash,lease,tests:[{fingerprint:'f1',evidence:run("node --test 'src/total2.repro.test.js'",1,'x')}]})).rejects.toThrow(/does not match/);
 await s.t.action(internal.runtimeJobs.report,{id:claimed!.id,hash,lease,tests:[{fingerprint:'f1',evidence:run("node --test 'src/total.repro.test.js'",1,'not ok 1 - f1\ntoken ghp_'+'x'.repeat(36))},{fingerprint:'f2',evidence:run("node --test 'src/total2.repro.test.js'",0,'ok 1 - f2')},{fingerprint:'unknown',evidence:run('x',0,'')}]});
 const job=await s.t.run(ctx=>ctx.db.get(claimed!.id));
 expect(job?.status).toBe('completed');
 expect(job?.testResults?.map(r=>r.fingerprint)).toEqual(['f1','f2']);
 expect(job?.testResults?.[0].evidence?.output).not.toContain('ghp_');
 expect((await s.t.run(ctx=>ctx.db.get(s.reviewId)))?.runtimeEvidence).toBeUndefined();
 // The review resumes and publishes the saved result with the outcomes attached.
 await vi.runOnlyPendingTimersAsync();await s.t.finishAllScheduledFunctions(()=>vi.runAllTimersAsync());
 const after=await s.t.run(async ctx=>({review:await ctx.db.get(s.reviewId),runs:(await ctx.db.query('reviewRuns').collect()).map(r=>r.stage+':'+r.detail)}));
 expect(s.publish,JSON.stringify({status:after.review?.status,error:after.review?.error,runs:after.runs})).toHaveBeenCalledOnce();
 const published=s.publish.mock.calls[0][4] as Finding[];
 expect(published.map(f=>[f.fingerprint,f.confidence,f.generatedTest?.status])).toEqual([['f1',.95,'reproduced'],['f2',.85,'not reproduced']]);
 expect(findingComment(published[0])).toMatch(/\*\*Generated test:\*\* reproduced the defect \(exit 1\) · `node --test 'src\/total\.repro\.test\.js'`/);
 expect(findingComment(published[1])).toMatch(/passed, so the defect was not reproduced \(exit 0\); confidence was lowered/);
 const detail=await s.t.query(api.reviews.detail,{token:s.token,reviewId:s.reviewId});
 expect(detail.findings.find(f=>f.fingerprint==='f1')?.generatedTest).toMatchObject({status:'reproduced',path:'src/total.repro.test.js'});
 expect(detail.findings.find(f=>f.fingerprint==='f2')?.confidence).toBe(.85);
 // No-commit guarantee: no provider write path ran and nothing reached the network.
 for(const write of s.writes)expect(write).not.toHaveBeenCalled();
 expect(s.fetchCalls).toEqual([]);
 expect((await s.t.run(ctx=>ctx.db.get(s.reviewId)))?.status).toBe('completed');
});

test('generated tests are skipped when not opted in or no worker is connected; a policy change cancels results',async()=>{
 vi.useFakeTimers();
 const off=await setup({generatedTests:false,testCommand:''});
 expect(await off.t.mutation(internal.runtime.requestTests,{reviewId:off.reviewId,tests:drafts})).toBe(false);
 expect(await off.t.query(internal.runtime.testsEnabled,{repositoryId:off.repo._id})).toBe(false);
 vi.restoreAllMocks();
 const offline=await setup(undefined,false);
 expect(await offline.t.query(internal.runtime.testsEnabled,{repositoryId:offline.repo._id})).toBe(false);
 expect(await offline.t.mutation(internal.runtime.requestTests,{reviewId:offline.reviewId,tests:drafts})).toBe(false);
 vi.restoreAllMocks();
 const s=await setup();
 expect(await s.t.query(internal.runtime.testsEnabled,{repositoryId:s.repo._id})).toBe(true);
 await s.t.mutation(internal.runtime.requestTests,{reviewId:s.reviewId,tests:drafts});
 await vi.runOnlyPendingTimersAsync();await s.t.finishInProgressScheduledFunctions();
 const lease='1e3c6c63-0c38-4a6e-9a0e-6f0c4f1f7a11',claimed=await s.t.mutation(internal.runtime.claim,{hash,lease});
 await s.t.mutation(api.runtime.save,{token:s.token,organizationId:s.organizationId,policy:{enabled:false,image,command:'',timeout:60,requiredForApproval:false,generatedTests:true,testCommand:'npx vitest run {test}'}});
 await s.t.action(internal.runtimeJobs.report,{id:claimed!.id,hash,lease,tests:[{fingerprint:'f1',evidence:run("node --test 'src/total.repro.test.js'",1,'x')}]});
 const job=await s.t.run(ctx=>ctx.db.get(claimed!.id));
 expect(job?.status).toBe('cancelled');expect(job?.testResults).toBeUndefined();
});
