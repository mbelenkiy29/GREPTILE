import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import {SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import schema from '../convex/schema';
import {api} from '../convex/_generated/api';
import {HttpModel} from '../src/engine/model';
import {mcpToolNames} from '../src/mcp-tools';
import type {Id} from '../convex/_generated/dataModel';
import type {ToolCall,ToolRequest,ToolTurn} from '../src/engine/types';

// The remote MCP route and the REST handlers it dispatches to run for real against convex-test.
const holder=vi.hoisted(()=>({t:undefined as unknown}));
vi.mock('../src/server',()=>({
 backend:()=>{type Call=(ref:unknown,args:unknown)=>Promise<unknown>;const t=holder.t as {query:Call;mutation:Call;action:Call};return {query:(r:unknown,a:unknown)=>t.query(r,a),mutation:(r:unknown,a:unknown)=>t.mutation(r,a),action:(r:unknown,a:unknown)=>t.action(r,a)};},
 signSession:(userId:string)=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(userId).setIssuer('openreview').setAudience('openreview').setExpirationTime('1h').sign(new TextEncoder().encode('integration-session-secret-at-least-32-characters')),
}));
import {POST,GET} from '../app/api/mcp/route';

const modules=import.meta.glob('../convex/**/*.ts');
const secret='integration-session-secret-at-least-32-characters',indexed='e'.repeat(40);
beforeEach(()=>{process.env.SESSION_SECRET=secret;process.env.SERVICE_SECRET='integration-service-secret';process.env.LLM_API_KEY='fixture';delete process.env.EMBEDDING_MODEL;});
afterEach(()=>vi.restoreAllMocks());

async function setup(){
 const t=convexTest(schema,modules);holder.t=t;
 const login=async(githubId:number,name:string)=>{const id=await t.mutation(api.users.login,{secret:'integration-service-secret',githubId,login:name,avatar:''});return {id,token:await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setIssuer('openreview').setAudience('openreview').setSubject(id).setExpirationTime('1h').sign(new TextEncoder().encode(secret))};};
 const alice=await login(71,'alice'),mallory=await login(72,'mallory');
 const org=await t.mutation(api.users.createOrganization,{token:alice.token,name:'Acme'});
 const rival=await t.mutation(api.users.createOrganization,{token:mallory.token,name:'Rival'});
 await t.mutation(api.repositories.connect,{token:alice.token,secret:'integration-service-secret',organizationId:org,installationId:71,account:'acme',accountId:1,repositories:[{id:7101,fullName:'acme/shop',defaultBranch:'main'}]});
 const [shop]=await t.query(api.repositories.list,{token:alice.token,organizationId:org});
 const keys=await t.run(async ctx=>{
  await ctx.db.patch(shop._id,{enabled:true,indexStatus:'ready',indexedSha:indexed});
  const content='export function total(cents: number, qty: number) {\n  return cents * qty;\n}\n';
  await ctx.db.insert('repositoryFiles',{organizationId:org,repositoryId:shop._id,path:'src/cart.ts',sha:'blob',storageId:await ctx.storage.store(new Blob([content])),language:'typescript',updatedAt:0});
  await ctx.db.insert('codeChunks',{organizationId:org,repositoryId:shop._id,filePath:'src/cart.ts',startLine:1,content});
  const key=async(raw:string,organizationId:Id<'organizations'>,userId:string,scopes:string[],revoked=false)=>{await ctx.db.insert('apiKeys',{organizationId,userId:userId as Id<'users'>,hash:createHash('sha256').update(raw).digest('hex'),name:raw,prefix:raw.slice(0,11),createdAt:0,revoked,scopes});return raw;};
  return {read:await key('or_mcp_read',org,alice.id,['read']),revoked:await key('or_mcp_revoked',org,alice.id,['read'],true),rival:await key('or_mcp_rival',rival,mallory.id,['read'])};
 });
 return {t,shop,keys};
}
async function connect(key?:string){
 const client=new Client({name:'test-client',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'),{requestInit:{headers:key?{authorization:'Bearer '+key}:{}},fetch:async(url,init)=>POST(new Request(url,init))}));
 return client;
}
const textOf=(r:unknown)=>((r as {content:{type:string;text:string}[]}).content[0].text);
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'raw',version:'1'}}};
const raw=(key?:string,body:unknown=initialize)=>POST(new Request('http://localhost/api/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(key?{authorization:'Bearer '+key}:{})},body:JSON.stringify(body)}));

test('requests without a valid API key are rejected before any MCP handling',async()=>{
 const {keys}=await setup();
 for(const key of [undefined,'or_unknown',keys.revoked]){
  const response=await raw(key);
  expect(response.status).toBe(401);
  // RFC 9728 challenge: where to find the protected-resource metadata and which scope to request.
  expect(response.headers.get('www-authenticate')).toMatch(new RegExp(`^Bearer ${key?'error="invalid_token", ':''}resource_metadata="https?://[^"]+/\\.well-known/oauth-protected-resource/api/mcp", scope="read"$`));
 }
 await expect(connect()).rejects.toThrow();
 expect((await GET()).status).toBe(405);
 // The initialize handshake succeeds with a key.
 const ok=await raw(keys.read);
 expect(ok.status).toBe(200);
 expect((await ok.json()).result.serverInfo).toEqual({name:'openreview',version:'0.2.0'});
});

test('tools/list exposes the stdio tools plus ask_codebase and search_code',async()=>{
 const {keys}=await setup();
 const client=await connect(keys.read);
 const {tools}=await client.listTools();
 expect(tools.map(t=>t.name).sort()).toEqual([...mcpToolNames].sort());
 expect(tools.find(t=>t.name==='ask_codebase')?.inputSchema.required).toEqual(['question','repositoryIds']);
 await client.close();
});

test('tools/call runs through the public API with the key\'s scopes and workspace',async()=>{
 const {shop,keys}=await setup();
 const client=await connect(keys.read);
 const repos=JSON.parse(textOf(await client.callTool({name:'list_repositories',arguments:{}})));
 expect(repos.map((r:{fullName:string})=>r.fullName)).toEqual(['acme/shop']);
 const search=await client.callTool({name:'search_code',arguments:{query:'total',repositoryIds:[shop._id]}});
 expect(search.isError).toBeFalsy();
 expect(JSON.parse(textOf(search)).results[0]).toMatchObject({repository:'acme/shop',path:'src/cart.ts',revision:indexed});
 // A read-scoped key cannot write.
 const write=await client.callTool({name:'mark_finding_resolved',arguments:{findingId:'0'.repeat(20)+'findings',comment:'done'}});
 expect(write.isError).toBe(true);
 expect(textOf(write)).toBe('OpenReview API returned HTTP 403: This API key does not have the write scope');
 // Invalid arguments are rejected by the tool schema.
 const invalid=await client.callTool({name:'search_code',arguments:{query:'x'}});
 expect(invalid.isError).toBe(true);
 await client.close();
 // Another workspace's key cannot reach Acme's repository.
 const rival=await connect(keys.rival);
 const denied=await rival.callTool({name:'search_code',arguments:{query:'total',repositoryIds:[shop._id]}});
 expect(denied.isError).toBe(true);expect(textOf(denied)).toMatch(/HTTP 404/);
 expect(JSON.parse(textOf(await rival.callTool({name:'list_repositories',arguments:{}})))).toEqual([]);
 await rival.close();
});

test('ask_codebase answers with sources validated against the indexed revision',async()=>{
 const {shop,keys}=await setup();
 let turn=0;
 vi.spyOn(HttpModel.prototype,'runTools').mockImplementation(async(r:ToolRequest):Promise<ToolTurn>=>{void r;turn++;const calls:ToolCall[]=turn===1?[{id:'r',name:'read_file',input:{repository:'acme/shop',path:'src/cart.ts'}}]:turn===2?[{id:'a',name:'answer',input:{answer:'total() multiplies cents by quantity [1].',citations:[{repository:'acme/shop',filePath:'src/cart.ts',startLine:2,quote:'  return cents * qty;'}]}}]:[];return {content:'',toolCalls:calls,stopReason:calls.length?'tool_use':'end_turn',usage:{task:'chat',provider:'fixture',model:'fixture',inputTokens:1,outputTokens:1,latencyMs:1,estimatedCost:0,cached:false},message:{role:'assistant',content:'',toolCalls:calls}};});
 const client=await connect(keys.read);
 const answer=await client.callTool({name:'ask_codebase',arguments:{question:'How is the total computed?',repositoryIds:[shop._id]}});
 expect(answer.isError).toBeFalsy();
 expect(JSON.parse(textOf(answer))).toMatchObject({status:'completed',answer:'total() multiplies cents by quantity [1].',sources:[{repository:'acme/shop',path:'src/cart.ts',startLine:2,revision:indexed}]});
 await client.close();
},30_000);
