import {query,mutation,internalQuery,internalMutation,type QueryCtx,type MutationCtx} from './_generated/server';
import {v} from 'convex/values';
import {internal} from './_generated/api';
import type {Id} from './_generated/dataModel';
import {authenticated,authorizeRepository,repositoryAccess,visibleRepositories,audit,service} from './auth';
import {personalIdentityProviders} from '../src/personal-providers';
import {connectionDigest} from './indexAuthority';
export async function providerIdentityDigest(c:{kind:string;instance:string;credentials:string;installationId?:string;namespaceId?:string}){return connectionDigest(JSON.stringify(['origin','bitbucket-cloud'].includes(c.kind)?[c.kind,c.instance,c.credentials,c.installationId,c.namespaceId]:[c.kind,c.instance,c.credentials]));}
export const authorize=internalQuery({args:{token:v.string(),repositoryId:v.id('repositories')},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true),connection=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(!connection?.active||connection.suspended||!personalIdentityProviders.includes(connection.kind)||connection.organizationId!==repo.organizationId)throw new Error('Active supported provider connection required');return {repo,user,connection};
}});
export const save=internalMutation({args:{token:v.string(),repositoryId:v.id('repositories'),connectionId:v.id('providerConnections'),digest:v.string(),externalId:v.string(),username:v.string(),credentials:v.string(),originReceipt:v.optional(v.object({jti:v.string(),expiresAt:v.number(),installationId:v.string(),namespaceId:v.string()}))},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true),c=await ctx.db.get(a.connectionId);
 if(c?.kind==='bitbucket-cloud')throw new Error('Use native Forge personal confirmation');
 if(repo.connectionId!==c?._id||!c?.active||c.suspended||!personalIdentityProviders.includes(c.kind)||c.organizationId!==repo.organizationId||await providerIdentityDigest(c)!==a.digest||!a.externalId||!a.username||!a.credentials)throw new Error('Provider identity connection changed');
 if(c.kind==='origin'){
  const r=a.originReceipt;if(!r||r.installationId!==c.installationId||r.namespaceId!==c.namespaceId||!/^user_[a-zA-Z0-9]+$/.test(a.externalId)||a.username!==a.externalId||!r.jti||r.jti.length>200||r.expiresAt<=Date.now()||r.expiresAt>Date.now()+300000)throw new Error('Verified Origin user confirmation required');
  const jti='origin-user:'+r.jti;if(await ctx.db.query('providerReceipts').withIndex('by_jti',q=>q.eq('jti',jti)).unique())throw new Error('Origin user receipt already consumed');
  const receipt=await ctx.db.insert('providerReceipts',{jti,expiresAt:r.expiresAt});await ctx.scheduler.runAt(r.expiresAt,internal.providerConnections.expireReceipt,{id:receipt});
 }else if(a.originReceipt)throw new Error('Origin receipt cannot link another provider');
 const claimed=await ctx.db.query('providerIdentities').withIndex('by_connection_external',q=>q.eq('connectionId',c._id).eq('externalId',a.externalId)).unique();if(claimed&&claimed.userId!==user._id)throw new Error('Provider account is linked to another workspace account');
 const old=await ctx.db.query('providerIdentities').withIndex('by_connection_user',q=>q.eq('connectionId',c._id).eq('userId',user._id)).unique(),now=Date.now(),value={organizationId:repo.organizationId,connectionId:c._id,userId:user._id,externalId:a.externalId,username:a.username,credentials:a.credentials,connectionDigest:a.digest,active:true,generation:(old?.generation??0)+1,expiresAt:now+24*60*60000,updatedAt:now};
 const id=old?old._id:await ctx.db.insert('providerIdentities',{...value,createdAt:now});if(old)await ctx.db.patch(id,value);await audit(ctx,repo.organizationId,user._id,'provider.identity.linked',c._id);return id;
}});
export async function providerIdentityAuthority(ctx:QueryCtx|MutationCtx,id:Id<'providerIdentities'>,repositoryId:Id<'repositories'>,generation?:number){
 const identity=await ctx.db.get(id);if(!identity?.active||!identity.credentials||identity.expiresAt<=Date.now()||generation!==undefined&&identity.generation!==generation)throw new Error('Provider personal identity expired, revoked or replaced');
 const {repo}=await repositoryAccess(ctx,identity.userId,repositoryId,true),c=await ctx.db.get(identity.connectionId);
 if(repo.organizationId!==identity.organizationId||repo.connectionId!==identity.connectionId||!c?.active||c.suspended||!personalIdentityProviders.includes(c.kind)||c.organizationId!==repo.organizationId||await providerIdentityDigest(c)!==identity.connectionDigest)throw new Error('Provider identity connection authority changed');return {identity,repo,connection:c};
}
export const data=internalQuery({args:{id:v.id('providerIdentities'),repositoryId:v.id('repositories'),generation:v.optional(v.number())},handler:(ctx,a)=>providerIdentityAuthority(ctx,a.id,a.repositoryId,a.generation)});
export const revoke=mutation({args:{token:v.string(),id:v.id('providerIdentities')},handler:async(ctx,a)=>{const user=await authenticated(ctx,a.token),i=await ctx.db.get(a.id);if(i?.userId!==user._id)throw new Error('Provider identity not owned by this account');await ctx.db.patch(i._id,{active:false,credentials:undefined,generation:i.generation+1,updatedAt:Date.now()});await audit(ctx,i.organizationId,user._id,'provider.identity.revoked',i.connectionId);}});
export const list=query({args:{token:v.string(),organizationId:v.id('organizations')},handler:async(ctx,a)=>{
 const user=await authenticated(ctx,a.token),repos=await visibleRepositories(ctx,a.token,a.organizationId),seen=new Set<string>(),result=[];
 for(const repo of repos){if(!repo.connectionId||seen.has(repo.connectionId))continue;const c=await ctx.db.get(repo.connectionId);if(!c?.active||c.suspended||!personalIdentityProviders.includes(c.kind))continue;
 let canLink=true;try{await repositoryAccess(ctx,user._id,repo._id,true);}catch{canLink=false;}if(!canLink){let alternative=false;for(const r of repos.filter(r=>r.connectionId===c._id&&r._id!==repo._id)){try{await repositoryAccess(ctx,user._id,r._id,true);alternative=true;break;}catch{/* Retain a viewer-only entry if no writable repository exists. */}}if(alternative)continue;}
 seen.add(c._id);const i=await ctx.db.query('providerIdentities').withIndex('by_connection_user',q=>q.eq('connectionId',c._id).eq('userId',user._id)).unique();
 const status=i?i.expiresAt<=Date.now()?'expired':!i.active?'disconnected':!canLink?'access-denied':!i.credentials||await providerIdentityDigest(c)!==i.connectionDigest?'reconfirmation-required':'linked':null;
 result.push({repositoryId:repo._id,connectionId:c._id,kind:c.kind,instance:c.instance,canLink,identity:i?{id:i._id,username:i.username,externalId:i.externalId,active:i.active,expiresAt:i.expiresAt,status:status!}:null});
 }return result;
}});

