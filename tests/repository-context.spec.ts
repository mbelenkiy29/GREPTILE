import {test,expect,vi,afterEach} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
const modules=import.meta.glob('../convex/**/*.ts'),secret='repository-context-fixture-secret-at-least-32-characters';
afterEach(()=>vi.restoreAllMocks());
test('GitHub context rejects recycled usernames and legacy receipts, and survives a verified account rename',async()=>{
 const s=await setup(),selected=await s.select();expect(selected.receipt?.githubActorId).toBe('5100');
 for(const id of [undefined,'5101','05100','0','invalid']){
  const denied=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'alice',...(id?{authorExternalId:id}:{})});expect(denied.receipt).toBeNull();expect(denied.sources).toEqual([]);
 }
 const legacy={...selected.receipt!};delete legacy.githubActorId;await expect(s.t.query(internal.repositoryContext.validate,{receipt:legacy})).rejects.toThrow('identity changed');
 await s.t.run(ctx=>ctx.db.patch(s.user,{githubId:5101}));await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('identity changed');expect((await s.select()).receipt).toBeNull();
 await s.t.run(ctx=>ctx.db.patch(s.user,{githubId:5100,login:'renamed'}));await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('identity changed');
 const renamed=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'renamed',authorExternalId:'5100'});expect(renamed.receipt?.userId).toBe(s.user);expect(renamed.sources).toHaveLength(1);expect(await s.t.query(internal.repositoryContext.validate,{receipt:renamed.receipt!})).toBe(true);
});
async function setup(){
 process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='context-service';
 const t=convexTest(schema,modules),user=await t.mutation(api.users.login,{secret:'context-service',githubId:5100,login:'alice',avatar:''}),token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret)),organizationId=await t.mutation(api.users.createOrganization,{token,name:'Context fixture'});
 await t.mutation(api.repositories.connect,{token,secret:'context-service',organizationId,installationId:7100,account:'alice',accountId:5100,repositories:[{id:7101,fullName:'alice/main',defaultBranch:'main'},{id:7102,fullName:'alice/source',defaultBranch:'main'}]});
 const [main,source]=await t.query(api.repositories.list,{token,organizationId});await t.run(async ctx=>{for(const repo of [main,source])await ctx.db.patch(repo._id,{enabled:true,indexStatus:'ready',indexedSha:'a'.repeat(40)});});
 await t.mutation(api.scopes.cluster,{token,organizationId,name:'Explicit context',repositoryIds:[main._id,source._id]});
 const select=()=>t.query(internal.repositoryContext.select,{repositoryId:main._id,actor:'alice',authorExternalId:'5100'});return {t,token,user,organizationId,main,source,select};
}
test('historical review links disclose the latest review only while all its source repositories are readable',async()=>{
 const s=await setup(),receipt=(await s.select()).receipt!,now=Date.now();
 const oldId=await s.t.run(ctx=>ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.main._id,prNumber:1,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:now,updatedAt:now}));
 const latestId=await s.t.run(ctx=>ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.main._id,prNumber:1,headSha:'b'.repeat(40),status:'completed',mode:'standard',attempts:1,repositoryContext:receipt,createdAt:now+1,updatedAt:now+1}));
 const user=await s.t.mutation(api.users.login,{secret:'context-service',githubId:5104,login:'history-reader',avatar:''}),token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const invitationId=await s.t.mutation(api.users.invite,{token:s.token,organizationId:s.organizationId,githubLogin:'history-reader',role:'member'});await s.t.mutation(api.users.acceptInvitation,{token,invitationId});
 const team=await s.t.mutation(api.scopes.createTeam,{token:s.token,organizationId:s.organizationId,name:'Private latest source'});await s.t.mutation(api.scopes.assign,{token:s.token,repositoryId:s.source._id,teamId:team});
 const inspect=()=>s.t.query(api.reviews.detail,{token,reviewId:oldId});
 const hidden=await inspect();expect(hidden.review._id).toBe(oldId);expect(hidden.latestReviewId).toBeUndefined();expect(hidden.history.page.map(r=>r._id)).toEqual([oldId]);
 await expect(s.t.query(api.reviews.detail,{token,reviewId:latestId})).rejects.toThrow('Team access denied');
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:user,role:'viewer',remove:false});
 const visible=await inspect();expect(visible.latestReviewId).toBe(latestId);expect(visible.history.page.map(r=>r._id)).toEqual([latestId,oldId]);
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:user,role:'viewer',remove:true});expect((await inspect()).latestReviewId).toBeUndefined();
 expect((await s.t.query(api.reviews.detail,{token:s.token,reviewId:oldId})).latestReviewId).toBe(latestId);
});
test('context is explicitly clustered, author scoped and denied across inaccessible teams or unlinked native authors',async()=>{
 const s=await setup(),selected=await s.select();expect(selected.sources.map(r=>r.repo._id)).toEqual([s.source._id]);
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'unlinked'})).sources).toEqual([]);
 const native=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'alice',nativeAuthor:true});expect(native.sources).toEqual([]);expect(native.coverage.join()).toContain('personal P4 identity');
 const other=await s.t.mutation(api.users.login,{secret:'context-service',githubId:5101,login:'bob',avatar:''}),bobToken=await new SignJWT({}).setSubject(other).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const invitationId=await s.t.mutation(api.users.invite,{token:s.token,organizationId:s.organizationId,githubLogin:'bob',role:'member'});await s.t.mutation(api.users.acceptInvitation,{token:bobToken,invitationId});
 const team=await s.t.mutation(api.scopes.createTeam,{token:s.token,organizationId:s.organizationId,name:'Other team'});await s.t.mutation(api.scopes.assign,{token:s.token,repositoryId:s.source._id,teamId:team});
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'bob',authorExternalId:'5101'})).sources).toEqual([]);
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:other,role:'member',remove:false});const authorized=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'bob',authorExternalId:'5101'});expect(authorized.sources).toHaveLength(1);
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:other,role:'member',remove:true});await expect(s.t.query(internal.repositoryContext.validate,{receipt:authorized.receipt!})).rejects.toThrow('Team access denied');
});
test('pinned context guards cache reads/writes and fails after revision, disable or cluster removal',async()=>{
 const s=await setup(),receipt=(await s.select()).receipt!,context={repositoryId:s.main._id,scopes:[],repositoryContext:receipt};
 await s.t.mutation(internal.cache.set,{organizationId:s.organizationId,key:'context-key',result:'authorized',context});expect(await s.t.query(internal.cache.get,{organizationId:s.organizationId,key:'context-key',context})).toBe('authorized');
 await s.t.run(ctx=>ctx.db.patch(s.source._id,{indexedSha:'b'.repeat(40)}));await expect(s.t.query(internal.cache.get,{organizationId:s.organizationId,key:'context-key',context})).rejects.toThrow('revision');await expect(s.t.mutation(internal.cache.set,{organizationId:s.organizationId,key:'context-key',result:'stale',context})).rejects.toThrow('revision');
 await s.t.run(ctx=>ctx.db.patch(s.source._id,{indexedSha:receipt.sources[0].revision,enabled:false}));await expect(s.t.query(internal.repositoryContext.validate,{receipt})).rejects.toThrow('disabled');
 await s.t.run(ctx=>ctx.db.patch(s.source._id,{enabled:true}));await s.t.mutation(api.scopes.cluster,{token:s.token,organizationId:s.organizationId,id:receipt.clusters[0].id,name:'',repositoryIds:[],remove:true});await expect(s.t.query(internal.repositoryContext.validate,{receipt})).rejects.toThrow('cluster changed');
});
test('editing cluster members invalidates old context while renaming preserves its source authority',async()=>{
 const s=await setup(),receipt=(await s.select()).receipt!,id=receipt.clusters[0].id;
 await s.t.mutation(api.scopes.cluster,{token:s.token,organizationId:s.organizationId,id,name:'Renamed context',repositoryIds:[s.main._id,s.source._id]});
 expect(await s.t.query(internal.repositoryContext.validate,{receipt})).toBe(true);
 await expect(s.t.mutation(api.scopes.cluster,{token:s.token,organizationId:s.organizationId,id,name:'Invalid',repositoryIds:[s.main._id]})).rejects.toThrow('2–20');
 expect((await s.t.query(api.scopes.list,{token:s.token,organizationId:s.organizationId})).clusters[0].name).toBe('Renamed context');
 const replacement=await s.t.run(ctx=>ctx.db.insert('repositories',{organizationId:s.organizationId,installationId:7100,githubId:7103,fullName:'alice/replacement',defaultBranch:'main',enabled:true,indexStatus:'ready',indexedSha:'c'.repeat(40),createdAt:Date.now()}));
 await s.t.mutation(api.scopes.cluster,{token:s.token,organizationId:s.organizationId,id,name:'Changed sources',repositoryIds:[s.main._id,replacement]});
 await expect(s.t.query(internal.repositoryContext.validate,{receipt})).rejects.toThrow('cluster changed');
 const updated=await s.select();expect(updated.sources.map(r=>r.repo._id)).toEqual([replacement]);expect(updated.receipt?.sources[0].revision).toBe('c'.repeat(40));
});

