import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import {Github} from '../src/github';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='diff-session-secret-at-least-32-characters',head='h'.repeat(40),base='b'.repeat(40);
beforeEach(()=>{Object.assign(process.env,{SESSION_SECRET:secret,SERVICE_SECRET:'diff-service'});});
afterEach(()=>vi.restoreAllMocks());

async function setup(baseSha?:string){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'diff-service',githubId,login:name,avatar:''});return new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret));};
 const alice=await login(51,'alice'),mallory=await login(52,'mallory');
 const org=await t.mutation(api.users.createOrganization,{token:alice,name:'Acme'});
 await t.mutation(api.repositories.connect,{token:alice,secret:'diff-service',organizationId:org,installationId:51,account:'acme',accountId:1,repositories:[{id:5101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId:org});
 const reviewId=await t.run(async ctx=>{
  await ctx.db.patch(repo._id,{enabled:true});
  const reviewId=await ctx.db.insert('reviews',{organizationId:org,repositoryId:repo._id,prNumber:4,headSha:head,...(baseSha?{baseSha}:{}),status:'completed',mode:'standard',attempts:1,findingsRecorded:true,createdAt:0,updatedAt:0});
  const snapshot={title:'Cents become dollars',description:'d',impact:'i',severity:'high',confidence:0.9,category:'correctness',filePath:'src/z.ts',startLine:2,endLine:2,commitSha:head,evidence:[{filePath:'src/z.ts',startLine:2,quote:'x'}],suggestedFix:'f',agent:'correctness',symbol:'s',fingerprint:'fp1'};
  const findingId=await ctx.db.insert('findings',{...snapshot,organizationId:org,repositoryId:repo._id,reviewId,prNumber:4,status:'open',createdAt:0,updatedAt:0});
  await ctx.db.insert('reviewFindings',{reviewId,findingId,snapshot});
  return reviewId;
 });
 const scm=new Github('fixture');vi.spyOn(Github,'installation').mockResolvedValue(scm);
 return {t,alice,mallory,reviewId:reviewId as Id<'reviews'>,scm};
}
const files=[{path:'src/a.ts',status:'modified',patch:'@@ -1 +1 @@\n-a\n+b',previousPath:undefined},{path:'src/z.ts',status:'modified',patch:'@@ -1,2 +1,2 @@\n x\n-y\n+z'}];

test('the diff is the exact base...head comparison, files with findings first, for authorized readers only',async()=>{
 const {t,alice,mallory,reviewId,scm}=await setup(base);
 const compare=vi.spyOn(scm,'compare').mockResolvedValue({status:'ahead',commits:1,complete:true,files});
 const pull=vi.spyOn(scm,'pullRequest');
 const diff=await t.action(api.reviewDiff.load,{token:alice,reviewId});
 expect(compare).toHaveBeenCalledWith('acme/shop',base,head);expect(pull).not.toHaveBeenCalled();
 expect(diff).toMatchObject({source:'compare',revision:head,omitted:0});
 expect(diff.files.map(f=>f.path)).toEqual(['src/z.ts','src/a.ts']);
 await expect(t.action(api.reviewDiff.load,{token:mallory,reviewId})).rejects.toThrow();
});

test('without a comparable base the pull request diff is used only while its head is the reviewed revision',async()=>{
 const {t,alice,reviewId,scm}=await setup();
 const pr=(sha:string)=>({number:4,title:'t',body:'',draft:false,state:'open',html_url:'',user:{login:'bob'},head:{sha,ref:'f'},base:{sha:base,ref:'main'},diff:files,comments:[],reviews:[],commits:[],checks:[],omitted:[]} as never);
 vi.spyOn(scm,'pullRequest').mockResolvedValueOnce(pr(head)).mockResolvedValueOnce(pr('n'.repeat(40)));
 expect((await t.action(api.reviewDiff.load,{token:alice,reviewId})).source).toBe('pull-request');
 const moved=await t.action(api.reviewDiff.load,{token:alice,reviewId});
 expect(moved).toMatchObject({source:'unavailable',files:[]});
 expect(moved.reason).toMatch(/moved past the reviewed revision/);
});
