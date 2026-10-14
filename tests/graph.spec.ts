import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts');

test('neighborhood traverses resolved edges two hops, expands packages, ignores raw calls and other tenants',async()=>{
 const t=convexTest(schema,modules);
 const {a,b}=await t.run(async ctx=>{
  const mk=async(name:string)=>{const organizationId=await ctx.db.insert('organizations',{name,createdAt:Date.now()});const repositoryId=await ctx.db.insert('repositories',{organizationId,fullName:name+'/app',defaultBranch:'main',enabled:true,indexStatus:'ready',createdAt:Date.now()});return {organizationId,repositoryId};};
  const a=await mk('alpha'),b=await mk('beta');const storageId=await ctx.storage.store(new Blob(['x']));
  for(const path of ['internal/pay/a.go','internal/pay/b.go','internal/pay/sub/c.go'])await ctx.db.insert('repositoryFiles',{...a,path,sha:'s',storageId,language:'go',updatedAt:0});
  const edge=(r:typeof a,from:string,to:string,kind:string,resolved?:boolean)=>ctx.db.insert('relationships',{...r,from,sourcePath:from,to,kind,...(resolved===undefined?{}:{resolved})});
  await edge(a,'src/cart.ts','src/billing.ts','calls',true);
  await edge(a,'src/payments.ts','src/cart.ts','calls',true);
  await edge(a,'src/api.ts','src/payments.ts','calls',true);
  await edge(a,'tests/billing.test.ts','src/billing.ts','imports');
  await edge(a,'src/billing.ts','legacyRawCallee','calls');
  await edge(a,'src/billing.ts','internal/pay/','imports',true);
  await edge(b,'src/beta-secret.ts','src/billing.ts','calls',true);
  return {a,b};
 });
 const result=await t.query(internal.context.neighborhood,{repositoryId:a.repositoryId,paths:['src/billing.ts'],hops:2});
 const paths=result.map(n=>n.path);
 expect(paths.slice(0,1)).toEqual(['src/cart.ts']);
 expect(paths).toEqual(expect.arrayContaining(['tests/billing.test.ts','src/payments.ts','internal/pay/a.go','internal/pay/b.go']));
 expect(paths).not.toContain('internal/pay/sub/c.go');
 expect(paths).not.toContain('src/api.ts');
 expect(paths).not.toContain('legacyRawCallee');
 expect(paths).not.toContain('src/beta-secret.ts');
 expect(result.find(n=>n.path==='src/payments.ts')).toMatchObject({hops:2});
 expect((await t.query(internal.context.neighborhood,{repositoryId:b.repositoryId,paths:['src/billing.ts']})).map(n=>n.path)).toEqual(['src/beta-secret.ts']);
});
