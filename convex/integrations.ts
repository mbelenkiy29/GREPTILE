import {query,mutation,internalQuery,internalMutation} from "./_generated/server";
import {v} from "convex/values";
import {internal} from "./_generated/api";
import {authorize,authorizeRepository,audit} from "./auth";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Id} from "./_generated/dataModel";
// Notion's resource scope is the set of pages the user shared with the integration in Notion itself.
export function hasResources(c:{kind:string;teamIds:string[];jiraProjectIds?:string[];confluenceSpaceIds?:string[]}) {return c.kind==="notion"?true:c.kind==="linear"?c.teamIds.length>0:Boolean(c.jiraProjectIds?.length||c.confluenceSpaceIds?.length);}
export const integrationScope=v.object({id:v.id("integrationConnections"),generation:v.number()});
export async function validateIntegrationScopes(ctx:QueryCtx|MutationCtx,repositoryId:Id<"repositories">,scopes:{id:Id<"integrationConnections">;generation:number}[]){
 const repo=await ctx.db.get(repositoryId);if(!repo)throw new Error("Repository unavailable");
 for(const s of scopes){const c=await ctx.db.get(s.id);if(!c?.active||c.organizationId!==repo.organizationId||c.generation!==s.generation||!c.repositoryIds.includes(repositoryId)||!hasResources(c))throw new Error("Requirements integration scope changed; re-review with current authorization");}
}
export const validate=internalQuery({args:{repositoryId:v.id("repositories"),scopes:v.array(integrationScope)},handler:async(ctx,a)=>{await validateIntegrationScopes(ctx,a.repositoryId,a.scopes);return true;}});
export const forRepository=internalQuery({args:{repositoryId:v.id("repositories"),kind:v.optional(v.union(v.literal("linear"),v.literal("atlassian"),v.literal("notion")))},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId);if(!repo)throw new Error("Repository unavailable");
 const connections=(await ctx.db.query("integrationConnections").withIndex("by_org",q=>q.eq("organizationId",repo.organizationId)).collect()).filter(c=>c.active&&hasResources(c)&&c.repositoryIds.includes(repo._id)&&(!a.kind||c.kind===a.kind));
 if(connections.length>5)throw new Error("Requirements context supports at most five requirements connections per repository");return connections.map(c=>({_id:c._id,generation:c.generation}));
}});

