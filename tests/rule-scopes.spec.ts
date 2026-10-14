import {test,expect} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import type {Id} from '../convex/_generated/dataModel';
import {applicableRules,ruleApplies,validRepositoryPattern} from '../src/rule-scopes';
const modules=import.meta.glob('../convex/**/*.ts');

test('rule scopes match by name pattern and team, never another workspace',()=>{
 const repo={_id:'r1',teamId:'t1',fullName:'Acme/Payments-Service'};
 expect(ruleApplies({title:'a'},repo)).toBe(true);
 expect(ruleApplies({title:'a',repositoryPattern:'acme/*-service'},repo)).toBe(true);
 expect(ruleApplies({title:'a',repositoryPattern:'acme/web*'},repo)).toBe(false);
 expect(ruleApplies({title:'a',teamId:'t1'},repo)).toBe(true);
 expect(ruleApplies({title:'a',teamId:'t2'},repo)).toBe(false);
 expect(ruleApplies({title:'a',teamId:'t1'},{...repo,teamId:undefined})).toBe(false);
 expect(ruleApplies({title:'a',repositoryId:'r2'},repo)).toBe(false);
 for(const ok of ['acme/*-service','acme/{api,web}','*/payments','acme/team/*'])expect(validRepositoryPattern(ok)).toBe(true);
 for(const bad of ['*','acme','a/','../x','acme/$(id)'])expect(validRepositoryPattern(bad)).toBe(false);
 // Same title: the most specific scope wins; different titles all apply.
 const rules:{title:string;createdAt:number;repositoryId?:string;teamId?:string;repositoryPattern?:string}[]=[{title:'Logging',createdAt:1},{title:'logging ',repositoryPattern:'acme/*-service',createdAt:2},{title:'Logging',teamId:'t1',createdAt:3},{title:'Cents',createdAt:4}];
 expect(applicableRules(rules,repo).map(r=>r.repositoryPattern??r.teamId??'workspace')).toEqual(['acme/*-service','workspace']);
 expect(applicableRules([...rules,{title:'LOGGING',repositoryId:'r1',createdAt:0}],repo).map(r=>r.repositoryId??r.repositoryPattern??'workspace')).toEqual(['r1','workspace']);
});

