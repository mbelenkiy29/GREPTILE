"use node";
import {createHash,randomUUID} from "node:crypto";
import {action,internalAction,type ActionCtx} from "./_generated/server";
import {internal} from "./_generated/api";
import type {Id,Doc} from "./_generated/dataModel";
import {v} from "convex/values";
import {service} from "./auth";
import {Atlassian,AtlassianError,atlassianToken,atlassianCredentials,type AtlassianSite} from "../src/atlassian";
import {encryptCredential,decryptCredential} from "../src/credentials";
import type {SourceFile} from "../src/engine/types";

async function client(ctx:ActionCtx,id:Id<"integrationConnections">,force=false) {
 const connection=await ctx.runQuery(internal.integrations.data,{id});
 if(connection.kind!=="atlassian")throw new Error("Atlassian connection required");
 const scope=connection.organizationId+":atlassian",credentials=atlassianCredentials.parse(JSON.parse(decryptCredential(connection.credentials,scope)));
 if(force||credentials.expiresAt<Date.now()+60000){
  const lease=randomUUID();if(!await ctx.runMutation(internal.integrations.claimRefresh,{id,credentials:connection.credentials,lease}))throw new Error("Token refresh in progress; retry shortly");
  try{
   const refreshed=await atlassianToken(process.env.ATLASSIAN_CLIENT_ID??"",process.env.ATLASSIAN_CLIENT_SECRET??"",{refreshToken:credentials.refreshToken});
   if(!await ctx.runMutation(internal.integrations.refreshed,{id,lease,credentials:encryptCredential(JSON.stringify(refreshed),scope),expiresAt:refreshed.expiresAt}))throw new Error("Atlassian disconnected during refresh; revoke the app grant in Connected Apps");
   return {connection,atlassian:new Atlassian(refreshed.accessToken)};
  }catch(error){await ctx.runMutation(internal.integrations.refreshFailed,{id,lease});throw error;}
 }
 return {connection,atlassian:new Atlassian(credentials.accessToken)};
}
async function read<T>(ctx:ActionCtx,id:Id<"integrationConnections">,operation:(client:Atlassian,c:Doc<"integrationConnections">)=>Promise<T>):Promise<{value:T;connection:Doc<"integrationConnections">}>{
 let current=await client(ctx,id),value:T;
 try{value=await operation(current.atlassian,current.connection);}catch(error){if(!(error instanceof AtlassianError)||error.status!==401)throw error;current=await client(ctx,id,true);value=await operation(current.atlassian,current.connection);}
 const latest=await ctx.runQuery(internal.integrations.data,{id});if(latest.generation!==current.connection.generation)throw new Error("Atlassian scope changed during retrieval");
 return {value,connection:current.connection};
}
function mergeSites(sites:AtlassianSite[]) {
 const result:AtlassianSite[]=[];
 for(const site of sites){const old=result.find(s=>s.id===site.id);if(old&&old.url!==site.url)throw new Error("Atlassian site identity mismatch");if(old)old.scopes=[...new Set([...old.scopes,...site.scopes])];else result.push({...site});}
 return result;
}
async function resources(atlassian:Atlassian,c:Doc<"integrationConnections">) {
 const sites=mergeSites(await atlassian.sites()).filter(s=>c.sites?.some(old=>old.id===s.id&&old.url===s.url));
 const projects:{id:string;name:string}[]=[],spaces:{id:string;name:string}[]=[];
 for(const site of sites){const data=await atlassian.resources(site);projects.push(...data.projects.map(p=>({id:site.id+":"+p.id,name:site.name+" · "+p.name+" · "+p.key})));spaces.push(...data.spaces.map(p=>({id:site.id+":"+p.id,name:site.name+" · "+p.name+" · "+p.key})));}
 return {projects,spaces};
}
export const connect=action({args:{token:v.string(),secret:v.string(),organizationId:v.id("organizations"),code:v.string(),redirectUri:v.string(),jti:v.string(),expiresAt:v.number()},handler:async(ctx,a):Promise<Id<"integrationConnections">>=>{
 service(a.secret);await ctx.runQuery(internal.integrations.authorizeAdmin,{token:a.token,organizationId:a.organizationId});
 if(!a.code||a.code.length>4000||a.redirectUri!==(process.env.APP_URL??"http://localhost:3000").replace(/\/$/,"")+"/api/integrations/atlassian/callback")throw new Error("Invalid Atlassian OAuth callback");
 await ctx.runMutation(internal.integrations.receipt,{token:a.token,organizationId:a.organizationId,jti:a.jti,expiresAt:a.expiresAt});
 const credentials=await atlassianToken(process.env.ATLASSIAN_CLIENT_ID??"",process.env.ATLASSIAN_CLIENT_SECRET??"",{code:a.code,redirectUri:a.redirectUri});
 const sites=mergeSites(await new Atlassian(credentials.accessToken).sites());
 if(!sites.length)throw new Error("No authorized Atlassian sites");
 const externalId=createHash("sha256").update(JSON.stringify(sites.map(s=>s.id+":"+s.url).sort())).digest("hex");
 return ctx.runMutation(internal.integrations.save,{token:a.token,organizationId:a.organizationId,kind:"atlassian",sites,externalId,name:sites.map(s=>s.name).join(", ").slice(0,200),credentials:encryptCredential(JSON.stringify(credentials),a.organizationId+":atlassian"),expiresAt:credentials.expiresAt});
}});
export const discover=action({args:{token:v.string(),id:v.id("integrationConnections")},handler:async(ctx,a):Promise<{projects:{id:string;name:string}[];spaces:{id:string;name:string}[]}>=>{
 await ctx.runQuery(internal.integrations.access,a);return(await read(ctx,a.id,resources)).value;
}});
export const configure=action({args:{token:v.string(),id:v.id("integrationConnections"),jiraProjectIds:v.array(v.string()),confluenceSpaceIds:v.array(v.string()),repositoryIds:v.array(v.id("repositories"))},handler:async(ctx,a)=>{
 await ctx.runQuery(internal.integrations.access,{token:a.token,id:a.id});const {value,connection}=await read(ctx,a.id,resources);
 if(a.jiraProjectIds.some(id=>!value.projects.some(p=>p.id===id))||a.confluenceSpaceIds.some(id=>!value.spaces.some(p=>p.id===id)))throw new Error("Select only currently authorized Atlassian resources");
 await ctx.runMutation(internal.integrations.scope,{...a,teamIds:[],projectIds:[],generation:connection.generation});
}});
export const requirements=internalAction({args:{repositoryId:v.id("repositories"),references:v.string()},handler:async(ctx,a):Promise<{files:SourceFile[];scopes:{id:Id<"integrationConnections">;generation:number}[];coverage:string[]}>=>{
 const connections=await ctx.runQuery(internal.integrations.forRepository,{repositoryId:a.repositoryId,kind:"atlassian"});
 const files:SourceFile[]=[],coverage:string[]=[],scopes=connections.map(c=>({id:c._id,generation:c.generation}));if(!connections.length)return{files,coverage,scopes};
 const keys=[...new Set(a.references.match(/\b[A-Z][A-Z0-9_]{0,49}-[1-9]\d{0,19}\b/g)??[])];
 const urls=[...new Set(a.references.match(/https:\/\/[^\s<>()\[\]`"']+/g)??[])].map(s=>{try{return new URL(s.replace(/[.,;:!]+$/,""));}catch{return null;}}).filter((u):u is URL=>!!u);
 // ponytail: ten referenced issues/pages per connection and 100KB total context; diagnostics expose truncation.
 let bytes=0;
 for(const c of connections){
  const data=await ctx.runQuery(internal.integrations.data,{id:c._id});
  const references:{site:AtlassianSite;key?:string;pageId?:string}[]=[];
  for(const site of data.sites??[]){
   if(data.jiraProjectIds?.some(id=>id.startsWith(site.id+":")))for(const key of keys)references.push({site,key});
   if(data.confluenceSpaceIds?.some(id=>id.startsWith(site.id+":")))for(const u of urls){
    if(u.origin!==new URL(site.url).origin||u.username||u.password)continue;
    const id=u.pathname==="/wiki/pages/viewpage.action"?u.searchParams.get("pageId"):u.pathname.match(/^\/wiki\/spaces\/[^/]+\/pages\/([1-9]\d{0,19})(?:\/|$)/)?.[1];
    if(id&&/^[1-9]\d{0,19}$/.test(id))references.push({site,pageId:id});
   }
  }
  const unique=[...new Map(references.map(r=>[r.site.id+":"+(r.key??r.pageId),r])).values()];
  if(unique.length>10)coverage.push("Atlassian retrieval limited to ten referenced issues/pages per connection.");
  if(!unique.length)coverage.push(`No Jira keys or Confluence page URLs matched selected resources in connection ${c._id}; no Atlassian requirements were fetched.`);
  for(const r of unique.slice(0,10))try{
   const {value:item,connection}=await read(ctx,c._id,(api,connection)=>r.key?api.issue(r.site,r.key,(connection.jiraProjectIds??[]).filter(id=>id.startsWith(r.site.id+":")).map(id=>id.split(":")[1])):api.page(r.site,r.pageId!,(connection.confluenceSpaceIds??[]).filter(id=>id.startsWith(r.site.id+":")).map(id=>id.split(":")[1])));
   if(connection.generation!==c.generation)throw new Error("Integration changed");
   const content=`# ${item.title}\nSource: ${item.url}\nRevision: ${item.revision}\n\n${item.description}`,size=Buffer.byteLength(content,"utf8");
   if(bytes+size>100000){coverage.push("Atlassian requirements exceeded the 100KB context limit.");continue;}
   bytes+=size;files.push({path:`requirements/atlassian/${c._id}/${r.site.id}/${r.key??r.pageId}.md`,content,sha:item.revision,provenance:{repository:"Atlassian: "+r.site.name,revision:item.revision,sourceUrl:item.url}});
  }catch{coverage.push(`Atlassian reference ${r.key??r.pageId} was unavailable or outside selected resources in connection ${c._id}; its requirements were not used.`);}
 }
 await ctx.runQuery(internal.integrations.validate,{repositoryId:a.repositoryId,scopes});return{files,scopes,coverage:[...new Set(coverage)]};
}});
