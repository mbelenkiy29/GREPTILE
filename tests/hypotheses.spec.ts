import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
test('review diagnostics list each investigated hypothesis with its status for repository readers only',async()=>{
 process.env.SERVICE_SECRET='hypotheses-service';process.env.SESSION_SECRET='hypotheses-session-secret-at-least-32-characters';
 const t=convexTest(schema,modules);
 const sign=async(githubId:number)=>new SignJWT({}).setSubject(await t.mutation(api.users.login,{secret:'hypotheses-service',githubId,login:'h'+githubId,avatar:''})).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const alice=await sign(1),bob=await sign(2);
 const organizationId=await t.mutation(api.users.createOrganization,{token:alice,name:'Hypotheses'});
 await t.mutation(api.users.createOrganization,{token:bob,name:'Other'});
 await t.mutation(api.repositories.connect,{token:alice,secret:'hypotheses-service',organizationId,installationId:71,account:'h1',accountId:1,repositories:[{id:710,fullName:'h/repo',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token:alice,organizationId});
 const hypotheses=[{id:1,claim:'Callers of total() still treat cents as dollars',category:'correctness',filePath:'cart.ts',startLine:2,status:'completed',stopReason:'completed',toolCalls:3,turns:3,reported:1},{id:2,claim:'Refunds reuse the old dollar conversion',category:'correctness',filePath:'cart.ts',startLine:2,status:'skipped',stopReason:'total hypothesis token budget exhausted',toolCalls:0,turns:0,reported:0}];
 const reviewId=await t.run(async ctx=>{
  const resultStorageId=await ctx.storage.store(new Blob([JSON.stringify({metadata:{engine:'hypotheses',hypotheses,coverageLimits:['1 of 2 hypotheses were not investigated because the total hypothesis budget ran out']}})]));
  return ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:1,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now(),resultStorageId});
 });
 const diagnostics=await t.action(api.jobs.diagnostics,{token:alice,reviewId});
 expect(diagnostics?.hypotheses).toEqual(hypotheses);
 expect(diagnostics?.coverageLimits).toEqual(['1 of 2 hypotheses were not investigated because the total hypothesis budget ran out']);
 await expect(t.action(api.jobs.diagnostics,{token:bob,reviewId})).rejects.toThrow();
});
