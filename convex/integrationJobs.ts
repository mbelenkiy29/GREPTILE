"use node";
import {randomUUID} from "node:crypto";
import {action,internalAction,type ActionCtx} from "./_generated/server";
import {internal} from "./_generated/api";
import type {Id,Doc} from "./_generated/dataModel";
import {v} from "convex/values";
import {service} from "./auth";
import {Linear,LinearError,linearToken,linearCredentials,revokeLinear} from "../src/linear";
import {encryptCredential,decryptCredential} from "../src/credentials";
import type {SourceFile} from "../src/engine/types";
import {boundRequirementsContext} from "../src/requirements-context";

async function client(ctx:ActionCtx,id:Id<"integrationConnections">,force=false):Promise<{connection:Doc<"integrationConnections">;linear:Linear}>{
 const connection=await ctx.runQuery(internal.integrations.data,{id});
 if(connection.kind!=="linear")throw new Error("Linear connection required");
 const scope=connection.organizationId+":linear",credentials=linearCredentials.parse(JSON.parse(decryptCredential(connection.credentials,scope)));
 if(force||credentials.expiresAt<Date.now()+60000){
  const lease=randomUUID();
  if(!await ctx.runMutation(internal.integrations.claimRefresh,{id,credentials:connection.credentials,lease}))throw new Error("Linear token refresh is in progress; retry shortly");
  try{
   const refreshed=await linearToken(process.env.LINEAR_CLIENT_ID??"",{refreshToken:credentials.refreshToken});
   if(!await ctx.runMutation(internal.integrations.refreshed,{id,lease,credentials:encryptCredential(JSON.stringify(refreshed),scope),expiresAt:refreshed.expiresAt})){await revokeLinear(refreshed);throw new Error("Linear disconnected during token refresh");}
   return {connection,linear:new Linear(refreshed.accessToken)};
  }catch(error){await ctx.runMutation(internal.integrations.refreshFailed,{id,lease});throw error;}
 }
 return {connection,linear:new Linear(credentials.accessToken)};
}
async function read<T>(ctx:ActionCtx,id:Id<"integrationConnections">,operation:(linear:Linear,connection:Doc<"integrationConnections">)=>Promise<T>):Promise<{value:T;connection:Doc<"integrationConnections">}>{
 let current=await client(ctx,id),value:T;
 try{value=await operation(current.linear,current.connection);}catch(error){if(!(error instanceof LinearError)||error.status!==401)throw error;current=await client(ctx,id,true);value=await operation(current.linear,current.connection);}
 const latest=await ctx.runQuery(internal.integrations.data,{id});if(latest.generation!==current.connection.generation)throw new Error("Linear connection or scope changed during retrieval");
 return {value,connection:current.connection};
}
export const connect=action({args:{token:v.string(),secret:v.string(),organizationId:v.id("organizations"),code:v.string(),verifier:v.string(),redirectUri:v.string(),jti:v.string(),expiresAt:v.number()},handler:async(ctx,a):Promise<Id<"integrationConnections">>=>{
 service(a.secret);await ctx.runQuery(internal.integrations.authorizeAdmin,{token:a.token,organizationId:a.organizationId});
 if(!a.code||a.code.length>4000||!/^[a-zA-Z0-9_-]{43,128}$/.test(a.verifier)||a.redirectUri!==(process.env.APP_URL??"http://localhost:3000").replace(/\/$/,"")+"/api/integrations/linear/callback")throw new Error("Invalid Linear OAuth callback");
 await ctx.runMutation(internal.integrations.receipt,{token:a.token,organizationId:a.organizationId,jti:a.jti,expiresAt:a.expiresAt});
 const credentials=await linearToken(process.env.LINEAR_CLIENT_ID??"",{code:a.code,verifier:a.verifier,redirectUri:a.redirectUri});
 try{const identity=await new Linear(credentials.accessToken).identity();return await ctx.runMutation(internal.integrations.save,{token:a.token,organizationId:a.organizationId,externalId:identity.organization.id,name:identity.organization.name,credentials:encryptCredential(JSON.stringify(credentials),a.organizationId+":linear"),expiresAt:credentials.expiresAt});}
 catch(error){await revokeLinear(credentials);throw error;}
}});
export const discover=action({args:{token:v.string(),id:v.id("integrationConnections")},handler:async(ctx,a):Promise<{teams:{id:string;name:string;key:string}[];projects:{id:string;name:string}[]}>=>{
 await ctx.runQuery(internal.integrations.access,a);
 return (await read(ctx,a.id,async(linear,connection)=>{const identity=await linear.identity();if(identity.organization.id!==connection.externalId)throw new Error("Linear workspace identity changed");return linear.resources();})).value;
}});
export const refresh=action({args:{token:v.string(),id:v.id("integrationConnections")},handler:async(ctx,a):Promise<{expiresAt:number}>=>{
 await ctx.runQuery(internal.integrations.access,a);
 const current=await client(ctx,a.id,true),identity=await current.linear.identity();
 if(identity.organization.id!==current.connection.externalId)throw new Error("Linear workspace identity changed");
 const latest=await ctx.runQuery(internal.integrations.data,{id:a.id});
 if(latest.generation!==current.connection.generation)throw new Error("Linear connection or scope changed during refresh");
 return {expiresAt:latest.expiresAt};
}});
export const configure=action({args:{token:v.string(),id:v.id("integrationConnections"),teamIds:v.array(v.string()),projectIds:v.array(v.string()),repositoryIds:v.array(v.id("repositories"))},handler:async(ctx,a)=>{
 await ctx.runQuery(internal.integrations.access,{token:a.token,id:a.id});
 const {value,connection}=await read(ctx,a.id,async(linear,c)=>{const identity=await linear.identity();if(identity.organization.id!==c.externalId)throw new Error("Linear workspace identity changed");return linear.resources();});
 if(a.teamIds.some(id=>!value.teams.some(t=>t.id===id))||a.projectIds.some(id=>!value.projects.some(p=>p.id===id)))throw new Error("Select only resources authorized by Linear");
 await ctx.runMutation(internal.integrations.scope,{...a,generation:connection.generation});
}});
export const revoke=internalAction({args:{id:v.id("integrationRevocations")},handler:async(ctx,a)=>{
 const lease=randomUUID(),r=await ctx.runMutation(internal.integrations.claimRevocation,{...a,lease});if(!r)return;
 try{await revokeLinear(linearCredentials.parse(JSON.parse(decryptCredential(r.credentials,r.organizationId+":linear"))));await ctx.runMutation(internal.integrations.revocationResult,{id:a.id,lease,success:true});}
 catch{await ctx.runMutation(internal.integrations.revocationResult,{id:a.id,lease,success:false});}
}});
export const requirements=internalAction({args:{repositoryId:v.id("repositories"),references:v.string()},handler:async(ctx,a):Promise<{files:SourceFile[];scopes:{id:Id<"integrationConnections">;generation:number}[];coverage:string[]}>=>{
 const connections=await ctx.runQuery(internal.integrations.forRepository,{repositoryId:a.repositoryId,kind:"linear"});
 const identifiers=[...new Set(a.references.match(/\b[A-Z0-9][A-Z0-9_]{0,49}-[1-9]\d{0,9}\b/g)??[])];
 const files:SourceFile[]=[],coverage:string[]=[],scopes=connections.map(c=>({id:c._id,generation:c.generation}));

 // ponytail: fetch at most ten explicitly referenced issues, 100KB total; surface the ceiling in review diagnostics.
 if(connections.length&&identifiers.length>10)coverage.push("Linear retrieval limited to the first 10 referenced issue identifiers.");
 let bytes=0;
 for(const c of connections)for(const identifier of identifiers.slice(0,10)){
  try{
   const {value:issue,connection}=await read(ctx,c._id,(linear,connection)=>linear.issue(identifier,{organizationId:connection.externalId,teamIds:connection.teamIds,projectIds:connection.projectIds}));
   if(connection.generation!==c.generation)throw new Error("Integration changed");
   const content=`# ${issue.identifier}: ${issue.title}\nSource: ${issue.url}\nUpdated: ${issue.updatedAt}\n\n${issue.description??""}`;
   const size=Buffer.byteLength(content,"utf8");
   if(bytes+size>100000){coverage.push("Linear requirements context exceeded the 100KB limit.");continue;}
   bytes+=size;files.push({path:`requirements/linear/${c._id}/${identifier}.md`,content,sha:issue.updatedAt,provenance:{repository:"Linear: "+connection.name,revision:issue.updatedAt,sourceUrl:issue.url}});
  }catch{coverage.push(`Linear issue ${identifier} was unavailable or outside the selected resources in connection ${c._id}; its requirements were not used.`);}
 }
 await ctx.runQuery(internal.integrations.validate,{repositoryId:a.repositoryId,scopes});
 if(connections.length&&!identifiers.length)coverage.push("No Linear issue identifiers were referenced in the PR title, description or branch; no requirements were fetched.");
 const atlassian=await ctx.runAction(internal.atlassianJobs.requirements,a);
 const notion=await ctx.runAction(internal.notionJobs.requirements,a);
 const combined=boundRequirementsContext([...files,...atlassian.files,...notion.files]);
 return {files:combined.files,scopes:[...scopes,...atlassian.scopes,...notion.scopes],coverage:[...new Set([...coverage,...atlassian.coverage,...notion.coverage,...combined.coverage])]};
}});
