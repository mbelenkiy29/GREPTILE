import {mutation,query,internalMutation,internalQuery} from "./_generated/server";
import type {QueryCtx,MutationCtx} from "./_generated/server";
import type {Doc,Id} from "./_generated/dataModel";
import {internal} from "./_generated/api";
import {v} from "convex/values";
import {z} from "zod";
import {authorize,organizationAccess,service,audit} from "./auth";
import {rateLimit} from "./rateLimit";
import {receiveEvent} from "./providerConnections";
import {bitbucketEvent as nativeBitbucketEvent} from "../src/bitbucket-events";
import {disableRepository} from "./repositories";

async function request(ctx:QueryCtx|MutationCtx,hash:string){
 if(!/^[a-f0-9]{64}$/.test(hash))throw new Error("Invalid installation authorization");
 const r=await ctx.db.query("providerInstallRequests").withIndex("by_hash",q=>q.eq("tokenHash",hash)).unique();
 if(!r||r.expiresAt<=Date.now()||r.consumed)throw new Error("Installation authorization expired or consumed");
 await organizationAccess(ctx,r.userId,r.organizationId,true);return r;
}
export const beginBitbucket=mutation({args:{token:v.string(),organizationId:v.id("organizations"),tokenHash:v.string()},handler:async(ctx,a)=>{
 const {user}=await authorize(ctx,a.token,a.organizationId,true);
 if(!/^[a-f0-9]{64}$/.test(a.tokenHash))throw new Error("Invalid installation authorization");
 await rateLimit(ctx,"provider:install:"+user._id,10);
 if(await ctx.db.query("providerInstallRequests").withIndex("by_hash",q=>q.eq("tokenHash",a.tokenHash)).unique())throw new Error("Installation authorization already exists");
 const expiresAt=Date.now()+5*60000;
 const id=await ctx.db.insert("providerInstallRequests",{organizationId:a.organizationId,userId:user._id,tokenHash:a.tokenHash,expiresAt,consumed:false,createdAt:Date.now()});
 await ctx.scheduler.runAt(expiresAt,internal.providerInstalls.expire,{id});
 await audit(ctx,a.organizationId,user._id,"bitbucket.install_authorized",id);return {id,expiresAt};
}});
export const inspect=query({args:{secret:v.string(),tokenHash:v.string()},handler:async(ctx,a)=>{service(a.secret);const r=await request(ctx,a.tokenHash);return {organizationId:r.organizationId,expiresAt:r.expiresAt};}});
export const revoke=mutation({args:{token:v.string(),id:v.id("providerInstallRequests")},handler:async(ctx,a)=>{
 const r=await ctx.db.get(a.id);if(!r)throw new Error("Installation authorization unavailable");
 const {user}=await authorize(ctx,a.token,r.organizationId,true);await ctx.db.patch(r._id,{consumed:true});await audit(ctx,r.organizationId,user._id,"bitbucket.install_authorization_revoked",r._id);
}});
export const connectBitbucket=mutation({args:{secret:v.string(),tokenHash:v.string(),installationId:v.string(),workspaceId:v.string(),credentials:v.string(),invocationId:v.string(),invocationExpiresAt:v.number()},handler:async(ctx,a)=>{
 service(a.secret);const r=await request(ctx,a.tokenHash);
 const workspace=z.string().uuid().parse(a.workspaceId),prefix="ari:cloud:ecosystem::installation/";
 if(!a.installationId.startsWith(prefix)||!z.string().uuid().safeParse(a.installationId.slice(prefix.length)).success||!a.invocationId||a.invocationId.length>200||!a.credentials||a.credentials.length>40000||a.invocationExpiresAt<=Date.now()||a.invocationExpiresAt>Date.now()+300000)throw new Error("Invalid verified Forge installation");
 const receiptKey="bitbucket:"+a.invocationId;
 if(await ctx.db.query("providerReceipts").withIndex("by_jti",q=>q.eq("jti",receiptKey)).unique())throw new Error("Forge invocation already consumed");
 const old=await ctx.db.query("providerConnections").withIndex("by_installation",q=>q.eq("kind","bitbucket-cloud").eq("installationId",a.installationId)).unique();
 if(old&&(old.organizationId!==r.organizationId||old.namespaceId!==workspace))throw new Error("Forge installation belongs to another workspace");
 // Reconnection requires fresh native delivery proofs and an explicit admin activation.
 const data={credentials:a.credentials,namespaceId:workspace,active:true,suspended:true,forgeEventAt:undefined,forgeRefreshAt:undefined,error:"Awaiting signed Forge event delivery, scheduled token renewal and administrator activation."};
 const id=old?old._id:await ctx.db.insert("providerConnections",{...data,organizationId:r.organizationId,kind:"bitbucket-cloud",installationId:a.installationId,instance:"https://api.bitbucket.org",name:"Bitbucket Cloud",webhookSecret:"",createdAt:Date.now()});
 if(old)await ctx.db.patch(id,data);
 await ctx.db.patch(r._id,{consumed:true});
 const receipt=await ctx.db.insert("providerReceipts",{jti:receiptKey,expiresAt:a.invocationExpiresAt});await ctx.scheduler.runAt(a.invocationExpiresAt,internal.providerConnections.expireReceipt,{id:receipt});
 await audit(ctx,r.organizationId,r.userId,"bitbucket.connected",id);return id;
}});
export const expire=internalMutation({args:{id:v.id("providerInstallRequests")},handler:async(ctx,a)=>{const r=await ctx.db.get(a.id);if(r&&r.expiresAt<=Date.now())await ctx.db.delete(r._id);}});
export const bitbucketInstallation=query({args:{secret:v.string(),installationId:v.string(),workspaceId:v.string()},handler:async(ctx,a)=>{
 service(a.secret);const c=await ctx.db.query("providerConnections").withIndex("by_installation",q=>q.eq("kind","bitbucket-cloud").eq("installationId",a.installationId)).unique();
 if(!c?.active||c.namespaceId!==a.workspaceId)throw new Error("Forge installation unavailable");return {id:c._id,organizationId:c.organizationId,credentials:c.credentials};
}});
export const refreshBitbucket=mutation({args:{secret:v.string(),id:v.id("providerConnections"),installationId:v.string(),workspaceId:v.string(),previousCredentials:v.string(),credentials:v.string(),invocationId:v.string(),invocationExpiresAt:v.number()},handler:async(ctx,a)=>{
 service(a.secret);const c=await ctx.db.get(a.id);
 if(!c?.active||c.kind!=="bitbucket-cloud"||c.installationId!==a.installationId||c.namespaceId!==a.workspaceId||c.credentials!==a.previousCredentials||!a.credentials||a.credentials.length>40000||!a.invocationId||a.invocationId.length>200||a.invocationExpiresAt<=Date.now()||a.invocationExpiresAt>Date.now()+300000)throw new Error("Forge refresh no longer authorized");
 const jti="bitbucket:"+a.invocationId;if(await ctx.db.query("providerReceipts").withIndex("by_jti",q=>q.eq("jti",jti)).unique())throw new Error("Forge invocation already consumed");
 await ctx.db.patch(c._id,{credentials:a.credentials,forgeRefreshAt:Date.now()});
 const id=await ctx.db.insert("providerReceipts",{jti,expiresAt:a.invocationExpiresAt});await ctx.scheduler.runAt(a.invocationExpiresAt,internal.providerConnections.expireReceipt,{id});
 // Renewal records readiness but never enables reviews by itself.
 return {id:c._id};
}});
export const bitbucketEvent=mutation({args:{secret:v.string(),installationId:v.string(),workspaceId:v.string(),body:v.string(),invocationId:v.string(),invocationExpiresAt:v.number()},handler:async(ctx,a)=>{
 service(a.secret);
 const c=await ctx.db.query("providerConnections").withIndex("by_installation",q=>q.eq("kind","bitbucket-cloud").eq("installationId",a.installationId)).unique();
 if(!c?.active||c.namespaceId!==a.workspaceId||a.body.length>400000||!a.invocationId||a.invocationId.length>200||a.invocationExpiresAt<=Date.now()||a.invocationExpiresAt>Date.now()+300000)throw new Error("Forge event not authorized");
 const event=nativeBitbucketEvent.parse(JSON.parse(a.body));if(event.workspace.uuid!==c.namespaceId)throw new Error("Forge event workspace mismatch");
 const jti="bitbucket:"+a.invocationId;
 if(await ctx.db.query("providerReceipts").withIndex("by_jti",q=>q.eq("jti",jti)).unique())throw new Error("Forge invocation already consumed");
 const body=JSON.stringify(event),digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body))),externalId=Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
 const receipt=await ctx.db.insert("providerReceipts",{jti,expiresAt:a.invocationExpiresAt});await ctx.scheduler.runAt(a.invocationExpiresAt,internal.providerConnections.expireReceipt,{id:receipt});
 await ctx.db.patch(c._id,{forgeEventAt:Date.now()});
 // Before activation, retain only delivery proof; do not launch jobs or replay setup activity.
 if(c.suspended)return null;
 return receiveEvent(ctx,{connectionId:c._id,externalId,body,eventType:event.eventType});
}});
export const uninstallBitbucket=mutation({args:{secret:v.string(),installationId:v.string(),workspaceId:v.string(),invocationId:v.string(),invocationExpiresAt:v.number()},handler:async(ctx,a)=>{
 service(a.secret);
 if(!a.invocationId||a.invocationId.length>200||a.invocationExpiresAt<=Date.now()||a.invocationExpiresAt>Date.now()+300000)throw new Error("Invalid Forge uninstall receipt");
 const c=await ctx.db.query("providerConnections").withIndex("by_installation",q=>q.eq("kind","bitbucket-cloud").eq("installationId",a.installationId)).unique();
 if(c&&c.namespaceId!==a.workspaceId)throw new Error("Forge uninstall workspace mismatch");
 const jti="bitbucket:"+a.invocationId;
 if(await ctx.db.query("providerReceipts").withIndex("by_jti",q=>q.eq("jti",jti)).unique())throw new Error("Forge invocation already consumed");
 const receipt=await ctx.db.insert("providerReceipts",{jti,expiresAt:a.invocationExpiresAt});await ctx.scheduler.runAt(a.invocationExpiresAt,internal.providerConnections.expireReceipt,{id:receipt});
 if(c){
  await ctx.db.patch(c._id,{active:false,suspended:true,credentials:"",webhookSecret:"",error:"Bitbucket Forge installation removed"});
  for(const repo of await ctx.db.query("repositories").withIndex("by_org",q=>q.eq("organizationId",c.organizationId)).collect())if(repo.connectionId===c._id)await disableRepository(ctx,repo);
  if(c.active)await audit(ctx,c.organizationId,undefined,"bitbucket.uninstalled",c._id);
 }
 return {status:"disconnected"};
}});

