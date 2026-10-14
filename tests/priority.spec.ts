import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {z} from 'zod';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');
test('review detail (REST API and MCP) adds priority, tags and outsideDiff without changing existing finding fields',async()=>{
 process.env.SERVICE_SECRET='priority-service';process.env.SESSION_SECRET='priority-session-secret-at-least-32-characters';
 const t=convexTest(schema,modules);
 const id=await t.mutation(api.users.login,{secret:'priority-service',githubId:1,login:'priority-1',avatar:''});
 const token=await new SignJWT({}).setSubject(id).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
 const organizationId=await t.mutation(api.users.createOrganization,{token,name:'Priority'});
 await t.mutation(api.repositories.connect,{token,secret:'priority-service',organizationId,installationId:78,account:'priority-1',accountId:1,repositories:[{id:780,fullName:'priority/repo',defaultBranch:'main'}]});
 const [repo]=await t.query(api.repositories.list,{token,organizationId});
 const base={description:'The guard treats a missing user as active and exposes the route.',confidence:.95,filePath:'auth.ts',startLine:2,endLine:2,commitSha:'a'.repeat(40),evidence:[{filePath:'auth.ts',startLine:2,quote:'return user?.active !== false;'}],impact:'Deleted users keep access.',suggestedFix:'Require an active user.',symbol:'allowed'};
 const findings=[
  {...base,title:'Deleted accounts stay authorized',severity:'high',category:'security',agent:'security',fingerprint:'p-security'},
  {...base,title:'Caller still multiplies cents',severity:'critical',category:'correctness',agent:'correctness',fingerprint:'p-outside',filePath:'pay.ts',outsideDiff:true},
  {...base,title:'Rounding drops a cent',severity:'medium',category:'correctness',agent:'correctness',fingerprint:'p-medium'},
 ];
 const reviewId=await t.run(ctx=>ctx.db.insert('reviews',{organizationId,repositoryId:repo._id,prNumber:1,headSha:base.commitSha,status:'summarizing',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()}));
 const storageId=await t.run(ctx=>ctx.storage.store(new Blob(['{}'])));
 await t.mutation(internal.reviews.save,{reviewId,storageId,summary:'Recorded review.',reviewScore:{value:1,reason:'A critical caller defect blocks merging this change.'},verdict:'changes',findings,resolved:[],usage:[]});
 const detail=await t.query(api.reviews.detail,{token,reviewId});
 expect(detail.review.verdict).toBe('changes');
 const byTitle=Object.fromEntries(detail.findings.map(f=>[f.title,f]));
 expect([byTitle['Deleted accounts stay authorized'].priority,byTitle['Caller still multiplies cents'].priority,byTitle['Rounding drops a cent'].priority]).toEqual(['P1','P0','P2']);
 expect(byTitle['Deleted accounts stay authorized'].tags).toEqual(['security']);
 expect(byTitle['Rounding drops a cent'].tags).toEqual([]);
 expect(byTitle['Caller still multiplies cents'].outsideDiff).toBe(true);
 expect(byTitle['Rounding drops a cent'].outsideDiff).toBeUndefined();
 // An old client's strict schema of the previous shape still parses once the additive keys are ignored,
 // and every previous field keeps its value and type.
 const previous=z.object({_id:z.string(),title:z.string(),description:z.string(),severity:z.enum(['critical','high','medium','low']),confidence:z.number(),category:z.string(),filePath:z.string(),startLine:z.number(),endLine:z.number(),evidence:z.array(z.object({filePath:z.string(),startLine:z.number(),quote:z.string()})),impact:z.string(),suggestedFix:z.string(),agent:z.string(),symbol:z.string(),fingerprint:z.string(),commitSha:z.string(),currentStatus:z.string(),canFix:z.boolean()});
 for(const f of detail.findings){
  const {priority,tags,outsideDiff,...rest}=f;void priority;void tags;void outsideDiff;
  expect(previous.passthrough().safeParse(rest).success).toBe(true);
  const saved=findings.find(s=>s.fingerprint===f.fingerprint)!;
  expect(f.severity).toBe(saved.severity);expect(f.category).toBe(saved.category);
 }
});
