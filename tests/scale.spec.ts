import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
// Above the 32,000 documents-scanned-per-transaction ceiling that the old whole-repository
// `.collect()` in repositories.data would hit on every review and index batch.
const FILES=33_000;
async function setup(){
 const t=convexTest(schema,modules);
 const state=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Monorepo',createdAt:Date.now()});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'fixture/monorepo',defaultBranch:'main',enabled:true,indexStatus:'indexing',createdAt:Date.now()});
  const storageId=await ctx.storage.store(new Blob(['export const value = 1;']));
  // Removal deletes each file's blob, so the swept files get their own.
  for(let i=0;i<FILES;i++)await ctx.db.insert('repositoryFiles',{organizationId,repositoryId,path:`pkg${String(i%50).padStart(2,'0')}/src/file${i}.ts`,sha:'s'+i,storageId:i<2?await ctx.storage.store(new Blob(['own'])):storageId,language:'ts',updatedAt:0});
  const jobId=await ctx.db.insert('indexJobs',{organizationId,repositoryId,sha:'b'.repeat(40),status:'running',total:FILES,processed:0,changed:0,attempts:1,createdAt:Date.now(),updatedAt:Date.now()});
  return {organizationId,repositoryId,jobId};
 });
 return {t,...state};
}
test('a repository above the old read ceiling is served by bounded, need-based reads',async()=>{
 const {t,repositoryId,jobId}=await setup();
 const data=await t.query(internal.repositories.data,{repositoryId});
 expect(data.repo._id).toBe(repositoryId);
 expect('files' in data).toBe(false);
 // Full inventory only through ≤1000-row pages.
 const seen=new Set<string>();let cursor:string|null=null,pages=0;
 for(;;){
  const page:{files:{path:string}[];cursor:string;done:boolean}=await t.query(internal.repositories.filePage,{repositoryId,cursor,numItems:5000});
  expect(page.files.length).toBeLessThanOrEqual(1000);
  for(const f of page.files)seen.add(f.path);
  pages++;if(page.done)break;cursor=page.cursor;
 }
 expect(seen.size).toBe(FILES);expect(pages).toBeGreaterThanOrEqual(33);
 // A review or index batch looks up exactly the paths it needs.
 const wanted=['pkg07/src/file7.ts','pkg49/src/file32999.ts','missing.ts'];
 expect((await t.query(internal.repositories.filesByPath,{repositoryId,paths:wanted})).map(f=>f.path).sort()).toEqual(wanted.slice(0,2).sort());
 await expect(t.query(internal.repositories.filesByPath,{repositoryId,paths:Array.from({length:201},(_,i)=>'p'+i)})).rejects.toThrow('exceeds 200');
 const under=await t.query(internal.repositories.filesUnder,{repositoryId,directories:['pkg03/src'],paths:[],limit:30});
 expect(under).toHaveLength(30);expect(under.every(f=>f.path.startsWith('pkg03/src/'))).toBe(true);
 // Completion no longer reads or receives the whole inventory: stale files are swept in small batches.
 await expect(t.mutation(internal.repositories.removeIndexedFiles,{repositoryId,jobId,paths:Array.from({length:26},(_,i)=>'x'+i)})).rejects.toThrow('exceeds 25');
 expect(await t.mutation(internal.repositories.removeIndexedFiles,{repositoryId,jobId,paths:['pkg00/src/file0.ts','pkg01/src/file1.ts']})).toBe(true);
 expect(await t.mutation(internal.repositories.finishIndex,{repositoryId,jobId,sha:'b'.repeat(40),processed:FILES-2,knowledgePaths:['pkg00/src/file0.ts','pkg02/src/file2.ts','never-indexed.ts'],removedPaths:['pkg00/src/file0.ts']})).toBe(true);
 const repo=await t.run(ctx=>ctx.db.get(repositoryId));
 expect(repo).toMatchObject({indexStatus:'ready',indexedSha:'b'.repeat(40),knowledgePaths:['pkg00/src/file0.ts','pkg02/src/file2.ts']});
 expect(await t.run(ctx=>ctx.db.get(jobId))).toMatchObject({status:'completed',processed:FILES-2});
 expect((await t.query(internal.repositories.filesByPath,{repositoryId,paths:['pkg00/src/file0.ts','pkg01/src/file1.ts']}))).toHaveLength(0);
},120_000);