export const originStart=query({args:{token:v.string(),secret:v.string(),repositoryId:v.id('repositories')},handler:async(ctx,a)=>{
 service(a.secret);const {repo}=await authorizeRepository(ctx,a.token,a.repositoryId,true),c=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(!c?.active||c.suspended||c.kind!=='origin'||c.organizationId!==repo.organizationId||!c.installationId||!c.namespaceId||!repo.externalId)throw new Error('Active Origin repository required');
 return {connectionId:c._id,installationId:c.installationId,namespaceId:c.namespaceId,digest:await providerIdentityDigest(c)};
}});

export const originAuthor=internalQuery({args:{repositoryId:v.id('repositories'),externalId:v.string()},handler:async(ctx,a)=>{
 const repo=await ctx.db.get(a.repositoryId),connection=repo?.connectionId?await ctx.db.get(repo.connectionId):null;
 if(!repo||!connection?.active||connection.suspended||connection.kind!=='origin'||connection.organizationId!==repo.organizationId||!/^user_[a-zA-Z0-9]+$/.test(a.externalId))return null;
 const linked=await ctx.db.query('providerIdentities').withIndex('by_connection_external',q=>q.eq('connectionId',connection._id).eq('externalId',a.externalId)).unique();
 if(!linked||linked.username!==a.externalId)return null;
 try{return await providerIdentityAuthority(ctx,linked._id,repo._id,linked.generation);}catch{return null;}
}});
