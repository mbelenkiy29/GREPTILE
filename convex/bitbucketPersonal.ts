import {mutation,query,internalMutation,type QueryCtx,type MutationCtx} from './_generated/server';
import {v} from 'convex/values';
import {z} from 'zod';
import {internal} from './_generated/api';
import {authorizeRepository,repositoryAccess,service,audit} from './auth';
import {providerIdentityDigest} from './providerIdentities';
import {rateLimit} from './rateLimit';

async function grant(ctx:QueryCtx|MutationCtx,tokenHash:string){
 if(!/^[a-f0-9]{64}$/.test(tokenHash))throw new Error('Invalid personal authorization');
 const g=await ctx.db.query('providerIdentityGrants').withIndex('by_hash',q=>q.eq('tokenHash',tokenHash)).unique();
 if(!g||g.consumed||g.expiresAt<=Date.now())throw new Error('Personal authorization expired or consumed');
 const {repo,user}=await repositoryAccess(ctx,g.userId,g.repositoryId,true),c=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(!c?.active||c.suspended||c.kind!=='bitbucket-cloud'||c.organizationId!==repo.organizationId||c._id!==g.connectionId||!c.installationId||!c.namespaceId||!repo.externalId||await providerIdentityDigest(c)!==g.digest)throw new Error('Personal authorization connection changed');
 return {g,repo,user,c};
}
export const begin=mutation({args:{token:v.string(),repositoryId:v.id('repositories'),tokenHash:v.string()},handler:async(ctx,a)=>{
 const {repo,user}=await authorizeRepository(ctx,a.token,a.repositoryId,true),c=repo.connectionId?await ctx.db.get(repo.connectionId):null;
 if(!c?.active||c.suspended||c.kind!=='bitbucket-cloud'||c.organizationId!==repo.organizationId||!c.installationId||!c.namespaceId||!repo.externalId||! /^[a-f0-9]{64}$/.test(a.tokenHash))throw new Error('Active Bitbucket repository required');
 await rateLimit(ctx,'bitbucket:personal:'+user._id,10);
 if(await ctx.db.query('providerIdentityGrants').withIndex('by_hash',q=>q.eq('tokenHash',a.tokenHash)).unique())throw new Error('Personal authorization already exists');
 const expiresAt=Date.now()+5*60000,id=await ctx.db.insert('providerIdentityGrants',{repositoryId:repo._id,connectionId:c._id,userId:user._id,digest:await providerIdentityDigest(c),tokenHash:a.tokenHash,expiresAt,consumed:false});
 await ctx.scheduler.runAt(expiresAt,internal.bitbucketPersonal.expireGrant,{id});return {expiresAt};
}});
export const inspect=query({args:{secret:v.string(),tokenHash:v.string()},handler:async(ctx,a)=>{
 service(a.secret);const {repo,user,c,g}=await grant(ctx,a.tokenHash);
 return {organizationId:repo.organizationId,userId:user._id,repositoryId:repo._id,externalId:repo.externalId!,fullName:repo.fullName,connectionId:c._id,installationId:c.installationId!,workspaceId:c.namespaceId!,digest:g.digest};
}});
export const save=mutation({args:{secret:v.string(),tokenHash:v.string(),digest:v.string(),installationId:v.string(),workspaceId:v.string(),externalId:v.string(),username:v.string(),credentials:v.string(),expiresAt:v.number(),invocationId:v.string(),invocationExpiresAt:v.number()},handler:async(ctx,a)=>{
 service(a.secret);const {repo,user,c,g}=await grant(ctx,a.tokenHash),now=Date.now();
 z.string().uuid().parse(a.externalId);
 if(a.digest!==g.digest||a.installationId!==c.installationId||a.workspaceId!==c.namespaceId||a.username!=='{'+a.externalId+'}'||!a.credentials||a.credentials.length>40000||a.expiresAt<=now||a.expiresAt>now+60*60000||!a.invocationId||a.invocationId.length>200||a.invocationExpiresAt<=now||a.invocationExpiresAt>now+300000)throw new Error('Verified personal Forge proof required');
 const jti='bitbucket:'+a.invocationId;
 if(await ctx.db.query('providerReceipts').withIndex('by_jti',q=>q.eq('jti',jti)).unique())throw new Error('Forge invocation already consumed');
 const claimed=await ctx.db.query('providerIdentities').withIndex('by_connection_external',q=>q.eq('connectionId',c._id).eq('externalId',a.externalId)).unique();
 if(claimed&&claimed.userId!==user._id)throw new Error('Native account belongs to another workspace account');
 const old=await ctx.db.query('providerIdentities').withIndex('by_connection_user',q=>q.eq('connectionId',c._id).eq('userId',user._id)).unique(),generation=(old?.generation??0)+1;
 const value={organizationId:repo.organizationId,connectionId:c._id,userId:user._id,externalId:a.externalId,username:a.username,credentials:a.credentials,connectionDigest:g.digest,active:true,generation,expiresAt:a.expiresAt,updatedAt:now};
 const id=old?old._id:await ctx.db.insert('providerIdentities',{...value,createdAt:now});if(old)await ctx.db.patch(id,value);
 await ctx.db.patch(g._id,{consumed:true});
 const receipt=await ctx.db.insert('providerReceipts',{jti,expiresAt:a.invocationExpiresAt});await ctx.scheduler.runAt(a.invocationExpiresAt,internal.providerConnections.expireReceipt,{id:receipt});
 await ctx.scheduler.runAt(a.expiresAt,internal.bitbucketPersonal.expireIdentity,{id,generation});
 await audit(ctx,repo.organizationId,user._id,'provider.identity.linked',c._id);return {expiresAt:a.expiresAt};
}});
export const expireGrant=internalMutation({args:{id:v.id('providerIdentityGrants')},handler:async(ctx,a)=>{const g=await ctx.db.get(a.id);if(g&&g.expiresAt<=Date.now())await ctx.db.delete(g._id);}});
export const expireIdentity=internalMutation({args:{id:v.id('providerIdentities'),generation:v.number()},handler:async(ctx,a)=>{const i=await ctx.db.get(a.id);if(i&&i.generation===a.generation&&i.expiresAt<=Date.now())await ctx.db.patch(i._id,{active:false,credentials:undefined,generation:i.generation+1,updatedAt:Date.now()});}});