export const list=query({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId);
 return (await ctx.db.query("integrationConnections").withIndex("by_org",q=>q.eq("organizationId",a.organizationId)).collect()).map(c=>({_id:c._id,kind:c.kind,name:c.name,active:c.active,error:c.error,teamIds:c.teamIds,projectIds:c.projectIds,repositoryIds:c.repositoryIds,jiraProjectIds:c.jiraProjectIds??[],confluenceSpaceIds:c.confluenceSpaceIds??[]}));
}});
export const authorizeAdmin=internalQuery({args:{token:v.string(),organizationId:v.id("organizations")},handler:async(ctx,a)=>{await authorize(ctx,a.token,a.organizationId,true);return true;}});
export const access=internalQuery({args:{token:v.string(),id:v.id("integrationConnections")},handler:async(ctx,a)=>{const c=await ctx.db.get(a.id);if(!c?.active)throw new Error("Integration disconnected");await authorize(ctx,a.token,c.organizationId,true);return c;}});
export const data=internalQuery({args:{id:v.id("integrationConnections")},handler:async(ctx,a)=>{const c=await ctx.db.get(a.id);if(!c?.active)throw new Error("Integration disconnected");return c;}});
export const receipt=internalMutation({args:{token:v.string(),organizationId:v.id("organizations"),jti:v.string(),expiresAt:v.number()},handler:async(ctx,a)=>{
 await authorize(ctx,a.token,a.organizationId,true);
 if(!/^(linear|atlassian|notion):[a-zA-Z0-9_-]{32,128}$/.test(a.jti)||a.expiresAt<=Date.now()||a.expiresAt>Date.now()+600000)throw new Error("Invalid integration OAuth receipt");
 if(await ctx.db.query("providerReceipts").withIndex("by_jti",q=>q.eq("jti",a.jti)).unique())throw new Error("OAuth receipt already consumed");
 const id=await ctx.db.insert("providerReceipts",{jti:a.jti,expiresAt:a.expiresAt});await ctx.scheduler.runAt(a.expiresAt,internal.providerConnections.expireReceipt,{id});
}});
export const save=internalMutation({args:{token:v.string(),organizationId:v.id("organizations"),kind:v.optional(v.union(v.literal("linear"),v.literal("atlassian"),v.literal("notion"))),sites:v.optional(v.array(v.object({id:v.string(),name:v.string(),url:v.string(),scopes:v.array(v.string())}))),externalId:v.string(),name:v.string(),credentials:v.string(),expiresAt:v.number()},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!a.externalId||!a.name||a.name.length>200||a.credentials.length>20000||a.expiresAt<=Date.now())throw new Error("Invalid requirements connection");
 const kind=a.kind??"linear";
 const old=await ctx.db.query("integrationConnections").withIndex("by_account",q=>q.eq("organizationId",a.organizationId).eq("kind",kind).eq("externalId",a.externalId)).unique();
 if(old?.active)throw new Error("Disconnect the existing requirements connection before reconnecting");
 if(old&&(await ctx.db.query("integrationRevocations").withIndex("by_connection",q=>q.eq("connectionId",old._id)).collect()).some(r=>r.status==="queued"))throw new Error("Linear revocation is pending; retry after it finishes");
 const data={sites:a.sites,jiraProjectIds:[],confluenceSpaceIds:[],externalId:a.externalId,name:a.name,credentials:a.credentials,expiresAt:a.expiresAt,active:true,generation:(old?.generation??0)+1,teamIds:[],projectIds:[],repositoryIds:[],error:undefined,refreshLease:undefined,refreshExpiresAt:undefined};
 const id=old?old._id:await ctx.db.insert("integrationConnections",{...data,organizationId:a.organizationId,kind,createdAt:Date.now()});if(old)await ctx.db.patch(id,data);
 await audit(ctx,a.organizationId,user._id,"integration.connected",id);return id;
}});
export const scope=internalMutation({args:{token:v.string(),id:v.id("integrationConnections"),generation:v.number(),jiraProjectIds:v.optional(v.array(v.string())),confluenceSpaceIds:v.optional(v.array(v.string())),teamIds:v.array(v.string()),projectIds:v.array(v.string()),repositoryIds:v.array(v.id("repositories"))},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.generation!==a.generation)throw new Error("Integration changed; refresh and retry");const {user}=await authorize(ctx,a.token,c.organizationId,true);
 if(c.kind==="linear"&&((a.jiraProjectIds?.length??0)+(a.confluenceSpaceIds?.length??0)>0)||c.kind==="atlassian"&&(a.teamIds.length+a.projectIds.length>0)||c.kind==="notion"&&(a.teamIds.length+a.projectIds.length+(a.jiraProjectIds?.length??0)+(a.confluenceSpaceIds?.length??0)>0))throw new Error("Resource kind does not match connection");
 if([...a.jiraProjectIds??[],...a.confluenceSpaceIds??[]].length>200||[...a.jiraProjectIds??[],...a.confluenceSpaceIds??[]].some(id=>!id||id.length>200))throw new Error("Too many Atlassian resources");
 if(a.teamIds.length>100||a.projectIds.length>100||a.repositoryIds.length>100||[...a.teamIds,...a.projectIds].some(s=>!s||s.length>200))throw new Error("Integration scope exceeds 100 teams, projects or repositories");
 const siblings=await ctx.db.query("integrationConnections").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect();
 for(const id of a.repositoryIds){const {repo}=await authorizeRepository(ctx,a.token,id,true);if(repo.organizationId!==c.organizationId)throw new Error("Repository belongs to another workspace");if((c.kind==="notion"||a.teamIds.length||a.jiraProjectIds?.length||a.confluenceSpaceIds?.length)&&siblings.filter(s=>s._id!==c._id&&s.active&&hasResources(s)&&s.repositoryIds.includes(id)).length>=5)throw new Error("At most five requirements connections per repository");}
 await ctx.db.patch(c._id,{teamIds:[...new Set(a.teamIds)],projectIds:[...new Set(a.projectIds)],repositoryIds:[...new Set(a.repositoryIds)],jiraProjectIds:[...new Set(a.jiraProjectIds??[])],confluenceSpaceIds:[...new Set(a.confluenceSpaceIds??[])],generation:c.generation+1,error:undefined});await ctx.scheduler.runAfter(0,internal.cache.clearOrganization,{organizationId:c.organizationId});await audit(ctx,c.organizationId,user._id,"integration.scope_changed",c._id);
}});
export const claimRefresh=internalMutation({args:{id:v.id("integrationConnections"),credentials:v.string(),lease:v.string()},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.credentials!==a.credentials||c.refreshExpiresAt&&c.refreshExpiresAt>Date.now())return false;
 await ctx.db.patch(c._id,{refreshLease:a.lease,refreshExpiresAt:Date.now()+120000});return true;
}});
export const refreshed=internalMutation({args:{id:v.id("integrationConnections"),lease:v.string(),credentials:v.string(),expiresAt:v.number()},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c?.active||c.refreshLease!==a.lease)return false;
 await ctx.db.patch(c._id,{credentials:a.credentials,expiresAt:a.expiresAt,refreshLease:undefined,refreshExpiresAt:undefined,error:undefined});return true;
}});
export const refreshFailed=internalMutation({args:{id:v.id("integrationConnections"),lease:v.string()},handler:async(ctx,a)=>{const c=await ctx.db.get(a.id);if(c?.active&&c.refreshLease===a.lease)await ctx.db.patch(c._id,{refreshLease:undefined,refreshExpiresAt:undefined,error:"Token refresh failed; reconnect if authorization was revoked."});}});
export const disconnect=mutation({args:{token:v.string(),id:v.id("integrationConnections")},handler:async(ctx,a)=>{
 const c=await ctx.db.get(a.id);if(!c)throw new Error("Integration unavailable");const {user}=await authorize(ctx,a.token,c.organizationId,true);if(!c.active)return;
 const revocation=c.kind==="linear"||c.kind==="notion"?await ctx.db.insert("integrationRevocations",{connectionId:c._id,organizationId:c.organizationId,credentials:c.credentials,status:"queued",attempts:0,createdAt:Date.now()}):null;
 await ctx.db.patch(c._id,{active:false,credentials:"",generation:c.generation+1,teamIds:[],projectIds:[],repositoryIds:[],jiraProjectIds:[],confluenceSpaceIds:[],sites:[],refreshLease:undefined,refreshExpiresAt:undefined,error:c.kind==="atlassian"?"Local credentials and context access removed. Revoke the OpenReview grant in your Atlassian account Connected Apps.":undefined});
 await ctx.scheduler.runAfter(0,internal.cache.clearOrganization,{organizationId:c.organizationId});if(revocation)await ctx.scheduler.runAfter(0,c.kind==="notion"?internal.notionJobs.revoke:internal.integrationJobs.revoke,{id:revocation});await audit(ctx,c.organizationId,user._id,"integration.disconnected",c._id);
}});
export const revocation=internalQuery({args:{id:v.id("integrationRevocations")},handler:async(ctx,a)=>ctx.db.get(a.id)});
export const claimRevocation=internalMutation({args:{id:v.id("integrationRevocations"),lease:v.string()},handler:async(ctx,a)=>{
 const r=await ctx.db.get(a.id);if(!r||r.status!=="queued"||!r.credentials||r.leaseExpiresAt&&r.leaseExpiresAt>Date.now())return null;
 const attempts=r.attempts+1;if(attempts>3)return null;
 await ctx.db.patch(r._id,{lease:a.lease,leaseExpiresAt:Date.now()+120000,attempts});
 await ctx.scheduler.runAfter(120000,internal.integrations.recoverRevocation,{id:r._id,lease:a.lease});return r;
}});
export const recoverRevocation=internalMutation({args:{id:v.id("integrationRevocations"),lease:v.string()},handler:async(ctx,a)=>{
 const r=await ctx.db.get(a.id);if(!r||r.status!=="queued"||r.lease!==a.lease)return;
 await ctx.scheduler.runAfter(0,internal.integrations.revocationResult,{...a,success:false});
}});
export const revocationResult=internalMutation({args:{id:v.id("integrationRevocations"),lease:v.string(),success:v.boolean()},handler:async(ctx,a)=>{
 const r=await ctx.db.get(a.id);if(!r||r.status!=="queued"||r.lease!==a.lease)return;const attempts=r.attempts;
 await ctx.db.patch(r._id,{lease:undefined,leaseExpiresAt:undefined,status:a.success?"completed":attempts>=3?"failed":"queued",...((a.success||attempts>=3)?{credentials:""}:{})});
 const connection=await ctx.db.get(r.connectionId),notion=connection?.kind==="notion";
 if(!a.success&&attempts<3)await ctx.scheduler.runAfter(10000*2**attempts,notion?internal.notionJobs.revoke:internal.integrationJobs.revoke,{id:r._id});
 if(!a.success){const c=connection;if(c&&!c.active)await ctx.db.patch(c._id,{error:attempts>=3?(notion?"Local access removed. Notion revocation failed; remove the OpenReview connection in Notion under Settings → Connections.":"Local access removed. Linear revocation failed; revoke the OpenReview app in Linear settings."):notion?"Local access removed. Retrying Notion token revocation.":"Local access removed. Retrying Linear token revocation."});}
 else {const c=await ctx.db.get(r.connectionId);if(c&&!c.active)await ctx.db.patch(c._id,{error:undefined});}
}});