test('saved review results must bind the context receipt to the reviewed repository',async()=>{
 const s=await setup(),receipt=(await s.select()).receipt!;
 const reviewId=await s.t.run(ctx=>ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.source._id,prNumber:1,headSha:'a'.repeat(40),status:'summarizing',mode:'standard',attempts:1,createdAt:Date.now(),updatedAt:Date.now()})),storageId=await s.t.run(ctx=>ctx.storage.store(new Blob(['{}'])));
 await expect(s.t.mutation(internal.reviews.save,{reviewId,storageId,summary:'Not published',repositoryContext:receipt,findings:[],resolved:[],usage:[]})).rejects.toThrow('another review repository');
});

test('review detail, lists and Fix require reader access to every recorded source repository',async()=>{
 const s=await setup(),receipt=(await s.select()).receipt!;
 await s.t.mutation(internal.knowledge.save,{repositoryId:s.main._id,sha:'a'.repeat(40),entries:[{subsystem:'Totals',description:'Primary repository totals',files:['total.ts'],dependencies:[],risks:[],conventions:[]}]});
 const reviewId=await s.t.run(ctx=>ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.main._id,prNumber:1,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,summary:'Private source evidence',repositoryContext:receipt,createdAt:Date.now(),updatedAt:Date.now()}));
 const now=Date.now();
 const approvalId=await s.t.run(ctx=>ctx.db.insert('approvalJobs',{organizationId:s.organizationId,repositoryId:s.main._id,reviewId,prNumber:1,headSha:'a'.repeat(40),policyKey:'fixture',status:'blocked',reasons:['Private context assessment'],createdAt:now,updatedAt:now}));
 await s.t.run(async ctx=>{
  await ctx.db.insert('findings',{organizationId:s.organizationId,repositoryId:s.main._id,reviewId,prNumber:1,title:'Private context bug',description:'Private evidence',severity:'high',confidence:1,category:'data',filePath:'total.ts',startLine:1,endLine:1,commitSha:'a'.repeat(40),evidence:[{filePath:'context/'+s.source._id+'/total.ts',startLine:1,quote:'private'}],impact:'Wrong units',suggestedFix:'Preserve cents',agent:'data',symbol:'total',fingerprint:'private-cents',status:'open',createdAt:now,updatedAt:now});
  await ctx.db.insert('usageEvents',{organizationId:s.organizationId,repositoryId:s.main._id,reviewId,kind:'review',inputTokens:100,outputTokens:50,estimatedCost:0.5,durationMs:100,createdAt:now});
 });
 const user=await s.t.mutation(api.users.login,{secret:'context-service',githubId:5102,login:'viewer',avatar:''}),token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const invitationId=await s.t.mutation(api.users.invite,{token:s.token,organizationId:s.organizationId,githubLogin:'viewer',role:'member'});await s.t.mutation(api.users.acceptInvitation,{token,invitationId});
 const team=await s.t.mutation(api.scopes.createTeam,{token:s.token,organizationId:s.organizationId,name:'Source team'});await s.t.mutation(api.scopes.assign,{token:s.token,repositoryId:s.source._id,teamId:team});
 await expect(s.t.query(api.reviews.detail,{token,reviewId})).rejects.toThrow('Team access denied');expect((await s.t.query(api.reviews.list,{token,organizationId:s.organizationId})).page).toEqual([]);await expect(s.t.mutation(api.bridge.createFix,{token,reviewId,agent:'codex'})).rejects.toThrow('Team access denied');
 await expect(s.t.query(api.approvals.review,{token,reviewId})).rejects.toThrow('Team access denied');
 const analytics={token,organizationId:s.organizationId,since:now-1000,until:now+1000};
 expect(await s.t.query(api.analytics.report,analytics)).toMatchObject({totalReviews:0,findings:0,cost:0,tokens:0});
 expect(await s.t.query(api.dashboard.overview,{token,organizationId:s.organizationId})).toMatchObject({reviews:[],findings:[],usage:[]});
 expect((await s.t.query(api.dashboard.knowledge,{token,repositoryId:s.main._id}))[0].pastFindings).toEqual([]);
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:user,role:'viewer',remove:false});expect((await s.t.query(api.reviews.detail,{token,reviewId})).review.summary).toBe('Private source evidence');expect((await s.t.query(api.reviews.list,{token,organizationId:s.organizationId})).page).toHaveLength(1);
 expect((await s.t.query(api.approvals.review,{token,reviewId}))?._id).toBe(approvalId);
 expect(await s.t.query(api.analytics.report,analytics)).toMatchObject({totalReviews:1,findings:1,cost:0.5,tokens:150});
 const visible=await s.t.query(api.dashboard.overview,{token,organizationId:s.organizationId});expect(visible.reviews).toHaveLength(1);expect(visible.findings).toHaveLength(1);expect(visible.usage).toHaveLength(1);
 expect((await s.t.query(api.dashboard.knowledge,{token,repositoryId:s.main._id}))[0].pastFindings).toHaveLength(1);
 // Costs/findings remain period-wide even when their review started outside the period.
 await s.t.run(ctx=>ctx.db.patch(reviewId,{createdAt:now-2000}));
 expect(await s.t.query(api.analytics.report,analytics)).toMatchObject({totalReviews:0,findings:1,cost:0.5});
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:user,role:'viewer',remove:true});
 expect(await s.t.query(api.analytics.report,analytics)).toMatchObject({totalReviews:0,findings:0,cost:0});
 expect(await s.t.query(api.dashboard.overview,{token,organizationId:s.organizationId})).toMatchObject({reviews:[],findings:[],usage:[]});
 expect((await s.t.query(api.dashboard.knowledge,{token,repositoryId:s.main._id}))[0].pastFindings).toEqual([]);
 await s.t.run(async ctx=>{for(let i=0;i<100;i++)await ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.main._id,prNumber:i+10,headSha:'a'.repeat(40),status:'completed',mode:'standard',attempts:1,createdAt:now,updatedAt:now});});
 const bounded=await s.t.query(api.dashboard.overview,{token,organizationId:s.organizationId});expect(bounded.reviews).toHaveLength(100);expect(bounded.findings).toEqual([]);expect(bounded.usage).toEqual([]);
 await expect(s.t.query(api.approvals.review,{token,reviewId})).rejects.toThrow('Team access denied');

});

