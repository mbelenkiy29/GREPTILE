import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {HttpModel} from '../src/engine/model';
import type {Id} from '../convex/_generated/dataModel';
import type {ToolCall,ToolRequest,ToolTurn} from '../src/engine/types';
const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters';
const indexed='c'.repeat(40);
// Fake timers keep jobs scheduled by `ask` from running in the background; tests run them explicitly.
beforeEach(()=>{vi.useFakeTimers();process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';process.env.LLM_API_KEY='fixture';});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

async function setup(){
 const t=convexTest(schema,modules);
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId,login:name,avatar:''});return {id,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const alice=await login(91,'alice'),bob=await login(92,'bob'),mallory=await login(93,'mallory');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 const rival=await t.mutation(api.users.createOrganization,{token:mallory.token,name:'Rival'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'integration-service-secret',organizationId:org,installationId:91,account:'acme',accountId:1,repositories:[{id:9101,fullName:'acme/shop',defaultBranch:'main'},{id:9102,fullName:'acme/secret',defaultBranch:'main'}]});
 await t.mutation(api.repositories.connect,{token:mallory.token,secret:'integration-service-secret',organizationId:rival,installationId:93,account:'rival',accountId:3,repositories:[{id:9301,fullName:'rival/app',defaultBranch:'main'}]});
 const repos=[...await t.query(api.repositories.list,{token:alice.token,organizationId:org}),...await t.query(api.repositories.list,{token:mallory.token,organizationId:rival})];
 const [shop,secretRepo,rivalRepo]=['acme/shop','acme/secret','rival/app'].map(n=>repos.find(r=>r.fullName===n)!);
 const teamId=await t.run(async ctx=>{
  await ctx.db.insert('organizationMembers',{organizationId:org,userId:bob.id as Id<'users'>,role:'member'});
  const teamId=await ctx.db.insert('teams',{organizationId:org,name:'Payments',createdAt:0});
  for(const r of [shop,secretRepo,rivalRepo]){
   await ctx.db.patch(r._id,{enabled:true,indexedSha:indexed,...(r._id===secretRepo._id?{teamId}:{})});
   const content=r._id===rivalRepo._id?'export const rivalSecret = "do-not-leak";\n':'export function total(cents: number, qty: number) {\n  return cents * qty;\n}\n';
   const storageId=await ctx.storage.store(new Blob([content]));
   await ctx.db.insert('repositoryFiles',{organizationId:r.organizationId,repositoryId:r._id,path:'src/cart.ts',sha:'blob-'+r.fullName,storageId,language:'typescript',updatedAt:0});
   await ctx.db.insert('codeChunks',{organizationId:r.organizationId,repositoryId:r._id,filePath:'src/cart.ts',startLine:1,content});
  }
  return teamId;
 });
 return {t,alice,bob,mallory,org,rival,shop,secretRepo,rivalRepo,teamId};
}
const usage={task:'chat',provider:'fixture',model:'fixture',inputTokens:100,outputTokens:20,latencyMs:1,estimatedCost:0.002,cached:false};
function script(steps:(request:ToolRequest)=>ToolCall[]|null){
 const requests:ToolRequest[]=[];
 vi.spyOn(HttpModel.prototype,'runTools').mockImplementation(async(request:ToolRequest):Promise<ToolTurn>=>{requests.push({...request,messages:[...request.messages]});const calls=steps(request)??[];return {content:'',toolCalls:calls,stopReason:calls.length?'tool_use':'end_turn',usage,message:{role:'assistant',content:'',toolCalls:calls}};});
 return requests;
}
const call=(name:string,input:unknown,id=name+Math.random().toString(36).slice(2,8)):ToolCall=>({id,name,input});
const results=(r:ToolRequest)=>{const m=r.messages.at(-1);return m?.role==='tool'?m.results:[];};

test('a member never reads another workspace\'s or another member\'s threads, or code outside their repositories',async()=>{
 const {t,alice,bob,mallory,org,rival,shop,secretRepo,rivalRepo}=await setup();
 vi.spyOn(HttpModel.prototype,'runTools').mockRejectedValue(new Error('not reached'));
 const {threadId,messageId}=await t.mutation(api.chat.ask,{token:alice.token,organizationId:org,repositoryIds:[shop._id],question:'Where are totals computed?'});
 // Another workspace: no threads, no thread, no progress, no asking over Acme repositories.
 await expect(t.query(api.chat.threads,{token:mallory.token,organizationId:org})).rejects.toThrow();
 await expect(t.query(api.chat.thread,{token:mallory.token,threadId})).rejects.toThrow();
 await expect(t.query(api.chat.progress,{token:mallory.token,messageId})).rejects.toThrow();
 await expect(t.mutation(api.chat.ask,{token:mallory.token,organizationId:rival,repositoryIds:[shop._id],question:'Show me the Acme cart'})).rejects.toThrow(/not accessible/);
 await expect(t.mutation(api.chat.ask,{token:mallory.token,organizationId:org,repositoryIds:[shop._id],question:'Show me the Acme cart'})).rejects.toThrow(/Forbidden/);
 await expect(t.mutation(api.chat.ask,{token:mallory.token,organizationId:rival,threadId,repositoryIds:[rivalRepo._id],question:'Continue their thread'})).rejects.toThrow();
 await expect(t.mutation(api.chat.deleteThread,{token:mallory.token,threadId})).rejects.toThrow();
 // Same workspace, different member: threads stay private; team-restricted repositories stay closed.
 expect(await t.query(api.chat.threads,{token:bob.token,organizationId:org})).toEqual([]);
 await expect(t.query(api.chat.thread,{token:bob.token,threadId})).rejects.toThrow(/Thread not found/);
 await expect(t.mutation(api.chat.ask,{token:bob.token,organizationId:org,repositoryIds:[secretRepo._id],question:'What is in the payments repo?'})).rejects.toThrow(/not accessible/);
 await expect(t.mutation(api.chat.ask,{token:alice.token,organizationId:org,repositoryIds:[shop._id,rivalRepo._id],question:'Compare with the rival app'})).rejects.toThrow(/not accessible/);
 expect((await t.query(api.chat.threads,{token:alice.token,organizationId:org})).map(x=>x._id)).toEqual([threadId]);
});

test('the chat job answers with citations pinned to the indexed revision, streams progress and records usage',async()=>{
 const {t,alice,org,shop,rivalRepo}=await setup();
 const requests=script(request=>{
  const turn=requests.length;
  if(turn===1)return [call('search_code',{query:'total cents'})];
  if(turn===2){expect(results(request)[0].content).toContain('acme/shop');expect(results(request)[0].content).not.toContain('rivalSecret');return [call('read_file',{repository:'acme/shop',path:'src/cart.ts'}),call('read_file',{repository:rivalRepo.fullName,path:'src/cart.ts'})];}
  if(turn===3){expect(results(request)[1].isError).toBe(true);return [call('answer',{answer:'Totals multiply integer cents by quantity [1].',citations:[{repository:'acme/shop',filePath:'src/cart.ts',startLine:2,quote:'  return cents * qty;'}]})];}
  return null;
 });
 const {threadId,messageId}=await t.mutation(api.chat.ask,{token:alice.token,organizationId:org,repositoryIds:[shop._id],question:'Do totals stay in cents?'});
 await t.action(internal.chatJobs.answer,{messageId});
 const progress=await t.query(api.chat.progress,{token:alice.token,messageId});
 expect([progress.status,progress.error,progress.limits]).toEqual(['completed',undefined,[]]);
 expect(progress.content).toBe('Totals multiply integer cents by quantity [1].');
 expect(progress.citations).toEqual([{repositoryId:shop._id,repository:'acme/shop',filePath:'src/cart.ts',startLine:2,endLine:2,quote:'  return cents * qty;',revision:indexed,url:`https://github.com/acme/shop/blob/${indexed}/src/cart.ts#L2`}]);
 expect(progress.events.map(e=>e.text)).toEqual(['Investigating acme/shop','Searching selected repositories for “total cents”','Reading acme/shop:src/cart.ts']);
 expect(requests[0].task).toBe('chat');
 const usageEvents=await t.run(ctx=>ctx.db.query('usageEvents').collect());
 expect(usageEvents.filter(u=>u.kind==='chat')).toEqual([expect.objectContaining({repositoryId:shop._id,inputTokens:300,outputTokens:60})]);
 // Follow-ups carry the thread's earlier turns as unverified context.
 script(request=>{expect((request.messages[0] as {content:string}).content).toContain('Developer: Do totals stay in cents?');return null;});
 const followUp=await t.mutation(api.chat.ask,{token:alice.token,organizationId:org,threadId,repositoryIds:[shop._id],question:'And who calls total?'});
 expect(followUp.threadId).toBe(threadId);
 await t.action(internal.chatJobs.answer,{messageId:followUp.messageId});
 const failed=await t.query(api.chat.progress,{token:alice.token,messageId:followUp.messageId});
 expect(failed.status).toBe('failed');expect(failed.content).toBe('');
 expect(failed.error).toMatch(/No answer with citations/);
 expect((await t.query(api.chat.thread,{token:alice.token,threadId})).messages.map(m=>[m.role,m.status])).toEqual([['user','completed'],['assistant','completed'],['user','completed'],['assistant','failed']]);
});

test('answers are withheld when the member loses access; one answer runs at a time; asking is rate limited',async()=>{
 const {t,alice,bob,org,shop,secretRepo,teamId}=await setup();
 script(()=>null);
 await t.run(ctx=>ctx.db.insert('teamMembers',{organizationId:org,teamId,userId:bob.id as Id<'users'>,role:'member'}));
 const {threadId,messageId}=await t.mutation(api.chat.ask,{token:bob.token,organizationId:org,repositoryIds:[secretRepo._id],question:'What does the payments repo do?'});
 await expect(t.mutation(api.chat.ask,{token:bob.token,organizationId:org,threadId,repositoryIds:[secretRepo._id],question:'Another one'})).rejects.toThrow(/Wait for the current answer/);
 await t.run(ctx=>ctx.db.patch(messageId,{status:'completed',content:'Payments code lives in src/cart.ts [1].'}));
 expect((await t.query(api.chat.thread,{token:bob.token,threadId})).messages[1].content).toBe('Payments code lives in src/cart.ts [1].');
 await t.run(async ctx=>{for(const m of await ctx.db.query('teamMembers').collect())await ctx.db.delete(m._id);});
 const hidden=await t.query(api.chat.thread,{token:bob.token,threadId});
 expect(hidden.messages[1].content).toMatch(/Hidden: this answer used a repository you can no longer access/);
 expect(hidden.repositoryIds).toEqual([]);
 // A queued job for a repository the member can no longer see fails without reading code.
 await t.run(ctx=>ctx.db.insert('teamMembers',{organizationId:org,teamId,userId:bob.id as Id<'users'>,role:'member'}));
 const second=await t.mutation(api.chat.ask,{token:bob.token,organizationId:org,threadId,repositoryIds:[secretRepo._id],question:'Follow-up'});
 await t.run(async ctx=>{for(const m of await ctx.db.query('teamMembers').collect())await ctx.db.delete(m._id);});
 await t.action(internal.chatJobs.answer,{messageId:second.messageId});
 expect((await t.run(ctx=>ctx.db.get(second.messageId)))?.status).toBe('failed');
 expect(vi.mocked(HttpModel.prototype.runTools)).not.toHaveBeenCalled();
 // Per-member rate limit: six questions a minute.
 for(let i=0;i<6;i++)await t.mutation(api.chat.ask,{token:alice.token,organizationId:org,repositoryIds:[shop._id],question:'Question '+i});
 await expect(t.mutation(api.chat.ask,{token:alice.token,organizationId:org,repositoryIds:[shop._id],question:'One too many'})).rejects.toThrow(/Rate limit/);
});
