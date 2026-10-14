import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
test('review numbers count published reviews per pull request; retries, resumes and replays reuse the number',async()=>{
 const t=convexTest(schema,modules);
 const {repositoryId,organizationId}=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'Footer',createdAt:Date.now()} as never);
  const repositoryId=await ctx.db.insert('repositories',{organizationId,installationId:1,githubId:1,fullName:'o/r',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()} as never);
  return {repositoryId,organizationId};
 });
 const review=(prNumber:number,status='publishing')=>t.run(ctx=>ctx.db.insert('reviews',{organizationId,repositoryId,prNumber,headSha:'a'.repeat(40),status,mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()}));
 const first=await review(7),cancelled=await review(7,'cancelled'),second=await review(7),other=await review(8);
 const number=(reviewId:Awaited<ReturnType<typeof review>>)=>t.mutation(internal.reviews.assignNumber,{reviewId});
 expect(await number(first)).toBe(1);
 // A publish retry or a resumed persisted result reuses the stored number.
 expect(await number(first)).toBe(1);
 expect(await number(second)).toBe(2);
 expect(await number(first)).toBe(1);
 // Other pull requests count separately; reviews that never publish (cancelled) take no number.
 expect(await number(other)).toBe(1);
 expect((await t.run(ctx=>ctx.db.get(cancelled)))?.reviewNumber).toBeUndefined();
 const third=await review(7);
 expect(await number(third)).toBe(3);
});