test('native username equality cannot authorize an unlinked code-provider author',async()=>{
 const s=await setup(),receipt=(await s.select()).receipt!;
 const connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'gitlab',instance:'https://gitlab.com',name:'Native fixture',credentials:'fixture-only',webhookSecret:'',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId}));
 const selected=await s.select();expect(selected.sources).toEqual([]);expect(selected.coverage.join()).toContain('personal provider identity');await expect(s.t.query(internal.repositoryContext.validate,{receipt})).rejects.toThrow('provider identity changed');
});

test('native provider authors require verified immutable identities, and revoke/relink invalidates context receipts',async()=>{
 const s=await setup(),connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'gitlab',instance:'https://gitlab.com',name:'Native',credentials:'encrypted',webhookSecret:'fixture',active:true,createdAt:Date.now()}));
 await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId,externalId:'100'}));
 const digest=(await import('../convex/providerIdentities')).providerIdentityDigest,base={token:s.token,repositoryId:s.main._id,connectionId,digest:await digest({kind:'gitlab',instance:'https://gitlab.com',credentials:'encrypted'}),externalId:'99',username:'native-author',credentials:'personal-encrypted'};
 const identityId=await s.t.mutation(internal.providerIdentities.save,base);
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-author',authorExternalId:'other-id'})).sources).toHaveLength(0);
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'wrong-name',authorExternalId:'99'})).sources).toHaveLength(0);
 const selected=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-author',authorExternalId:'99'});expect(selected.receipt?.userId).toBe(s.user);expect(selected.sources).toHaveLength(1);
 await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id:identityId});await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('revoked');
 await s.t.mutation(internal.providerIdentities.save,base);await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('replaced');
 const fresh=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-author',authorExternalId:'99'});await s.t.run(ctx=>ctx.db.patch(connectionId,{credentials:'replaced'}));await expect(s.t.query(internal.repositoryContext.validate,{receipt:fresh.receipt!})).rejects.toThrow('connection authority');
});

test('provider identity linking authenticates a personal token and retains only encrypted credentials',async()=>{
 const s=await setup();process.env.CREDENTIAL_ENCRYPTION_KEY='personal-identity-test-key-at-least-32-characters';
 const connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'gitlab',instance:'https://gitlab.com',name:'Native',credentials:'encrypted',webhookSecret:'fixture',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId,externalId:'100'}));
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({id:99,username:'native-author',state:'active'})));
 const id=await s.t.action(api.providerIdentityJobs.connect,{token:s.token,repositoryId:s.main._id,personalToken:'fixture-personal-token'});
 const authority=await s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id});expect(authority.identity.externalId).toBe('99');expect(authority.identity.credentials).not.toContain('fixture-personal-token');expect(fetch.mock.calls[0][0]).toBe('https://gitlab.com/api/v4/user');expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
 const list=await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId});expect(list[0].identity).not.toHaveProperty('credentials');
 const receipt=(await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-author',authorExternalId:'99'})).receipt!;
 fetch.mockResolvedValue(new Response(JSON.stringify({id:99,username:'native-author',state:'active'})));expect(await s.t.action(internal.repositoryContextJobs.validate,{receipt})).toBe(true);
 fetch.mockResolvedValue(new Response(JSON.stringify({id:100,username:'native-author',state:'active'})));await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt})).rejects.toThrow('identity changed');
 fetch.mockResolvedValue(new Response('{}',{status:401}));await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt})).rejects.toThrow('authenticated');await expect(s.t.action(api.providerIdentityJobs.connect,{token:s.token,repositoryId:s.main._id,personalToken:'revoked-token'})).rejects.toThrow('authenticated');expect((await s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id})).identity.generation).toBe(1);
});

