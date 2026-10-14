import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { api,internal } from "./_generated/api";
import { v } from "convex/values";
import { authorize,authorizeRepository,service,audit } from "./auth";
import { providerGroupValidator } from "./schema";
import { providerTeam } from "./scopes";
import { defaults } from "../src/review-settings";
import {disableRepository,cancelRepositoryIndex} from "./repositories";
import type {MutationCtx} from "./_generated/server";
import type {Id} from "./_generated/dataModel";
export const list=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 return (await ctx.db.query("providerConnections").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect()).map(c=>({_id:c._id,kind:c.kind,instance:c.instance,name:c.name,active:c.active,suspended:c.suspended,error:c.error,lastEventAt:c.lastEventAt,forgeEventAt:c.forgeEventAt,forgeRefreshAt:c.forgeRefreshAt,apiUrl:c.apiUrl,proxyUrl:c.proxyUrl,caCertificates:c.caBundle?(c.caBundle.match(/-----BEGIN CERTIFICATE-----/g)??[]).length:0}));
}});
export const data=internalQuery({args:{id:v.id("providerConnections")},handler:async(ctx,a)=>{const c=await ctx.db.get(a.id);if(!c?.active||c.suspended)throw new Error("Provider connection disabled or suspended");return c;}});
export const replaceGitCredentials=internalMutation({args:{token:v.string(),id:v.id("providerConnections"),previousCredentials:v.string(),credentials:v.string(),repositories:v.array(v.object({id:v.id("repositories"),externalId:v.string(),fullName:v.string()}))},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.suspended||!["gitlab","gitea","github-enterprise","bitbucket-dc"].includes(c.kind)||c.credentials!==a.previousCredentials)throw Error("Provider connection changed during credential verification");
 const {user}=await authorize(ctx,a.token,c.organizationId,true);
 const selected=(await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect()).filter(r=>r.connectionId===c._id);
 if(selected.length!==a.repositories.length||new Set(a.repositories.map(r=>r.id)).size!==a.repositories.length||selected.some(r=>!a.repositories.some(verified=>verified.id===r._id&&verified.externalId===r.externalId&&verified.fullName===r.fullName)))throw Error("Selected repositories changed during credential verification");
 await ctx.db.patch(c._id,{credentials:a.credentials,error:undefined});
 await audit(ctx,c.organizationId,user._id,"provider.credentials_replaced",c._id);
}});
export const refreshP4=internalMutation({args:{token:v.string(),id:v.id("providerConnections"),previousCredentials:v.string(),credentials:v.string(),projectIds:v.array(v.string())},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.suspended||c.kind!=="perforce"||c.credentials!==a.previousCredentials)throw new Error("P4 connection changed during credential verification");
 const {user}=await authorize(ctx,a.token,c.organizationId,true);
 const repositories=(await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect()).filter(r=>r.connectionId===c._id);
 if(repositories.some(r=>!r.externalId||!a.projectIds.includes(r.externalId)))throw new Error("P4 project selection changed during credential verification");
 await ctx.db.patch(c._id,{credentials:a.credentials,error:undefined});
 for(const repo of repositories){
  await ctx.runMutation(api.p4Polling.configure,{token:a.token,repositoryId:repo._id,enabled:false});
  await cancelRepositoryIndex(ctx,repo);
  await ctx.db.patch(repo._id,{indexStatus:"not_indexed",error:"Bot ticket refreshed. Upload a verified submitted baseline before reviewing."});
 }
 await audit(ctx,c.organizationId,user._id,"p4.bot_ticket_refreshed",c._id);
}});
export const access=query({args:{token:v.string(),id:v.id("providerConnections")},handler:async(ctx,a)=>{const c=await ctx.db.get(a.id);if(!c?.active)throw new Error("Connection unavailable");await authorize(ctx,a.token,c.organizationId,true);return {id:c._id,organizationId:c.organizationId};}});
// Network settings arrive already validated by the web server (which test-connects with them) and are
// validated again by every Node action that uses them (connectionNetwork in src/scm-transport.ts).
const networkArgs={apiUrl:v.optional(v.string()),caBundle:v.optional(v.string()),proxyUrl:v.optional(v.string())};
function network(kind:string,a:{apiUrl?:string;caBundle?:string;proxyUrl?:string}){
 if(kind!=="gitlab"&&(a.apiUrl||a.caBundle||a.proxyUrl))throw new Error("Network settings are available for GitLab connections");
 if((a.apiUrl?.length??0)>500||(a.proxyUrl?.length??0)>500||(a.caBundle?.length??0)>65536)throw new Error("Invalid network settings");
 return {apiUrl:a.apiUrl||undefined,caBundle:a.caBundle||undefined,proxyUrl:a.proxyUrl||undefined};
}
export const save=mutation({args:{token:v.string(),secret:v.string(),organizationId:v.id("organizations"),kind:v.string(),instance:v.string(),name:v.string(),credentials:v.string(),webhookSecret:v.string(),...networkArgs},handler:async(ctx,a)=>{
 service(a.secret);const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!["gitlab","github-enterprise","gitea","bitbucket-dc","origin","perforce","azure-devops"].includes(a.kind)||!a.name.trim()||a.name.length>100||a.credentials.length>20000||a.webhookSecret.length>20000)throw new Error("Invalid connection");
 const id=await ctx.db.insert("providerConnections",{organizationId:a.organizationId,kind:a.kind,instance:a.instance,name:a.name,credentials:a.credentials,webhookSecret:a.webhookSecret,...network(a.kind,a),active:true,createdAt:Date.now()});
 await audit(ctx,a.organizationId,user._id,"provider.connected",id);return id;
}});
// Changing the API URL, CA bundle or proxy of an existing GitLab connection (for example a CA rotation),
// after providerJobs.updateNetwork validated the settings and reached every selected repository with them.
export const setNetwork=internalMutation({args:{token:v.string(),id:v.id("providerConnections"),expected:v.string(),...networkArgs},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.suspended||c.credentials!==a.expected)throw new Error("Provider connection changed during verification");
 const {user}=await authorize(ctx,a.token,c.organizationId,true);
 await ctx.db.patch(c._id,{...network(c.kind,a),error:undefined});
 await audit(ctx,c.organizationId,user._id,"provider.network_updated",c._id);
}});
export const disconnect=mutation({args:{token:v.string(),id:v.id("providerConnections")},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c)throw new Error("Connection not found");const {user}=await authorize(ctx,a.token,c.organizationId,true);
 await ctx.db.patch(c._id,{active:false,credentials:"",webhookSecret:""});
 const repos=await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect();
 for(const r of repos.filter(r=>r.connectionId===c._id))await disableRepository(ctx,r);
 await audit(ctx,c.organizationId,user._id,"provider.disconnected",c._id);
}});
export const select=internalMutation({args:{token:v.string(),connectionId:v.id("providerConnections"),repositories:v.array(v.object({externalId:v.string(),fullName:v.string(),defaultBranch:v.string(),remoteUrl:v.optional(v.string()),group:v.optional(providerGroupValidator)}))},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.connectionId);if(!c?.active||c.suspended)throw new Error("Connection disabled or suspended");const {user}=await authorize(ctx,a.token,c.organizationId,true);
 for(const {group,...r} of a.repositories){
  if(c.kind==="perforce"?(r.defaultBranch!==""||r.remoteUrl!==undefined||r.fullName!==r.externalId||group?.externalId!==r.externalId):!r.remoteUrl)throw new Error("Invalid provider repository identity");
  const sourceGroup=group??(c.kind==="origin"&&c.namespaceId?{externalId:c.namespaceId,name:"Origin "+c.namespaceId}:undefined);
  const teamId=sourceGroup?await providerTeam(ctx,c.organizationId,c.kind,c.instance,sourceGroup,user._id):undefined;
  const old=await ctx.db.query("repositories").withIndex("by_connection",q=>q.eq("connectionId",c._id).eq("externalId",r.externalId)).unique();if(old)continue;
  const id=await ctx.db.insert("repositories",{...r,teamId,connectionId:c._id,organizationId:c.organizationId,enabled:false,indexStatus:c.kind==="perforce"?"unavailable":"not_indexed",...(c.kind==="perforce"?{error:"Perforce submitted indexing requires openreview p4 index/upload or the opt-in watch worker. Review polling can be enabled after indexing."}:{}),createdAt:Date.now()});
  await ctx.db.insert("repositorySettings",{repositoryId:id,organizationId:c.organizationId,inherit:true,settings:defaults});
 }
 await audit(ctx,c.organizationId,user._id,"provider.repositories_selected",c._id);
}});
export async function receiveEvent(ctx:MutationCtx,a:{connectionId:Id<"providerConnections">;externalId:string;body:string;eventType?:string}){
 const c=await ctx.db.get(a.connectionId);if(!c?.active)throw new Error("Connection disabled");
 const old=await ctx.db.query("providerEvents").withIndex("by_delivery",q=>q.eq("connectionId",c._id).eq("externalId",a.externalId)).unique();if(old)return old._id;
 const id=await ctx.db.insert("providerEvents",{...a,status:"queued",attempts:0,createdAt:Date.now()});await ctx.db.patch(c._id,{lastEventAt:Date.now()});await ctx.scheduler.runAfter(0,internal.providerJobs.event,{id});return id;
}
export const receive=internalMutation({args:{connectionId:v.id("providerConnections"),externalId:v.string(),body:v.string(),eventType:v.optional(v.string())},handler:receiveEvent});
export const eventData=internalQuery({args:{id:v.id("providerEvents")},handler:async(ctx,a)=>ctx.db.get(a.id)});
export const eventState=internalMutation({args:{id:v.id("providerEvents"),status:v.string(),error:v.optional(v.string())},handler:async(ctx,a)=>{const e=await ctx.db.get(a.id);if(!e)return;await ctx.db.patch(e._id,{status:a.status,error:a.error,updatedAt:Date.now(),attempts:e.attempts+(a.status==="processing"?1:0)});if(a.status==="failed"&&e.attempts<3)await ctx.scheduler.runAfter(10000*2**e.attempts,internal.providerJobs.event,{id:e._id});}});
export const repositories=internalQuery({args:{connectionId:v.id("providerConnections")},handler:async(ctx,a)=>{const c=await ctx.db.get(a.connectionId);if(!c?.active)return [];return (await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect()).filter(r=>r.connectionId===c._id);}});
export const authorizeAdmin=internalQuery({args:{token:v.string(),connectionId:v.id("providerConnections")},handler:async(ctx,a)=>{const c=await ctx.db.get(a.connectionId);if(!c?.active)throw new Error("Connection unavailable");await authorize(ctx,a.token,c.organizationId,true);return true;}});
export const reviewAccess=internalQuery({args:{token:v.string(),repositoryId:v.id("repositories")},handler:async(ctx,a)=>{return (await authorizeRepository(ctx,a.token,a.repositoryId,true)).repo;}});
export const connectOrigin=mutation({args:{token:v.string(),secret:v.string(),organizationId:v.id("organizations"),installationId:v.string(),namespaceId:v.string(),credentials:v.string(),jti:v.string(),expiresAt:v.number()},handler:async(ctx,a)=>{
 service(a.secret);const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!/^(inst|i)_[a-z0-9]+$/.test(a.installationId)||!/^ns_[a-z0-9]+$/.test(a.namespaceId)||!a.jti||a.jti.length>200||a.credentials.length>20000||a.expiresAt<=Date.now()||a.expiresAt>Date.now()+300000)throw new Error("Invalid Origin installation receipt");
 if(await ctx.db.query("providerReceipts").withIndex("by_jti",q=>q.eq("jti",a.jti)).unique())throw new Error("Installation receipt already consumed");
 const old=await ctx.db.query("providerConnections").withIndex("by_installation",q=>q.eq("kind","origin").eq("installationId",a.installationId)).unique();
 if(old&&old.organizationId!==a.organizationId)throw new Error("Origin installation belongs to another workspace");
 const data={credentials:a.credentials,namespaceId:a.namespaceId,active:true,suspended:false,error:undefined};
 const id=old?old._id:await ctx.db.insert("providerConnections",{...data,organizationId:a.organizationId,kind:"origin",installationId:a.installationId,instance:"https://api.cursor.com",name:"Cursor Origin",webhookSecret:"",createdAt:Date.now()});
 if(old)await ctx.db.patch(id,data);
 const receipt=await ctx.db.insert("providerReceipts",{jti:a.jti,expiresAt:a.expiresAt});
 await ctx.scheduler.runAt(a.expiresAt,internal.providerConnections.expireReceipt,{id:receipt});
 await audit(ctx,a.organizationId,user._id,"origin.connected",id);return id;
}});
export const expireReceipt=internalMutation({args:{id:v.id("providerReceipts")},handler:async(ctx,a)=>{const r=await ctx.db.get(a.id);if(r&&r.expiresAt<=Date.now())await ctx.db.delete(r._id);}});
export const originInstallation=internalQuery({args:{installationId:v.string()},handler:async(ctx,a)=>ctx.db.query("providerConnections").withIndex("by_installation",q=>q.eq("kind","origin").eq("installationId",a.installationId)).unique()});
export const originLifecycle=internalMutation({args:{id:v.id("providerConnections"),eventType:v.string()},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.kind!=="origin")return;
 if(a.eventType==="installation.deleted"){
  await ctx.db.patch(c._id,{active:false,credentials:"",webhookSecret:"",error:"Origin installation removed"});
  for(const r of await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect())if(r.connectionId===c._id)await disableRepository(ctx,r);
 }else if(a.eventType==="installation.suspended"){
  await ctx.db.patch(c._id,{suspended:true,error:"Origin installation suspended"});
  for(const r of await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect())if(r.connectionId===c._id)await cancelRepositoryIndex(ctx,r);
 }
 else if(a.eventType==="installation.unsuspended")await ctx.db.patch(c._id,{suspended:false,error:undefined});
 await audit(ctx,c.organizationId,undefined,a.eventType,c._id);
}});
export const claimEvent=internalMutation({args:{id:v.id("providerEvents")},handler:async(ctx,a)=>{
 const event=await ctx.db.get(a.id);if(!event||event.status==="completed")return false;
 if(event.status==="processing"&&(event.updatedAt??event.createdAt)>Date.now()-15*60000)return false;
 if(event.attempts>=3){await ctx.db.patch(event._id,{status:"failed",error:"Provider event recovery exhausted",updatedAt:Date.now()});return false;}
 await ctx.db.patch(event._id,{status:"processing",attempts:event.attempts+1,updatedAt:Date.now()});
 await ctx.scheduler.runAfter(15*60000+1,internal.providerJobs.event,a);
 return true;
}});

