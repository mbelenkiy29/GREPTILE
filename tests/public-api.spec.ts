import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import {HttpModel} from '../src/engine/model';
import type {Id} from '../convex/_generated/dataModel';
import type {ToolCall,ToolRequest,ToolTurn} from '../src/engine/types';

// Route handlers run for real; their Convex client is backed by convex-test.
const holder=vi.hoisted(()=>({t:undefined as unknown as ReturnType<typeof convexTest>}));
const secret='integration-session-secret-at-least-32-characters';
vi.mock('../src/server',()=>({
 backend:()=>{type Call=(ref:unknown,args:unknown)=>Promise<unknown>;const t=holder.t as unknown as {query:Call;mutation:Call;action:Call};return {query:(ref:unknown,args:unknown)=>t.query(ref,args),mutation:(ref:unknown,args:unknown)=>t.mutation(ref,args),action:(ref:unknown,args:unknown)=>t.action(ref,args)};},
 signSession:(userId:string)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode('integration-session-secret-at-least-32-characters')),
}));
import {POST as queryRoute} from '../app/api/query/route';
import {GET as queryResultRoute} from '../app/api/query/[messageId]/route';
import {POST as searchRoute} from '../app/api/search/route';
import {GET as listRepositories,POST as enableRepository} from '../app/api/repositories/route';
import {GET as repositoryStatus} from '../app/api/repositories/[id]/route';
import {POST as requestReview} from '../app/api/reviews/route';