test('personal provider links reject workspace viewers, duplicate claims, foreign revocation and team access loss',async()=>{
 const s=await setup(),connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'gitlab',instance:'https://gitlab.com',name:'Native',credentials:'encrypted',webhookSecret:'fixture',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId,externalId:'100'}));
 const digest=await (await import('../convex/providerIdentities')).providerIdentityDigest({kind:'gitlab',instance:'https://gitlab.com',credentials:'encrypted'}),base={token:s.token,repositoryId:s.main._id,connectionId,digest,externalId:'99',username:'native-owner',credentials:'personal-encrypted'},ownerIdentity=await s.t.mutation(internal.providerIdentities.save,base);
 const other=await s.t.mutation(api.users.login,{secret:'context-service',githubId:5103,login:'other',avatar:''}),token=await new SignJWT({}).setSubject(other).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret)),invitationId=await s.t.mutation(api.users.invite,{token:s.token,organizationId:s.organizationId,githubLogin:'other',role:'viewer'});await s.t.mutation(api.users.acceptInvitation,{token,invitationId});
 await expect(s.t.mutation(internal.providerIdentities.save,{...base,token})).rejects.toThrow('Viewers');expect((await s.t.query(api.providerIdentities.list,{token,organizationId:s.organizationId}))[0].canLink).toBe(false);
 await s.t.run(async ctx=>{const m=await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',s.organizationId).eq('userId',other)).unique();await ctx.db.patch(m!._id,{role:'member'});});
 await expect(s.t.mutation(internal.providerIdentities.save,{...base,token})).rejects.toThrow('another workspace account');await expect(s.t.mutation(api.providerIdentities.revoke,{token,id:ownerIdentity})).rejects.toThrow('not owned');
 const id=await s.t.mutation(internal.providerIdentities.save,{...base,token,externalId:'100',username:'native-other'}),team=await s.t.mutation(api.scopes.createTeam,{token:s.token,organizationId:s.organizationId,name:'Native author team'});await s.t.mutation(api.scopes.assign,{token:s.token,repositoryId:s.main._id,teamId:team});await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:other,role:'viewer',remove:false});
 await expect(s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id})).rejects.toThrow('Team access denied');expect((await s.t.query(api.providerIdentities.list,{token,organizationId:s.organizationId}))[0].canLink).toBe(false);
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:other,role:'member',remove:false});expect((await s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id})).identity.userId).toBe(other);
 await s.t.mutation(api.scopes.member,{token:s.token,teamId:team,userId:other,role:'member',remove:true});await expect(s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id})).rejects.toThrow('Team access denied');
});

test('GitHub Enterprise primary context binds the native author ID to its personal connection and denies reuse on another instance',async()=>{
 const s=await setup(),connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'github-enterprise',instance:'https://enterprise.fixture',name:'Enterprise',credentials:'enterprise-encrypted',webhookSecret:'fixture',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId,externalId:'100'}));
 const digest=await (await import('../convex/providerIdentities')).providerIdentityDigest({kind:'github-enterprise',instance:'https://enterprise.fixture',credentials:'enterprise-encrypted'});await s.t.mutation(internal.providerIdentities.save,{token:s.token,repositoryId:s.main._id,connectionId,digest,externalId:'88',username:'native-user',credentials:'personal-encrypted'});
 const selected=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-user',authorExternalId:'88'});expect(selected.sources).toHaveLength(1);expect(selected.receipt?.providerActor?.externalId).toBe('88');
 await s.t.run(ctx=>ctx.db.patch(connectionId,{instance:'https://changed.fixture'}));await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('connection authority');await s.t.run(ctx=>ctx.db.patch(connectionId,{instance:'https://enterprise.fixture'}));
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-user',authorExternalId:'89'})).sources).toHaveLength(0);
 const another=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'github-enterprise',instance:'https://other.fixture',name:'Other',credentials:'enterprise-encrypted',webhookSecret:'fixture',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId:another}));await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('connection authority');
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'native-user',authorExternalId:'88'})).sources).toHaveLength(0);
});

test('Bitbucket Data Center cluster context requires a verified native author ID and invalidates disconnected personal links',async()=>{
 const s=await setup(),connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'bitbucket-dc',instance:'https://bitbucket.fixture/bitbucket',name:'Data Center',credentials:'dc-encrypted',webhookSecret:'fixture',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId,externalId:'100'}));
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'alice',authorExternalId:'77'})).sources).toHaveLength(0);
 const digest=await (await import('../convex/providerIdentities')).providerIdentityDigest({kind:'bitbucket-dc',instance:'https://bitbucket.fixture/bitbucket',credentials:'dc-encrypted'}),id=await s.t.mutation(internal.providerIdentities.save,{token:s.token,repositoryId:s.main._id,connectionId,digest,externalId:'77',username:'alice',credentials:'personal-encrypted'}),selected=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'alice',authorExternalId:'77'});
 expect(selected.sources).toHaveLength(1);expect(selected.receipt?.providerActor?.externalId).toBe('77');expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'alice',authorExternalId:'78'})).sources).toHaveLength(0);
 await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id});await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('revoked');
});

