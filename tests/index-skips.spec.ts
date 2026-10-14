import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
async function setup(){
 const t=convexTest(schema,modules);
 const state=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Skip recovery',createdAt:Date.now()});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/recovery',defaultBranch:'main',enabled:true,indexStatus:'indexing',createdAt:Date.now()});
  const skipped=Array.from({length:500},(_,i)=>({path:`generated/${i}.js`,reason:'Generated source'}));
  const jobId=await ctx.db.insert('indexJobs',{organizationId,repositoryId,sha:'a'.repeat(40),status:'running',total:2,processed:0,changed:0,attempts:1,skipped,skippedTotal:500,batchLease:{id:'first',expiresAt:Date.now()+60000},createdAt:Date.now(),updatedAt:Date.now()});
  return {organizationId,repositoryId,jobId};
 });return {t,...state};
}
test('skipped source beyond the display cap counts once across retry leases and independently per job',async()=>{
 const {t,jobId}=await setup();const args={jobId,path:'src/oversized.ts',reason:'Exceeds 200 KB source limit',leaseId:'first'};
 await t.mutation(internal.repositories.skippedFile,args);
 await t.mutation(internal.repositories.skippedFile,args);
 expect(await t.run(ctx=>ctx.db.get(jobId))).toMatchObject({skippedTotal:501});
 await t.run(ctx=>ctx.db.patch(jobId,{batchLease:{id:'retry',expiresAt:Date.now()+60000},attempts:2}));
 await t.mutation(internal.repositories.skippedFile,{...args,leaseId:'retry'});
 const job=await t.run(ctx=>ctx.db.get(jobId));expect(job?.skippedTotal).toBe(501);expect(job?.skipped).toHaveLength(500);
 await t.mutation(internal.repositories.skippedFile,{...args,path:'src/binary.ts',reason:'Binary source',leaseId:'retry'});
 expect((await t.run(ctx=>ctx.db.get(jobId)))?.skippedTotal).toBe(502);
 const second=await t.run(async ctx=>{const {_id,_creationTime,...fields}=(await ctx.db.get(jobId))!;return ctx.db.insert('indexJobs',{...fields,skipped:[],skippedTotal:0});});
 await t.mutation(internal.repositories.skippedFile,{...args,jobId:second,leaseId:'retry'});
 expect((await t.run(ctx=>ctx.db.get(second)))?.skippedTotal).toBe(1);
 expect(await t.run(ctx=>ctx.db.query('indexSkippedFiles').withIndex('by_job_path',q=>q.eq('jobId',jobId)).collect())).toHaveLength(2);
 expect(await t.run(ctx=>ctx.db.query('indexSkippedFiles').withIndex('by_job_path',q=>q.eq('jobId',second)).collect())).toHaveLength(1);
});
test('stale, expired and disabled index writers cannot add skip counts',async()=>{
 const {t,jobId,repositoryId}=await setup();const args={jobId,path:'src/oversized.ts',reason:'Exceeds 200 KB source limit'};
 await t.mutation(internal.repositories.skippedFile,{...args,leaseId:'other'});
 await t.run(ctx=>ctx.db.patch(jobId,{batchLease:{id:'first',expiresAt:Date.now()-1}}));
 await t.mutation(internal.repositories.skippedFile,{...args,leaseId:'first'});
 await t.run(async ctx=>{await ctx.db.patch(jobId,{batchLease:{id:'first',expiresAt:Date.now()+60000}});await ctx.db.patch(repositoryId,{enabled:false});});
 await t.mutation(internal.repositories.skippedFile,{...args,leaseId:'first'});
 expect((await t.run(ctx=>ctx.db.get(jobId)))?.skippedTotal).toBe(500);
 expect(await t.run(ctx=>ctx.db.query('indexSkippedFiles').collect())).toHaveLength(0);
});