test('workspace, team, pattern and repository rules reach the right reviews; legacy rules keep their meaning; viewers are read-only',async()=>{
 process.env.SERVICE_SECRET='rules-service';process.env.SESSION_SECRET='rules-session-secret-at-least-32-characters';
 const t=convexTest(schema,modules);
 const sign=async(githubId:number)=>{const id=await t.mutation(api.users.login,{secret:'rules-service',githubId,login:'u'+githubId,avatar:''});return {id,token:await new SignJWT({}).setSubject(id).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.SESSION_SECRET))};};
 const admin=await sign(1),viewer=await sign(2),outsider=await sign(3);
 const organizationId=await t.mutation(api.users.createOrganization,{token:admin.token,name:'Rules'});
 const otherOrg=await t.mutation(api.users.createOrganization,{token:outsider.token,name:'Other'});
 await t.run(ctx=>ctx.db.insert('organizationMembers',{organizationId,userId:viewer.id,role:'viewer'}));
 await t.mutation(api.repositories.connect,{token:admin.token,secret:'rules-service',organizationId,installationId:91,account:'acme',accountId:1,repositories:[{id:1,fullName:'acme/payments-service',defaultBranch:'main'},{id:2,fullName:'acme/web',defaultBranch:'main'},{id:3,fullName:'acme/billing-service',defaultBranch:'main'}]});
 const repos=Object.fromEntries((await t.query(api.repositories.list,{token:admin.token,organizationId})).map(r=>[r.fullName,r._id])) as Record<string,Id<'repositories'>>;
 const team=await t.mutation(api.scopes.createTeam,{token:admin.token,organizationId,name:'Payments'});
 const foreignTeam=await t.mutation(api.scopes.createTeam,{token:outsider.token,organizationId:otherOrg,name:'Foreign'});
 await t.mutation(api.scopes.assign,{token:admin.token,repositoryId:repos['acme/payments-service'],teamId:team});
 const rule=(title:string,scope:Record<string,unknown>={})=>t.mutation(api.dashboard.rules,{token:admin.token,organizationId,title,instructions:title+' instructions.',category:'rules',severity:'medium',globs:[],enabled:true,...scope});
 await rule('Cents everywhere');
 await rule('Logging');
 await rule('logging',{repositoryPattern:'acme/*-service'});
 await rule('Payments idempotency',{teamId:team});
 await rule('Web accessibility',{repositoryId:repos['acme/web']});
 // Legacy rows written before scopes existed: no scope fields = workspace, repositoryId = one repository.
 await t.run(async ctx=>{
  await ctx.db.insert('customRules',{organizationId,title:'Legacy workspace',instructions:'x',category:'rules',severity:'low',globs:[],enabled:true,createdAt:1});
  await ctx.db.insert('customRules',{organizationId,repositoryId:repos['acme/billing-service'],title:'Legacy billing',instructions:'x',category:'rules',severity:'low',globs:[],enabled:true,createdAt:1});
  await ctx.db.insert('customRules',{organizationId,title:'Disabled',instructions:'x',category:'rules',severity:'low',globs:[],enabled:false,createdAt:1});
 });
 const titles=async(name:string)=>(await t.query(internal.repositories.data,{repositoryId:repos[name]})).rules.map(r=>r.title+(r.repositoryPattern?' (pattern)':'')).sort();
 expect(await titles('acme/payments-service')).toEqual(['Cents everywhere','Legacy workspace','Payments idempotency','logging (pattern)'].sort());
 expect(await titles('acme/web')).toEqual(['Cents everywhere','Legacy workspace','Logging','Web accessibility'].sort());
 expect(await titles('acme/billing-service')).toEqual(['Cents everywhere','Legacy billing','Legacy workspace','logging (pattern)'].sort());
 // The rules page for one repository lists every rule that applies to it (before same-title dedupe),
 // and viewers can read the rules of repositories they can see.
 const page=await t.query(api.dashboard.rulesPage,{token:admin.token,organizationId,repositoryId:repos['acme/payments-service']});
 expect(page.page.map(r=>r.title).sort()).toEqual(['Cents everywhere','Disabled','Legacy workspace','Logging','Payments idempotency','logging'].sort());
 const viewerPage=await t.query(api.dashboard.rulesPage,{token:viewer.token,organizationId,repositoryId:repos['acme/web']});
 expect(viewerPage.page.map(r=>r.title).sort()).toEqual(['Cents everywhere','Disabled','Legacy workspace','Logging','Web accessibility'].sort());
 // Viewers cannot change rules; invalid scopes are refused; changes are audited.
 await expect(t.mutation(api.dashboard.rules,{token:viewer.token,organizationId,title:'x',instructions:'y',category:'rules',severity:'low',globs:[],enabled:true})).rejects.toThrow();
 await expect(rule('Two scopes',{teamId:team,repositoryPattern:'acme/*'})).rejects.toThrow(/Choose one rule scope/);
 await expect(rule('Bad pattern',{repositoryPattern:'*'})).rejects.toThrow(/Invalid repository pattern/);
 await expect(rule('Foreign team',{teamId:foreignTeam})).rejects.toThrow(/Invalid team scope/);
 const audits=await t.run(ctx=>ctx.db.query('auditEvents').collect());
 expect(audits.filter(a=>a.action==='rule.created')).toHaveLength(5);
 const [web]=page.page.filter(r=>r.title==='Logging');
 await t.mutation(api.dashboard.rules,{token:admin.token,organizationId,id:web._id,remove:true,title:web.title,instructions:web.instructions,category:web.category,severity:web.severity,globs:[],enabled:true});
 expect((await t.run(ctx=>ctx.db.query('auditEvents').collect())).some(a=>a.action==='rule.deleted'&&a.target===web._id)).toBe(true);
});