test('Origin confirmed authors bind native receipts to workspace authority and reject replay, revocation and changed installations',async()=>{
 const s=await setup();process.env.CREDENTIAL_ENCRYPTION_KEY='origin-personal-test-key-at-least-32-characters';
 const {generateKeyPair,exportJWK,exportPKCS8}=await import('jose'),pair=await generateKeyPair('EdDSA',{extractable:true}),jwk={...await exportJWK(pair.publicKey),kid:'origin-confirmed-context-key'},credentials={appId:'app_fixture',installationId:'i_fixture',privateKey:await exportPKCS8(pair.privateKey)},personal={userId:'user_tkWiNrWtwGn2FzKlyV5iqodPBN',installationId:'i_fixture',namespaceId:'ns_fixture'},encrypt=(await import('../src/credentials')).encryptCredential;
 const encrypted=encrypt(JSON.stringify(credentials),s.organizationId+':origin'),connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{organizationId:s.organizationId,kind:'origin',instance:'https://api.cursor.com',name:'Origin',installationId:'i_fixture',namespaceId:'ns_fixture',credentials:encrypted,webhookSecret:'',active:true,createdAt:Date.now()}));await s.t.run(ctx=>ctx.db.patch(s.main._id,{connectionId,externalId:'repo_fixture'}));
 const start=await s.t.query(api.providerIdentities.originStart,{token:s.token,secret:'context-service',repositoryId:s.main._id});expect(start).not.toHaveProperty('credentials');
 await expect(s.t.query(api.providerIdentities.originStart,{token:s.token,secret:'wrong-service',repositoryId:s.main._id})).rejects.toThrow('Unauthorized service');
 let status=200,repository='repo_fixture',permission='admin',permissionUser=personal.userId,revokeDuringPermission=false;const native=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
  const url=String(input);expect(options?.redirect).toBe('error');
  if(url.endsWith('/keys'))return Response.json({keys:[jwk]});
  if(url.endsWith('/permission')){if(revokeDuringPermission){revokeDuringPermission=false;await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id});}return Response.json({user:{id:permissionUser},permission});}
  if(url.endsWith('/user_access_tokens')){expect(JSON.parse(String(options?.body))).toEqual({userId:'user_tkWiNrWtwGn2FzKlyV5iqodPBN',scopes:['repository:metadata:read','repository:contents:read','repository:pull_requests:read'],repositoryIds:['repo_fixture']});return Response.json({token:'never-persist-this-delegated-token',expiresAt:new Date(Date.now()+240000).toISOString()},{status});}
  expect(url).toBe('https://api.cursor.com/v1/origin/repos/_/repo_fixture');return Response.json({id:repository,owner:{id:'ns_fixture'}});
 });
 const now=Math.floor(Date.now()/1000),receipt=await new SignJWT({sub:'user_tkWiNrWtwGn2FzKlyV5iqodPBN',installation_id:'i_fixture',namespace_id:'ns_fixture',state:'confirmation-state',jti:'native-user-receipt-one'}).setProtectedHeader({alg:'EdDSA',kid:jwk.kid,typ:'origin-user-confirmation-receipt+jwt'}).setIssuer('https://api.cursor.com/v1/origin').setAudience('app_fixture').setIssuedAt(now).setExpirationTime(now+299).sign(pair.privateKey),args={token:s.token,secret:'context-service',repositoryId:s.main._id,receipt,state:'confirmation-state',digest:start.digest};
 await expect(s.t.action(api.providerIdentityJobs.connectOrigin,{...args,secret:'wrong'})).rejects.toThrow('Unauthorized service');await expect(s.t.action(api.providerIdentityJobs.connectOrigin,{...args,state:'foreign'})).rejects.toThrow('confirmation');
 const id=await s.t.action(api.providerIdentityJobs.connectOrigin,args),saved=await s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id});expect(saved.identity.externalId).toBe('user_tkWiNrWtwGn2FzKlyV5iqodPBN');expect(saved.identity.credentials).not.toContain(personal.userId);expect(saved.identity.credentials).not.toContain('never-persist-this-delegated-token');
 await expect(s.t.action(api.providerIdentityJobs.connectOrigin,args)).rejects.toThrow('already consumed');expect((await s.t.query(internal.providerIdentities.data,{id,repositoryId:s.main._id})).identity.generation).toBe(1);
 const replyArgs={repositoryId:s.main._id,authorExternalId:personal.userId};
 expect(await s.t.action(internal.providerIdentityJobs.originCanReply,replyArgs)).toBe(true);
 for(const role of ['read','custom']){permission=role;expect(await s.t.action(internal.providerIdentityJobs.originCanReply,replyArgs)).toBe(false);}permission='admin';
 permissionUser='user_other';expect(await s.t.action(internal.providerIdentityJobs.originCanReply,replyArgs)).toBe(false);permissionUser=personal.userId;
 expect(await s.t.action(internal.providerIdentityJobs.originCanReply,{...replyArgs,authorExternalId:'user_unknown'})).toBe(false);
 const selected=await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'user_tkWiNrWtwGn2FzKlyV5iqodPBN',authorExternalId:'user_tkWiNrWtwGn2FzKlyV5iqodPBN'});expect(selected.receipt?.providerActor?.externalId).toBe('user_tkWiNrWtwGn2FzKlyV5iqodPBN');expect(selected.sources).toHaveLength(1);
 expect((await s.t.query(internal.repositoryContext.select,{repositoryId:s.main._id,actor:'user_tkWiNrWtwGn2FzKlyV5iqodPBN',authorExternalId:'user_other'})).receipt).toBeNull();
 expect(await s.t.action(internal.repositoryContextJobs.validate,{receipt:selected.receipt!})).toBe(true);
 status=403;await expect(s.t.action(internal.repositoryContextJobs.guardForgeContext,{receipt:selected.receipt!})).rejects.toThrow('personal access rejected');await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt:selected.receipt!})).rejects.toThrow('personal access rejected');status=200;repository='repo_other';await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt:selected.receipt!})).rejects.toThrow('repository identity changed');repository='repo_fixture';
 const before=native.mock.calls.length;await s.t.run(ctx=>ctx.db.patch(connectionId,{namespaceId:'ns_other'}));await expect(s.t.action(api.providerIdentityJobs.connectOrigin,args)).rejects.toThrow('connection changed');await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt:selected.receipt!})).rejects.toThrow('connection authority');expect(native.mock.calls.length).toBe(before);await s.t.run(ctx=>ctx.db.patch(connectionId,{namespaceId:'ns_fixture'}));
 revokeDuringPermission=true;expect(await s.t.action(internal.providerIdentityJobs.originCanReply,replyArgs)).toBe(false);
 const noAccessReads=native.mock.calls.length;expect(await s.t.action(internal.providerIdentityJobs.originCanReply,replyArgs)).toBe(false);expect(native.mock.calls.length).toBe(noAccessReads);
 await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id});await expect(s.t.query(internal.repositoryContext.validate,{receipt:selected.receipt!})).rejects.toThrow('revoked');expect((await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId}))[0].identity?.active).toBe(false);
});