export const events=query({args:{token:v.string(),connectionId:v.id("providerConnections")},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.connectionId);if(!c)throw new Error("Connection unavailable");await authorize(ctx,a.token,c.organizationId,true);
 return (await ctx.db.query("providerEvents").withIndex("by_connection_created",q=>q.eq("connectionId",c._id)).order("desc").take(50)).map(e=>({_id:e._id,eventType:e.eventType,status:e.status,attempts:e.attempts,createdAt:e.createdAt}));
}});
export const retryEvent=mutation({args:{token:v.string(),id:v.id("providerEvents")},handler:async(ctx,a)=>{
 const e=await ctx.db.get(a.id);if(!e)throw new Error("Delivery unavailable");const c=await ctx.db.get(e.connectionId);if(!c)throw new Error("Connection unavailable");
 const {user}=await authorize(ctx,a.token,c.organizationId,true);
 if(!c.active||c.suspended)throw new Error("Connection disabled or suspended");
 if(e.status!=="failed")throw new Error("Only failed deliveries may be retried");
 await ctx.db.patch(e._id,{status:"queued",attempts:0,error:undefined,updatedAt:Date.now()});
 await audit(ctx,c.organizationId,user._id,"provider.delivery_retried",e._id);
 await ctx.scheduler.runAfter(0,internal.providerJobs.event,{id:e._id});
}});
