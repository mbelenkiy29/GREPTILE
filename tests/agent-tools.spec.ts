import {test,expect,vi} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
const modules=import.meta.glob('../convex/**/*.ts');

async function tenant(t:ReturnType<typeof convexTest>,name:string,secret:string){
 return t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name,createdAt:Date.now()});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:name+'/app',defaultBranch:'main',enabled:true,indexStatus:'ready',indexedSha:'i'.repeat(40),createdAt:Date.now()});
  const storageId=await ctx.storage.store(new Blob([secret]));
  await ctx.db.insert('repositoryFiles',{organizationId,repositoryId,path:'src/billing.ts',sha:'s',storageId,language:'ts',updatedAt:0});
  await ctx.db.insert('codeChunks',{organizationId,repositoryId,filePath:'src/billing.ts',startLine:10,content:`export function chargeTotal() {\n  return ${secret};\n}`});
  await ctx.db.insert('symbols',{organizationId,repositoryId,filePath:'src/billing.ts',name:'chargeTotal',kind:'function',line:10,exported:true});
  await ctx.db.insert('relationships',{organizationId,repositoryId,from:'src/billing.ts',sourcePath:'src/billing.ts',to:'src/'+name+'-only.ts',kind:'imports'});
  const reviewId=await ctx.db.insert('reviews',{organizationId,repositoryId,prNumber:1,headSha:'h'.repeat(40),status:'reviewing',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()} as never);
  await ctx.db.insert('findings',{organizationId,repositoryId,reviewId,prNumber:1,title:name+' finding',description:'d'.repeat(20),severity:'high',confidence:1,category:'correctness',filePath:'src/billing.ts',startLine:11,endLine:11,commitSha:'h'.repeat(40),evidence:[{filePath:'src/billing.ts',startLine:11,quote:'x'}],impact:'impact',suggestedFix:'fix it',symbol:'chargeTotal',fingerprint:'f-'+name,agent:'correctness',status:'open',createdAt:Date.now(),updatedAt:Date.now()} as never);
  return {organizationId,repositoryId,reviewId};
 });
}

test('agent tool queries only ever return data from the bound repository',async()=>{
 const t=convexTest(schema,modules);
 const a=await tenant(t,'alpha','ALPHA_PRIVATE'),b=await tenant(t,'beta','BETA_PRIVATE');
 for(const [mine,theirs,secret,other] of [[a,b,'ALPHA_PRIVATE','BETA_PRIVATE'],[b,a,'BETA_PRIVATE','ALPHA_PRIVATE']] as const){
  const r=mine.repositoryId;
  const results=JSON.stringify([
   await t.query(internal.agentTools.search,{repositoryId:r,query:'chargeTotal'}),
   await t.query(internal.agentTools.definitions,{repositoryId:r,symbol:'chargeTotal'}),
   await t.query(internal.agentTools.references,{repositoryId:r,symbol:'chargeTotal'}),
   await t.query(internal.agentTools.directory,{repositoryId:r,path:''}),
   await t.query(internal.agentTools.related,{repositoryId:r,path:'src/billing.ts'}),
   await t.query(internal.agentTools.pastFindings,{repositoryId:r,path:'src/billing.ts'}),
  ]);
  expect(results).not.toContain(other);
  expect(results).not.toContain(theirs===a?'alpha':'beta');
  expect((await t.query(internal.agentTools.definitions,{repositoryId:r,symbol:'chargeTotal'}))).toHaveLength(1);
  expect((await t.query(internal.agentTools.pastFindings,{repositoryId:r,path:'src/billing.ts'}))).toHaveLength(1);
  expect(results).toContain(secret==='ALPHA_PRIVATE'?'alpha-only':'beta-only');
 }
 expect(await t.query(internal.agentTools.directory,{repositoryId:a.repositoryId,path:'src'})).toEqual(['src/billing.ts']);
});

test('agent state persists per revision, suspends without consuming attempts, and is discarded on the final outcome',async()=>{
 vi.useFakeTimers();
 try{
  const t=convexTest(schema,modules);
  const {reviewId}=await tenant(t,'gamma','GAMMA');
  const store=(text:string)=>t.run(ctx=>ctx.storage.store(new Blob([text])));
  const first=await store('{"turn":1}');
  await t.mutation(internal.reviews.saveAgentState,{reviewId,storageId:first,headSha:'h'.repeat(40)});
  const second=await store('{"turn":2}');
  await t.mutation(internal.reviews.saveAgentState,{reviewId,storageId:second,headSha:'h'.repeat(40)});
  expect(await t.run(async ctx=>(await ctx.storage.get(first))===null)).toBe(true);
  expect(await t.query(internal.reviews.agentStatus,{reviewId})).toMatchObject({agentStateStorageId:second,agentStateHead:'h'.repeat(40)});
  const stale=await store('{}');
  expect(await t.mutation(internal.reviews.saveAgentState,{reviewId,storageId:stale,headSha:'z'.repeat(40)})).toBe(false);
  expect(await t.run(async ctx=>(await ctx.storage.get(stale))===null)).toBe(true);
  expect(await t.mutation(internal.reviews.suspendAgent,{reviewId})).toBe(true);
  const suspended=await t.run(ctx=>ctx.db.get(reviewId));
  expect(suspended).toMatchObject({status:'waiting_agent',attempts:1});
  const scheduled=await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect());
  expect(scheduled.some(j=>j.name.includes('jobs:review')&&(j.args[0] as {reviewId:Id<'reviews'>}).reviewId===reviewId)).toBe(true);
  expect(await t.mutation(internal.reviews.stage,{reviewId,status:'ingesting'})).toBe(true);
  expect(await t.run(ctx=>ctx.db.get(reviewId))).toMatchObject({status:'ingesting',attempts:1});
  // Not suspendable twice from a non-running state, and a final outcome removes the saved loop.
  await t.run(ctx=>ctx.db.patch(reviewId,{attempts:3}));
  await t.mutation(internal.reviews.finished,{reviewId,error:'Model unavailable'});
  const final=await t.run(ctx=>ctx.db.get(reviewId));expect(final?.status).toBe('failed');expect(final?.agentStateStorageId).toBeUndefined();
  expect(await t.run(async ctx=>(await ctx.storage.get(second))===null)).toBe(true);
  expect(await t.mutation(internal.reviews.suspendAgent,{reviewId})).toBe(false);
 }finally{vi.useRealTimers();}
});