async function bitbucketSetup(){
 const s=await setup();process.env.CREDENTIAL_ENCRYPTION_KEY='bitbucket-personal-encryption-fixture-at-least-32';
 const {encryptCredential}=await import('../src/credentials'),workspace='11111111-1111-4111-8111-111111111111',nativeUser='22222222-2222-4222-8222-222222222222',mainId='33333333-3333-4333-8333-333333333333',sourceId='44444444-4444-4444-8444-444444444444',installation='ari:cloud:ecosystem::installation/55555555-5555-4555-8555-555555555555',now=Date.now();
 const c={kind:'bitbucket-cloud',instance:'https://api.bitbucket.org',installationId:installation,namespaceId:workspace,credentials:encryptCredential(JSON.stringify({systemToken:'native-system-token',publisherId:'66666666-6666-4666-8666-666666666666',receivedAt:now,expiresAt:now+60*60000}),s.organizationId+':bitbucket-cloud')};
 const connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{...c,organizationId:s.organizationId,name:'Forge fixture',webhookSecret:'',active:true,createdAt:now}));
 await s.t.run(async ctx=>{await ctx.db.patch(s.main._id,{connectionId,externalId:mainId,fullName:'acme/main'});await ctx.db.patch(s.source._id,{connectionId,externalId:sourceId,fullName:'acme/source'});});
 const hash='a'.repeat(64),digest=await (await import('../convex/providerIdentities')).providerIdentityDigest(c),personal={userToken:'native-user-token',nativeUserId:nativeUser,accountId:'native-account',workspaceId:workspace,installationId:installation,receivedAt:now,expiresAt:now+50*60000};
 const proof={secret:'context-service',tokenHash:hash,digest,installationId:installation,workspaceId:workspace,externalId:nativeUser,username:'{'+nativeUser+'}',credentials:encryptCredential(JSON.stringify(personal),s.organizationId+':provider-personal:'+connectionId+':'+s.user),expiresAt:personal.expiresAt,invocationId:'personal-fit-one',invocationExpiresAt:now+60000};
 return {...s,workspace,nativeUser,mainId,sourceId,installation,connectionId,c,hash,proof,personal};
}
test('Bitbucket personal authorization is single-use, exact-connection bound, expiring and isolated from PAT linking',async()=>{
 const s=await bitbucketSetup();
 await s.t.mutation(api.bitbucketPersonal.begin,{token:s.token,repositoryId:s.main._id,tokenHash:s.hash});
 await expect(s.t.query(api.bitbucketPersonal.inspect,{secret:'wrong',tokenHash:s.hash})).rejects.toThrow('Unauthorized service');
 expect(await s.t.query(api.bitbucketPersonal.inspect,{secret:'context-service',tokenHash:s.hash})).toMatchObject({userId:s.user,externalId:s.mainId,connectionId:s.connectionId});
 for(const change of [{workspaceId:'foreign'},{installationId:'foreign'},{digest:'foreign'},{externalId:'not-a-uuid'},{expiresAt:Date.now()-1},{expiresAt:Date.now()+120*60000},{username:'forged'},{invocationExpiresAt:Date.now()-1}])await expect(s.t.mutation(api.bitbucketPersonal.save,{...s.proof,...change})).rejects.toThrow();
 await s.t.mutation(api.bitbucketPersonal.save,s.proof);
 await expect(s.t.mutation(api.bitbucketPersonal.save,s.proof)).rejects.toThrow('consumed');
 const list=await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId});expect(list[0].identity?.externalId).toBe(s.nativeUser);expect(list[0].identity).not.toHaveProperty('credentials');
 const identityId=list[0].identity!.id;
 await expect(s.t.action(api.providerIdentityJobs.connect,{token:s.token,repositoryId:s.main._id,personalToken:'fake-pat'})).rejects.toThrow('unavailable');
 await expect(s.t.mutation(internal.providerIdentities.save,{token:s.token,repositoryId:s.main._id,connectionId:s.connectionId,digest:s.proof.digest,externalId:s.nativeUser,username:s.proof.username,credentials:'fake'})).rejects.toThrow('native Forge');
 const second='b'.repeat(64);await s.t.mutation(api.bitbucketPersonal.begin,{token:s.token,repositoryId:s.main._id,tokenHash:second});
 await expect(s.t.mutation(api.bitbucketPersonal.save,{...s.proof,tokenHash:second})).rejects.toThrow('already consumed');
 await s.t.mutation(api.bitbucketPersonal.save,{...s.proof,tokenHash:second,invocationId:'personal-fit-two'});
 await s.t.mutation(internal.bitbucketPersonal.expireIdentity,{id:identityId,generation:1});expect((await s.t.query(internal.providerIdentities.data,{id:identityId,repositoryId:s.main._id})).identity.generation).toBe(2);
 await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id:identityId});expect((await s.t.run(ctx=>ctx.db.get(identityId)))?.credentials).toBeUndefined();
 const viewer=await s.t.mutation(api.users.login,{secret:'context-service',githubId:5199,login:'forge-viewer',avatar:''}),viewerToken=await new SignJWT({}).setSubject(viewer).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret)),invitationId=await s.t.mutation(api.users.invite,{token:s.token,organizationId:s.organizationId,githubLogin:'forge-viewer',role:'viewer'});await s.t.mutation(api.users.acceptInvitation,{token:viewerToken,invitationId});
 await expect(s.t.mutation(api.bitbucketPersonal.begin,{token:viewerToken,repositoryId:s.main._id,tokenHash:'e'.repeat(64)})).rejects.toThrow('Viewers');
 await s.t.run(async ctx=>{const member=await ctx.db.query('organizationMembers').withIndex('by_org_user',q=>q.eq('organizationId',s.organizationId).eq('userId',viewer)).unique();await ctx.db.patch(member!._id,{role:'member'});});
 const viewerHash='f'.repeat(64);await s.t.mutation(api.bitbucketPersonal.begin,{token:viewerToken,repositoryId:s.main._id,tokenHash:viewerHash});await expect(s.t.mutation(api.bitbucketPersonal.save,{...s.proof,tokenHash:viewerHash,invocationId:'other-fit'})).rejects.toThrow('another workspace account');
 const expired='d'.repeat(64);await s.t.mutation(api.bitbucketPersonal.begin,{token:s.token,repositoryId:s.main._id,tokenHash:expired});const grantId=await s.t.run(async ctx=>{const grant=await ctx.db.query('providerIdentityGrants').withIndex('by_hash',q=>q.eq('tokenHash',expired)).unique();await ctx.db.patch(grant!._id,{expiresAt:Date.now()-1});return grant!._id;});await expect(s.t.query(api.bitbucketPersonal.inspect,{secret:'context-service',tokenHash:expired})).rejects.toThrow('expired');await s.t.mutation(internal.bitbucketPersonal.expireGrant,{id:grantId});expect(await s.t.run(ctx=>ctx.db.get(grantId))).toBeNull();
 await s.t.run(ctx=>ctx.db.patch(identityId,{active:true,credentials:'old-fixture',expiresAt:Date.now()-1,generation:3}));await s.t.mutation(internal.bitbucketPersonal.expireIdentity,{id:identityId,generation:3});expect(await s.t.run(ctx=>ctx.db.get(identityId))).toMatchObject({active:false,generation:4});expect((await s.t.run(ctx=>ctx.db.get(identityId)))?.credentials).toBeUndefined();
 await s.t.run(ctx=>ctx.db.patch(identityId,{active:true,credentials:s.proof.credentials,expiresAt:s.proof.expiresAt}));
 expect((await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId}))[0].identity?.status).toBe('linked');
 const third='c'.repeat(64);await s.t.mutation(api.bitbucketPersonal.begin,{token:s.token,repositoryId:s.main._id,tokenHash:third});await s.t.run(ctx=>ctx.db.patch(s.connectionId,{credentials:'replaced'}));await expect(s.t.query(api.bitbucketPersonal.inspect,{secret:'context-service',tokenHash:third})).rejects.toThrow('connection changed');
 expect((await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId}))[0].identity?.status).toBe('reconfirmation-required');
 await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id:identityId});expect((await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId}))[0].identity?.status).toBe('disconnected');
 await s.t.run(ctx=>ctx.db.patch(identityId,{expiresAt:Date.now()-1}));expect((await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId}))[0].identity?.status).toBe('expired');
});
test('Bitbucket cluster retrieval rechecks the actual author and every source with personal native access before reading bot source and before publication',async()=>{
 const s=await bitbucketSetup();await s.t.mutation(api.bitbucketPersonal.begin,{token:s.token,repositoryId:s.main._id,tokenHash:s.hash});await s.t.mutation(api.bitbucketPersonal.save,s.proof);
 await s.t.run(async ctx=>{const storageId=await ctx.storage.store(new Blob(['shared']));await ctx.db.insert('repositoryFiles',{organizationId:s.organizationId,repositoryId:s.source._id,path:'README.md',sha:'a'.repeat(40),storageId,language:'markdown',updatedAt:Date.now()});});
 let denySource=false,denyUser=false,systemReads=0;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
  const url=new URL(String(input)),auth=new Headers(options?.headers).get('authorization');expect(url.origin).toBe('https://api.bitbucket.org');expect(options?.redirect).toBe('error');
  if(auth==='Bearer native-user-token'){
   if(denyUser)return new Response('{}',{status:401});
   if(url.pathname==='/2.0/user')return Response.json({uuid:s.nativeUser,type:'user',account_id:'native-account',account_status:'active'});
   const path=decodeURIComponent(url.pathname),main=path.endsWith('{'+s.mainId+'}');if(!main&&denySource)return new Response('{}',{status:403});
   expect(path).toBe('/2.0/repositories/{'+s.workspace+'}/{'+(main?s.mainId:s.sourceId)+'}');return Response.json({uuid:main?s.mainId:s.sourceId,scm:'git',full_name:main?'acme/main':'acme/source',workspace:{uuid:s.workspace}});
  }
  expect(auth).toBe('Bearer native-system-token');systemReads++;
  const prefix='/2.0/repositories/{'+s.workspace+'}/{'+s.sourceId+'}',path=decodeURIComponent(url.pathname);if(path===prefix)return Response.json({uuid:s.sourceId,full_name:'acme/source',workspace:{uuid:s.workspace}});
  const record={type:'commit_file',path:'README.md',commit:{hash:'a'.repeat(40)},size:6,attributes:[]};
  if(path===prefix+'/src/'+'a'.repeat(40)+'/')return Response.json({values:[record]});if(url.searchParams.get('format')==='meta')return Response.json(record);return new Response('shared');
 });
 const args={repositoryId:s.main._id,actor:'{'+s.nativeUser+'}',authorExternalId:s.nativeUser,identifiers:[]};
 const result=await s.t.action(internal.repositoryContextJobs.retrieve,args);expect(result.files).toHaveLength(1);expect(result.files[0].content).toBe('shared');expect(result.receipt?.sources[0].providerIdentity?.externalId).toBe(s.nativeUser);
 expect(await s.t.action(internal.repositoryContextJobs.validate,{receipt:result.receipt!})).toBe(true);
 const before=systemReads;denySource=true;await expect(s.t.action(internal.repositoryContextJobs.retrieve,args)).rejects.toThrow('unavailable');expect(systemReads).toBe(before);await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt:result.receipt!})).rejects.toThrow('unavailable');
 denySource=false;denyUser=true;await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt:result.receipt!})).rejects.toThrow('unavailable');
 denyUser=false;const identity=(await s.t.query(api.providerIdentities.list,{token:s.token,organizationId:s.organizationId}))[0].identity!;await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id:identity.id});await expect(s.t.query(internal.repositoryContext.validate,{receipt:result.receipt!})).rejects.toThrow('revoked');
});


