import {beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {Github} from '../src/github';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters';
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';});

async function setup(installationId:number){
 const t=convexTest(schema,modules);
 const userId=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId:installationId,login:'alice'+installationId,avatar:''});
 const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(userId).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Semantic workspace'});
 await t.mutation(api.repositories.connect,{token,secret:'integration-service-secret',organizationId,installationId,account:'alice',accountId:1,repositories:[{id:installationId,fullName:'alice/semantic',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});await t.run(ctx=>ctx.db.patch(repo._id,{enabled:true}));
 return {t,token,repo};
}
const files=[{path:'src/billing.ts',sha:'billing-blob',content:'import { cents } from "./util";\n\nexport function total(c: number) {\n  return cents(c);\n}\n\nexport class Ledger {\n  add() { return 1; }\n}\n'},{path:'src/util.ts',sha:'util-blob',content:'export const cents = (c: number) => c;\n'}];
function index(t:Awaited<ReturnType<typeof setup>>['t'],repositoryId:Awaited<ReturnType<typeof setup>>['repo']['_id'],sha:string){
 return (async()=>{
  const jobId=(await t.mutation(internal.repositories.indexing,{repositoryId,sha,total:files.length,knowledgePaths:[]}))!;
  await t.run(async ctx=>{const manifestStorageId=await ctx.storage.store(new Blob([JSON.stringify({sha,gitignore:'',changedPaths:[],entries:files.map(({path,sha})=>({path,sha}))})]));await ctx.db.patch(jobId,{manifestStorageId});});
  await t.action(internal.jobs.indexBatch,{jobId});
  return jobId;
 })();
}

test('chunk embeddings backfill once per blob and model, record cost, and re-embed only when the model changes',async()=>{
 vi.useFakeTimers();vi.stubEnv('EMBEDDING_MODEL','text-embedding-3-small');vi.stubEnv('EMBEDDING_API_KEY','fixture');vi.stubEnv('EMBEDDING_COST_PER_MILLION','0.02');
 try{
  const {t,token,repo}=await setup(401);
  const native=new Github('fixture');vi.spyOn(native,'blob').mockImplementation(async(_r,path)=>files.find(f=>f.path===path)!);vi.spyOn(Github,'installation').mockResolvedValue(native);
  const inputs:string[][]=[];
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{const body=JSON.parse(String(init?.body));inputs.push(body.input);expect(body.dimensions).toBe(1536);return Response.json({data:body.input.map((_:string,index:number)=>({index,embedding:Array(1536).fill(index+1)})),usage:{total_tokens:10*body.input.length}});});
  await index(t,repo._id,'head-1');
  const rows=await t.run(ctx=>ctx.db.query('chunkEmbeddings').collect());
  expect(rows.filter(r=>r.path==='src/billing.ts').map(r=>[r.startLine,r.endLine,r.symbol])).toEqual([[1,2,undefined],[3,6,'total'],[7,10,'Ledger']]);
  expect(rows.every(r=>r.vector.length===1536&&r.model==='text-embedding-3-small'&&r.scope===repo._id+':text-embedding-3-small')).toBe(true);
  expect(inputs.flat().some(i=>i.startsWith('src/billing.ts:3-6 total\n'))).toBe(true);
  const firstCalls=fetch.mock.calls.length;expect(firstCalls).toBe(2);
  const usage=await t.run(ctx=>ctx.db.query('usageEvents').collect());
  expect(usage.filter(u=>u.kind==='embedding').reduce((s,u)=>s+u.inputTokens,0)).toBe(10*rows.length);
  expect(await t.query(api.embeddings.status,{token,repositoryId:repo._id})).toMatchObject({configured:true,model:'text-embedding-3-small',files:2,stale:0});
  // Re-index the same blobs: idempotent, no provider calls, identical rows.
  await index(t,repo._id,'head-2');
  expect(fetch.mock.calls.length).toBe(firstCalls);
  expect((await t.run(ctx=>ctx.db.query('chunkEmbeddings').collect())).map(r=>r._id).sort()).toEqual(rows.map(r=>r._id).sort());
  // A model change backfills again and replaces the old rows.
  vi.stubEnv('EMBEDDING_MODEL','text-embedding-3-large');
  await index(t,repo._id,'head-3');
  expect(fetch.mock.calls.length).toBe(firstCalls+2);
  const replaced=await t.run(ctx=>ctx.db.query('chunkEmbeddings').collect());
  expect(replaced.length).toBe(rows.length);expect(replaced.every(r=>r.model==='text-embedding-3-large')).toBe(true);
  // Removing a file removes its chunk vectors.
  await t.run(async ctx=>{const job=await ctx.db.insert('indexJobs',{organizationId:repo.organizationId,repositoryId:repo._id,sha:'head-4',status:'running',total:1,processed:0,changed:0,attempts:1,createdAt:Date.now(),updatedAt:Date.now()});await ctx.db.patch(repo._id,{indexStatus:'indexing'});return job;}).then(jobId=>t.mutation(internal.repositories.removeIndexedFiles,{repositoryId:repo._id,jobId,paths:['src/util.ts']}));
  expect((await t.run(ctx=>ctx.db.query('chunkEmbeddings').collect())).some(r=>r.path==='src/util.ts')).toBe(false);
 }finally{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();}
});

test('without an embedding endpoint indexing makes no provider calls and the dashboard reports semantic retrieval off',async()=>{
 vi.useFakeTimers();vi.stubEnv('EMBEDDING_MODEL','');
 try{
  const {t,token,repo}=await setup(402);
  const native=new Github('fixture');vi.spyOn(native,'blob').mockImplementation(async(_r,path)=>files.find(f=>f.path===path)!);vi.spyOn(Github,'installation').mockResolvedValue(native);
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No inference without embeddings'));
  const jobId=await index(t,repo._id,'head-1');
  expect(fetch).not.toHaveBeenCalled();
  expect(await t.run(ctx=>ctx.db.get(jobId))).toMatchObject({status:'completed'});
  expect(await t.run(ctx=>ctx.db.query('chunkEmbeddings').collect())).toEqual([]);
  expect((await t.run(ctx=>ctx.db.query('codeChunks').collect())).length).toBeGreaterThan(0);
  expect(await t.query(api.embeddings.status,{token,repositoryId:repo._id})).toEqual({configured:false});
 }finally{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();}
});

test('chunk hits only resolve rows from the requested repository',async()=>{
 const a=await setup(403),b=await setup(404);
 const id=await b.t.run(ctx=>ctx.db.insert('chunkEmbeddings',{organizationId:b.repo.organizationId,repositoryId:b.repo._id,path:'secret.ts',sha:'s',model:'m',scope:'x',startLine:1,endLine:2,vector:Array(1536).fill(0),updatedAt:0}));
 expect(await b.t.query(internal.embeddings.chunkHits,{ids:[id],repositoryId:b.repo._id})).toHaveLength(1);
 const otherRepo=await b.t.run(async ctx=>ctx.db.insert('repositories',{organizationId:b.repo.organizationId,fullName:'other/repo',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0}));
 expect(await b.t.query(internal.embeddings.chunkHits,{ids:[id],repositoryId:otherRepo})).toEqual([]);
 expect(a.repo._id).toBeTruthy();
});
