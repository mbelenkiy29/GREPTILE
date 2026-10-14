import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');

test('previous head is the latest earlier completed review of the same PR; finding comment ids are scoped to the PR',async()=>{
 const t=convexTest(schema,modules);
 const ids=await t.run(async ctx=>{
  const organizationId=await ctx.db.insert('organizations',{name:'History',createdAt:0});
  const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:'o/r',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:0});
  const review=(prNumber:number,headSha:string,status:string,createdAt:number)=>ctx.db.insert('reviews',{organizationId,repositoryId,prNumber,headSha,status,mode:'standard',attempts:1,createdAt,updatedAt:createdAt});
  const old=await review(1,'a'.repeat(40),'completed',1),failed=await review(1,'b'.repeat(40),'failed',2),latest=await review(1,'c'.repeat(40),'completed',3),otherPr=await review(2,'d'.repeat(40),'completed',4),current=await review(1,'e'.repeat(40),'queued',5);
  for(const [reviewId,githubId,fingerprint] of [[old,10,'fp-old'],[latest,11,'fp-new'],[latest,'gitlab-note','fp-new'],[otherPr,12,'fp-new'],[latest,13,undefined]] as const)await ctx.db.insert('reviewComments',{organizationId,reviewId,githubId,...(fingerprint?{fingerprint}:{}),createdAt:0});
  return {repositoryId,failed,current,old};
 });
 expect(await t.query(internal.reviews.previousHead,{reviewId:ids.current})).toBe('c'.repeat(40));
 expect(await t.query(internal.reviews.previousHead,{reviewId:ids.old})).toBeNull();
 expect(await t.query(internal.reviews.findingCommentIds,{repositoryId:ids.repositoryId,prNumber:1,fingerprints:['fp-new','fp-old']})).toEqual([{commentId:11,fingerprint:'fp-new'},{commentId:10,fingerprint:'fp-old'}]);
 expect(await t.query(internal.reviews.findingCommentIds,{repositoryId:ids.repositoryId,prNumber:1,fingerprints:['missing']})).toEqual([]);
});