test('Origin source context requires personal access before App reads and rechecks denial, expiry and revocation',async()=>{
 const s=await setup();process.env.CREDENTIAL_ENCRYPTION_KEY='origin-source-personal-fixture-at-least-32';
 const {generateKeyPair,exportPKCS8}=await import('jose'),pair=await generateKeyPair('EdDSA',{extractable:true}),encrypt=(await import('../src/credentials')).encryptCredential;
 const credentials={appId:'app_source',installationId:'i_source',privateKey:await exportPKCS8(pair.privateKey)},personal={userId:'user_SourceIdentity',installationId:'i_source',namespaceId:'ns_source'};
 const c={kind:'origin',instance:'https://api.cursor.com',installationId:'i_source',namespaceId:'ns_source',credentials:encrypt(JSON.stringify(credentials),s.organizationId+':origin')};
 const connectionId=await s.t.run(ctx=>ctx.db.insert('providerConnections',{...c,organizationId:s.organizationId,name:'Origin source',webhookSecret:'',active:true,createdAt:Date.now()}));
 await s.t.run(async ctx=>{await ctx.db.patch(s.source._id,{connectionId,externalId:'r_source'});const storageId=await ctx.storage.store(new Blob(['shared']));await ctx.db.insert('repositoryFiles',{organizationId:s.organizationId,repositoryId:s.source._id,path:'README.md',sha:'b'.repeat(40),storageId,language:'markdown',updatedAt:Date.now()});});
 const missing=await s.select();expect(missing.sources).toHaveLength(0);expect(missing.coverage.join()).toContain('current personal identity');
 const digest=await (await import('../convex/providerIdentities')).providerIdentityDigest(c);
 const identityId=await s.t.run(ctx=>ctx.db.insert('providerIdentities',{organizationId:s.organizationId,connectionId,userId:s.user,externalId:personal.userId,username:personal.userId,connectionDigest:digest,credentials:encrypt(JSON.stringify(personal),s.organizationId+':provider-personal:'+connectionId+':'+s.user),active:true,generation:1,expiresAt:Date.now()+86400000,createdAt:Date.now(),updatedAt:Date.now()}));
 let deny=false,denyAfterBlob=false,appReads=0;const scopedRequests:string[][]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
  const url=String(input),headers=new Headers(options?.headers);expect(options?.redirect).toBe('error');
  if(url.endsWith('/user_access_tokens')){const body=JSON.parse(String(options?.body));expect(body.userId).toBe(personal.userId);expect(body.scopes).toEqual(['repository:metadata:read','repository:contents:read','repository:pull_requests:read']);expect(body.repositoryIds).toEqual(['r_source']);scopedRequests.push(body.repositoryIds);return deny?new Response('{}',{status:403}):Response.json({token:'personal-read-only',expiresAt:new Date(Date.now()+240000).toISOString()});}
  if(headers.get('authorization')==='Bearer personal-read-only'){expect(url).toBe('https://api.cursor.com/v1/origin/repos/_/r_source');return Response.json({id:'r_source',owner:{id:'ns_source'}});}
  appReads++;
  if(url.endsWith('/access_tokens'))return Response.json({token:'oit_app',expiresAt:new Date(Date.now()+600000).toISOString()});
  expect(headers.get('authorization')).toBe('Bearer oit_app');
  if(url.includes('/git/trees/'))return Response.json({tree:[{path:'README.md',sha:'b'.repeat(40),type:'blob',size:6}],truncated:false});
  expect(url).toContain('/git/blobs/'+'b'.repeat(40));if(denyAfterBlob)deny=true;return Response.json({content:Buffer.from('shared').toString('base64'),size:6,encoding:'base64'});
 });
 const args={repositoryId:s.main._id,actor:'alice',authorExternalId:'5100',identifiers:[]};
 const result=await s.t.action(internal.repositoryContextJobs.retrieve,args);expect(result.files).toHaveLength(1);expect(result.files[0].content).toBe('shared');expect(result.receipt!.sources[0].providerIdentity).toEqual({id:identityId,generation:1,externalId:personal.userId});expect(scopedRequests).toHaveLength(2);
 expect(await s.t.action(internal.repositoryContextJobs.validate,{receipt:result.receipt!})).toBe(true);
 const legacy=structuredClone(result.receipt!);delete legacy.sources[0].providerIdentity;await expect(s.t.query(internal.repositoryContext.validate,{receipt:legacy})).rejects.toThrow('native personal identity');
 deny=true;const before=appReads;await expect(s.t.action(internal.repositoryContextJobs.retrieve,args)).rejects.toThrow('personal access rejected');expect(appReads).toBe(before);await expect(s.t.action(internal.repositoryContextJobs.validate,{receipt:result.receipt!})).rejects.toThrow('personal access rejected');
 deny=false;denyAfterBlob=true;await expect(s.t.action(internal.repositoryContextJobs.retrieve,args)).rejects.toThrow('personal access rejected');deny=false;denyAfterBlob=false;
 await s.t.run(ctx=>ctx.db.patch(identityId,{expiresAt:Date.now()-1}));expect((await s.select()).sources).toHaveLength(0);await expect(s.t.query(internal.repositoryContext.validate,{receipt:result.receipt!})).rejects.toThrow('expired');
 await s.t.run(ctx=>ctx.db.patch(identityId,{expiresAt:Date.now()+86400000}));await s.t.mutation(api.providerIdentities.revoke,{token:s.token,id:identityId});expect((await s.select()).sources).toHaveLength(0);await expect(s.t.query(internal.repositoryContext.validate,{receipt:result.receipt!})).rejects.toThrow('revoked');
});

