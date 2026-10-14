"use node";
import {randomUUID} from "node:crypto";
import {action,internalAction,type ActionCtx} from "./_generated/server";
import {internal} from "./_generated/api";
import type {Id,Doc} from "./_generated/dataModel";
import {v} from "convex/values";
import {service} from "./auth";
import {Notion,NotionError,notionCredentials,notionPageIds,notionToken,revokeNotion} from "../src/notion";
import {encryptCredential,decryptCredential} from "../src/credentials";
import type {SourceFile} from "../src/engine/types";

// Notion requirements context, following the Linear/Atlassian pattern: encrypted credentials,
// refresh under a lease, one retry after a 401, generation checks against scope changes.
const scopeOf=(c:Doc<"integrationConnections">)=>c.organizationId+":notion";
async function client(ctx:ActionCtx,id:Id<"integrationConnections">,force=false):Promise<{connection:Doc<"integrationConnections">;notion:Notion}>{
 const connection=await ctx.runQuery(internal.integrations.data,{id});
 if(connection.kind!=="notion")throw new Error("Notion connection required");
 const credentials=notionCredentials.parse(JSON.parse(decryptCredential(connection.credentials,scopeOf(connection))));
 if(!force)return {connection,notion:new Notion(credentials.accessToken)};
 if(!credentials.refreshToken){await ctx.runMutation(internal.notionData.markError,{id,error:"Notion rejected the stored token. Reconnect Notion to restore requirements access."});throw new Error("Notion authorization was revoked");}
 const lease=randomUUID();
 if(!await ctx.runMutation(internal.integrations.claimRefresh,{id,credentials:connection.credentials,lease}))throw new Error("Notion token refresh is in progress; retry shortly");
 try{
  const refreshed=await notionToken(process.env.NOTION_CLIENT_ID??"",process.env.NOTION_CLIENT_SECRET??"",{refreshToken:credentials.refreshToken});
  if(refreshed.workspaceId!==connection.externalId)throw new Error("Notion workspace identity changed");
  if(!await ctx.runMutation(internal.integrations.refreshed,{id,lease,credentials:encryptCredential(JSON.stringify(refreshed.credentials),scopeOf(connection)),expiresAt:refreshed.credentials.expiresAt}))throw new Error("Notion disconnected during token refresh");
  return {connection,notion:new Notion(refreshed.credentials.accessToken)};
 }catch(error){await ctx.runMutation(internal.integrations.refreshFailed,{id,lease});throw error;}
}
async function read<T>(ctx:ActionCtx,id:Id<"integrationConnections">,operation:(notion:Notion)=>Promise<T>):Promise<{value:T;connection:Doc<"integrationConnections">}>{
 let current=await client(ctx,id),value:T;
 try{value=await operation(current.notion);}catch(error){if(!(error instanceof NotionError)||error.status!==401)throw error;current=await client(ctx,id,true);value=await operation(current.notion);}
 const latest=await ctx.runQuery(internal.integrations.data,{id});if(latest.generation!==current.connection.generation)throw new Error("Notion connection or scope changed during retrieval");
 return {value,connection:current.connection};
}
export const connect=action({args:{token:v.string(),secret:v.string(),organizationId:v.id("organizations"),code:v.string(),redirectUri:v.string(),jti:v.string(),expiresAt:v.number()},handler:async(ctx,a):Promise<Id<"integrationConnections">>=>{
 service(a.secret);await ctx.runQuery(internal.integrations.authorizeAdmin,{token:a.token,organizationId:a.organizationId});
 if(!a.code||a.code.length>4000||a.redirectUri!==(process.env.APP_URL??"http://localhost:3000").replace(/\/$/,"")+"/api/integrations/notion/callback")throw new Error("Invalid Notion OAuth callback");
 await ctx.runMutation(internal.integrations.receipt,{token:a.token,organizationId:a.organizationId,jti:a.jti,expiresAt:a.expiresAt});
 const granted=await notionToken(process.env.NOTION_CLIENT_ID??"",process.env.NOTION_CLIENT_SECRET??"",{code:a.code,redirectUri:a.redirectUri});
 try{return await ctx.runMutation(internal.integrations.save,{token:a.token,organizationId:a.organizationId,kind:"notion",externalId:granted.workspaceId,name:granted.workspaceName,credentials:encryptCredential(JSON.stringify(granted.credentials),a.organizationId+":notion"),expiresAt:granted.credentials.expiresAt});}
 catch(error){await revokeNotion(process.env.NOTION_CLIENT_ID??"",process.env.NOTION_CLIENT_SECRET??"",granted.credentials.accessToken).catch(()=>undefined);throw error;}
}});
export const discover=action({args:{token:v.string(),id:v.id("integrationConnections")},handler:async(ctx,a):Promise<{pages:{id:string;title:string;url:string}[]}>=>{
 await ctx.runQuery(internal.integrations.access,a);
 return {pages:(await read(ctx,a.id,notion=>notion.sharedPages())).value};
}});
export const configure=action({args:{token:v.string(),id:v.id("integrationConnections"),repositoryIds:v.array(v.id("repositories"))},handler:async(ctx,a)=>{
 await ctx.runQuery(internal.integrations.access,{token:a.token,id:a.id});
 const {connection}=await read(ctx,a.id,notion=>notion.sharedPages());
 await ctx.runMutation(internal.integrations.scope,{token:a.token,id:a.id,teamIds:[],projectIds:[],repositoryIds:a.repositoryIds,generation:connection.generation});
}});
export const revoke=internalAction({args:{id:v.id("integrationRevocations")},handler:async(ctx,a)=>{
 const lease=randomUUID(),r=await ctx.runMutation(internal.integrations.claimRevocation,{...a,lease});if(!r)return;
 try{const credentials=notionCredentials.parse(JSON.parse(decryptCredential(r.credentials,r.organizationId+":notion")));await revokeNotion(process.env.NOTION_CLIENT_ID??"",process.env.NOTION_CLIENT_SECRET??"",credentials.accessToken);await ctx.runMutation(internal.integrations.revocationResult,{id:a.id,lease,success:true});}
 catch{await ctx.runMutation(internal.integrations.revocationResult,{id:a.id,lease,success:false});}
}});
// Pages linked from the PR title, description or branch; at most ten per connection, 100KB.
export const requirements=internalAction({args:{repositoryId:v.id("repositories"),references:v.string()},handler:async(ctx,a):Promise<{files:SourceFile[];scopes:{id:Id<"integrationConnections">;generation:number}[];coverage:string[]}>=>{
 const connections=await ctx.runQuery(internal.integrations.forRepository,{repositoryId:a.repositoryId,kind:"notion"});
 const files:SourceFile[]=[],coverage:string[]=[],scopes=connections.map(c=>({id:c._id,generation:c.generation}));
 if(!connections.length)return {files,scopes,coverage};
 const {ids,truncated}=notionPageIds(a.references);
 if(truncated)coverage.push("Notion retrieval limited to the first 10 linked pages.");
 if(!ids.length)coverage.push("No Notion page links were found in the PR title, description or branch; no Notion requirements were fetched.");
 let bytes=0;
 for(const c of connections)for(const id of ids){
  try{
   const {value:page,connection}=await read(ctx,c._id,notion=>notion.page(id));
   if(connection.generation!==c.generation)throw new Error("Integration changed");
   const content=`# ${page.title}\nSource: ${page.url}\nUpdated: ${page.revision}\n\n${page.text}`,size=Buffer.byteLength(content,"utf8");
   if(bytes+size>100000){coverage.push("Notion requirements context exceeded the 100KB limit.");continue;}
   bytes+=size;files.push({path:`requirements/notion/${c._id}/${id}.md`,content,sha:page.revision,provenance:{repository:"Notion: "+connection.name,revision:page.revision,sourceUrl:page.url}});
  }catch{coverage.push(`Notion page ${id} was unavailable or not shared with the integration in connection ${c._id}; its requirements were not used.`);}
 }
 await ctx.runQuery(internal.integrations.validate,{repositoryId:a.repositoryId,scopes});
 return {files,scopes,coverage:[...new Set(coverage)]};
}});