async function activation(ctx:QueryCtx|MutationCtx,token:string,id:Id<"providerConnections">):Promise<Doc<"providerConnections">>{
 const c=await ctx.db.get(id);if(!c?.active||c.kind!=="bitbucket-cloud")throw new Error("Active Bitbucket installation required");
 await authorize(ctx,token,c.organizationId,true);
 if(!c.forgeEventAt||!c.forgeRefreshAt||c.forgeEventAt<Date.now()-24*60*60000||c.forgeRefreshAt<Date.now()-90*60000)throw new Error("Receive a native Forge event within 24 hours and scheduled token renewal within 90 minutes before activation");
 return c;
}
export const bitbucketActivation=internalQuery({args:{token:v.string(),id:v.id("providerConnections")},handler:async(ctx,a)=>activation(ctx,a.token,a.id)});
export const activateBitbucket=internalMutation({args:{token:v.string(),id:v.id("providerConnections"),credentials:v.string()},handler:async(ctx,a)=>{
 const c=await activation(ctx,a.token,a.id);if(c.credentials!==a.credentials)throw new Error("Installation changed during activation; retry");
 if(!c.suspended)return;
 await ctx.db.patch(c._id,{suspended:false,error:undefined});const {user}=await authorize(ctx,a.token,c.organizationId,true);await audit(ctx,c.organizationId,user._id,"bitbucket.activated",c._id);
}});