const modules=import.meta.glob('../convex/**/*.ts');
const indexed='d'.repeat(40);
beforeEach(()=>{vi.useFakeTimers();process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';process.env.LLM_API_KEY='fixture';delete process.env.EMBEDDING_MODEL;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

async function setup(){
 const t=convexTest(schema,modules);holder.t=t;
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId,login:name,avatar:''});return {id,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const alice=await login(61,'alice'),mallory=await login(62,'mallory');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 const rival=await t.mutation(api.users.createOrganization,{token:mallory.token,name:'Rival'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'integration-service-secret',organizationId:org,installationId:61,account:'acme',accountId:1,repositories:[{id:6101,fullName:'acme/shop',defaultBranch:'main'},{id:6102,fullName:'acme/new',defaultBranch:'main'}]});
 await t.mutation(api.repositories.connect,{token:mallory.token,secret:'integration-service-secret',organizationId:rival,installationId:62,account:'rival',accountId:2,repositories:[{id:6201,fullName:'rival/app',defaultBranch:'main'}]});
 const repos=[...await t.query(api.repositories.list,{token:alice.token,organizationId:org}),...await t.query(api.repositories.list,{token:mallory.token,organizationId:rival})];
 const [shop,fresh,rivalRepo]=['acme/shop','acme/new','rival/app'].map(n=>repos.find(r=>r.fullName===n)!);
 const keys=await t.run(async ctx=>{
  for(const r of [shop,rivalRepo]){
   await ctx.db.patch(r._id,{enabled:true,indexStatus:'ready',indexedSha:indexed});
   const content=r._id===shop._id?'export function total(cents: number, qty: number) {\n  return cents * qty;\n}\nexport const checkout = (c: number) => total(c, 1);\n':'export const rivalTotal = "do-not-leak total";\n';
   await ctx.db.insert('repositoryFiles',{organizationId:r.organizationId,repositoryId:r._id,path:'src/cart.ts',sha:'blob',storageId:await ctx.storage.store(new Blob([content])),language:'typescript',updatedAt:0});
   await ctx.db.insert('codeChunks',{organizationId:r.organizationId,repositoryId:r._id,filePath:'src/cart.ts',startLine:1,content});
  }
  const key=async(raw:string,organizationId:Id<'organizations'>,userId:string,scopes?:string[],revoked=false)=>{await ctx.db.insert('apiKeys',{organizationId,userId:userId as Id<'users'>,hash:createHash('sha256').update(raw).digest('hex'),name:raw,prefix:raw.slice(0,11),createdAt:0,revoked,...(scopes?{scopes}:{})});return raw;};
  return {read:await key('or_read_key',org,alice.id,['read']),write:await key('or_write_key',org,alice.id,['write']),legacy:await key('or_legacy_key',org,alice.id),revoked:await key('or_revoked_key',org,alice.id,['admin'],true),rival:await key('or_rival_key',rival,mallory.id,['admin'])};
 });
 return {t,org,rival,shop,fresh,rivalRepo,keys};
}
const request=(path:string,key?:string,body?:unknown,method=body===undefined?'GET':'POST')=>new Request('http://localhost'+path,{method,headers:{...(key?{authorization:'Bearer '+key}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
const params=<T extends string>(name:T,value:string)=>({params:Promise.resolve({[name]:value} as Record<T,string>)});
const json=async(r:Response)=>[r.status,await r.json()] as const;

test('every endpoint requires a valid, unrevoked API key',async()=>{
 const {shop,keys}=await setup();
 for(const key of [undefined,'not-a-key','or_unknown_key',keys.revoked]){
  expect((await queryRoute(request('/api/query',key,{question:'Where is total?',repositoryIds:[shop._id]}))).status).toBe(401);
  expect((await searchRoute(request('/api/search',key,{query:'total'}))).status).toBe(401);
  expect((await enableRepository(request('/api/repositories',key,{repositoryId:shop._id}))).status).toBe(401);
  expect((await repositoryStatus(request('/api/repositories/'+shop._id,key),params('id',shop._id))).status).toBe(401);
  expect((await listRepositories(request('/api/repositories',key))).status).toBe(401);
 }
});

test('scopes: read keys cannot write; write and legacy keys can enable and index; status reflects the request',async()=>{
 const {t,fresh,shop,keys}=await setup();
 expect(await json(await enableRepository(request('/api/repositories',keys.read,{repositoryId:fresh._id})))).toEqual([403,{error:'This API key does not have the write scope'}]);
 expect((await requestReview(request('/api/reviews',keys.read,{repositoryId:shop._id,prNumber:1,headSha:'a'.repeat(40)}))).status).toBe(403);
 expect((await t.run(ctx=>ctx.db.get(fresh._id)))?.enabled).toBe(false);
 const [status,body]=await json(await enableRepository(request('/api/repositories',keys.write,{repositoryId:fresh._id})));
 expect(status).toBe(202);
 expect(body).toMatchObject({id:fresh._id,fullName:'acme/new',enabled:true,indexStatus:'queued',indexedSha:null});
 expect((await t.run(ctx=>ctx.db.system.query('_scheduled_functions').collect())).some(j=>j.name.includes('jobs:index')&&(j.args[0] as {repositoryId:string}).repositoryId===fresh._id)).toBe(true);
 // Keys created before scopes keep working with full access.
 expect((await enableRepository(request('/api/repositories',keys.legacy,{repositoryId:shop._id}))).status).toBe(202);
 expect(await json(await repositoryStatus(request('/api/repositories/'+shop._id,keys.read),params('id',shop._id)))).toEqual([200,expect.objectContaining({id:shop._id,enabled:true,indexStatus:'queued',indexedSha:indexed})]);
});

test('tenant isolation: another workspace\'s key never reaches Acme repositories, threads or code',async()=>{
 const {shop,rivalRepo,keys}=await setup();
 expect((await repositoryStatus(request('/api/repositories/'+shop._id,keys.rival),params('id',shop._id))).status).toBe(404);
 expect((await enableRepository(request('/api/repositories',keys.rival,{repositoryId:shop._id}))).status).toBe(404);
 expect((await searchRoute(request('/api/search',keys.rival,{query:'total',repositoryIds:[shop._id]}))).status).toBe(404);
 expect((await queryRoute(request('/api/query',keys.rival,{question:'What does acme/shop do?',repositoryIds:[shop._id]}))).status).toBe(404);
 // Acme's key cannot pull rival code either; default search covers only its own workspace.
 expect((await searchRoute(request('/api/search',keys.read,{query:'total',repositoryIds:[rivalRepo._id]}))).status).toBe(404);
 const [status,body]=await json(await searchRoute(request('/api/search',keys.read,{query:'total'})));
 expect(status).toBe(200);
 expect(JSON.stringify(body)).not.toContain('do-not-leak');
 expect(body.results.every((r:{repository:string})=>r.repository==='acme/shop')).toBe(true);
 expect((await json(await listRepositories(request('/api/repositories',keys.rival))))[1].map((r:{fullName:string})=>r.fullName)).toEqual(['rival/app']);
});

test('validation errors are 400s with issue paths',async()=>{
 const {shop,keys}=await setup();
 const bad=async(r:Promise<Response>)=>{const [status,body]=await json(await r);expect(status).toBe(400);return body;};
 expect((await bad(searchRoute(request('/api/search',keys.read,{query:'x'})))).issues[0].path).toBe('query');
 expect((await bad(searchRoute(request('/api/search',keys.read,{query:'total',limit:500})))).issues[0].path).toBe('limit');
 expect((await bad(searchRoute(request('/api/search',keys.read,{query:'total',extra:true})))).error).toBe('Invalid request');
 expect((await bad(queryRoute(request('/api/query',keys.read,{question:'Where is total?',repositoryIds:Array(6).fill(shop._id)})))).issues[0].path).toBe('repositoryIds');
 expect((await bad(queryRoute(request('/api/query',keys.read,{question:'Where is total?',repositoryIds:['../etc']})))).issues[0].path).toBe('repositoryIds.0');
 expect(await bad(queryRoute(request('/api/query',keys.read,'{not json')))).toEqual({error:'Request body must be JSON'});
 expect((await bad(repositoryStatus(request('/api/repositories/x',keys.read),params('id','x')))).issues[0].message).toBe('Invalid identifier');
 expect((await bad(enableRepository(request('/api/repositories',keys.write,{})))).issues[0].path).toBe('repositoryId');
});

// Real timers here: convex-test runs the scheduled chat job while the route polls for its result.
test('search returns ranked snippets; query returns a validated answer with sources, as JSON or a stream',async()=>{
 vi.useRealTimers();
 const {t,shop,keys}=await setup();
 const [status,body]=await json(await searchRoute(request('/api/search',keys.read,{query:'total',repositoryIds:[shop._id],limit:5})));
 expect(status).toBe(200);
 expect(body.results[0]).toMatchObject({repositoryId:shop._id,repository:'acme/shop',path:'src/cart.ts',revision:indexed,reason:'full-text match'});
 expect(body.results[0].snippet).toContain('return cents * qty;');
 const script=()=>{let turn=0;vi.spyOn(HttpModel.prototype,'runTools').mockImplementation(async(r:ToolRequest):Promise<ToolTurn>=>{turn++;const calls:ToolCall[]=turn===1?[{id:'r1',name:'read_file',input:{repository:'acme/shop',path:'src/cart.ts'}}]:turn===2?[{id:'a1',name:'answer',input:{answer:'total() multiplies cents by quantity [1].',citations:[{repository:'acme/shop',filePath:'src/cart.ts',startLine:2,quote:'  return cents * qty;'}]}}]:[];void r;return {content:'',toolCalls:calls,stopReason:calls.length?'tool_use':'end_turn',usage:{task:'chat',provider:'fixture',model:'fixture',inputTokens:10,outputTokens:5,latencyMs:1,estimatedCost:0.001,cached:false},message:{role:'assistant',content:'',toolCalls:calls}};});};
 script();
 const [answerStatus,answer]=await json(await queryRoute(request('/api/query',keys.read,{question:'How is the total computed?',repositoryIds:[shop._id]})));
 expect(answerStatus).toBe(200);
 expect(answer).toMatchObject({status:'completed',answer:'total() multiplies cents by quantity [1].',sources:[{repository:'acme/shop',path:'src/cart.ts',startLine:2,endLine:2,quote:'  return cents * qty;',revision:indexed,url:`https://github.com/acme/shop/blob/${indexed}/src/cart.ts#L2`}]});
 expect(await json(await queryResultRoute(request('/api/query/'+answer.messageId,keys.read),params('messageId',answer.messageId)))).toEqual([200,expect.objectContaining({threadId:answer.threadId,status:'completed'})]);
 expect((await queryResultRoute(request('/api/query/'+answer.messageId,keys.rival),params('messageId',answer.messageId))).status).toBe(404);
 // API threads are labelled as such in the owner's chat list.
 expect((await t.run(ctx=>ctx.db.get(answer.threadId as Id<'chatThreads'>)))?.origin).toBe('api');
 vi.mocked(HttpModel.prototype.runTools).mockRestore();script();
 const streamed=await queryRoute(request('/api/query',keys.read,{question:'And the checkout?',repositoryIds:[shop._id],stream:true}));
 expect(streamed.headers.get('content-type')).toContain('text/event-stream');
 const events=await streamed.text();
 const thread=JSON.parse(/^event: thread\ndata: (.+)\n\n/.exec(events)![1]);
 expect(Object.keys(thread).sort()).toEqual(['messageId','threadId']);
 expect(events).toContain('event: progress\ndata: {"kind":"tool","text":"Reading acme/shop:src/cart.ts"}');
 const final=JSON.parse(/event: answer\ndata: (.+)\n\n$/.exec(events)![1]);
 expect(final).toMatchObject({...thread,status:'completed',answer:'total() multiplies cents by quantity [1].',sources:[{repository:'acme/shop',path:'src/cart.ts',startLine:2,revision:indexed}]});
},30_000);