test('bridge claim rechecks finding evidence access after its source team grant is revoked',async()=>{
 const s=await setup(),user=await s.t.mutation(api.users.login,{secret:'context-service',githubId:5103,login:'fixer',avatar:''});
 const token=await new SignJWT({}).setSubject(user).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const invitationId=await s.t.mutation(api.users.invite,{token:s.token,organizationId:s.organizationId,githubLogin:'fixer',role:'member'});await s.t.mutation(api.users.acceptInvitation,{token,invitationId});
 const teamId=await s.t.mutation(api.scopes.createTeam,{token:s.token,organizationId:s.organizationId,name:'Evidence source'});
 await s.t.mutation(api.scopes.assign,{token:s.token,repositoryId:s.source._id,teamId});
 await s.t.mutation(api.scopes.member,{token:s.token,teamId,userId:user,role:'viewer',remove:false});
 const head='a'.repeat(40),now=Date.now();
 const reviewId=await s.t.run(ctx=>ctx.db.insert('reviews',{organizationId:s.organizationId,repositoryId:s.main._id,prNumber:2,headSha:head,status:'completed',mode:'standard',attempts:1,createdAt:now,updatedAt:now}));
 await s.t.run(ctx=>ctx.db.insert('findings',{organizationId:s.organizationId,repositoryId:s.main._id,reviewId,prNumber:2,title:'Preserve cent units',description:'Converting integer cents causes undercharging.',severity:'high',confidence:1,category:'data',filePath:'total.ts',startLine:1,endLine:1,commitSha:head,evidence:[{filePath:'context/'+s.source._id+'/total.ts',startLine:1,quote:'return cents'}],impact:'Incorrect payment',suggestedFix:'Preserve integer cents',agent:'data',symbol:'total',fingerprint:'source-access',status:'open',createdAt:now,updatedAt:now}));
 const hash='f'.repeat(64),code='c'.repeat(12);
 await s.t.mutation(api.bridge.startPair,{secret:'context-service',hash,code,name:'Evidence access'});
 await s.t.mutation(api.bridge.approvePair,{token,organizationId:s.organizationId,code});
 const requestId=await s.t.mutation(api.bridge.createFix,{token,reviewId,agent:'codex'});
 await s.t.mutation(internal.bridge.claimData,{secret:'context-service',hash,requestId});
 await s.t.mutation(api.scopes.member,{token:s.token,teamId,userId:user,role:'viewer',remove:true});
 await expect(s.t.mutation(internal.bridge.claimData,{secret:'context-service',hash,requestId})).rejects.toThrow('Team access denied');
 await expect(s.t.mutation(internal.bridge.claim,{secret:'context-service',hash,requestId,current:{headSha:head,state:'open'}})).rejects.toThrow('Team access denied');
 expect(await s.t.run(ctx=>ctx.db.get(requestId))).toMatchObject({status:'pending'});
});
