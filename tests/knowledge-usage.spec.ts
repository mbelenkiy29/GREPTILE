import {test,expect,vi,afterEach} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
import {HttpModel,ModelFailure} from '../src/engine/model';

const modules=import.meta.glob('../convex/**/*.ts');
afterEach(()=>vi.restoreAllMocks());
test('failed knowledge generation retains billed usage and schedules recovery without saving invented entries',async()=>{
 const t=convexTest(schema,modules);
 const repositoryId=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Knowledge usage',createdAt:Date.now()});
  const id=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/knowledge',defaultBranch:'main',enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40),createdAt:Date.now()});
  const storageId=await ctx.storage.store(new Blob(['export const price = 100;']));
  await ctx.db.insert('repositoryFiles',{organizationId,repositoryId:id,path:'src/price.ts',sha:'a'.repeat(40),storageId,language:'typescript',updatedAt:Date.now()});
  return id;
 });
 vi.spyOn(HttpModel.prototype,'generate').mockRejectedValue(new ModelFailure('Structured output rejected',{task:'knowledge',provider:'fixture',model:'fixture',inputTokens:123,outputTokens:45,estimatedCost:.0123,latencyMs:25,cached:false}));
 await t.action(internal.knowledgeJobs.generate,{repositoryId,paths:['src/price.ts']});
 expect(await t.run(ctx=>ctx.db.query('usageEvents').collect())).toEqual([expect.objectContaining({repositoryId,kind:'knowledge',inputTokens:123,outputTokens:45,estimatedCost:.0123})]);
 expect(await t.run(ctx=>ctx.db.get(repositoryId))).toMatchObject({knowledgeStatus:'failed',knowledgeAttempt:1});
 expect(await t.run(ctx=>ctx.db.query('knowledgeEntries').collect())).toEqual([]);
 expect(await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).toEqual([expect.objectContaining({args:[{repositoryId,paths:['src/price.ts'],attempt:2}]})]);
});
